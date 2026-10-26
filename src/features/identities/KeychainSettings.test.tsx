import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentStatus, IdentitySummary, InstallEvent } from '@shared/identities';
import type { ServerSummary } from '@shared/types';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { resetServersStore } from '@/store/servers';
import { KeychainSettings } from './KeychainSettings';
import { resetIdentitiesStore } from './store';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: InstallEvent[]) =>
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });

const DEPLOY: IdentitySummary = {
    id: 1, name: 'deploy', username: 'deployer', private_key_path: null, use_agent: 1,
    public_key: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDeploy shellmind:deploy', fingerprint: 'SHA256:deployFingerprint', key_type: 'ssh-ed25519',
    has_password: 0, has_private_key: 1, has_passphrase: 0, server_count: 1, created_at: 1, updated_at: 1,
};

const SERVERS: ServerSummary[] = [
    { id: 10, name: 'web-1', ip: '10.0.0.1', type: 'linux', username: 'root', identity_id: 1 },
    { id: 11, name: 'web-2', ip: '10.0.0.2', type: 'linux', username: 'root', has_password: 1 },
    { id: 12, name: 'files', ip: 'ftp.example', type: 'ftp' },
];

type Call = { method: string; path: string; body: Record<string, unknown> };

function backend(options: { identities?: IdentitySummary[]; agent?: AgentStatus; install?: () => Response; rotate?: () => Response; remove?: () => Response; update?: () => Response } = {}) {
    let identities = [...(options.identities ?? [DEPLOY])];
    const calls: Call[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit = {}) => {
        const path = new URL(input).pathname;
        const method = init.method ?? 'GET';
        const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
        if (method !== 'GET') calls.push({ method, path, body });
        if (method === 'GET' && path === '/api/identities') return json(200, { message: 'success', data: identities });
        if (method === 'GET' && path === '/api/identities/agent') return json(200, options.agent ?? { available: true, source: 'windows-openssh', keys: [{ type: 'ssh-ed25519', fingerprint: 'SHA256:agentKey', comment: 'me@laptop' }] });
        if (method === 'GET' && path === '/api/servers') return json(200, { message: 'success', data: SERVERS });
        if (method === 'POST' && path === '/api/identities') {
            const created: IdentitySummary = {
                ...DEPLOY, id: 2, name: String(body.name), username: (body.username as string) ?? null, use_agent: body.use_agent ? 1 : 0, server_count: 0,
                has_password: body.password ? 1 : 0, has_private_key: body.generate_key ? 1 : 0,
                public_key: body.generate_key ? `ssh-ed25519 AAAAGenerated shellmind:${String(body.name)}` : null, fingerprint: body.generate_key ? 'SHA256:generated' : null,
            };
            identities = [...identities, created];
            return json(200, { message: 'success', data: created });
        }
        if (method === 'POST' && path === '/api/identities/1/install') return options.install?.() ?? sse([]);
        if (method === 'POST' && path === '/api/identities/1/rotate') return options.rotate?.() ?? sse([{ type: 'start', servers: [], fingerprint: 'SHA256:new' }, { type: 'rotated', replaced: true, fingerprint: 'SHA256:new' }, { type: 'done', cancelled: false }]);
        if (method === 'POST' && path === '/api/identities/assign') return json(200, { message: 'success', data: { updated: body.serverIds, skipped: [] } });
        if (method === 'DELETE' && path === '/api/identities/1') return options.remove?.() ?? json(200, { message: 'deleted' });
        if (method === 'PUT' && path === '/api/identities/1') return options.update?.() ?? json(200, { message: 'success', data: identities[0], dependents: 1 });
        return json(404, { error: 'not found' });
    }));
    return calls;
}

function renderKeychain() {
    const user = userEvent.setup();
    render(
        <ToastProvider>
            <ConfirmProvider>
                <KeychainSettings />
            </ConfirmProvider>
        </ToastProvider>
    );
    return user;
}

beforeEach(() => {
    setLanguage('en');
    resetServersStore();
    resetIdentitiesStore();
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('Settings > Keychain', () => {
    it('lists identities with what they sign in with and how many servers use them, and the agent status', async () => {
        backend();
        const user = renderKeychain();
        const list = await screen.findByRole('list', { name: 'Saved identities' });
        const card = within(list).getByRole('listitem');
        expect(card).toHaveTextContent('deploy');
        expect(card).toHaveTextContent('Key (ed25519)');
        expect(card).toHaveTextContent('SSH agent');
        expect(card).toHaveTextContent('User deployer');
        await waitFor(() => expect(card).toHaveTextContent('Used by 1 server'));
        expect(await screen.findByText('SSH agent connected')).toBeInTheDocument();
        expect(screen.getByText('1 key available · via Windows OpenSSH agent')).toBeInTheDocument();

        // The public key is one click away, with a copy button.
        await user.click(within(card).getByRole('button', { name: /SHA256:deployFingerprint/ }));
        expect(within(card).getByText(DEPLOY.public_key as string)).toBeInTheDocument();
        expect(within(card).getByRole('button', { name: 'Copy the public key of deploy' })).toBeInTheDocument();
    });

    it('explains why there is no SSH agent', async () => {
        backend({ identities: [], agent: { available: false, source: null, reason: 'not-found' } });
        renderKeychain();
        expect(await screen.findByText('No SSH agent')).toBeInTheDocument();
        expect(screen.getByText(/SSH_AUTH_SOCK is not set for ShellMind/)).toBeInTheDocument();
        expect(await screen.findByText('No identities yet')).toBeInTheDocument();
    });

    it('creates an identity that generates its key, and shows its public key', async () => {
        const calls = backend({ identities: [] });
        const user = renderKeychain();
        await user.click(await screen.findByRole('button', { name: 'Generate key' }));
        const editor = screen.getByRole('dialog', { name: 'New identity' });
        expect(within(editor).getByRole('radio', { name: 'Generate', checked: true })).toBeInTheDocument();
        await user.type(within(editor).getByLabelText(/^Name/), 'ci');
        await user.type(within(editor).getByLabelText(/^Username/), 'runner');
        await user.click(within(editor).getByRole('button', { name: 'Create and generate key' }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New identity' })).toBeNull());
        expect(calls[0]).toEqual({ method: 'POST', path: '/api/identities', body: { name: 'ci', username: 'runner', use_agent: false, private_key_path: null, generate_key: true } });
        expect(await screen.findByText('ssh-ed25519 AAAAGenerated shellmind:ci')).toBeInTheDocument();
    });

    it('refuses to delete an identity in use and names the servers', async () => {
        backend({ remove: () => json(409, { error: 'in use', code: 'IDENTITY_IN_USE', details: { dependents: [{ id: 10, name: 'web-1' }] } }) });
        const user = renderKeychain();
        await screen.findByRole('list', { name: 'Saved identities' });
        await user.click(screen.getByRole('button', { name: 'More actions for deploy' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
        expect(await screen.findByText(/"deploy" is still used by these servers/)).toBeInTheDocument();
        expect(screen.getByText('web-1')).toBeInTheDocument();
    });

    it('installs the key on servers, then offers to switch the ones it now signs in to', async () => {
        const calls = backend({
            install: () => sse([
                { type: 'start', servers: [{ serverId: 10, name: 'web-1' }, { serverId: 11, name: 'web-2' }], fingerprint: 'SHA256:deployFingerprint' },
                { type: 'result', result: { serverId: 10, name: 'web-1', status: 'present', verified: true } },
                { type: 'result', result: { serverId: 11, name: 'web-2', status: 'installed', verified: true, file: '/root/.ssh/authorized_keys' } },
                { type: 'done', cancelled: false },
            ]),
        });
        const user = renderKeychain();
        await user.click(await screen.findByRole('button', { name: 'Install key: deploy' }));
        const dialog = screen.getByRole('dialog', { name: 'Install the key of deploy' });
        const servers = within(dialog).getByRole('list', { name: 'Servers to install the key on' });
        // Only SSH servers; the one using the identity is preselected.
        expect(within(servers).getAllByRole('checkbox').map((box) => (box as HTMLInputElement).checked)).toEqual([true, false]);
        await user.click(within(servers).getByRole('checkbox', { name: /web-2/ }));
        await user.click(within(dialog).getByRole('button', { name: 'Install on 2 servers' }));

        expect(await within(dialog).findByText('Already there · signs in')).toBeInTheDocument();
        expect(within(dialog).getByText('Installed · signs in')).toBeInTheDocument();
        expect(within(dialog).getByText('1 installed · 1 already there')).toBeInTheDocument();
        expect(calls[0]).toMatchObject({ path: '/api/identities/1/install', body: { serverIds: [10, 11] } });

        await user.click(within(dialog).getByRole('button', { name: 'Use deploy on that server' }));
        const assign = screen.getByRole('dialog', { name: 'Use deploy on servers' });
        expect(within(assign).getByRole('checkbox', { name: /web-2/ })).toBeChecked();
        // The key was just verified there: removing its own password is offered.
        expect(within(assign).getByRole('checkbox', { name: /Remove the own password and key/ })).toBeChecked();
        await user.click(within(assign).getByRole('button', { name: 'Save' }));
        const confirm = screen.getByRole('alertdialog', { name: 'Remove their own credentials?' });
        expect(confirm).toHaveTextContent('web-2');
        expect(confirm).not.toHaveTextContent('Not checked');
        await user.click(within(confirm).getByRole('button', { name: 'Remove and save' }));
        await waitFor(() => expect(calls.at(-1)).toMatchObject({ path: '/api/identities/assign', body: { identityId: 1, serverIds: [11], clearOwnCredentials: true } }));
    });

    it('assigns from the card menu keeping the servers\' own credentials unless asked, and names the unchecked ones', async () => {
        const calls = backend();
        const user = renderKeychain();
        await screen.findByRole('list', { name: 'Saved identities' });
        await user.click(screen.getByRole('button', { name: 'More actions for deploy' }));
        await user.click(screen.getByRole('menuitem', { name: 'Use on servers…' }));
        const assign = screen.getByRole('dialog', { name: 'Use deploy on servers' });
        const clearOwn = within(assign).getByRole('checkbox', { name: /Remove the own password and key/ });
        expect(clearOwn).not.toBeChecked();

        // web-1 (which only had the identity) is unticked, web-2 ticked.
        await user.click(within(assign).getByRole('checkbox', { name: /web-1/ }));
        expect(within(assign).getByText(/web-1 has no password or key of its own/)).toBeInTheDocument();
        await user.click(within(assign).getByRole('checkbox', { name: /web-2/ }));
        await user.click(clearOwn);
        expect(within(assign).getByText(/has not checked that "deploy" signs in to web-2/)).toBeInTheDocument();

        // Cancelling the confirmation saves nothing.
        await user.click(within(assign).getByRole('button', { name: 'Save' }));
        const confirm = screen.getByRole('alertdialog', { name: 'Remove their own credentials?' });
        expect(confirm).toHaveTextContent('Not checked: ShellMind has not verified that "deploy" signs in to web-2.');
        await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
        expect(calls).toEqual([]);

        await user.click(clearOwn);
        await user.click(within(assign).getByRole('button', { name: 'Save' }));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        await waitFor(() => expect(calls).toEqual([
            { method: 'POST', path: '/api/identities/assign', body: { identityId: 1, serverIds: [11], clearOwnCredentials: false } },
            { method: 'POST', path: '/api/identities/assign', body: { identityId: null, serverIds: [10] } },
        ]));
    });

    it('keeps a stored key\'s passphrase, and shows a refused key even without a key field', async () => {
        const calls = backend({ identities: [{ ...DEPLOY, has_passphrase: 1 }], update: () => json(400, { error: 'The private key is encrypted and the passphrase is missing or wrong.', code: 'INVALID_PRIVATE_KEY', details: { field: 'privateKey' } }) });
        const user = renderKeychain();
        await user.click(await screen.findByRole('button', { name: 'Edit deploy' }));
        const editor = screen.getByRole('dialog', { name: 'Edit identity' });
        expect(within(editor).getByRole('radio', { name: 'Current', checked: true })).toBeInTheDocument();
        expect(within(editor).getByText('Passphrase saved')).toBeInTheDocument();
        expect(within(editor).queryByLabelText(/Key passphrase/)).toBeNull();

        // A key file whose stored key the backend refuses: the alert says so.
        await user.click(within(editor).getByRole('radio', { name: 'File' }));
        await user.type(within(editor).getByLabelText(/^Private key file/), '~/.ssh/id_ed25519');
        await user.click(within(editor).getByRole('button', { name: 'Save changes' }));
        expect(await within(editor).findByRole('alert')).toHaveTextContent('This private key cannot be read: check the key and its passphrase.');
        expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: '/api/identities/1', body: { private_key_path: '~/.ssh/id_ed25519', clear_private_key: true } });
    });

    it('rotates to a key without a passphrase when asked (blank keeps the current one)', async () => {
        const calls = backend({ identities: [{ ...DEPLOY, has_passphrase: 1 }] });
        const user = renderKeychain();
        await screen.findByRole('list', { name: 'Saved identities' });
        await user.click(screen.getByRole('button', { name: 'More actions for deploy' }));
        await user.click(screen.getByRole('menuitem', { name: 'Rotate key…' }));
        const dialog = screen.getByRole('dialog', { name: 'Rotate the key of deploy' });
        await user.click(within(dialog).getByRole('checkbox', { name: 'Store the new key without a passphrase' }));
        expect(within(dialog).getByLabelText(/Passphrase of the new key/)).toBeDisabled();
        await user.click(within(dialog).getByRole('button', { name: 'Rotate key' }));
        expect(await within(dialog).findByText('SHA256:new')).toBeInTheDocument();
        expect(calls.find((call) => call.path === '/api/identities/1/rotate')?.body).toEqual({ passphrase: '', force: false, removeOld: true });
    });

    // SEC-6: the previous key leaves the servers' authorized_keys by default.
    it('takes the previous key off the servers unless told not to, and names where it could not', async () => {
        const calls = backend({
            rotate: () => sse([
                { type: 'start', servers: [{ serverId: 10, name: 'web-1' }, { serverId: 11, name: 'web-2' }], fingerprint: 'SHA256:new' },
                { type: 'result', result: { serverId: 10, name: 'web-1', status: 'installed', verified: true } },
                { type: 'result', result: { serverId: 11, name: 'web-2', status: 'installed', verified: true } },
                { type: 'rotated', replaced: true, fingerprint: 'SHA256:new' },
                { type: 'removed', result: { serverId: 10, status: 'removed', removed: 1 } },
                { type: 'removed', result: { serverId: 11, status: 'failed', errorCode: 'OPS_PERMISSION_DENIED', error: 'Permission denied' } },
                { type: 'done', cancelled: false },
            ]),
        });
        const user = renderKeychain();
        await screen.findByRole('list', { name: 'Saved identities' });
        await user.click(screen.getByRole('button', { name: 'More actions for deploy' }));
        await user.click(screen.getByRole('menuitem', { name: 'Rotate key…' }));
        const dialog = screen.getByRole('dialog', { name: 'Rotate the key of deploy' });
        const removeOld = within(dialog).getByRole('checkbox', { name: /Remove the previous key from these servers/ });
        expect(removeOld).toBeChecked();
        await user.click(removeOld);
        expect(within(dialog).getByText(/The previous key stays in their authorized_keys/)).toBeInTheDocument();
        await user.click(removeOld);
        await user.click(within(dialog).getByRole('button', { name: 'Rotate key' }));
        expect(await within(dialog).findByText('Previous key removed')).toBeInTheDocument();
        expect(within(dialog).getByText(/The previous key could not be removed: it still signs in here./)).toBeInTheDocument();
        expect(within(dialog).getByText('The previous key is still in the authorized_keys of 1 server: remove it there by hand.')).toBeInTheDocument();
        expect(calls.find((call) => call.path === '/api/identities/1/rotate')?.body).toEqual({ force: false, removeOld: true });
    });

    it('words install failures and agent errors in the user\'s language', async () => {
        setLanguage('es');
        backend({
            agent: { available: false, source: 'pageant', error: 'Pageant is not running', errorCode: 'not-running' },
            install: () => sse([
                { type: 'start', servers: [{ serverId: 10, name: 'web-1' }, { serverId: 11, name: 'web-2' }], fingerprint: 'SHA256:deployFingerprint' },
                { type: 'result', result: { serverId: 10, name: 'web-1', status: 'failed', errorCode: 'ECONNREFUSED', error: 'connect ECONNREFUSED 10.0.0.1:22' } },
                { type: 'result', result: { serverId: 11, name: 'web-2', status: 'installed', verified: false, errorCode: 'AUTH_FAILED', error: 'All configured authentication methods failed' } },
                { type: 'done', cancelled: false },
            ]),
        });
        const user = renderKeychain();
        expect(await screen.findByText(/^Pageant no se está ejecutando\./)).toBeInTheDocument();
        await user.click(await screen.findByRole('button', { name: 'Instalar clave: deploy' }));
        const dialog = screen.getByRole('dialog', { name: 'Instalar la clave de deploy' });
        await user.click(within(dialog).getByRole('checkbox', { name: /web-2/ }));
        await user.click(within(dialog).getByRole('button', { name: 'Instalar en 2 servidores' }));
        expect(await within(dialog).findByText('El servidor ha rechazado la conexión: no hay nada escuchando en ese puerto.')).toBeInTheDocument();
        expect(within(dialog).getByText(/^sshd no ha aceptado la clave por sí sola/)).toBeInTheDocument();
        expect(within(dialog).queryByText(/ECONNREFUSED|authentication methods/)).toBeNull();
    });

    it('is translated', async () => {
        setLanguage('es');
        backend();
        renderKeychain();
        expect(await screen.findByRole('list', { name: 'Identidades guardadas' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Nueva identidad' })).toBeInTheDocument();
        expect(await screen.findByText('1 clave disponible · mediante Agente OpenSSH de Windows')).toBeInTheDocument();
    });
});
