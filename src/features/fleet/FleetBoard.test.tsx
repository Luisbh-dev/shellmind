import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_FLEET_SETTINGS, type FleetBoard as Board, type FleetMetrics, type FleetSnapshot } from '@shared/fleet';
import type { ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import { ToastProvider } from '@/components/ui/Toast';
import { useAppStore } from '@/store/appStore';
import { resetServersStore } from '@/store/servers';
import FleetBoard from './FleetBoard';
import { resetFleetFeed, setFleetSocketFactory, useFleetStore } from './feed';
import { FakeFleetSocket } from './testSocket';

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux', username: 'deploy', group_name: 'Prod', tags: ['web'] },
    { id: 2, name: 'db-1', ip: '10.0.0.2', type: 'linux', group_name: 'Data', tags: ['db'] },
    { id: 3, name: 'dc-1', ip: '10.0.0.3', type: 'windows' },
    { id: 4, name: 'gw', ip: '10.0.0.4', type: 'linux' },
    { id: 5, name: 'bucket', ip: '', type: 's3' }
];

const metrics = (overrides: Partial<FleetMetrics> = {}): FleetMetrics => ({
    platform: 'linux', hostname: 'h', os: 'Debian 12', kernel: null, uptimeSeconds: 7200, bootedAt: 0, cores: 4, cpuPercent: null,
    load: { one: 1, five: 1, fifteen: 1 }, loadPerCore: 0.25, memory: { usagePercent: 40, totalMB: 1000, availableMB: 600 }, swapPercent: 0,
    disk: { mount: '/', usagePercent: 50, freeGB: 5, totalGB: 10 }, diskCount: 1, failedUnits: 0, loggedInUsers: null, rebootRequired: false,
    updates: null, ...overrides
});

const snapshot = (serverId: number, overrides: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
    serverId, state: 'ok', issues: [], metrics: metrics(), checkedAt: Date.now() - 60_000, lastSeenAt: Date.now() - 60_000, error: null,
    handshakeMs: 40, durationMs: 900, failures: 0, hold: null, blocked: null, readAt: null, reachedVia: null, sshSeenAt: null, monitored: true, checking: false, nextCheckAt: null, ...overrides
});

function board(settings = DEFAULT_FLEET_SETTINGS): Board {
    return {
        settings,
        snapshots: [
            snapshot(1),
            snapshot(2, {
                state: 'critical',
                issues: [{ metric: 'disk', tone: 'critical', value: 96, mount: '/var' }],
                metrics: metrics({ disk: { mount: '/var', usagePercent: 96, freeGB: 1, totalGB: 30 }, rebootRequired: true, updates: { manager: 'apt', count: 4, security: 2, cacheAt: null } })
            }),
            snapshot(3, { state: 'error', hold: 'auth', metrics: null, lastSeenAt: null, error: { code: 'AUTH_FAILED', message: 'Auth failed' } }),
            snapshot(4, { state: 'unknown', checkedAt: null, lastSeenAt: null, metrics: null })
        ]
    };
}

type Call = { method: string; url: string; body: unknown };
let calls: Call[];
let socket: FakeFleetSocket;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    setLanguage('en');
    localStorage.clear();
    resetFleetFeed();
    resetServersStore();
    useAppStore.setState(useAppStore.getInitialState(), true);
    calls = [];
    socket = new FakeFleetSocket(board());
    setFleetSocketFactory(() => {
        queueMicrotask(() => socket.connect());
        return socket.asSocket();
    });
    vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input).replace(/^https?:\/\/[^/]+/, '');
        const method = init?.method ?? 'GET';
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ method, url, body });
        if (url === '/api/servers') return json({ message: 'success', data: SERVERS });
        if (url === '/api/fleet/refresh') return json({ message: 'success', data: { queued: body?.ids ?? [1, 2], skipped: [] } }, 202);
        if (url === '/api/fleet/settings' && method === 'PUT') return json({ message: 'success', data: { ...DEFAULT_FLEET_SETTINGS, ...body } });
        return json({ error: 'not found', code: 'NOT_FOUND' }, 404);
    }));
});

afterEach(() => {
    resetFleetFeed();
    setFleetSocketFactory(null);
    vi.unstubAllGlobals();
    setLanguage('system');
});

async function setup() {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<ToastProvider><FleetBoard onClose={onClose} server={null} /></ToastProvider>);
    await screen.findByText('web-1');
    return { onClose, user, table: () => screen.getByRole('table', { name: 'Fleet health' }) };
}

const rowOf = (name: string) => screen.getByText(name, { selector: 'button' }).closest('tr') as HTMLTableRowElement;
// The name buttons of the rows, in order.
const rowButtons = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-fleet-row] th[scope="row"] button'));
const rowNames = () => rowButtons().map((button) => button.textContent);

describe('fleet board', () => {
    it('lists the SSH servers, most urgent first, with their readings', async () => {
        await setup();
        const dialog = screen.getByRole('dialog', { name: 'Fleet health' });
        expect(dialog).toHaveAccessibleDescription('4 SSH servers · reachability every 5 min · health checks off');
        const names = rowNames();
        expect(names).toEqual(['db-1', 'dc-1', 'gw', 'web-1']);
        expect(screen.queryByText('bucket')).toBeNull();

        const db = rowOf('db-1');
        expect(within(db).getByText('Critical')).toBeInTheDocument();
        expect(within(db).getByText('96%')).toBeInTheDocument();
        expect(within(db).getByText('Pending')).toBeInTheDocument();
        expect(within(db).getByText('2 security')).toBeInTheDocument();
        expect(within(rowOf('web-1')).getByText('0.25/core')).toBeInTheDocument();
        expect(within(rowOf('dc-1')).getByText(/Credentials rejected/)).toBeInTheDocument();
        expect(within(rowOf('gw')).getByText('Not checked')).toBeInTheDocument();
    });

    it('names each row by its server and says why it needs attention without colour', async () => {
        await setup();
        const header = screen.getByRole('rowheader', { name: /^db-1/ });
        expect(header.tagName).toBe('TH');
        // The reason is on screen under the name, and read with it.
        expect(within(header).getByText('/var 96% full')).toBeInTheDocument();
        expect(within(header).getByRole('button', { name: 'db-1' })).toHaveAccessibleDescription('Critical /var 96% full');
        // A critical reading has a word (and an icon) besides its colour.
        expect(within(rowOf('db-1')).getByText('(critical)', { exact: false })).toHaveClass('sr-only');
        // Column hints are read with their sort buttons.
        expect(screen.getByRole('button', { name: 'Sort by CPU / load' })).toHaveAccessibleDescription(/load average per core/);
    });

    it('fits the columns to a narrow window, folding reboot and updates under the name', async () => {
        const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(956);
        try {
            await setup();
            expect(screen.getByRole('table')).toHaveAttribute('data-layout', 'compact');
            const headers = screen.getAllByRole('columnheader').map((cell) => cell.textContent);
            expect(headers).not.toContain('Reboot');
            expect(headers.some((text) => text?.startsWith('Updates'))).toBe(false);
            expect(headers.some((text) => text?.startsWith('Last seen'))).toBe(true);
            const db = screen.getByRole('rowheader', { name: /^db-1/ });
            expect(within(db).getByText('Reboot pending')).toBeInTheDocument();
            expect(within(db).getByText(/4 updates · 2 security/)).toBeInTheDocument();
            expect(within(rowOf('db-1')).getByRole('button', { name: 'Check db-1 now' })).toBeInTheDocument();
        } finally {
            width.mockRestore();
        }
    });

    it('filters by state and signal, and searches', async () => {
        const { user } = await setup();
        await user.click(screen.getByRole('button', { name: /^Needs attention/ }));
        expect(screen.getByRole('button', { name: /^Needs attention/ })).toHaveAttribute('aria-pressed', 'true');
        expect(screen.queryByText('web-1')).toBeNull();
        expect(screen.getByText('db-1')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /^All/ }));
        await user.click(screen.getByRole('button', { name: /^Reboot pending/ }));
        expect(rowButtons()).toHaveLength(1);

        await user.click(screen.getByRole('button', { name: 'Clear filters' }));
        await user.type(screen.getByRole('searchbox', { name: 'Filter servers' }), 'prod');
        expect(rowNames()).toEqual(['web-1']);
    });

    it('sorts by a column, and the other way on a second click', async () => {
        const { user } = await setup();
        const header = () => screen.getByRole('columnheader', { name: /Server/ });
        await user.click(screen.getByRole('button', { name: 'Sort by Server' }));
        expect(header()).toHaveAttribute('aria-sort', 'ascending');
        expect(rowNames()).toEqual(['db-1', 'dc-1', 'gw', 'web-1']);
        await user.click(screen.getByRole('button', { name: 'Sort by Server' }));
        expect(header()).toHaveAttribute('aria-sort', 'descending');
        expect(rowButtons()[0]).toHaveTextContent('web-1');
    });

    it('groups by group', async () => {
        const { user } = await setup();
        await user.click(screen.getByRole('combobox', { name: 'Group by' }));
        await user.click(screen.getByRole('option', { name: 'Group' }));
        const groups = Array.from(document.querySelectorAll('th[scope="rowgroup"]')).map((cell) => cell.textContent);
        expect(groups[0]).toMatch(/^Data1 server · Needs attention: 1/);
        expect(groups[1]).toMatch(/^Prod1 server/);
        expect(groups[2]).toMatch(/^No group2 servers/);
    });

    it('checks a server now, its row spinning from the click', async () => {
        const { user } = await setup();
        await user.click(screen.getByRole('button', { name: 'Check web-1 now' }));
        expect(calls).toContainEqual({ method: 'POST', url: '/api/fleet/refresh', body: { ids: [1] } });
        expect(screen.getByRole('button', { name: 'Check web-1 now' })).toBeDisabled();
        expect(useFleetStore.getState().requested[1]).toBeDefined();

        act(() => socket.push({ snapshots: [snapshot(1, { checkedAt: Date.now() })] }));
        expect(screen.getByRole('button', { name: 'Check web-1 now' })).toBeEnabled();
    });

    it('opens a server on its Status tab from its row', async () => {
        const { user, onClose } = await setup();
        await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'db-1' }));
        expect(useAppStore.getState().serverTabRequest).toMatchObject({ serverId: 2, tabId: 'status' });
        expect(onClose).toHaveBeenCalled();
    });

    it('asks the AI about a server in its own workspace', async () => {
        const { user, onClose } = await setup();
        await user.click(screen.getByRole('button', { name: 'Ask AI about db-1' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({
            serverId: 2,
            kind: 'context',
            attachment: { kind: 'status' },
            prompt: 'db-1 is "Critical" on the fleet board (/var 96% full). What is going on and what should I check first?'
        });
        expect(useAppStore.getState().serverTabRequest).toMatchObject({ serverId: 2, tabId: 'status' });
        expect(onClose).toHaveBeenCalled();
    });

    it('offers to turn the health checks on, asking for the notification permission', async () => {
        const requestPermission = vi.fn(async () => 'granted' as NotificationPermission);
        vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission }));
        const { user } = await setup();
        expect(screen.getByText('Only reachability is checked')).toBeInTheDocument();
        await user.click(screen.getByRole('button', { name: 'Turn on health checks' }));
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(calls).toContainEqual({ method: 'PUT', url: '/api/fleet/settings', body: { enabled: true } });
        expect(await screen.findByText(/checked every 5 min/)).toBeInTheDocument();
        expect(screen.queryByText('Only reachability is checked')).toBeNull();
    });

    it('offers the notification permission while alerts are on and the browser was never asked', async () => {
        const requestPermission = vi.fn(async () => 'denied' as NotificationPermission);
        vi.stubGlobal('Notification', Object.assign(vi.fn(), { permission: 'default', requestPermission }));
        const { user } = await setup();
        await user.click(screen.getByRole('button', { name: 'Allow desktop notifications' }));
        expect(requestPermission).toHaveBeenCalledTimes(1);
        expect(screen.queryByRole('button', { name: 'Allow desktop notifications' })).toBeNull();
    });

    it('opens the connection to fix, not the server, when its login was rejected', async () => {
        const { user, onClose } = await setup();
        await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'dc-1' }));
        expect(await screen.findByRole('dialog', { name: 'Edit connection' })).toBeInTheDocument();
        expect(useAppStore.getState().serverTabRequest).toBeNull();
        expect(onClose).not.toHaveBeenCalled();
        // Asking the AI would open it too.
        expect(within(rowOf('dc-1')).getByRole('button', { name: 'Ask AI about dc-1' })).toHaveAttribute('aria-disabled', 'true');
    });

    it('sends a changed host key to the terminal, where the keys are compared', async () => {
        socket.setBoard({ ...board(), snapshots: [snapshot(1, { state: 'error', hold: 'host-key', error: { code: 'HOST_KEY_MISMATCH', message: 'changed' } })] });
        const { user, onClose } = await setup();
        await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'web-1' }));
        expect(useAppStore.getState().serverTabRequest).toMatchObject({ serverId: 1, tabId: 'terminal' });
        expect(onClose).toHaveBeenCalled();
    });

    it('checks the jump host of a server that waits for it', async () => {
        socket.setBoard({
            ...board(),
            snapshots: [
                snapshot(4, { state: 'error', hold: 'auth', metrics: null, error: { code: 'AUTH_FAILED', message: 'Auth failed' } }),
                snapshot(1, { state: 'unknown', checkedAt: null, lastSeenAt: null, metrics: null, blocked: { kind: 'jump-host', serverId: 4, hold: 'auth' } })
            ]
        });
        const { user } = await setup();
        const web = rowOf('web-1');
        expect(within(web).getByText(/Waiting for jump host gw: its credentials were rejected/)).toBeInTheDocument();
        await user.click(within(web).getByRole('button', { name: 'Check jump host gw now' }));
        expect(calls).toContainEqual({ method: 'POST', url: '/api/fleet/refresh', body: { ids: [4] } });
        // Its row opens the jump host's connection to fix.
        await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'web-1' }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit connection' });
        expect(within(dialog).getByDisplayValue('gw')).toBeInTheDocument();
    });

    it('leaves a server out of the automatic checks from its menu', async () => {
        const { user } = await setup();
        await user.click(within(screen.getByRole('table')).getByRole('button', { name: 'More actions for web-1' }));
        await user.click(screen.getByRole('menuitem', { name: 'Leave out of automatic checks' }));
        expect(calls).toContainEqual({ method: 'PUT', url: '/api/fleet/settings', body: { excludedServerIds: [1] } });
    });

    it('says when only the Remote Desktop port of a Windows server answers, and warns when SSH used to', async () => {
        const seen = Date.now() - 30_000;
        const rdp = { state: 'up' as const, metrics: null, lastSeenAt: seen, checkedAt: seen, reachedVia: 'rdp' as const };
        socket.setBoard({ settings: DEFAULT_FLEET_SETTINGS, snapshots: [snapshot(1), snapshot(3, rdp), snapshot(4, { ...rdp, sshSeenAt: Date.now() - 3 * 3_600_000 })] });
        await setup();
        const windows = rowOf('dc-1');
        expect(within(windows).getByText('RDP only')).toBeInTheDocument();
        const note = within(windows).getByText(/^Only its Remote Desktop port answers: its SSH port does not/);
        expect(note).toHaveClass('text-zinc-400');
        const stopped = within(rowOf('gw')).getByText('Only its Remote Desktop port answers: its SSH server answered 3 h ago, but not now. The terminal, Status, multi-exec and health checks need it.');
        expect(stopped).toHaveClass('text-amber-300');
        expect(within(rowOf('web-1')).queryByText('RDP only')).toBeNull();
    });

    it('says when there is no SSH server', async () => {
        socket.setBoard({ settings: DEFAULT_FLEET_SETTINGS, snapshots: [] });
        vi.stubGlobal('fetch', vi.fn(async () => json({ message: 'success', data: [SERVERS[4]] })));
        render(<ToastProvider><FleetBoard onClose={vi.fn()} server={null} /></ToastProvider>);
        expect(await screen.findByText('No SSH servers yet')).toBeInTheDocument();
    });
});
