import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { LogChunkPayload, LogEndPayload } from '../../shared/ops';
import type { StatusSnapshot } from '../../shared/status';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// End to end against a real sshd and busybox userland in Docker (opt-in:
// SHELLMIND_E2E=1). systemctl, journalctl and docker are stand-ins in the
// image (test/fixtures/ops/e2e) that log their calls; everything else (the
// status script, quoting, sudo, the log watchdog) runs for real.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-ops-sshd';
const CONTAINER = `shellmind-test-ops-${process.pid}`;
const CONTEXT = fileURLToPath(new URL('../fixtures/ops/e2e', import.meta.url));

vi.setConfig({ testTimeout: 30_000, hookTimeout: 180_000 });

let server: TestServer;
let opsId: number;
let rootId: number;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// Remote processes whose command line starts with `prefix` (not the shells
// that merely mention it in their own arguments).
function remoteProcesses(prefix: string): string[] {
    const result = spawnSync('docker', ['exec', CONTAINER, 'ps', '-o', 'pid,args'], { encoding: 'utf8' });
    return result.stdout.split('\n').map((line) => line.trim().replace(/^\d+\s+/, '')).filter((args) => args.startsWith(prefix));
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 15_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

function sshBanner(port: number): Promise<boolean> {
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

async function call<T = Record<string, unknown>>(method: string, path: string): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { method });
    return { status: res.status, body: await res.json() as T };
}

async function saveServer(username: string, password: string, port: number): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `e2e-${username}`, ip: '127.0.0.1', port, type: 'linux', username, password }),
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

describe.skipIf(!ENABLED)('operations against a real sshd (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        docker('run', '-d', '--name', CONTAINER, '-p', '127.0.0.1::22', IMAGE);
        const port = Number(docker('port', CONTAINER, '22').split('\n')[0].split(':').pop());
        await waitFor(() => sshBanner(port), 30_000);
        server = await bootTestServer();
        opsId = await saveServer('ops', 'opspw', port);
        rootId = await saveServer('root', 'rootpw', port);
    });

    afterAll(async () => {
        await server?.close();
        spawnSync('docker', ['rm', '-f', CONTAINER]);
        vi.restoreAllMocks();
    });

    it('collects real metrics with one busybox script', async () => {
        const { status, body } = await call<StatusSnapshot>('GET', `/api/servers/${opsId}/status`);
        expect(status).toBe(200);
        expect(body.os).toMatch(/^Alpine Linux/);
        expect(body.cpu?.cores).toBeGreaterThan(0);
        expect(body.memory?.totalMB).toBeGreaterThan(0);
        expect(body.memory?.usedMB).toBeGreaterThan(0);
        expect(body.load).not.toBeNull();
        expect(body.disks.map((disk) => disk.mount)).toContain('/');
        expect(body.network).not.toBeNull();
        expect(body.processes.map((process) => process.name)).toContain('sshd');
        // The sampling pipeline itself is not reported.
        expect(body.processes.map((process) => process.name)).not.toContain('sort');
        expect(body.failedUnits).toBe(1);
        expect(body.sampleSeconds).toBeGreaterThanOrEqual(0.9);
    });

    it('detects sudo, the stand-in systemd and Docker reached through sudo', async () => {
        const { body } = await call('GET', `/api/servers/${opsId}/ops/capabilities`);
        expect(body).toMatchObject({ root: false, sudo: true, systemd: true, journal: true, containers: { engine: 'docker', sudo: true, compose: true } });
        const root = await call('GET', `/api/servers/${rootId}/ops/capabilities`);
        expect(root.body).toMatchObject({ root: true, sudo: false, containers: { engine: 'docker', sudo: false } });
    });

    it('keeps Docker\'s own error when the daemon is down, even after trying sudo', async () => {
        docker('exec', CONTAINER, 'touch', '/tmp/docker-down');
        try {
            const { body } = await call('GET', `/api/servers/${opsId}/ops/capabilities?refresh=1`);
            expect(body).toMatchObject({ sudo: true, containers: { engine: null, problem: expect.stringMatching(/^Cannot connect to the Docker daemon/) } });
        } finally {
            docker('exec', CONTAINER, 'rm', '-f', '/tmp/docker-down');
            await call('GET', `/api/servers/${opsId}/ops/capabilities?refresh=1`);
        }
    });

    it('lists services and restarts one with sudo -n', async () => {
        const list = await call<{ services: Array<{ name: string; active: string }> }>('GET', `/api/servers/${opsId}/ops/services`);
        expect(list.body.services.find((service) => service.name === 'nginx.service')).toMatchObject({ active: 'failed' });
        expect(list.body.services.map((service) => service.name)).toContain('postgresql.service');

        const restart = await call('POST', `/api/servers/${opsId}/ops/services/nginx.service/restart`);
        expect(restart).toMatchObject({ status: 200, body: { command: "sudo -n systemctl --no-ask-password restart -- 'nginx.service'" } });
        expect(docker('exec', CONTAINER, 'cat', '/tmp/ops-calls.log')).toContain('systemctl --no-ask-password restart -- nginx.service');
    });

    it('lists, inspects and removes containers through sudo docker', async () => {
        const list = await call<{ containers: Array<{ name: string }>; projects: Array<{ name: string }> }>('GET', `/api/servers/${opsId}/ops/containers`);
        expect(list.body.containers.map((container) => container.name)).toEqual(['web-proxy-1', 'old-job']);
        expect(list.body.projects).toEqual([expect.objectContaining({ name: 'web' })]);
        expect((await call('GET', `/api/servers/${opsId}/ops/containers/web-proxy-1`)).body).toMatchObject({ inspect: { Name: '/web-proxy-1' } });
        expect(await call('POST', `/api/servers/${opsId}/ops/containers/gone/remove`)).toMatchObject({ status: 502, body: { error: 'Error response from daemon: No such container: gone' } });
        expect((await call('POST', `/api/servers/${opsId}/ops/containers/old-job/remove`)).status).toBe(200);
    });

    it('streams a growing file and leaves no tail behind once stopped', async () => {
        const socket: Socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
        try {
            let text = '';
            socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
                text += payload.data;
                ack();
            });
            socket.emit('logs-start', { id: 'tail1', serverId: opsId, source: { kind: 'file', path: '/var/log/ticker.log' } });
            await waitFor(() => (text.match(/app\[42\]: tick/g) ?? []).length >= 3);
            expect(remoteProcesses('tail -n 200 -F')).toHaveLength(1);

            const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
            socket.emit('logs-stop', { id: 'tail1' });
            expect(await ended).toEqual({ id: 'tail1', code: null });
            await waitFor(() => remoteProcesses('tail -n 200 -F').length === 0);
        } finally {
            socket.disconnect();
        }
    });

    it('follows the journal and container logs; a dropped socket stops them', async () => {
        const socket: Socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
        let journal = '';
        let container = '';
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            if (payload.id === 'j') journal += payload.data;
            else container += payload.data;
            ack();
        });
        socket.emit('logs-start', { id: 'j', serverId: opsId, source: { kind: 'journal', unit: 'nginx' } });
        socket.emit('logs-start', { id: 'c', serverId: opsId, source: { kind: 'container', container: 'web-proxy-1' } });
        await waitFor(() => journal.includes('journal tick') && container.includes('container log line'));
        expect(journal).toContain("Failed with result 'exit-code'");
        expect(docker('exec', CONTAINER, 'cat', '/tmp/ops-calls.log')).toContain('journalctl -f -n 200 --no-pager -o short-iso -u nginx.service');

        socket.disconnect();
        await waitFor(() => remoteProcesses('/bin/sh /usr/local/bin/journalctl').length === 0 && remoteProcesses('/bin/sh /usr/local/bin/docker logs').length === 0);
    });
});
