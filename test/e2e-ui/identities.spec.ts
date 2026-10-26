import type { ServerSummary } from '../../shared/types';
import { inside } from './support/docker';
import { expect, openApp, test, uid } from './support/test';
import { choose, enableReadableTerminals, expectTerminalText, openServer, rowButton, typeCommand } from './support/ui';

// Identities: generate an ed25519 key in the keychain, install its public key
// on a server (signing in with the server's password), then switch the server
// to the identity alone and connect with the key.

test('generates a key, installs it on a server and signs in with it', async ({ page, state, api, addServer }) => {
    const id = uid();
    const identity = `deploy-${id}`;
    await enableReadableTerminals(page);
    const server = await addServer('alpha', { name: `Key login ${id}`, username: 'keyuser', password: 'keypw' });
    await openApp(page, state);

    // Settings › Keychain › Generate key.
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('dialog', { name: 'Settings' });
    await settings.getByRole('tab', { name: 'Keychain' }).click();
    await settings.getByRole('button', { name: 'Generate key' }).click();
    const form = page.getByRole('dialog', { name: 'New identity' });
    await expect(form.getByRole('radio', { name: 'Generate' })).toBeChecked();
    await form.getByRole('textbox', { name: 'Name', exact: true }).fill(identity);
    await form.getByRole('textbox', { name: 'Username' }).fill('keyuser');
    await form.getByRole('button', { name: 'Create and generate key' }).click();
    await expect(form).toBeHidden();

    const card = settings.getByRole('list', { name: 'Saved identities' }).getByRole('listitem').filter({ has: page.getByRole('heading', { name: identity }) });
    await expect(card).toContainText('Key (ed25519)');
    const keyLine = card.getByRole('code').filter({ hasText: 'ssh-ed25519' });
    await expect(keyLine).toHaveText(new RegExp(`^ssh-ed25519 AAAA\\S+ shellmind:${identity}$`));
    const publicKey = ((await keyLine.textContent()) ?? '').trim();

    // Install on the server: appended to authorized_keys, then checked.
    await card.getByRole('button', { name: `Install key: ${identity}` }).click();
    const install = page.getByRole('dialog', { name: `Install the key of ${identity}` });
    await install.getByRole('searchbox', { name: 'Search servers' }).fill(server.name);
    await install.getByRole('checkbox', { name: new RegExp(`^${server.name} keyuser@`) }).check();
    await install.getByRole('button', { name: 'Install on 1 server' }).click();
    await expect(install.getByRole('status')).toHaveText('1 installed', { timeout: 60_000 });
    await expect(install.getByRole('list', { name: 'Progress per server' })).toContainText(`${server.name}Installed · signs in`);
    expect(inside(state.hosts.alpha.container, 'cat /home/keyuser/.ssh/authorized_keys')).toContain(publicKey);
    await install.getByRole('button', { name: 'Done' }).click();
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();

    // The server signs in with the identity only: its own password is removed.
    await (await rowButton(page, server.name, `Edit ${server.name}`)).click();
    const edit = page.getByRole('dialog', { name: 'Edit connection' });
    await choose(page, edit.getByRole('combobox', { name: /^Credentials/ }), identity);
    await expect(edit.getByRole('checkbox', { name: "Also keep this server's own password or key" })).not.toBeChecked();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    const { data } = await api.get<{ data: ServerSummary[] }>('/api/servers');
    const saved = data.find((item) => item.id === server.id);
    expect(saved?.identity_id).toBeTruthy();
    expect(saved?.has_password).toBeFalsy();

    await openServer(page, server.name);
    const terminal = page.getByRole('tabpanel', { name: 'Terminal 1', exact: true });
    await expectTerminalText(terminal, /[$#] $/m, 30_000);
    await terminal.locator('.xterm-screen').click();
    await typeCommand(page, 'echo "signed in as $(whoami)"');
    await expectTerminalText(terminal, 'signed in as keyuser');
});
