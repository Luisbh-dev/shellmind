import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ServerHostKey, TunnelStatus, TunnelView } from '@shared/tunnels';
import { ConfirmProvider, ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import type { WorkspaceServer } from '@/workspace/types';
import TunnelsPanel from './TunnelsPanel';

const SERVER: WorkspaceServer = { id: 1, name: 'db-1', ip: '10.0.0.5', type: 'linux' };

const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const status = (overrides: Partial<TunnelStatus> = {}): TunnelStatus => ({
    state: 'stopped', activeConnections: 0, totalConnections: 0, bytesOut: 0, bytesIn: 0, startedAt: null, lastError: null, ...overrides,
});

const tunnel = (overrides: Partial<TunnelView> = {}): TunnelView => ({
    id: 7,
    server_id: 1,
    name: 'Prod DB',
    local_host: '127.0.0.1',
    local_port: 15432,
    remote_host: '127.0.0.1',
    remote_port: 5432,
    auto_start: false,
    created_at: 0,
    status: status(),
    ...overrides,
});

const HOST_KEY: ServerHostKey = { host: '10.0.0.5', port: 22, knownHost: null };

type Handler = (init: RequestInit) => Response | Promise<Response>;

// A fake backend answering "METHOD /path" routes; unknown routes are 404s.
function backend(routes: Record<string, Handler>) {
    const fetchMock = vi.fn(async (input: string, init: RequestInit = {}) => {
        const key = `${init.method ?? 'GET'} ${new URL(input).pathname}`;
        const handler = routes[key] ?? routes[`${init.method ?? 'GET'} *`];
        return handler ? handler(init) : json(404, { error: `no route for ${key}` });
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof backend>, method: string, path: string) =>
    fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && new URL(url).pathname === path);

function renderPanel() {
    return render(
        <ToastProvider>
            <ConfirmProvider>
                <TunnelsPanel server={SERVER} isActive />
            </ConfirmProvider>
        </ToastProvider>
    );
}

beforeEach(() => {
    setLanguage('en');
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('TunnelsPanel', () => {
    it('lists tunnels with their route, live counters and explained errors', async () => {
        backend({
            'GET /api/servers/1/tunnels': () => json(200, { message: 'success', data: [
                tunnel({ status: status({ state: 'listening', activeConnections: 2, totalConnections: 5, bytesIn: 1536, bytesOut: 300, startedAt: 1 }) }),
                tunnel({
                    id: 8, name: null, local_port: 10080, remote_port: 80, auto_start: true, local_host: '0.0.0.0',
                    status: status({ state: 'error', lastError: { code: 'PORT_IN_USE', message: '0.0.0.0:10080 is already in use', at: Date.UTC(2026, 0, 1, 10, 0, 0) } }),
                }),
            ] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
        });
        renderPanel();

        const list = await screen.findByRole('list', { name: 'Tunnels of db-1' });
        const [db, web] = within(list).getAllByRole('listitem');

        expect(within(db).getByRole('heading', { name: 'Prod DB' })).toBeInTheDocument();
        expect(db).toHaveTextContent('Listening');
        expect(db).toHaveTextContent('From 127.0.0.1:15432 on this computer to 127.0.0.1:5432 as seen from the server');
        expect(db).toHaveTextContent('2 open · 5 total');
        expect(db).toHaveTextContent('Received 1.5 KB');
        expect(db).toHaveTextContent('Sent 300 B');
        expect(within(db).getByRole('switch', { name: 'Run tunnel Prod DB' })).toHaveAttribute('aria-checked', 'true');

        // Unnamed: named after the service; exposed on the network; auto-started.
        expect(within(web).getByRole('heading', { name: 'HTTP' })).toBeInTheDocument();
        expect(web).toHaveTextContent('Failed');
        expect(web).toHaveTextContent('Auto-start');
        expect(web).toHaveTextContent('Network');
        expect(web).toHaveTextContent('Local port 10080 is already in use.');
        expect(within(web).getByRole('switch', { name: 'Run tunnel HTTP' })).toHaveAttribute('aria-checked', 'false');
    });

    it('starts a tunnel from its switch and reports a port that is already taken', async () => {
        let started = false;
        const fetchMock = backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [tunnel({ status: status({ state: started ? 'listening' : 'stopped' }) })] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'POST /api/tunnels/7/start': () => {
                started = true;
                return json(200, { data: tunnel({ status: status({ state: 'listening', startedAt: 1 }) }) });
            },
            'POST /api/tunnels/7/stop': () => json(409, { error: 'nope' }),
        });
        renderPanel();

        fireEvent.click(await screen.findByRole('switch', { name: 'Run tunnel Prod DB' }));
        expect(await screen.findByText('Tunnel listening on 127.0.0.1:15432')).toBeInTheDocument();
        expect(calls(fetchMock, 'POST', '/api/tunnels/7/start')).toHaveLength(1);
        await waitFor(() => expect(screen.getByRole('switch', { name: 'Run tunnel Prod DB' })).toHaveAttribute('aria-checked', 'true'));

        fireEvent.click(screen.getByRole('switch', { name: 'Run tunnel Prod DB' }));
        expect(await screen.findByText('Tunnel Prod DB could not be stopped')).toBeInTheDocument();
    });

    it('shows a start in flight right away and keeps the keyboard focus on the switch', async () => {
        let answer!: (response: Response) => void;
        const fetchMock = backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [tunnel()] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'POST /api/tunnels/7/start': () => new Promise<Response>((resolve) => { answer = resolve; }),
        });
        renderPanel();

        const toggle = await screen.findByRole('switch', { name: 'Run tunnel Prod DB' });
        toggle.focus();
        fireEvent.click(toggle);
        const card = screen.getByRole('listitem');
        await waitFor(() => expect(card).toHaveTextContent('Starting…'));
        expect(toggle).toHaveFocus();
        expect(toggle).toHaveAttribute('aria-checked', 'true');
        expect(toggle).toHaveAttribute('aria-disabled', 'true');
        expect(toggle).toHaveAttribute('aria-busy', 'true');
        // Busy: a second press does not send another request.
        fireEvent.click(toggle);
        expect(calls(fetchMock, 'POST', '/api/tunnels/7/start')).toHaveLength(1);

        // Edited meanwhile: the form knows the tunnel is on its way up and restarts it.
        fireEvent.click(screen.getByRole('button', { name: 'Edit tunnel Prod DB' }));
        expect(screen.getByText('This tunnel is running: it restarts with the new settings.')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Save and start' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        toggle.focus();

        answer(json(200, { data: tunnel({ status: status({ state: 'listening', startedAt: 1 }) }) }));
        expect(await screen.findByText('Tunnel listening on 127.0.0.1:15432')).toBeInTheDocument();
        expect(toggle).not.toHaveAttribute('aria-disabled');
        expect(toggle).toHaveFocus();
    });

    it('reports a start cancelled meanwhile as information, and never claims a tunnel that does not listen', async () => {
        let cancel = true;
        backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [tunnel()] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'POST /api/tunnels/7/start': () => (cancel
                ? json(409, { error: 'The start of … was cancelled', code: 'TUNNEL_START_CANCELLED' })
                : json(200, { data: tunnel({ status: status({ state: 'stopped' }) }) })),
        });
        renderPanel();

        fireEvent.click(await screen.findByRole('switch', { name: 'Run tunnel Prod DB' }));
        expect(await screen.findByText('Start of tunnel Prod DB cancelled')).toBeInTheDocument();
        expect(screen.getByText('The tunnel was stopped or its settings changed while it was starting.')).toBeInTheDocument();
        expect(screen.queryByText('Tunnel Prod DB could not start')).toBeNull();

        cancel = false;
        const toggle = screen.getByRole('switch', { name: 'Run tunnel Prod DB' });
        await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
        fireEvent.click(toggle);
        await waitFor(() => expect(toggle).not.toHaveAttribute('aria-disabled'));
        expect(screen.queryByText(/Tunnel listening on/)).toBeNull();
    });

    it('warns when an edit restarts a running tunnel into an error', async () => {
        const running = tunnel({ status: status({ state: 'listening', startedAt: 1 }) });
        const failed = tunnel({
            local_port: 16379,
            status: status({
                state: 'error',
                lastError: { code: 'PORT_IN_USE', message: '127.0.0.1:16379 is already used by the tunnel "Redis".', at: 1, details: { host: '127.0.0.1', port: 16379, tunnelId: 9, tunnelName: 'Redis' } },
            }),
        });
        const fetchMock = backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [calls(fetchMock, 'PUT', '/api/tunnels/7').length ? failed : running] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'PUT /api/tunnels/7': () => json(200, { data: failed }),
        });
        renderPanel();

        fireEvent.click(await screen.findByRole('button', { name: 'Edit tunnel Prod DB' }));
        fireEvent.change(screen.getByLabelText('Local port'), { target: { value: '16379' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save' }));

        expect(await screen.findByText('Tunnel Prod DB was saved but could not restart')).toBeInTheDocument();
        expect(screen.queryByText('Tunnel Prod DB saved')).toBeNull();
        // In the toast and on the card: the tunnel holding the port is named.
        expect(screen.getAllByText(/Local port 16379 is already used by the tunnel “Redis”/).length).toBeGreaterThanOrEqual(2);
    });

    it('explains a failed start in the toast', async () => {
        backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [tunnel()] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'POST /api/tunnels/7/start': () => json(409, { error: '127.0.0.1:15432 is already in use by another program.', code: 'PORT_IN_USE' }),
        });
        renderPanel();

        fireEvent.click(await screen.findByRole('switch', { name: 'Run tunnel Prod DB' }));
        expect(await screen.findByText('Tunnel Prod DB could not start')).toBeInTheDocument();
        expect(screen.getByText(/Local port 15432 is already in use/)).toBeInTheDocument();
    });

    it('copies the local address and opens web tunnels in the browser', async () => {
        const writeText = vi.fn(async () => undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        const open = vi.spyOn(window, 'open').mockImplementation(() => null);
        backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [
                tunnel({ id: 9, name: 'Grafana', local_host: '0.0.0.0', local_port: 13000, remote_port: 3000, status: status({ state: 'listening' }) }),
                tunnel({ id: 10, name: 'Postgres', status: status({ state: 'listening' }) }),
            ] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
        });
        renderPanel();

        // A wildcard listener is reached on loopback.
        fireEvent.click(await screen.findByRole('button', { name: 'Copy local address 127.0.0.1:13000' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('127.0.0.1:13000'));
        expect(await screen.findByText('Copied 127.0.0.1:13000')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Open http://127.0.0.1:13000/ in the browser' }));
        expect(open).toHaveBeenCalledWith('http://127.0.0.1:13000/', '_blank', 'noopener,noreferrer');
        // Not a web service: nothing to open.
        expect(screen.getAllByRole('button', { name: /in the browser/ })).toHaveLength(1);
    });

    it('deletes a tunnel after confirmation', async () => {
        const fetchMock = backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: calls(fetchMock, 'DELETE', '/api/tunnels/7').length ? [] : [tunnel()] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'DELETE /api/tunnels/7': () => json(200, { message: 'deleted' }),
        });
        renderPanel();

        fireEvent.click(await screen.findByRole('button', { name: 'Delete tunnel Prod DB' }));
        expect(await screen.findByText('Delete this tunnel?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Delete tunnel' }));

        expect(await screen.findByText('No tunnels yet')).toBeInTheDocument();
        expect(calls(fetchMock, 'DELETE', '/api/tunnels/7')).toHaveLength(1);
    });

    it('creates a tunnel from a preset and starts it', async () => {
        const created = tunnel({ id: 11, name: null, local_port: 16379, remote_port: 6379 });
        const fetchMock = backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
            'POST /api/servers/1/tunnels': () => json(201, { data: created }),
            'POST /api/tunnels/11/start': () => json(200, { data: { ...created, status: status({ state: 'listening' }) } }),
        });
        renderPanel();

        fireEvent.click(await screen.findByRole('button', { name: /^Redis/ }));
        expect(screen.getByLabelText('Remote port')).toHaveValue('6379');
        expect(screen.getByLabelText('Local port')).toHaveValue('16379');
        fireEvent.click(screen.getByRole('button', { name: 'Save and start' }));

        expect(await screen.findByText('Tunnel listening on 127.0.0.1:16379')).toBeInTheDocument();
        const [, init] = calls(fetchMock, 'POST', '/api/servers/1/tunnels')[0];
        expect(JSON.parse(String(init?.body))).toEqual({
            name: null, local_host: '127.0.0.1', local_port: 16379, remote_host: '127.0.0.1', remote_port: 6379, auto_start: false,
        });
        expect(calls(fetchMock, 'POST', '/api/tunnels/11/start')).toHaveLength(1);
        expect(screen.queryByRole('button', { name: 'Save and start' })).toBeNull();
    });

    it('shows the load error with a retry', async () => {
        let fail = true;
        backend({
            'GET /api/servers/1/tunnels': () => (fail ? json(500, { error: 'database is locked' }) : json(200, { data: [] })),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
        });
        renderPanel();

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not load the tunnels. database is locked');
        fail = false;
        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('No tunnels yet')).toBeInTheDocument();
    });

    it('speaks Spanish', async () => {
        setLanguage('es');
        backend({
            'GET /api/servers/1/tunnels': () => json(200, { data: [tunnel({ status: status({ state: 'listening', totalConnections: 1 }) })] }),
            'GET /api/servers/1/host-key': () => json(200, { data: HOST_KEY }),
        });
        renderPanel();

        expect(await screen.findByRole('heading', { name: 'Túneles SSH' })).toBeInTheDocument();
        expect(await screen.findByText('Escuchando')).toBeInTheDocument();
        expect(screen.getByRole('switch', { name: 'Activar el túnel Prod DB' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Nuevo túnel/ })).toBeInTheDocument();
    });
});
