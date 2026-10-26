import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ServerHostKey } from '@shared/tunnels';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import { HostKeyCard } from './HostKeyCard';

const SERVER: WorkspaceServer = { id: 4, name: 'web-1', ip: '10.0.0.5', type: 'linux', port: 2222 };

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PINNED: ServerHostKey = {
    host: '10.0.0.5',
    port: 2222,
    knownHost: { id: 12, host: '10.0.0.5', port: 2222, key_type: 'ssh-ed25519', fingerprint: 'SHA256:pinnedKey', created_at: Date.UTC(2026, 3, 2, 9, 30) },
};

function backend() {
    let pinned = true;
    const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
        const path = new URL(input).pathname;
        if (path === '/api/servers/4/host-key') return json(200, { data: pinned ? PINNED : { ...PINNED, knownHost: null } });
        if (path === '/api/known-hosts/12' && init.method === 'DELETE') {
            pinned = false;
            return json(200, { message: 'deleted' });
        }
        return json(404, { error: 'not found' });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

function renderCard() {
    render(
        <ToastProvider>
            <ConfirmProvider>
                <HostKeyCard server={SERVER} isActive />
            </ConfirmProvider>
        </ToastProvider>
    );
}

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('HostKeyCard', () => {
    it('shows the pinned key of the server and forgets it after confirmation', async () => {
        backend();
        renderCard();

        const card = await screen.findByRole('region', { name: 'Host key' });
        expect(await screen.findByText('SHA256:pinnedKey')).toBeInTheDocument();
        expect(card).toHaveTextContent('ssh-ed25519');
        expect(card).toHaveTextContent('The key 10.0.0.5:2222 presented the first time ShellMind connected.');

        fireEvent.click(screen.getByRole('button', { name: 'Forget the host key of 10.0.0.5:2222' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Forget key' }));

        expect(await screen.findByText(/No key saved for 10.0.0.5:2222 yet/)).toBeInTheDocument();
        expect(screen.queryByText('SHA256:pinnedKey')).toBeNull();
    });

    it('opens the list of every known host and reads the key again when it closes', async () => {
        const fetchMock = backend();
        renderCard();
        await screen.findByText('SHA256:pinnedKey');
        const reads = () => fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/host-key')).length;
        const before = reads();

        fireEvent.click(screen.getByRole('button', { name: 'All known hosts' }));
        expect(useAppStore.getState().activeActionId).toBe('known-hosts');

        act(() => useAppStore.getState().closeAction());
        await screen.findByText('SHA256:pinnedKey');
        expect(reads()).toBeGreaterThan(before);
    });
});
