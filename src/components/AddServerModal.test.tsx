import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLayoutEffect } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IdentitySummary } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { resetIdentitiesStore } from '@/features/identities/store';
import AddServerModal from './AddServerModal';

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[];
let respond: (call: Call) => Response;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const SAVED: ServerSummary[] = [
    { id: 1, name: 'bastion', ip: '10.0.0.1', type: 'linux', username: 'jump' },
    { id: 2, name: 'web', ip: '10.0.0.2', type: 'linux', username: 'root', jump_server_id: 1, has_private_key: 1, has_passphrase: 1, group_name: 'Prod', tags: ['web'] },
    { id: 3, name: 'files', ip: '10.0.0.3', type: 'ftp' },
    { id: 4, name: 'behind-web', ip: '10.0.0.4', type: 'linux', jump_server_id: 2 },
];

// W7-S2: the saved identities the form offers (GET /api/identities, not recorded in `calls`).
let identities: IdentitySummary[];

beforeEach(() => {
    setLanguage('en');
    calls = [];
    identities = [];
    resetIdentitiesStore();
    respond = (call) => json({ message: 'success', data: { ...call.body, id: 99 } });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/identities') && (init?.method ?? 'GET') === 'GET') return json({ message: 'success', data: identities });
        const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} };
        calls.push(call);
        return respond(call);
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

function setup(initialData: ServerSummary | null = null) {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
        <ToastProvider>
            <ConfirmProvider>
                <AddServerModal isOpen onClose={onClose} onSaved={onSaved} initialData={initialData} servers={SAVED} />
            </ConfirmProvider>
        </ToastProvider>
    );
    const dialog = screen.getByRole('dialog', { name: initialData ? 'Edit connection' : 'New connection' });
    return { user, onSaved, onClose, dialog };
}

describe('AddServerModal', () => {
    it('shows FTP fields only: password, FTPS and port 21 as the default, never key fields', async () => {
        const { user, dialog, onSaved } = setup();
        // Key auth picked first, then FTP: the key fields must not follow.
        await user.click(within(dialog).getByRole('radio', { name: 'Private key' }));
        await user.click(within(dialog).getByRole('radio', { name: 'FTP' }));

        expect(within(dialog).queryByLabelText(/Private key \(PEM/)).toBeNull();
        expect(within(dialog).queryByRole('radiogroup', { name: 'Authentication' })).toBeNull();
        expect(within(dialog).getByLabelText('FTP port')).toHaveAttribute('placeholder', '21');

        await user.type(within(dialog).getByLabelText(/Display name/), 'uploads');
        await user.type(within(dialog).getByLabelText(/Host \/ IP/), 'ftp.example.com');
        await user.type(within(dialog).getByLabelText('Password'), 'pw');
        // Secure unless turned off.
        expect(within(dialog).getByRole('checkbox', { name: 'Encrypt the connection (FTPS)' })).toBeChecked();
        await user.click(within(dialog).getByRole('button', { name: 'Add connection' }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(calls[0]).toMatchObject({ method: 'POST', body: { type: 'ftp', port: null, password: 'pw', ftp_secure: true } });
        expect(calls[0].body).not.toHaveProperty('privateKey');
    });

    it('keeps the password of a Windows server whose SSH uses a key: it is the RDP password', async () => {
        const windows: ServerSummary = { id: 5, name: 'win', ip: '10.0.0.5', type: 'windows', username: 'Administrator', has_password: 1, has_private_key: 1 };
        const { user, dialog, onSaved } = setup(windows);
        expect(within(dialog).getByRole('radio', { name: 'Private key', checked: true })).toBeInTheDocument();
        const password = within(dialog).getByLabelText('Password (RDP / SSH)');
        expect(password).toHaveAccessibleDescription('Used for Remote Desktop; SSH signs in with the key.');
        expect(within(dialog).queryByText(/Saving deletes/)).toBeNull();

        const name = within(dialog).getByLabelText(/Display name/);
        await user.clear(name);
        await user.type(name, 'win-renamed');
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(calls[0].body).toMatchObject({ name: 'win-renamed', type: 'windows' });
        expect(calls[0].body).not.toHaveProperty('clear_password');
        expect(calls[0].body).not.toHaveProperty('clear_private_key');
    });

    // The dialog is on screen before its effects run (a lazily loaded one, under
    // load): a form an effect filled in then put a name typed by then back.
    it('holds the edited server from its first render, before any effect runs', () => {
        const seen: { name?: string; port?: string } = {};
        // Layout effects run before the passive ones of the same render.
        function FirstRender() {
            useLayoutEffect(() => {
                seen.name = (screen.getByLabelText(/Display name/) as HTMLInputElement).value;
                seen.port = (screen.getByLabelText('SSH port') as HTMLInputElement).value;
            }, []);
            return null;
        }
        render(
            <ToastProvider>
                <ConfirmProvider>
                    <AddServerModal isOpen onClose={vi.fn()} onSaved={vi.fn()} initialData={{ ...SAVED[1], port: 2200 }} servers={SAVED} />
                    <FirstRender />
                </ConfirmProvider>
            </ToastProvider>
        );
        expect(seen).toEqual({ name: 'web', port: '2200' });
    });

    it('keeps what was typed when the dialog renders again, and starts over for another server', async () => {
        const onSaved = vi.fn();
        const user = userEvent.setup();
        const view = (server: ServerSummary) => (
            <ToastProvider>
                <ConfirmProvider>
                    <AddServerModal isOpen onClose={vi.fn()} onSaved={onSaved} initialData={server} servers={SAVED} />
                </ConfirmProvider>
            </ToastProvider>
        );
        const { rerender } = render(view(SAVED[1]));
        const name = () => screen.getByLabelText(/Display name/);
        await user.clear(name());
        await user.type(name(), 'web-renamed');

        rerender(view(SAVED[1]));
        expect(name()).toHaveValue('web-renamed');

        rerender(view(SAVED[0]));
        await waitFor(() => expect(name()).toHaveValue('bastion'));
    });

    it('validates inline and focuses the first invalid field', async () => {
        const { user, dialog } = setup();
        await user.type(within(dialog).getByLabelText('SSH port'), '99999');
        await user.click(within(dialog).getByRole('button', { name: 'Add connection' }));

        const name = within(dialog).getByLabelText(/Display name/);
        expect(name).toHaveAttribute('aria-invalid', 'true');
        expect(name).toHaveAccessibleDescription('Enter a name.');
        expect(within(dialog).getByLabelText('SSH port')).toHaveAccessibleDescription(/between 1 and 65535/);
        await waitFor(() => expect(name).toHaveFocus());
        expect(calls).toEqual([]);
    });

    // Saved before presets were checked (data-ops migration 10 keeps unknown ones): the
    // backend refuses it, so the form says so instead of sending it.
    it('points out a CLI preset ShellMind does not know and does not save it', async () => {
        const { user, dialog } = setup({ id: 7, name: 'Typo console', ip: 'local', type: 'local', cli_preset: 'kubctl' });
        const preset = within(dialog).getByRole('combobox', { name: /^CLI preset/ });
        expect(preset).toHaveAccessibleDescription(/does not know this CLI preset/);
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
        expect(calls).toEqual([]);
    });

    it('offers only other SSH servers as jump hosts (not itself, nor servers that jump through it)', async () => {
        const { user, dialog } = setup(SAVED[1]);
        await user.click(within(dialog).getByRole('combobox', { name: /Jump host/ }));
        const options = within(screen.getByRole('listbox')).getAllByRole('option').map((option) => option.textContent);
        expect(options).toEqual(['None (direct connection)', 'bastionjump@10.0.0.1']);
    });

    it('switching an existing key server to a password removes the stored key and says so', async () => {
        const { user, dialog, onSaved } = setup(SAVED[1]);
        expect(within(dialog).getByRole('radio', { name: 'Private key', checked: true })).toBeInTheDocument();
        // The key and its passphrase are both stored.
        expect(within(dialog).getAllByText('Saved')).toHaveLength(2);

        await user.click(within(dialog).getByRole('radio', { name: 'Password' }));
        expect(within(dialog).getByText(/Saving deletes the stored private key, key passphrase/)).toBeInTheDocument();
        await user.type(within(dialog).getByLabelText('Password'), 'new-pw');
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(onSaved).toHaveBeenCalled());
        expect(calls[0]).toMatchObject({
            url: expect.stringContaining('/api/servers/2'),
            method: 'PUT',
            body: { password: 'new-pw', clear_private_key: true, clear_passphrase: true, jump_server_id: 1, group_name: 'Prod', tags: ['web'] },
        });
        expect(calls[0].body).not.toHaveProperty('os_detail');
    });

    it('asks before sending saved credentials to a new address, then resends with keep_secrets', async () => {
        respond = (call) => (call.body.keep_secrets
            ? json({ message: 'success', changes: 1, data: { ...SAVED[1], ip: '10.9.9.9' } })
            : json({ error: 'retarget', code: 'SECRETS_RETARGET', details: { kept: ['privateKey', 'passphrase'] } }, 409));
        const { user, dialog, onSaved } = setup(SAVED[1]);
        const host = within(dialog).getByLabelText(/Host \/ IP/);
        await user.clear(host);
        await user.type(host, '10.9.9.9');
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        const ask = await screen.findByRole('alertdialog', { name: 'Keep the saved credentials?' });
        expect(ask).toHaveTextContent('private key, key passphrase');
        await user.click(within(ask).getByRole('button', { name: 'Keep and save' }));

        await waitFor(() => expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ ip: '10.9.9.9' }), 'edit'));
        expect(calls.map((call) => call.body.keep_secrets)).toEqual([undefined, true]);
    });

    it('explains a declined retarget and shows server errors inline', async () => {
        respond = () => json({ error: 'retarget', code: 'SECRETS_RETARGET', details: { kept: ['privateKey'] } }, 409);
        const { user, dialog, onSaved } = setup(SAVED[1]);
        await user.type(within(dialog).getByLabelText(/Host \/ IP/), '0');
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
        await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Go back' }));
        expect(within(dialog).getByRole('alert')).toHaveTextContent(/Not saved\. Enter the credentials again/);

        respond = () => json({ error: 'jump server #1 does not exist', code: 'INVALID_SERVER' }, 400);
        await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(within(dialog).getByRole('alert')).toHaveTextContent('jump server #1 does not exist'));
        expect(onSaved).not.toHaveBeenCalled();
    });

    it('brings a failed save into view and focus, and keeps the submit button focusable while saving', async () => {
        let finish: (response: Response) => void = () => undefined;
        respond = () => json({});
        vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) => {
            calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} });
            return new Promise<Response>((resolve) => { finish = resolve; });
        }));
        const scrolled: Element[] = [];
        const scrollIntoView = vi.fn(function (this: Element) { scrolled.push(this); });
        Element.prototype.scrollIntoView = scrollIntoView;
        const { user, dialog } = setup();
        await user.type(within(dialog).getByLabelText(/Display name/), 'web-2');
        await user.type(within(dialog).getByLabelText(/Host \/ IP/), '10.0.0.9');
        await user.type(within(dialog).getByLabelText(/^Username/), 'root');

        const submit = within(dialog).getByRole('button', { name: 'Add connection' });
        submit.focus();
        await user.keyboard('{Enter}');
        // Busy, still focused (a disabled button would drop focus to <body>),
        // and a second Enter does not send it twice.
        expect(submit).toHaveAttribute('aria-busy', 'true');
        expect(submit).toHaveFocus();
        await user.type(within(dialog).getByLabelText(/Display name/), '{Enter}');
        expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);

        finish(json({ error: 'SQLITE_BUSY: database is locked' }, 500));
        const alert = await within(dialog).findByRole('alert');
        expect(alert).toHaveTextContent('SQLITE_BUSY: database is locked');
        await waitFor(() => expect(alert).toHaveFocus());
        expect(scrolled).toContain(alert);
    });

    it('does not suggest a saved password for a new connection', async () => {
        const { user, dialog } = setup();
        expect(within(dialog).getByLabelText(/^Password/)).toHaveAttribute('placeholder', 'Password for this user');
        await user.click(within(dialog).getByRole('radio', { name: /S3/ }));
        expect(within(dialog).getByLabelText(/^Secret key/)).toHaveAttribute('placeholder', 'Secret of the access key');
    });

    it('asks before discarding unsaved changes', async () => {
        const { user, dialog, onClose } = setup();
        await user.type(within(dialog).getByLabelText(/Display name/), 'half done');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));

        const ask = screen.getByRole('alertdialog', { name: 'Discard changes?' });
        expect(within(ask).getByRole('button', { name: 'Keep editing' })).toHaveFocus();
        await user.click(within(ask).getByRole('button', { name: 'Keep editing' }));
        expect(onClose).not.toHaveBeenCalled();

        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard' }));
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    describe('with saved identities (W7-S2)', () => {
        const DEPLOY: IdentitySummary = {
            id: 5, name: 'deploy', username: 'deployer', private_key_path: null, use_agent: 1, public_key: null, fingerprint: 'SHA256:abc', key_type: 'ssh-ed25519',
            has_password: 0, has_private_key: 1, has_passphrase: 0, server_count: 0, created_at: 1, updated_at: 1,
        };

        beforeEach(() => {
            identities = [DEPLOY];
        });

        it('collapses the credential fields, makes the username optional and names the identity', async () => {
            const { user, dialog, onSaved } = setup();
            const select = await within(dialog).findByRole('combobox', { name: /Credentials/ });
            await user.click(select);
            await user.click(within(screen.getByRole('option', { name: /deploy/ })).getByText('deploy'));

            expect(within(dialog).queryByRole('radiogroup', { name: 'Authentication' })).toBeNull();
            expect(within(dialog).queryByLabelText(/^Password/)).toBeNull();
            expect(within(dialog).getByText(/Signs in with "deploy":/)).toHaveTextContent('deployer · Key (ed25519) · SSH agent');
            const username = within(dialog).getByLabelText(/^Username/);
            expect(username).not.toBeRequired();
            expect(username).toHaveAttribute('placeholder', 'deployer');

            await user.click(within(dialog).getByRole('checkbox', { name: 'Forward the SSH agent to terminals' }));
            await user.type(within(dialog).getByLabelText(/Display name/), 'web-3');
            await user.type(within(dialog).getByLabelText(/Host \/ IP/), '10.0.0.30');
            await user.click(within(dialog).getByRole('button', { name: 'Add connection' }));

            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(calls[0].body).toMatchObject({ identity_id: 5, agent_forward: true, username: null, private_key_path: null });
            expect(calls[0].body).not.toHaveProperty('password');
        });

        it('removes the server\'s own credentials when it moves to an identity, unless they are kept', async () => {
            const { user, dialog, onSaved } = setup(SAVED[1]);
            await user.click(await within(dialog).findByRole('combobox', { name: /Credentials/ }));
            await user.click(within(screen.getByRole('option', { name: /deploy/ })).getByText('deploy'));
            expect(within(dialog).getByText(/Saving deletes the stored private key, key passphrase/)).toBeInTheDocument();

            await user.click(within(dialog).getByRole('checkbox', { name: /Also keep this server's own password or key/ }));
            expect(within(dialog).queryByText(/Saving deletes/)).toBeNull();
            expect(within(dialog).getByRole('radio', { name: 'Private key', checked: true })).toBeInTheDocument();
            await user.click(within(dialog).getByRole('checkbox', { name: /Also keep this server's own password or key/ }));

            await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
            await waitFor(() => expect(onSaved).toHaveBeenCalled());
            expect(calls[0].body).toMatchObject({ identity_id: 5, clear_private_key: true, clear_passphrase: true });
        });

        it('says whether a Windows server keeps a Remote Desktop password', async () => {
            identities = [DEPLOY, { ...DEPLOY, id: 6, name: 'admin', has_password: 1 }];
            const { user, dialog } = setup({ id: 7, name: 'win', ip: '10.0.0.7', type: 'windows', identity_id: 5 });
            expect(await within(dialog).findByText('This identity has no password, so this server will have none saved for Remote Desktop.')).toBeInTheDocument();
            expect(within(dialog).queryByText(/password is also used for Remote Desktop/)).toBeNull();

            await user.click(within(dialog).getByRole('combobox', { name: /Credentials/ }));
            await user.click(within(screen.getByRole('option', { name: /admin/ })).getByText('admin'));
            expect(within(dialog).queryByText(/will have none saved for Remote Desktop/)).toBeNull();
            expect(within(dialog).getByText('The identity\'s password is also used for Remote Desktop.')).toBeInTheDocument();
        });

        it('names a kept identity when the server is pointed elsewhere', async () => {
            respond = () => json({ error: 'retarget', code: 'SECRETS_RETARGET', details: { kept: ['identity'] } }, 409);
            const { user, dialog } = setup({ ...SAVED[0], identity_id: 5 });
            await within(dialog).findByText(/Signs in with "deploy":/);
            await user.type(within(dialog).getByLabelText(/Host \/ IP/), '0');
            await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
            expect(await screen.findByRole('alertdialog', { name: 'Keep the saved credentials?' })).toHaveTextContent('identity credentials');
        });
    });

    it('is translated', () => {
        setLanguage('es');
        const onSaved = vi.fn();
        render(<AddServerModal isOpen onClose={() => undefined} onSaved={onSaved} servers={[]} />);
        const dialog = screen.getByRole('dialog', { name: 'Nueva conexión' });
        expect(within(dialog).getByLabelText(/Nombre visible/)).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Añadir conexión' })).toBeInTheDocument();
    });
});
