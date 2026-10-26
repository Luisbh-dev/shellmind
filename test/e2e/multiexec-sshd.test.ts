import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { isJobFinal, type MultiExecJob, type MultiExecJobInfo } from '../../shared/multiexec';
import { groupByOutput } from '../../shared/multiexecOutput';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Multi-exec jobs end to end against two real sshd containers (opt-in:
// SHELLMIND_E2E=1): a canary rollout, grouping by output across host names,
// secret variables that run but are never recorded, and cancelling a command
// that really runs. Reuses the image of the operations e2e test.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-ops-sshd';
const CONTEXT = fileURLToPath(new URL('../fixtures/ops/e2e', import.meta.url));
const NAMES = { a: `shellmind-test-multiexec-${process.pid}-a`, b: `shellmind-test-multiexec-${process.pid}-b` };
const SECRET = 'e2e-S3cret-Value-42';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let server: TestServer;
const ids = { a1: 0, a2: 0, b: 0 };

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function call<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

async function saveServer(name: string, port: number): Promise<number> {
    const res = await call<{ data: { id: number } }>('POST', '/api/servers', { name, ip: '127.0.0.1', port, type: 'linux', username: 'ops', password: 'opspw' });
    return res.body.data.id;
}

async function start(body: Record<string, unknown>): Promise<MultiExecJobInfo> {
    const res = await call<{ data: { job: MultiExecJobInfo }; error?: string }>('POST', '/api/multiexec', body);
    expect(res.status, res.body.error).toBe(201);
    return res.body.data.job;
}

async function job(id: string): Promise<MultiExecJob> {
    return (await call<{ data: MultiExecJob }>('GET', `/api/multiexec/jobs/${id}`)).body.data;
}

async function until(id: string, check: (current: MultiExecJob) => boolean): Promise<MultiExecJob> {
    let current!: MultiExecJob;
    await waitFor(async () => check((current = await job(id))), 40_000);
    return current;
}

describe.skipIf(!ENABLED)('multi-exec jobs against real sshd (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        const ports: Record<'a' | 'b', number> = { a: 0, b: 0 };
        for (const key of ['a', 'b'] as const) {
            docker('run', '-d', '--name', NAMES[key], '--hostname', `e2e-host-${key}`, '-p', '127.0.0.1::22', IMAGE);
            ports[key] = Number(docker('port', NAMES[key], '22').split('\n')[0].split(':').pop());
        }
        await waitFor(() => sshBanner(ports.a), 30_000);
        await waitFor(() => sshBanner(ports.b), 30_000);
        docker('exec', NAMES.a, 'sh', '-c', 'echo "listen 80; workers 4" > /tmp/app.conf && chmod 644 /tmp/app.conf');
        docker('exec', NAMES.b, 'sh', '-c', 'echo "listen 8080; workers 4" > /tmp/app.conf && chmod 644 /tmp/app.conf');
        server = await bootTestServer();
        ids.a1 = await saveServer('frontend 1', ports.a);
        // The same host saved again under another name.
        ids.a2 = await saveServer('frontend 1 (alias)', ports.a);
        ids.b = await saveServer('frontend 2', ports.b);
    });

    afterAll(async () => {
        await server?.close();
        for (const name of Object.values(NAMES)) spawnSync('docker', ['rm', '-f', name]);
        vi.restoreAllMocks();
    });

    it('rolls out after a canary and groups the outputs that differ only by host name and time', async () => {
        const info = await start({
            command: 'cat /tmp/app.conf && echo "checked on $(hostname) at $(date +%H:%M:%S)"',
            serverIds: [ids.a1, ids.a2, ids.b],
            strategy: { canary: { count: 1, onSuccess: 'pause' }, concurrency: 2 },
        });
        const paused = await until(info.id, (current) => current.status === 'paused');
        expect(paused.servers.map((item) => item.status)).toEqual(['ok', 'queued', 'queued']);
        expect(paused.servers[0].stdout).toMatch(/^listen 80; workers 4\nchecked on e2e-host-a at \d\d:\d\d:\d\d\n$/);

        expect((await call('POST', `/api/multiexec/jobs/${info.id}/resume`)).status).toBe(200);
        const done = await until(info.id, (current) => isJobFinal(current.status));
        expect(done.status).toBe('done');
        const normalized = groupByOutput(done.servers, 'normalized').map((group) => group.members.map((item) => item.name));
        expect(normalized).toEqual([['frontend 1', 'frontend 1 (alias)'], ['frontend 2']]);
        // The host names came from one audited `hostname` per connection.
        const probes = (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=multi-exec&limit=100')).body.data
            .filter((entry) => entry.meta?.jobId === info.id && entry.meta?.probe);
        expect(probes.map((entry) => [entry.server_id, entry.command, entry.exit_code]).sort()).toEqual([[ids.a1, 'hostname', 0], [ids.a2, 'hostname', 0], [ids.b, 'hostname', 0]].sort());
    });

    it('runs secret values on the servers but records only their placeholder', async () => {
        const info = await start({
            command: 'printf %s {{password}} > /tmp/received && echo "set {{password}} for $(id -un)"',
            variables: { password: SECRET },
            serverIds: [ids.a1],
        });
        const done = await until(info.id, (current) => isJobFinal(current.status));
        expect(done.servers[0]).toMatchObject({ status: 'ok', stdout: 'set {{password}} for ops\n' });
        // The real value reached the server.
        expect(docker('exec', NAMES.a, 'cat', '/tmp/received')).toBe(SECRET);

        const audit = (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=multi-exec&limit=100')).body.data
            .filter((entry) => entry.meta?.jobId === info.id && !entry.meta?.probe);
        expect(audit.map((entry) => entry.command)).toEqual(['printf %s {{password}} > /tmp/received && echo "set {{password}} for $(id -un)"']);
        expect(JSON.stringify(await job(info.id))).not.toContain(SECRET);
        expect(JSON.stringify(audit)).not.toContain(SECRET);
    });

    it('cancels a command that really runs, and the process goes away', async () => {
        const remote = () => spawnSync('docker', ['exec', NAMES.b, 'ps', '-o', 'args'], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line.trim() === 'sleep 300');
        const info = await start({ command: 'sleep 300', serverIds: [ids.b] });
        await waitFor(() => remote().length > 0);
        expect((await call('POST', `/api/multiexec/jobs/${info.id}/cancel`)).status).toBe(200);
        const done = await until(info.id, (current) => isJobFinal(current.status));
        expect(done).toMatchObject({ status: 'cancelled' });
        expect(done.servers[0].status).toBe('cancelled');
        await waitFor(() => remote().length === 0);
    });
});
