import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { KnownHost, ServerSummary } from '@shared/types';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { resetServersStore } from '@/store/servers';
import { KnownHostsDialog } from './KnownHostsDialog';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const HOSTS: KnownHost[] = [
    { id: 1, host: '10.0.0.5', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:aaaaWebKey', created_at: Date.UTC(2026, 3, 2, 9, 30) },
    { id: 2, host: 'bastion.example.com', port: 2222, key_type: 'ssh-rsa', fingerprint: 'SHA256:bbbbBastion', created_at: Date.UTC(2026, 4, 5, 18, 0) },
];

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux' },
    { id: 2, name: 'jump', ip: 'bastion.example.com', type: 'windows', port: 3389, ssh_port: 2222 },
    { id: 3, name: 'ftp', ip: '10.0.0.5', type: 'ftp', port: 22 },
];

function backend(options: { hosts?: () => Response; servers?: ServerSummary[] } = {}) {
    let hosts = [...HOSTS];
    const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
        const path = new URL(input).pathname;
        const method = init.method ?? 'GET';
        if (method === 'GET' && path === '/api/known-hosts') return options.hosts?.() ?? json(200, { data: hosts });
        if (method === 'GET' && path === '/api/servers') return json(200, { message: 'success', data: options.servers ?? SERVERS });
        const forget = /^\/api\/known-hosts\/(\d+)$/.exec(path);
        if (method === 'DELETE' && forget) {
            hosts = hosts.filter((host) => host.id !== Number(forget[1]));
            return json(200, { message: 'deleted' });
        }
        return json(404, { error: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function renderDialog(onClose = vi.fn()) {
    render(
        <ToastProvider>
            <ConfirmProvider>
                <KnownHostsDialog onClose={onClose} server={null} />
            </ConfirmProvider>
        </ToastProvider>
    );
    return onClose;
}

beforeEach(() => {
    setLanguage('en');
    resetServersStore();
});
afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('KnownHostsDialog', () => {
    it('lists every pinned key with the servers that use it', async () => {
        backend();
        renderDialog();

        expect(screen.getByRole('searchbox', { name: 'Search known hosts' })).toHaveFocus();
        const list = await screen.findByRole('list', { name: 'Saved host keys' });
        const [web, bastion] = within(list).getAllByRole('listitem');
        expect(web).toHaveTextContent('10.0.0.5:22');
        expect(web).toHaveTextContent('ssh-ed25519');
        expect(web).toHaveTextContent('SHA256:aaaaWebKey');
        await waitFor(() => expect(web).toHaveTextContent('Used by web-1'));
        expect(bastion).toHaveTextContent('bastion.example.com:2222');
        expect(bastion).toHaveTextContent('Used by jump');
        expect(screen.getByRole('status')).toHaveTextContent('2 of 2');
    });

    // BC-02: a key is pinned per host, port and jump route.
    it('names the jump route of each pin and the servers that reach the host through it', async () => {
        const seen = Date.UTC(2026, 5, 1, 8, 0);
        const pins: KnownHost[] = [
            { id: 7, host: '10.0.0.9', port: 22, via: '', key_type: 'ssh-ed25519', fingerprint: 'SHA256:direct', created_at: seen },
            { id: 8, host: '10.0.0.9', port: 22, via: 'bastion.example.com:2222', key_type: 'ssh-ed25519', fingerprint: 'SHA256:jumped', created_at: seen },
            { id: 9, host: '10.0.0.10', port: 22, via: 'bastion.example.com:2222>10.0.0.9:22', key_type: 'ssh-ed25519', fingerprint: 'SHA256:deep', created_at: seen },
        ];
        backend({
            hosts: () => json(200, { data: pins }),
            servers: [
                ...SERVERS,
                { id: 4, name: 'db-direct', ip: '10.0.0.9', type: 'linux' },
                { id: 5, name: 'db-behind', ip: '10.0.0.9', type: 'linux', jump_server_id: 2 },
                { id: 6, name: 'deep', ip: '10.0.0.10', type: 'linux', jump_server_id: 5 },
            ],
        });
        renderDialog();
        const list = await screen.findByRole('list', { name: 'Saved host keys' });
        const [direct, jumped, deep] = within(list).getAllByRole('listitem');
        await waitFor(() => expect(direct).toHaveTextContent('Used by db-direct'));
        expect(direct).not.toHaveTextContent('via');
        expect(jumped).toHaveTextContent('10.0.0.9:22via bastion.example.com:2222');
        expect(jumped).toHaveTextContent('Used by db-behind');
        expect(deep).toHaveTextContent('via bastion.example.com:2222 → 10.0.0.9:22');
        expect(deep).toHaveTextContent('Used by deep');
        // Two pins of one address stay apart wherever they are named.
        expect(within(jumped).getByRole('button', { name: 'Forget the host key of 10.0.0.9:22 via bastion.example.com:2222' })).toBeInTheDocument();
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search known hosts' }), { target: { value: 'bastion' } });
        expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    });

    it('searches by address, fingerprint and server name', async () => {
        backend();
        renderDialog();
        await screen.findByRole('list', { name: 'Saved host keys' });
        await waitFor(() => expect(screen.getByText(/Used by jump/)).toBeInTheDocument());
        const search = screen.getByRole('searchbox', { name: 'Search known hosts' });

        fireEvent.change(search, { target: { value: 'bbbb' } });
        expect(within(screen.getByRole('list', { name: 'Saved host keys' })).getAllByRole('listitem')).toHaveLength(1);
        expect(screen.getByRole('status')).toHaveTextContent('1 of 2');

        fireEvent.change(search, { target: { value: 'WEB-1' } });
        expect(screen.getByRole('list', { name: 'Saved host keys' })).toHaveTextContent('10.0.0.5:22');

        fireEvent.change(search, { target: { value: 'nothing-like-this' } });
        expect(screen.queryByRole('list', { name: 'Saved host keys' })).toBeNull();
        expect(screen.getByText('No known hosts match "nothing-like-this".')).toBeInTheDocument();
    });

    it('forgets a key after confirmation', async () => {
        const fetchMock = backend();
        renderDialog();
        await screen.findByRole('list', { name: 'Saved host keys' });

        fireEvent.click(screen.getByRole('button', { name: 'Forget the host key of bastion.example.com:2222' }));
        expect(await screen.findByText('Forget this host key?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Forget key' }));

        expect(await screen.findByText('Host key of bastion.example.com:2222 forgotten')).toBeInTheDocument();
        expect(within(screen.getByRole('list', { name: 'Saved host keys' })).getAllByRole('listitem')).toHaveLength(1);
        expect(fetchMock.mock.calls.some(([url, init]) => init?.method === 'DELETE' && String(url).endsWith('/api/known-hosts/2'))).toBe(true);
    });

    it('keeps the key when the confirmation is declined', async () => {
        const fetchMock = backend();
        renderDialog();
        await screen.findByRole('list', { name: 'Saved host keys' });

        fireEvent.click(screen.getByRole('button', { name: 'Forget the host key of 10.0.0.5:22' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByText('Forget this host key?')).toBeNull());
        expect(within(screen.getByRole('list', { name: 'Saved host keys' })).getAllByRole('listitem')).toHaveLength(2);
        expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    });

    it('shows the empty state, and a load error with a retry', async () => {
        let fail = true;
        backend({ hosts: () => (fail ? json(500, { error: 'boom' }) : json(200, { data: [] })) });
        renderDialog();

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not load the known hosts. boom');
        fail = false;
        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText(/No host keys saved yet/)).toBeInTheDocument();
    });

    it('closes with Escape', async () => {
        backend();
        const onClose = renderDialog();
        await screen.findByRole('list');
        fireEvent.keyDown(window, { key: 'Escape' });
        expect(onClose).toHaveBeenCalled();
    });
});
