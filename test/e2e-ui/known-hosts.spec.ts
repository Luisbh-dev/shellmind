import type { KnownHost } from '../../shared/types';
import { inside } from './support/docker';
import { expect, openApp, test, uid } from './support/test';
import { enableReadableTerminals, expectTerminalText, openServer, openWorkspaceTab, runFromPalette } from './support/ui';

// Host keys: trusted on first use, a changed key refuses the connection and
// shows both fingerprints until the user trusts the new one, and the known
// hosts list.

const fingerprint = (container: string) =>
    /SHA256:\S+/.exec(inside(container, 'ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub'))![0];

test('a changed host key is refused until the new key is trusted', async ({ page, state, api, addServer }) => {
    const host = state.hosts.rekey;
    // This host is used by this spec only: no key of it is pinned yet (also
    // when the spec runs again against the same backend).
    const { data: pinned } = await api.get<{ data: KnownHost[] }>('/api/known-hosts');
    for (const entry of pinned.filter((item) => item.port === host.port)) await api.del(`/api/known-hosts/${entry.id}`);
    await enableReadableTerminals(page);
    const server = await addServer('rekey', { name: `Host keys ${uid()}` });
    const original = fingerprint(host.container);
    await openApp(page, state);
    await openServer(page, server.name);

    // First use: the key is pinned and the terminal says so.
    const terminal = page.getByRole('tabpanel', { name: 'Terminal 1', exact: true });
    await expectTerminalText(terminal, `Trusted the ssh-ed25519 host key of 127.0.0.1:${host.port} on first use`, 30_000);

    // The server gets a new host key; its sessions end.
    inside(host.container, [
        'rm -f /etc/ssh/ssh_host_*',
        'ssh-keygen -A >/dev/null',
        'kill -HUP 1',
        'sleep 1',
        "pkill -f 'sshd: demo' || true",
    ].join('\n'));
    const replaced = fingerprint(host.container);
    expect(replaced).not.toBe(original);
    const ended = terminal.getByRole('status').filter({ hasText: /Session ended|Disconnected|closed/i });
    await expect(ended).toBeVisible({ timeout: 30_000 });

    // Reconnecting meets the new key: refused, with both fingerprints.
    await ended.getByRole('button', { name: 'Reconnect' }).click();
    const warning = terminal.getByRole('alert').filter({ hasText: `The host key of 127.0.0.1:${host.port} has changed` });
    await expect(warning).toBeVisible({ timeout: 30_000 });
    await expect(warning.getByRole('definition')).toHaveText([original, replaced]);
    await expect(page.getByRole('banner')).not.toContainText('Connected');
    await warning.getByRole('button', { name: 'Trust the new key' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Trust the new host key?' });
    await expect(confirm).toContainText(replaced);
    await confirm.getByRole('button', { name: 'Trust and reconnect' }).click();
    await expect(warning).toBeHidden();
    await expectTerminalText(terminal, /demo@[\w-]+:~\$ $/m, 30_000);

    // The Tunnels tab shows the pinned key; so does the known hosts list.
    const tunnels = await openWorkspaceTab(page, 'Tunnels');
    await expect(tunnels.getByRole('region', { name: 'Host key' })).toContainText(replaced);
    await runFromPalette(page, 'known hosts', /^Known hosts/);
    const known = page.getByRole('dialog', { name: 'Known hosts' });
    const entry = known.getByRole('listitem').filter({ hasText: `127.0.0.1:${host.port}` });
    await expect(entry).toContainText(replaced);
    await expect(entry).toContainText(server.name);

    // Forgetting it: the next connection trusts whatever key it gets.
    await entry.getByRole('button', { name: `Forget the host key of 127.0.0.1:${host.port}` }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: /^Forget/ }).click();
    await expect(entry).toHaveCount(0);
});
