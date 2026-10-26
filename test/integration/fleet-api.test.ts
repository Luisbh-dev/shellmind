import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { FleetBoard, FleetHealthEvent, FleetRefreshResult, FleetSettings, FleetSnapshot } from '../../shared/fleet';
import type { AuditEntry } from '../../shared/types';
import { createOpsHost, type OpsHost } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The fleet board through the real backend: GET/POST /api/fleet, the
// settings, and the "fleet-health" socket feed, with the checks running
// over the in-process SSH server.

vi.setConfig({ testTimeout: 20_000 });

const fixture = fs.readFileSync(fileURLToPath(new URL('../fixtures/fleet/linux-ubuntu.txt', import.meta.url)), 'utf8');

const WINDOWS_REPORT = JSON.stringify({
    host: 'WIN-SRV01', os: 'Microsoft Windows Server 2022 Standard', ver: '10.0.20348', up: 3600, cores: 2,
    mem: { t: 4194304, f: 2097152, st: 0, sf: 0 }, disks: [{ n: 'C:', fs: 'NTFS', s: 107374182400, f: 53687091200 }], load: 12, reboot: false
});

let server: TestServer;
let harness: SshHarness;
let host: OpsHost;
let monitor: typeof import('../../server/fleet/monitor')['fleetMonitor'];
const sockets: Socket[] = [];

type Envelope<T> = { message: string; data: T };

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T & { code?: string; error?: string } }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as T & { code?: string; error?: string } };
}

async function saveServer(extra: Record<string, unknown> = {}): Promise<number> {
    const { body } = await call<Envelope<{ id: number }>>('POST', '/api/servers', {
        name: `fleet-${Math.random().toString(36).slice(2, 8)}`, ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret', ...extra,
    });
    return body.data.id;
}

async function snapshotOf(id: number): Promise<FleetSnapshot | undefined> {
    const { body } = await call<Envelope<FleetBoard>>('GET', '/api/fleet');
    return body.data.snapshots.find((snapshot) => snapshot.serverId === id);
}

// The snapshot once a check of the server finished after `since`.
async function checked(id: number, since: number, timeoutMs = 10_000): Promise<FleetSnapshot> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const snapshot = await snapshotOf(id);
        if (snapshot && snapshot.checkedAt !== null && snapshot.checkedAt >= since && !snapshot.checking) return snapshot;
        if (Date.now() > deadline) throw new Error(`No finished check of server #${id}: ${JSON.stringify(snapshot)}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function refresh(ids?: number[]) {
    return call<Envelope<FleetRefreshResult>>('POST', '/api/fleet/refresh', ids ? { ids } : {});
}

const fleetScripts = () => host.scripts.filter((entry) => entry.script.includes('m reboot') || entry.script.includes('RebootPending'));

async function closedPort(): Promise<number> {
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as net.AddressInfo;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    return port;
}

async function openSocket(): Promise<Socket> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    return socket;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    monitor = (await import('../../server/fleet/monitor')).fleetMonitor;
    host = createOpsHost();
    host.respond((script, kind) => {
        if (kind === 'posix' && script.includes('m reboot')) return { stdout: fixture };
        if (kind === 'powershell' && script.includes('RebootPending')) return { stdout: `${WINDOWS_REPORT}\r\n` };
        return undefined;
    });
    harness = await startSshServer({ exec: host.exec });
});

afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
});

afterAll(async () => {
    monitor?.stop();
    await server?.close();
    await harness?.close();
    vi.restoreAllMocks();
});

describe('fleet API', () => {
    it('needs the session token', async () => {
        const res = await fetch(`${server.baseUrl}/api/fleet`);
        expect(res.status).toBe(401);
        const refreshed = await fetch(`${server.baseUrl}/api/fleet/refresh`, { method: 'POST' });
        expect(refreshed.status).toBe(401);
    });

    it('lists the SSH servers and checks one over one channel of its pooled connection', async () => {
        const id = await saveServer();
        const ftp = (await call<Envelope<{ id: number }>>('POST', '/api/servers', { name: 'ftp', ip: '127.0.0.1', type: 'ftp' })).body.data.id;

        const before = await snapshotOf(id);
        expect(before).toMatchObject({ state: 'unknown', checkedAt: null, monitored: true, checking: false });
        expect(await snapshotOf(ftp)).toBeUndefined();

        const started = Date.now();
        const { status, body } = await refresh([id, ftp, 999_999]);
        expect(status).toBe(202);
        expect(body.data).toEqual({ queued: [id], skipped: [{ serverId: ftp, reason: 'unsupported' }, { serverId: 999_999, reason: 'not-found' }] });

        const snapshot = await checked(id, started);
        expect(snapshot).toMatchObject({
            state: 'critical',
            failures: 0,
            hold: null,
            error: null,
            issues: [{ metric: 'disk', tone: 'critical', value: 93, mount: '/' }, { metric: 'load', tone: 'warn', value: 1.3 }, { metric: 'failedUnits', tone: 'warn', value: 1 }],
            metrics: { hostname: 'web-01', loadPerCore: 1.3, rebootRequired: true, updates: { manager: 'apt', count: 12, security: 5 } },
        });
        expect(snapshot.handshakeMs).toBeGreaterThanOrEqual(0);
        expect(fleetScripts()).toHaveLength(1);
        expect(fleetScripts()[0].script).not.toContain('sleep 1');

        // Kept in the database (and gone with the server).
        const rows = await new Promise<Array<{ state: string }>>((resolve, reject) => {
            server.db.all('SELECT state FROM health_snapshots WHERE server_id = ?', [id], (err, result) => (err ? reject(err) : resolve(result as Array<{ state: string }>)));
        });
        expect(rows).toEqual([{ state: 'critical' }]);
        await call('DELETE', `/api/servers/${id}`);
        const after = await new Promise<unknown[]>((resolve, reject) => {
            server.db.all('SELECT state FROM health_snapshots WHERE server_id = ?', [id], (err, result) => (err ? reject(err) : resolve(result)));
        });
        expect(after).toEqual([]);
    });

    it('checks a Windows server with one encoded PowerShell command', async () => {
        const id = await saveServer({ type: 'windows', port: null, ssh_port: harness.port });
        const started = Date.now();
        await refresh([id]);
        const snapshot = await checked(id, started);
        expect(snapshot).toMatchObject({ state: 'ok', metrics: { platform: 'windows', hostname: 'WIN-SRV01', cpuPercent: 12, rebootRequired: false, cores: 2 } });
        await call('DELETE', `/api/servers/${id}`);
    });

    it('holds a server whose password is rejected instead of trying it again', async () => {
        const id = await saveServer({ password: 'wrong' });
        const attempts = () => harness.log.filter((entry) => entry === 'auth:password').length;
        const before = attempts();
        const started = Date.now();
        await refresh([id]);
        const snapshot = await checked(id, started);
        expect(snapshot).toMatchObject({ state: 'error', hold: 'auth', nextCheckAt: null, error: { code: 'AUTH_FAILED' } });
        const tried = attempts() - before;
        expect(tried).toBeGreaterThan(0);

        // "Check all" skips it; only naming it tries again.
        const all = await refresh();
        expect(all.body.data.queued).not.toContain(id);
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(attempts() - before).toBe(tried);
        await call('DELETE', `/api/servers/${id}`);
    });

    it('tries a jump host with a rejected password once, not once per server behind it', async () => {
        const bastion = await startSshServer({ exec: host.exec, forward: () => ({ host: harness.host, port: harness.port }) });
        try {
            const jumpId = await saveServer({ name: 'bastion-bad', ip: bastion.host, port: bastion.port, password: 'wrong' });
            const behind = [];
            for (let index = 1; index <= 5; index += 1) behind.push(await saveServer({ ip: `10.20.0.${index}`, port: 22, jump_server_id: jumpId }));
            const started = Date.now();
            const all = await refresh();
            expect(all.body.data.queued).toEqual(expect.arrayContaining([jumpId, ...behind]));
            expect(await checked(jumpId, started)).toMatchObject({ state: 'error', hold: 'auth', error: { code: 'AUTH_FAILED' } });
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(bastion.connections()).toBe(1);
            for (const id of behind) {
                expect(await snapshotOf(id)).toMatchObject({
                    state: 'unknown', hold: null, checking: false, nextCheckAt: null,
                    blocked: { kind: 'jump-host', serverId: jumpId, hold: 'auth' }
                });
            }

            // Checking one of them by name does not log in to the jump host again.
            expect((await refresh([behind[2]])).body.data).toEqual({ queued: [], skipped: [{ serverId: behind[2], reason: 'jump-host' }] });
            // Nor does editing the jump host's notes.
            const edit = (extra: Record<string, unknown>) => call('PUT', `/api/servers/${jumpId}`, {
                name: 'bastion-bad', ip: bastion.host, port: bastion.port, type: 'linux', username: 'tester', ...extra,
            });
            expect((await edit({ notes: 'ask the network team' })).status).toBe(200);
            expect(await snapshotOf(jumpId)).toMatchObject({ hold: 'auth' });
            expect((await refresh()).body.data.queued).not.toContain(jumpId);
            await new Promise((resolve) => setTimeout(resolve, 300));
            expect(bastion.connections()).toBe(1);

            // Its password is fixed: the hold lifts, and everything behind it works.
            expect((await edit({ password: 'secret' })).status).toBe(200);
            expect(await snapshotOf(jumpId)).toMatchObject({ hold: null });
            const fixed = Date.now();
            await refresh();
            for (const id of [jumpId, ...behind]) expect(await checked(id, fixed)).toMatchObject({ state: 'critical', blocked: null });
            expect(bastion.connections()).toBe(2);
            for (const id of [...behind, jumpId]) await call('DELETE', `/api/servers/${id}`);
        } finally {
            await bastion.close();
        }
    });

    it('reports a closed port as unreachable', async () => {
        const id = await saveServer({ port: await closedPort() });
        const started = Date.now();
        await refresh([id]);
        expect(await checked(id, started)).toMatchObject({ state: 'unreachable', hold: null, failures: 1, error: { code: 'ECONNREFUSED' } });
        await call('DELETE', `/api/servers/${id}`);
    });

    it('validates what it is sent', async () => {
        expect(await refresh(['1' as unknown as number])).toMatchObject({ status: 400, body: { code: 'INVALID_FLEET' } });
        expect(await call('POST', '/api/fleet/refresh', { ids: 'all' })).toMatchObject({ status: 400, body: { code: 'INVALID_FLEET' } });
        expect(await call('POST', '/api/fleet/refresh', { ids: Array.from({ length: 1001 }, (_, index) => index + 1) })).toMatchObject({ status: 400 });
        expect(await call('PUT', '/api/fleet/settings', { intervalMinutes: 7 })).toMatchObject({ status: 400, body: { code: 'INVALID_FLEET', details: { field: 'intervalMinutes' } } });
        expect(await call('PUT', '/api/fleet/settings', { enabled: 'yes' })).toMatchObject({ status: 400, body: { details: { field: 'enabled' } } });
        expect(await call('PUT', '/api/fleet/settings', { reachability: 1 })).toMatchObject({ status: 400, body: { details: { field: 'reachability' } } });
        expect(await call('PUT', '/api/fleet/settings', { excludedServerIds: [0] })).toMatchObject({ status: 400, body: { details: { field: 'excludedServerIds' } } });
    });
});

describe('fleet settings', () => {
    it('have health checks off and reachability checks on by default, are saved, and changes are audited', async () => {
        const initial = await call<Envelope<FleetSettings>>('GET', '/api/fleet/settings');
        expect(initial.body.data).toEqual({ enabled: false, reachability: true, intervalMinutes: 5, notifications: true, excludedServerIds: [] });

        const [first, second] = [await saveServer(), await saveServer()];
        const saved = await call<Envelope<FleetSettings>>('PUT', '/api/fleet/settings', { enabled: true, intervalMinutes: 15, excludedServerIds: [second, 999_999, first] });
        // Only servers on the board can be left out.
        expect(saved).toMatchObject({ status: 200, body: { data: { enabled: true, intervalMinutes: 15, notifications: true, excludedServerIds: [first, second] } } });
        expect((await call<Envelope<FleetSettings>>('GET', '/api/fleet/settings')).body.data.intervalMinutes).toBe(15);

        const audit = await call<Envelope<AuditEntry[]>>('GET', '/api/audit?source=fleet');
        expect(audit.body.data.map((entry) => entry.command)).toContain('fleet health checks on, every 15 min; 2 server(s) left out of automatic checks');

        // A deleted server leaves the list.
        await call('DELETE', `/api/servers/${second}`);
        expect((await call<Envelope<FleetBoard>>('GET', '/api/fleet')).body.data.settings.excludedServerIds).toEqual([first]);
        expect((await call<Envelope<FleetSettings>>('GET', '/api/fleet/settings')).body.data.excludedServerIds).toEqual([first]);

        await call('PUT', '/api/fleet/settings', { enabled: false, excludedServerIds: [] });
        await call('DELETE', `/api/servers/${first}`);
    });
});

describe('fleet socket feed', () => {
    it('answers the subscription with the board and pushes the changes', async () => {
        const id = await saveServer();
        const socket = await openSocket();
        const board = await new Promise<FleetBoard>((resolve) => socket.emit('fleet-subscribe', resolve));
        expect(board.snapshots.some((snapshot) => snapshot.serverId === id)).toBe(true);

        const events: FleetHealthEvent[] = [];
        socket.on('fleet-health', (event: FleetHealthEvent) => events.push(event));
        // Slow enough for the running check to be pushed on its own.
        host.respond((script) => (script.includes('m reboot') ? { stdout: fixture, delayMs: 500 } : undefined));
        await refresh([id]);
        const deadline = Date.now() + 10_000;
        while (!events.some((event) => event.snapshots?.some((snapshot) => snapshot.serverId === id && snapshot.checkedAt !== null && !snapshot.checking))) {
            if (Date.now() > deadline) throw new Error(`No change pushed: ${JSON.stringify(events)}`);
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        host.respond((script) => (script.includes('m reboot') ? { stdout: fixture } : undefined));
        const pushed = events.flatMap((event) => event.snapshots ?? []).filter((snapshot) => snapshot.serverId === id);
        expect(pushed.some((snapshot) => snapshot.checking)).toBe(true);
        expect(pushed.at(-1)).toMatchObject({ state: 'critical', checking: false });

        // Settings changes arrive too; after unsubscribing nothing does.
        await call('PUT', '/api/fleet/settings', { notifications: false });
        const settingsDeadline = Date.now() + 5000;
        while (!events.some((event) => event.settings?.notifications === false)) {
            if (Date.now() > settingsDeadline) throw new Error('No settings change pushed');
            await new Promise((resolve) => setTimeout(resolve, 25));
        }
        socket.emit('fleet-unsubscribe');
        await new Promise((resolve) => setTimeout(resolve, 100));
        const count = events.length;
        await call('PUT', '/api/fleet/settings', { notifications: true });
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect(events).toHaveLength(count);
        await call('DELETE', `/api/servers/${id}`);
    });

    it('refuses a socket without the token', async () => {
        const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true });
        sockets.push(socket);
        const error = await new Promise<Error>((resolve) => socket.once('connect_error', resolve));
        expect(error.message).toBe('unauthorized');
    });
});
