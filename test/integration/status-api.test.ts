import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { StatusSnapshot } from '../../shared/status';
import { createOpsHost, type OpsHost } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// GET /api/servers/:id/status against the in-process SSH server: one script
// over one channel of the pooled connection, bounded and cancellable.

vi.setConfig({ testTimeout: 20_000 });

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/ops/${name}`, import.meta.url)), 'utf8');

const WINDOWS_REPORT = JSON.stringify({
    host: 'WIN-SRV01', os: 'Microsoft Windows Server 2022 Standard', ver: '10.0.20348', up: 3600, cores: 2,
    mem: { t: 4194304, f: 2097152, st: 0, sf: 0 }, cpu: { i: 5000000, s: 10000000 }, el: 10000000,
    disks: [{ n: 'C:', fs: 'NTFS', s: 107374182400, f: 53687091200 }], net: [], procs: [], users: 0,
});

let server: TestServer;
let harness: SshHarness;
let host: OpsHost;
let sshPool: typeof import('../../server/ssh/pool')['sshPool'];
let timeouts: typeof import('../../server/status/collect')['STATUS_TIMEOUT_MS'];

async function getStatus(id: number, init?: RequestInit) {
    const res = await server.fetch(`/api/servers/${id}/status`, init);
    return { status: res.status, body: await res.json() as StatusSnapshot & { error?: string; code?: string; details?: Record<string, unknown> } };
}

async function saveServer(extra: Record<string, unknown> = {}): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `status-${Math.random()}`, ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret', ...extra }),
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

const statusScripts = () => host.scripts.filter((entry) => /m meminfo|Win32_PerfRawData_PerfOS_Processor/.test(entry.script));

async function until(check: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    sshPool = (await import('../../server/ssh/pool')).sshPool;
    timeouts = (await import('../../server/status/collect')).STATUS_TIMEOUT_MS;
    host = createOpsHost();
    harness = await startSshServer({ exec: host.exec });
});

afterEach(() => {
    host.scripts.length = 0;
    host.respond(() => undefined);
    timeouts.linux = 15_000;
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    vi.restoreAllMocks();
});

describe('status collection', () => {
    it('runs one Linux script over one channel and returns the parsed snapshot (Known issue architecture/status-new-ssh-per-poll fixed)', async () => {
        host.respond((script) => (script.includes('m meminfo') ? { stdout: fixture('status-ubuntu.txt') } : undefined));
        const id = await saveServer();
        const connectionsBefore = harness.connections();

        const first = await getStatus(id);
        const second = await getStatus(id);

        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ platform: 'linux', hostname: 'web-01', cpu: { usagePercent: 60 }, memory: { usagePercent: 39.7 } });
        expect(second.status).toBe(200);
        // Two polls, one pooled SSH connection, one channel each (not 8).
        expect(harness.connections() - connectionsBefore).toBe(1);
        expect(statusScripts()).toHaveLength(2);
        expect(harness.log.filter((entry) => entry === 'exec:sh -s').length).toBeGreaterThanOrEqual(2);
        expect(sshPool.inspect(id).refs).toBe(0);
    });

    it('shares one collection between overlapping requests (Known issue frontend/status-overlapping-polls fixed)', async () => {
        host.respond((script) => (script.includes('m meminfo') ? { stdout: fixture('status-ubuntu.txt'), delayMs: 300 } : undefined));
        const id = await saveServer();
        const [a, b] = await Promise.all([getStatus(id), getStatus(id)]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(a.body.collectedAt).toBe(b.body.collectedAt);
        expect(statusScripts()).toHaveLength(1);
    });

    it('times out a hung script, kills its channel and answers 504 (Known issue backend/status-no-timeouts-connection-leak fixed)', async () => {
        timeouts.linux = 400;
        host.respond(() => ({ hang: true }));
        const id = await saveServer();
        const started = Date.now();
        const res = await getStatus(id);
        expect(res.status).toBe(504);
        expect(res.body.code).toBe('EXEC_TIMEOUT');
        expect(Date.now() - started).toBeLessThan(4000);
        await until(() => harness.activeExecs() === 0);
        expect(sshPool.inspect(id).refs).toBe(0);
    });

    it('cancels the remote script when the client gives up (Known issue performance/status-no-timeout-overlap-leak fixed)', async () => {
        host.respond(() => ({ hang: true }));
        const id = await saveServer();
        const controller = new AbortController();
        const pending = getStatus(id, { signal: controller.signal }).catch((err: Error) => err);
        await until(() => statusScripts().length === 1);
        controller.abort();
        expect(await pending).toBeInstanceOf(Error);
        await until(() => harness.activeExecs() === 0);
        await until(() => sshPool.inspect(id).refs === 0);
    });

    it('reports a report cut short as 502 STATUS_UNAVAILABLE instead of zeros', async () => {
        host.respond(() => ({ stdout: fixture('status-ubuntu.txt').split('@@SM:cpu2')[0], code: 0 }));
        const id = await saveServer();
        const res = await getStatus(id);
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ code: 'STATUS_UNAVAILABLE', error: expect.stringMatching(/cut off/) });
    });

    it('runs the Windows collector as one PowerShell script on stdin, behind a fixed command line', async () => {
        host.respond((script, kind) => (kind === 'powershell' && script.includes('Win32_PerfRawData_PerfOS_Processor') ? { stdout: `${WINDOWS_REPORT}\r\n` } : undefined));
        const id = await saveServer({ type: 'windows', port: null, ssh_port: harness.port });
        const res = await getStatus(id);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        expect(res.body).toMatchObject({ platform: 'windows', hostname: 'WIN-SRV01', cpu: { usagePercent: 50 }, memory: { usagePercent: 50 } });
        expect(harness.log.filter((entry) => entry.startsWith('exec:powershell '))).toEqual(['exec:powershell -NoProfile -NonInteractive -Command -']);
    });

    it('answers 502 with a readable message and its cause when the server rejects the credentials', async () => {
        const id = await saveServer({ password: 'wrong' });
        const res = await getStatus(id);
        expect(res.status).toBe(502);
        expect(res.body).toMatchObject({ code: 'SSH_FAILED', error: expect.stringMatching(/^Auth failed/), details: { connection: { code: 'AUTH_FAILED' } } });
    });

    it('names a refused connection the way the terminal does (ECONNREFUSED)', async () => {
        // A port that was free a moment ago: nothing listens on it.
        const closed = net.createServer();
        await new Promise<void>((resolve) => closed.listen(0, harness.host, resolve));
        const { port } = closed.address() as net.AddressInfo;
        await new Promise((resolve) => closed.close(resolve));

        const res = await getStatus(await saveServer({ port }));
        expect(res.status).toBe(502);
        expect(res.body).toEqual({ code: 'SSH_FAILED', error: expect.stringMatching(/ECONNREFUSED/), details: { connection: { code: 'ECONNREFUSED' } } });
    });
});
