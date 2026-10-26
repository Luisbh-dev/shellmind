import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { setLanguage } from '@/i18n';
import { io } from 'socket.io-client';
import { api, captureLaunchParams, getAuthToken, setAuthToken } from '@/lib/api';
import { reconnectRefusedSockets } from '@/lib/refusedSockets';
import { createSocket } from '@/lib/socket';
import { AccessGate } from './AccessGate';

vi.mock('@/lib/refusedSockets', () => ({ reconnectRefusedSockets: vi.fn(() => 0), markRefused: vi.fn(), clearRefused: vi.fn() }));

// A socket.io client socket that only keeps its listeners and its options.
type SocketOptions = { auth: (cb: (data: object) => void) => void };
const sockets: Array<{ options: SocketOptions; fire: (event: string, ...args: unknown[]) => void }> = [];
vi.mock('socket.io-client', () => ({
    io: vi.fn((_url: string, options: SocketOptions) => {
        const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
        const socket = {
            on: (event: string, listener: (...args: unknown[]) => void) => {
                listeners.set(event, [...(listeners.get(event) ?? []), listener]);
                return socket;
            },
            connect: vi.fn(),
            disconnect: vi.fn()
        };
        sockets.push({ options, fire: (event, ...args) => listeners.get(event)?.forEach((listener) => listener(...args)) });
        return socket;
    })
}));

const VALID_TOKEN = 'good-token';

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// A fake backend: down for the first `downFor` health polls, then up and
// accepting the tokens in `accepted` (VALID_TOKEN by default; the array may be
// changed while the test runs).
function fakeBackend({ downFor = 0, health = 200, accepted = [VALID_TOKEN] }: { downFor?: number; health?: number; accepted?: string[] } = {}) {
    let polls = 0;
    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
        const headers = (init.headers ?? {}) as Record<string, string>;
        if (url.endsWith('/api/health')) {
            polls += 1;
            if (polls <= downFor) throw new TypeError('fetch failed');
            return health === 200 ? json(200, { ok: true, version: '1.0.0' }) : json(health, { error: 'Host not allowed' });
        }
        if (!accepted.some((token) => headers.Authorization === `Bearer ${token}`)) {
            return json(401, { error: 'Authentication required' });
        }
        return json(200, url.endsWith('/api/session') ? { authenticated: true } : {});
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const sentTokens = (fetchMock: ReturnType<typeof fakeBackend>) =>
    fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith('/api/session'))
        .map(([, init]) => ((init?.headers ?? {}) as Record<string, string>).Authorization);

const noDelay = () => 0;

function renderGate() {
    return render(
        <AccessGate retryDelay={noDelay}>
            <div>workspace</div>
        </AccessGate>
    );
}

beforeEach(() => {
    setLanguage('en');
    vi.mocked(reconnectRefusedSockets).mockClear();
    sessionStorage.clear();
    localStorage.clear();
    document.head.querySelectorAll('meta[name="shellmind-dev-session"]').forEach((meta) => meta.remove());
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('AccessGate', () => {
    it('shows a splash while the backend starts, then the app once the token is accepted', async () => {
        setAuthToken(VALID_TOKEN, { remember: false });
        const fetchMock = fakeBackend({ downFor: 3 });

        renderGate();

        expect(screen.getByRole('status')).toHaveTextContent('Starting backend…');
        expect(await screen.findByText('workspace')).toBeInTheDocument();
        const healthPolls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/health'));
        expect(healthPolls).toHaveLength(4);
    });

    it('asks for the access token, rejects a wrong one and remembers a right one on request', async () => {
        fakeBackend();
        renderGate();

        const input = await screen.findByLabelText('Access token');
        expect(screen.queryByRole('alert')).toBeNull();

        fireEvent.change(input, { target: { value: 'wrong' } });
        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('That token was not accepted.');
        expect(sessionStorage.getItem('shellmind.token')).toBeNull();

        fireEvent.change(input, { target: { value: ` ${VALID_TOKEN} ` } });
        fireEvent.click(screen.getByLabelText(/Remember on this device/));
        fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));

        expect(await screen.findByText('workspace')).toBeInTheDocument();
        expect(localStorage.getItem('shellmind.token')).toBe(VALID_TOKEN);
    });

    it('drops a stored token the backend no longer accepts', async () => {
        setAuthToken('stale', { remember: true });
        fakeBackend();
        renderGate();

        expect(await screen.findByRole('alert')).toHaveTextContent('The access token is no longer valid.');
        expect(localStorage.getItem('shellmind.token')).toBeNull();
    });

    it('keeps the remembered token when a token from a crafted link is refused', async () => {
        setAuthToken(VALID_TOKEN, { remember: true });
        window.history.replaceState(null, '', '/?token=crafted');
        captureLaunchParams();
        const fetchMock = fakeBackend();
        renderGate();

        expect(await screen.findByText('workspace')).toBeInTheDocument();
        expect(sentTokens(fetchMock)).toEqual(['Bearer crafted', `Bearer ${VALID_TOKEN}`]);
        expect(localStorage.getItem('shellmind.token')).toBe(VALID_TOKEN);
        expect(sessionStorage.getItem('shellmind.token')).toBeNull();
    });

    it('falls back to the dev server session when a token typed earlier is refused', async () => {
        const meta = document.createElement('meta');
        meta.name = 'shellmind-dev-session';
        meta.content = JSON.stringify({ token: VALID_TOKEN });
        document.head.append(meta);
        setAuthToken('typed-for-an-older-run', { remember: false });
        const fetchMock = fakeBackend();
        renderGate();

        expect(await screen.findByText('workspace')).toBeInTheDocument();
        expect(sentTokens(fetchMock)).toEqual(['Bearer typed-for-an-older-run', `Bearer ${VALID_TOKEN}`]);
    });

    it('asks for the token over the running app when a later request is refused, and keeps its state', async () => {
        setAuthToken(VALID_TOKEN, { remember: false });
        const accepted = [VALID_TOKEN];
        fakeBackend({ accepted });
        // Unsaved work of the app: it must survive the expiry.
        function Workspace() {
            const [draft, setDraft] = useState('');
            return <input aria-label="unsaved draft" value={draft} onChange={(event) => setDraft(event.target.value)} />;
        }
        const root = document.createElement('div');
        root.id = 'root';
        document.body.append(root);
        render(<AccessGate retryDelay={noDelay}><Workspace /></AccessGate>, { container: root });
        const draft = await screen.findByRole('textbox', { name: 'unsaved draft' });
        fireEvent.change(draft, { target: { value: 'half-edited /etc/hosts' } });
        draft.focus();

        // The backend restarted with another token.
        accepted.splice(0, 1, 'rotated');
        await act(async () => {
            await api.get('/api/servers').catch(() => {});
        });

        const gate = screen.getByRole('dialog', { name: 'Access token required' });
        expect(within(gate).getByLabelText('Access token')).toHaveFocus();
        expect(within(gate).getByRole('alert')).toHaveTextContent('The access token is no longer valid.');
        expect(gate).toHaveTextContent('Everything you had open stays as it is');
        expect(root).toHaveAttribute('inert');
        expect(sessionStorage.getItem('shellmind.token')).toBeNull();

        fireEvent.change(within(gate).getByLabelText('Access token'), { target: { value: 'rotated' } });
        fireEvent.click(within(gate).getByRole('button', { name: 'Unlock' }));

        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(screen.getByRole('textbox', { name: 'unsaved draft' })).toBe(draft);
        expect(draft).toHaveValue('half-edited /etc/hosts');
        expect(draft).toHaveFocus();
        expect(root).not.toHaveAttribute('inert');
        expect(vi.mocked(reconnectRefusedSockets)).toHaveBeenCalledTimes(1);
        root.remove();
    });

    // A terminal reconnecting after the backend restarted with another token
    // may be all that talks to the backend: no HTTP request gets the 401.
    it('asks for the token over the running app when a socket is refused for it, then reconnects it', async () => {
        setAuthToken(VALID_TOKEN, { remember: false });
        const accepted = [VALID_TOKEN];
        fakeBackend({ accepted });
        renderGate();
        await screen.findByText('workspace');
        createSocket();
        const socket = sockets[sockets.length - 1];
        expect(vi.mocked(io)).toHaveBeenCalled();

        accepted.splice(0, 1, 'rotated');
        act(() => {
            socket.options.auth(() => undefined);
            socket.fire('connect_error', new Error('unauthorized'));
        });

        const gate = await screen.findByRole('dialog', { name: 'Access token required' });
        expect(screen.getByText('workspace')).toBeInTheDocument();
        fireEvent.change(within(gate).getByLabelText('Access token'), { target: { value: 'rotated' } });
        fireEvent.click(within(gate).getByRole('button', { name: 'Unlock' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(vi.mocked(reconnectRefusedSockets)).toHaveBeenCalledTimes(1);
    });

    it('switches to another stored token when a later request is refused', async () => {
        const accepted = ['launch', VALID_TOKEN];
        setAuthToken(VALID_TOKEN, { remember: true });
        sessionStorage.setItem('shellmind.token', 'launch');
        fakeBackend({ accepted });
        renderGate();
        await screen.findByText('workspace');

        accepted.shift();
        await act(async () => {
            await api.get('/api/servers').catch(() => {});
        });

        expect(await screen.findByText('workspace')).toBeInTheDocument();
        expect(getAuthToken()).toBe(VALID_TOKEN);
    });

    it('ignores a refusal of a token that is no longer in use', async () => {
        setAuthToken(VALID_TOKEN, { remember: false });
        fakeBackend();
        renderGate();
        await screen.findByText('workspace');

        await act(async () => {
            await api.get('/api/servers', { token: 'old' }).catch(() => {});
        });

        expect(screen.getByText('workspace')).toBeInTheDocument();
        expect(getAuthToken()).toBe(VALID_TOKEN);
    });

    it('explains a refused Host/Origin instead of retrying forever', async () => {
        fakeBackend({ health: 403 });
        renderGate();

        expect(await screen.findByText('The backend refused this page: Host not allowed.')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    });

    it('offers to retry and shows the backend address after repeated failures', async () => {
        fakeBackend({ downFor: Number.POSITIVE_INFINITY });
        render(
            <AccessGate retryDelay={(attempt) => (attempt < 6 ? 0 : 60_000)}>
                <div>workspace</div>
            </AccessGate>
        );

        expect(await screen.findByText(/Still waiting for the backend at http:\/\/127\.0\.0\.1:3001/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry now' })).toBeInTheDocument();
    });
});
