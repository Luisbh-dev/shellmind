import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { FleetBoard, FleetSnapshot } from '../../shared/fleet';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The fleet health checks end to end against a real sshd and busybox userland
// in Docker (opt-in: SHELLMIND_E2E=1), with the image of the operations e2e
// (a systemctl stand-in that reports one failed unit). The check script runs
// for real: sections, df, the reboot flag, the scheduler's own timing.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-ops-sshd';
const CONTAINER = `shellmind-test-fleet-${process.pid}`;
const CONTEXT = fileURLToPath(new URL('../fixtures/ops/e2e', import.meta.url));

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 });

let server: TestServer;
let monitor: typeof import('../../server/fleet/monitor')['fleetMonitor'];
let port: number;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

function sshBanner(): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('data', (data) => {
            socket.destroy();
            resolve(data.toString().startsWith('SSH-'));
        });
        socket.once('error', () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function saveServer(name: string, username: string, password: string, extra: Record<string, unknown> = {}): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ip: '127.0.0.1', port, type: 'linux', username, password, ...extra }),
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

// sshd -e logs to stderr, which `docker logs` passes on as its own.
function sshdLog(pattern: RegExp): number {
    const logs = spawnSync('docker', ['logs', CONTAINER], { encoding: 'utf8' });
    return (`${logs.stdout}${logs.stderr}`.match(pattern) ?? []).length;
}

async function snapshotOf(id: number): Promise<FleetSnapshot | undefined> {
    const res = await server.fetch('/api/fleet');
    return ((await res.json()) as { data: FleetBoard }).data.snapshots.find((snapshot) => snapshot.serverId === id);
}

async function checkNow(id: number): Promise<FleetSnapshot> {
    const before = (await snapshotOf(id))?.checkedAt ?? null;
    await server.fetch('/api/fleet/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids: [id] }) });
    return waitFor(async () => {
        const snapshot = await snapshotOf(id);
        return snapshot && !snapshot.checking && snapshot.checkedAt !== before ? snapshot : null;
    });
}

describe.skipIf(!ENABLED)('fleet health checks against a real sshd (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        docker('run', '-d', '--name', CONTAINER, '-p', '127.0.0.1::22', IMAGE);
        port = Number(docker('port', CONTAINER, '22').split('\n')[0].split(':').pop());
        await waitFor(() => sshBanner(), 30_000);
        // This container is also a jump host for itself (127.0.0.1:22 inside):
        // Alpine's sshd forbids forwarding unless told otherwise.
        docker('exec', CONTAINER, 'sh', '-c', "sed -i 's/^AllowTcpForwarding no/AllowTcpForwarding yes/' /etc/ssh/sshd_config && kill -HUP 1");
        await waitFor(() => sshBanner(), 30_000);
        server = await bootTestServer();
        monitor = (await import('../../server/fleet/monitor')).fleetMonitor;
    });

    afterAll(async () => {
        monitor?.stop();
        await server?.close();
        spawnSync('docker', ['rm', '-f', CONTAINER]);
        vi.restoreAllMocks();
    });

    it('reads a real host with one read-only script', async () => {
        const id = await saveServer('e2e-fleet', 'ops', 'opspw');
        const snapshot = await checkNow(id);
        expect(snapshot).toMatchObject({
            state: 'warn',
            hold: null,
            error: null,
            metrics: { platform: 'linux', failedUnits: 1, disk: { mount: '/' } }
        });
        // The stand-in's failed unit. A container reads the load and memory of
        // the Docker VM it shares with everything else running (other suites,
        // builds), which may add a warning of their own on a busy machine.
        expect(snapshot.issues).toContainEqual({ metric: 'failedUnits', tone: 'warn', value: 1 });
        for (const issue of snapshot.issues.filter((entry) => entry.metric !== 'failedUnits')) {
            expect(issue).toMatchObject({ metric: expect.stringMatching(/^(load|memory)$/), tone: 'warn' });
        }
        expect(snapshot.metrics?.os).toMatch(/^Alpine Linux/);
        expect(snapshot.metrics?.cores).toBeGreaterThan(0);
        expect(snapshot.metrics?.loadPerCore).not.toBeNull();
        expect(snapshot.metrics?.memory?.totalMB).toBeGreaterThan(0);
        expect(snapshot.metrics?.uptimeSeconds).toBeGreaterThan(0);
        expect(snapshot.handshakeMs).toBeGreaterThan(0);
        // The stand-in logs its calls: the check only listed the failed units.
        expect(docker('exec', CONTAINER, 'cat', '/tmp/ops-calls.log')).toMatch(/systemctl list-units --state=failed/);
        expect(docker('exec', CONTAINER, 'cat', '/tmp/ops-calls.log')).not.toMatch(/restart|start|stop/);

        docker('exec', CONTAINER, 'touch', '/var/run/reboot-required');
        expect((await checkNow(id)).metrics?.rebootRequired).toBe(true);
        docker('exec', CONTAINER, 'rm', '-f', '/var/run/reboot-required');
    });

    it('checks that a server answers by default, without logging in', async () => {
        const id = await saveServer('e2e-fleet-reach', 'nobody-here', 'unused');
        const logins = () => sshdLog(/(Accepted|Failed) \w+ for (invalid user )?nobody-here/g);
        monitor.start();
        const snapshot = await waitFor(async () => {
            const current = await snapshotOf(id);
            return current?.checkedAt ? current : null;
        }, 45_000);
        expect(snapshot).toMatchObject({ state: 'up', error: null, readAt: null, metrics: null });
        expect(snapshot.nextCheckAt! - snapshot.checkedAt!).toBeGreaterThanOrEqual(4.5 * 60_000);
        expect(logins()).toBe(0);
        await server.fetch(`/api/servers/${id}`, { method: 'DELETE' });
    });

    it('tries a rejected password once, never again by itself', async () => {
        const id = await saveServer('e2e-fleet-wrong', 'ops', 'not-the-password');
        const failures = () => sshdLog(/Failed password for ops/g);
        const before = failures();
        expect(await checkNow(id)).toMatchObject({ state: 'error', hold: 'auth', error: { code: 'AUTH_FAILED' } });
        const tried = failures() - before;
        expect(tried).toBeGreaterThan(0);

        await server.fetch('/api/fleet/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, intervalMinutes: 1 }) });
        monitor.start();
        await server.fetch('/api/fleet/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await new Promise((resolve) => setTimeout(resolve, 40_000));
        expect(failures() - before).toBe(tried);
        expect((await snapshotOf(id))?.hold).toBe('auth');
        await server.fetch(`/api/servers/${id}`, { method: 'DELETE' });
    });

    it('logs in to a jump host with a rejected password once for all the servers behind it', async () => {
        const failures = () => sshdLog(/Failed password for root/g);
        const before = failures();
        const jumpId = await saveServer('e2e-bastion-bad', 'root', 'not-the-password');
        const behind = [];
        for (const index of [1, 2, 3]) behind.push(await saveServer(`e2e-behind-${index}`, 'ops', 'opspw', { port: 22, jump_server_id: jumpId }));
        // Automatic checks every minute are on (previous test), and "check all" too.
        await server.fetch('/api/fleet/refresh', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        await new Promise((resolve) => setTimeout(resolve, 40_000));
        expect(failures() - before).toBe(1);
        expect(await snapshotOf(jumpId)).toMatchObject({ hold: 'auth', error: { code: 'AUTH_FAILED' } });
        for (const id of behind) expect(await snapshotOf(id)).toMatchObject({ hold: null, blocked: { kind: 'jump-host', serverId: jumpId, hold: 'auth' } });

        // The jump host's password is fixed: everything behind it is read through it.
        await server.fetch(`/api/servers/${jumpId}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'e2e-bastion-bad', ip: '127.0.0.1', port, type: 'linux', username: 'root', password: 'rootpw' }),
        });
        for (const id of behind) {
            const snapshot = await waitFor(async () => {
                const current = await snapshotOf(id);
                return current?.readAt ? current : null;
            }, 60_000);
            expect(snapshot).toMatchObject({ state: 'warn', blocked: null, metrics: { platform: 'linux' } });
        }
        expect(failures() - before).toBe(1);
        for (const id of [...behind, jumpId]) await server.fetch(`/api/servers/${id}`, { method: 'DELETE' });
    });

    it('checks the monitored servers by itself, every interval', async () => {
        const id = await saveServer('e2e-fleet-auto', 'root', 'rootpw');
        // Turned on in the previous test, every minute.
        const first = await waitFor(async () => {
            const snapshot = await snapshotOf(id);
            return snapshot?.checkedAt ? snapshot : null;
        }, 45_000);
        expect(first.state).toBe('warn');
        expect(first.nextCheckAt).not.toBeNull();
        const delay = (first.nextCheckAt ?? 0) - (first.checkedAt ?? 0);
        expect(delay).toBeGreaterThanOrEqual(54_000);
        expect(delay).toBeLessThanOrEqual(66_000);
    });
});
