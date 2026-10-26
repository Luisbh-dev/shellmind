import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerChannel } from 'ssh2';
import { isJobFinal, type MultiExecJob, type MultiExecJobEvent, type MultiExecJobInfo, type MultiExecResult } from '../../shared/multiexec';
import type { AuditEntry } from '../../shared/types';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Multi-exec jobs over HTTP (start, follow, control, history) and the runner
// itself, against several in-process SSH servers.

// SSH handshakes are CPU-bound and slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
const harnesses: SshHarness[] = [];
// Saved servers: three harnesses, one more connection to the first, an
// unreachable port, a wrong password, a Windows server, an FTP server and a
// harness where the "deploy" command fails.
const ids = { a: 0, b: 0, c: 0, a2: 0, down: 0, badAuth: 0, win: 0, ftp: 0, broken: 0 };
// Ten more servers on one harness, for rollouts.
const fleet: number[] = [];

const SECRET = 'hunter2-Sup3rSecret';

// Extra scripted commands of every harness.
function scriptedExec(command: string, channel: ServerChannel): boolean {
    let match: RegExpExecArray | null;
    if ((match = /^spam (\d+)$/.exec(command))) {
        const total = Number(match[1]);
        const chunk = 'x'.repeat(16 * 1024);
        for (let sent = 0; sent < total; sent += chunk.length) channel.write(chunk.slice(0, Math.min(chunk.length, total - sent)));
        channel.stderr.write('ñ'.repeat(10));
        channel.exit(0);
        channel.end();
        return true;
    }
    if (command === 'mixed') {
        channel.write('out line\n');
        channel.stderr.write('err line\n');
        channel.exit(2);
        channel.end();
        return true;
    }
    if (command === 'deploy') {
        channel.write('deployed v2\n');
        channel.exit(0);
        channel.end();
        return true;
    }
    // Prints nothing.
    if (/^quiet\b/.test(command)) {
        channel.exit(0);
        channel.end();
        return true;
    }
    if ((match = /^fail-after-ms (\d+)$/.exec(command))) {
        setTimeout(() => {
            channel.stderr.write('failed late\n');
            channel.exit(1);
            channel.end();
        }, Number(match[1]));
        return true;
    }
    // Prints the secret in two packets, split in the middle.
    if ((match = /^split-echo (.+)$/.exec(command))) {
        const text = match[1];
        channel.write(`a${text.slice(0, 5)}`);
        setTimeout(() => {
            channel.write(`${text.slice(5)}z\n`);
            channel.exit(0);
            channel.end();
        }, 30);
        return true;
    }
    return false;
}

function brokenExec(command: string, channel: ServerChannel): boolean {
    if (command !== 'deploy') return false;
    channel.stderr.write('deploy failed: disk full\n');
    channel.exit(1);
    channel.end();
    return true;
}

async function api<T = unknown>(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(urlPath, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

async function saveServer(body: Record<string, unknown>): Promise<number> {
    const res = await api<{ data: { id: number } }>('POST', '/api/servers', { username: 'tester', password: 'secret', type: 'linux', ip: '127.0.0.1', ...body });
    expect(res.status).toBe(200);
    return res.body.data.id;
}

async function closedPort(): Promise<number> {
    const listener = net.createServer();
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    const { port } = listener.address() as net.AddressInfo;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    return port;
}

async function startJob(body: Record<string, unknown>): Promise<MultiExecJobInfo> {
    const res = await api<{ data: { job: MultiExecJobInfo }; error?: string }>('POST', '/api/multiexec', body);
    expect(res.status, res.body.error).toBe(201);
    return res.body.data.job;
}

type StreamOptions = {
    onEvent?: (event: MultiExecJobEvent) => void | Promise<void>;
    signal?: AbortSignal;
};

// Follows a job's event stream until it ends (or is aborted).
async function follow(id: string, options: StreamOptions = {}): Promise<MultiExecJobEvent[]> {
    const res = await server.fetch(`/api/multiexec/jobs/${id}/events`, { signal: options.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const events: MultiExecJobEvent[] = [];
    let buffer = '';
    for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
            chunk = await reader.read();
        } catch (err) {
            if (options.signal?.aborted) return events;
            throw err;
        }
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let separator: number;
        while ((separator = buffer.indexOf('\n\n')) !== -1) {
            const raw = buffer.slice(0, separator);
            buffer = buffer.slice(separator + 2);
            for (const line of raw.split('\n')) {
                if (!line.startsWith('data:')) continue;
                const event = JSON.parse(line.slice(5)) as MultiExecJobEvent;
                events.push(event);
                await options.onEvent?.(event);
            }
        }
    }
    return events;
}

async function run(body: Record<string, unknown>): Promise<{ info: MultiExecJobInfo; events: MultiExecJobEvent[] }> {
    const info = await startJob(body);
    return { info, events: await follow(info.id) };
}

const resultsOf = (events: MultiExecJobEvent[]) => new Map(
    events.flatMap((event) => (event.type === 'result' ? [[event.result.serverId, event.result] as const] : []))
);

function outputOf(events: MultiExecJobEvent[], serverId: number, stream: 'stdout' | 'stderr' = 'stdout'): string {
    const snapshot = events.find((event) => event.type === 'snapshot');
    const before = snapshot?.type === 'snapshot' ? snapshot.job.servers.find((item) => item.serverId === serverId)?.[stream] ?? '' : '';
    return before + events.map((event) => (event.type === 'output' && event.serverId === serverId && event.stream === stream ? event.data : '')).join('');
}

const lastJob = (events: MultiExecJobEvent[]) => [...events].reverse().find((event) => event.type === 'job' || event.type === 'snapshot') as
    | Extract<MultiExecJobEvent, { type: 'job' | 'snapshot' }>
    | undefined;

async function getJob(id: string): Promise<MultiExecJob> {
    const res = await api<{ data: MultiExecJob }>('GET', `/api/multiexec/jobs/${id}`);
    expect(res.status).toBe(200);
    return res.body.data;
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
}

async function waitForJob(id: string, check: (job: MultiExecJob) => boolean): Promise<MultiExecJob> {
    let job!: MultiExecJob;
    await waitFor(async () => check((job = await getJob(id))));
    return job;
}

const finalJob = (id: string) => waitForJob(id, (job) => isJobFinal(job.status));

async function jobAudit(jobId: string): Promise<AuditEntry[]> {
    const res = await api<{ data: AuditEntry[] }>('GET', '/api/audit?source=multi-exec&limit=500');
    return res.body.data.filter((entry) => entry.meta?.jobId === jobId);
}

// The job's commands (without the host name probes).
const auditFor = async (jobId: string) => (await jobAudit(jobId)).filter((entry) => !entry.meta?.probe);
const probesFor = async (jobId: string) => (await jobAudit(jobId)).filter((entry) => entry.meta?.probe);

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    for (let i = 0; i < 3; i += 1) harnesses.push(await startSshServer({ exec: scriptedExec }));
    const broken = await startSshServer({ exec: brokenExec });
    harnesses.push(broken);
    const [a, b, c] = harnesses;
    ids.a = await saveServer({ name: 'alpha', port: a.port });
    ids.b = await saveServer({ name: 'bravo', port: b.port });
    ids.c = await saveServer({ name: 'charlie', port: c.port });
    ids.a2 = await saveServer({ name: 'alpha-2', port: a.port });
    ids.down = await saveServer({ name: 'down', port: await closedPort() });
    ids.badAuth = await saveServer({ name: 'bad-auth', port: a.port, password: 'wrong' });
    ids.win = await saveServer({ name: 'win', type: 'windows', ssh_port: b.port, port: 3389 });
    ids.ftp = await saveServer({ name: 'ftp', type: 'ftp', port: 21 });
    ids.broken = await saveServer({ name: 'broken', port: broken.port });
    for (let i = 0; i < 10; i += 1) fleet.push(await saveServer({ name: `node-${i}`, port: c.port }));
});

afterAll(async () => {
    await server?.close();
    while (harnesses.length) await harnesses.pop()!.close();
    vi.restoreAllMocks();
});

describe('multi-exec jobs', () => {
    it('runs a command on several servers as a job and streams a snapshot, per-server events and the end', async () => {
        const info = await startJob({ command: 'echo hello', serverIds: [ids.a, ids.b, ids.c, ids.win], snippet: { id: 7, name: 'Greeting' } });
        expect(info).toMatchObject({ command: 'echo hello', masked: false, timeoutSec: 60, total: 4, batches: 1, status: 'running', snippet: { id: 7, name: 'Greeting' } });
        expect(info.strategy).toEqual({ concurrency: 5, batch: null, pauseSec: 0, canary: null, failureLimit: null });

        const events = await follow(info.id);
        expect(events[0].type).toBe('snapshot');
        expect(events.at(-1)).toEqual({ type: 'end' });
        expect(lastJob(events)?.job).toMatchObject({ status: 'done', finishedAt: expect.any(Number) });

        const results = resultsOf(events);
        const snapshot = events[0].type === 'snapshot' ? events[0].job : null;
        for (const id of [ids.a, ids.b, ids.c, ids.win]) {
            const result = results.get(id) ?? snapshot?.servers.find((item) => item.serverId === id);
            expect(result).toMatchObject({ status: 'ok', exitCode: 0, error: null, errorCode: null, truncated: false });
            expect(outputOf(events, id)).toBe('hello\n');
        }

        const job = await getJob(info.id);
        expect(job.servers.map((item) => item.name)).toEqual(['alpha', 'bravo', 'charlie', 'win']);
        expect(job.counts).toMatchObject({ ok: 4, failed: 0 });
        expect(job.servers.every((item) => item.stdout === 'hello\n' && item.outputHash && item.normalizedHash)).toBe(true);
        // Same output, same hash.
        expect(new Set(job.servers.map((item) => item.outputHash)).size).toBe(1);

        const audit = await auditFor(info.id);
        expect(audit).toHaveLength(4);
        expect(audit.map((entry) => entry.server_name).sort()).toEqual(['alpha', 'bravo', 'charlie', 'win']);
        expect(audit[0]).toMatchObject({
            source: 'multi-exec',
            command: 'echo hello',
            exit_code: 0,
            meta: expect.objectContaining({ status: 'ok', servers: 4, snippetId: 7, snippetName: 'Greeting' }),
        });
    });

    it('reports exit codes, stderr and connection failures per server', async () => {
        const { info, events } = await run({ command: 'mixed', serverIds: [ids.a, ids.down, ids.badAuth] });
        const job = await getJob(info.id);
        const byId = new Map(job.servers.map((item) => [item.serverId, item]));

        expect(byId.get(ids.a)).toMatchObject({ status: 'failed', exitCode: 2, error: null, stdout: 'out line\n', stderr: 'err line\n' });
        expect(outputOf(events, ids.a)).toBe('out line\n');
        expect(byId.get(ids.down)).toMatchObject({ status: 'failed', exitCode: null, errorCode: 'CONNECTION_REFUSED', outputHash: null });
        expect(byId.get(ids.down)!.error).toMatch(/ECONNREFUSED/);
        expect(byId.get(ids.badAuth)).toMatchObject({ status: 'failed', exitCode: null, errorCode: 'AUTH_FAILED' });
        expect(job.status).toBe('done');

        // Only the command that reached a server is in the audit log.
        const audit = await auditFor(info.id);
        expect(audit.map((entry) => [entry.server_id, entry.exit_code])).toEqual([[ids.a, 2]]);
    });

    it('times out commands that run too long and kills them', async () => {
        const [a] = harnesses;
        const { info } = await run({ command: 'hang', serverIds: [ids.a], timeoutSec: 1 });
        const [result] = (await getJob(info.id)).servers;
        expect(result).toMatchObject({ status: 'timeout', exitCode: null, errorCode: 'TIMEOUT' });
        expect(result.error).toMatch(/did not finish within 1s/);
        expect(result.durationMs).toBeGreaterThanOrEqual(900);
        await waitFor(() => a.log.includes('exec-closed:hang'));
        const [entry] = await auditFor(info.id);
        expect(entry).toMatchObject({ exit_code: null, meta: expect.objectContaining({ status: 'timeout' }) });
    });

    it('runs at most `concurrency` commands at a time', async () => {
        const harness = await startSshServer();
        harnesses.push(harness);
        const targets: number[] = [];
        for (let i = 0; i < 5; i += 1) targets.push(await saveServer({ name: `pool-${i}`, port: harness.port }));
        const { info } = await run({ command: 'sleep-ms 250', serverIds: targets, strategy: { concurrency: 2 } });
        expect((await getJob(info.id)).servers.map((item) => item.status)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
        expect(harness.maxActiveExecs()).toBe(2);
    });

    it('groups servers that differ only by their own host name, which it asks them once per connection', async () => {
        const named = (hostname: string) => (command: string, channel: ServerChannel) => {
            if (command === 'hostname') channel.write(`${hostname}\n`);
            else if (command === 'whoami-host') channel.write(`ready on ${hostname} pid [${Math.floor(Math.random() * 9000) + 1000}]\n`);
            else if (command !== 'quiet') return false;
            channel.exit(0);
            channel.end();
            return true;
        };
        const first = await startSshServer({ exec: named('db-primary-7') });
        const second = await startSshServer({ exec: named('db-replica-3') });
        harnesses.push(first, second);
        // Saved under names that are not their host names.
        const one = await saveServer({ name: 'database one', port: first.port });
        const two = await saveServer({ name: 'database two', port: second.port });
        // Nothing printed, nothing to group: no probe.
        const quiet = await run({ command: 'quiet', serverIds: [one, two] });
        expect(await probesFor(quiet.info.id)).toEqual([]);

        const { info } = await run({ command: 'whoami-host', serverIds: [one, two] });
        const [a, b] = (await getJob(info.id)).servers;
        expect(a.stdout).toMatch(/^ready on db-primary-7 pid \[\d+\]\n$/);
        expect(a.outputHash).not.toBe(b.outputHash);
        expect(a.normalizedHash).toBe(b.normalizedHash);
        expect((await auditFor(info.id)).map((entry) => entry.command)).toEqual(['whoami-host', 'whoami-host']);
        // The probe ran too, and is in the audit log as such.
        const probes = await probesFor(info.id);
        expect(probes.map((entry) => [entry.command, entry.exit_code]).sort()).toEqual([['hostname', 0], ['hostname', 0]]);
        expect(probes.map((entry) => entry.server_id).sort()).toEqual([one, two].sort());

        // The next job on the same connections does not ask again.
        const again = await run({ command: 'whoami-host', serverIds: [one, two] });
        const [c, d] = (await getJob(again.info.id)).servers;
        expect(c.normalizedHash).toBe(d.normalizedHash);
        expect(await probesFor(again.info.id)).toEqual([]);
        expect(first.log.filter((line) => line === 'exec:hostname')).toHaveLength(1);
        expect(second.log.filter((line) => line === 'exec:hostname')).toHaveLength(1);
    });

    it('caps the output kept per server, and keeps less of it in the history', async () => {
        const { info, events } = await run({ command: `spam ${400 * 1024}`, serverIds: [ids.b] });
        const result = resultsOf(events).get(ids.b)!;
        expect(result).toMatchObject({ status: 'ok', truncated: true });
        const streamed = events.filter((event) => event.type === 'output').reduce((sum, event) => sum + Buffer.byteLength(event.type === 'output' ? event.data : ''), 0);
        expect(streamed).toBe(256 * 1024);
        const [stored] = (await getJob(info.id)).servers;
        expect(Buffer.byteLength(stored.stdout) + Buffer.byteLength(stored.stderr)).toBe(64 * 1024);
        expect(stored).toMatchObject({ truncated: true, outputTrimmed: true });
        const [entry] = await auditFor(info.id);
        expect(entry.meta).toMatchObject({ truncated: true });
    });

    it('keeps running when the client closes the stream, and replays it to the next one', async () => {
        const [, , c] = harnesses;
        const info = await startJob({ command: 'sleep-ms 600', serverIds: [ids.c, fleet[0]], strategy: { concurrency: 1 } });
        const controller = new AbortController();
        await follow(info.id, {
            signal: controller.signal,
            onEvent: (event) => {
                if (event.type === 'running') controller.abort();
            },
        });
        // Reattached later: the snapshot has what happened meanwhile.
        await new Promise((resolve) => setTimeout(resolve, 700));
        const events = await follow(info.id);
        expect(events[0].type).toBe('snapshot');
        const snapshot = events[0].type === 'snapshot' ? events[0].job : null;
        expect(snapshot?.servers.find((item) => item.serverId === ids.c)).toMatchObject({ status: 'ok', stdout: 'slept\n' });
        expect(events.at(-1)).toEqual({ type: 'end' });
        expect((await getJob(info.id)).status).toBe('done');
        expect(c.log.filter((line) => line === 'exec-closed:sleep-ms 600').length).toBeGreaterThanOrEqual(2);
    });

    it('cancels running and queued commands through the cancel endpoint', async () => {
        const [a, b] = harnesses;
        const count = (harness: SshHarness, line: string) => harness.log.filter((entry) => entry === line).length;
        const before = { a: count(a, 'exec:hang'), b: count(b, 'exec:hang') };
        const info = await startJob({ command: 'hang', serverIds: [ids.a, ids.b, ids.c], strategy: { concurrency: 2 } });
        await waitFor(() => count(a, 'exec:hang') > before.a && count(b, 'exec:hang') > before.b);
        const cancelled = await api<{ data: MultiExecJobInfo }>('POST', `/api/multiexec/jobs/${info.id}/cancel`);
        expect(cancelled.status).toBe(200);

        const job = await finalJob(info.id);
        expect(job.status).toBe('cancelled');
        const byId = new Map(job.servers.map((item) => [item.serverId, item]));
        expect(byId.get(ids.a)).toMatchObject({ status: 'cancelled' });
        expect(byId.get(ids.b)).toMatchObject({ status: 'cancelled' });
        expect(byId.get(ids.c)).toMatchObject({ status: 'cancelled', startedAt: null });
        await waitFor(() => count(a, 'exec-closed:hang') > before.a && count(b, 'exec-closed:hang') > before.b);

        expect((await api<{ code: string }>('POST', `/api/multiexec/jobs/${info.id}/cancel`)).body.code).toBe('MULTIEXEC_JOB_FINISHED');
        expect((await auditFor(info.id)).map((entry) => entry.meta?.status)).toEqual(['cancelled', 'cancelled']);
    });

    it('starts no job when the client leaves while the request is being checked', async () => {
        const { serversRepo } = await import('../../server/db/serversRepo');
        const getSummary = serversRepo.getSummary.bind(serversRepo);
        let checking!: () => void;
        const checked = new Promise<void>((resolve) => { checking = resolve; });
        let resume!: () => void;
        const gate = new Promise<void>((resolve) => { resume = resolve; });
        const spy = vi.spyOn(serversRepo, 'getSummary').mockImplementation(async (id: number) => {
            checking();
            await gate;
            return getSummary(id);
        });
        const [, , c] = harnesses;
        const command = 'echo left-early';
        try {
            const controller = new AbortController();
            const request = server.fetch('/api/multiexec', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ command, serverIds: [ids.c] }),
                signal: controller.signal,
            }).catch(() => undefined);
            await checked;
            controller.abort();
            await request;
            // Time for the backend to see the connection close.
            await new Promise((resolve) => setTimeout(resolve, 200));
        } finally {
            resume();
            spy.mockRestore();
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
        expect(c.log).not.toContain(`exec:${command}`);
        const jobs = await api<{ data: MultiExecJobInfo[] }>('GET', '/api/multiexec/jobs?limit=200');
        expect(jobs.body.data.filter((job) => job.command === command)).toEqual([]);
    });

    it('validates the request', async () => {
        const cases: Array<[Record<string, unknown>, RegExp]> = [
            [{ serverIds: [ids.a] }, /command is required/],
            [{ command: '   ', serverIds: [ids.a] }, /command is required/],
            [{ command: 'x'.repeat(10_001), serverIds: [ids.a] }, /longer than/],
            [{ command: 'ls', serverIds: [] }, /at least one server/],
            [{ command: 'ls', serverIds: ['1'] }, /positive integers/],
            [{ command: 'ls', serverIds: Array.from({ length: 201 }, (_, i) => i + 1) }, /at most 200/],
            [{ command: 'ls', serverIds: [ids.a], timeoutSec: 0 }, /timeoutSec/],
            [{ command: 'ls', serverIds: [ids.a], timeoutSec: 3601 }, /timeoutSec/],
            [{ command: 'ls', serverIds: [ids.a], concurrency: 21 }, /concurrency/],
            [{ command: 'ls', serverIds: [ids.a], snippet: { name: '' } }, /snippet.name/],
            [{ command: 'ls', serverIds: [ids.a, ids.b], strategy: { canary: { count: 2 } } }, /canary must be smaller/],
            [{ command: 'ls', serverIds: [ids.a], strategy: { batch: { size: 0, unit: 'servers' } } }, /strategy.batch.size/],
            [{ command: 'ls', serverIds: [ids.a], strategy: { batch: { size: 101, unit: 'percent' } } }, /strategy.batch.size/],
            [{ command: 'ls', serverIds: [ids.a], strategy: { batch: { size: 1, unit: 'nodes' } } }, /strategy.batch.unit/],
            [{ command: 'ls', serverIds: [ids.a], strategy: { pauseSec: -1 } }, /pauseSec/],
            [{ command: 'ls', serverIds: [ids.a], strategy: { failureLimit: { percent: 0 } } }, /failureLimit.percent/],
            [{ command: 'ls {{dir}}', variables: {}, serverIds: [ids.a] }, /Fill in: dir/],
            [{ command: 'ls', variables: { 'bad name': 'x' }, serverIds: [ids.a] }, /not a variable name/],
            [{ command: 'ls', serverIds: [ids.a], rerunOf: 'nope' }, /rerunOf/],
        ];
        for (const [body, message] of cases) {
            const res = await api<{ error: string; code: string }>('POST', '/api/multiexec', body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(res.body.code).toBe('INVALID_MULTIEXEC');
            expect(res.body.error).toMatch(message);
        }

        const missing = await api<{ code: string; details: unknown }>('POST', '/api/multiexec', { command: 'ls', serverIds: [ids.a, 987_654] });
        expect(missing.body.details).toEqual({ missing: [987_654] });
        const unsupported = await api<{ code: string; details: unknown }>('POST', '/api/multiexec', { command: 'ls', serverIds: [ids.a, ids.ftp] });
        expect(unsupported.body.details).toEqual({ unsupported: [ids.ftp] });
        expect((await api('GET', '/api/multiexec/jobs/not-a-job')).status).toBe(404);
        expect((await api('GET', '/api/multiexec/jobs/00000000-0000-4000-8000-000000000000')).status).toBe(404);
    });

    it('limits how many jobs can run at once', async () => {
        const started: MultiExecJobInfo[] = [];
        for (let i = 0; i < 4; i += 1) started.push(await startJob({ command: 'hang', serverIds: [ids.a2] }));
        const busy = await api<{ code: string }>('POST', '/api/multiexec', { command: 'ls', serverIds: [ids.a] });
        expect(busy.status).toBe(429);
        expect(busy.body.code).toBe('MULTIEXEC_BUSY');
        const active = await api<{ data: MultiExecJobInfo[] }>('GET', '/api/multiexec/jobs?active=1');
        expect(active.body.data.map((job) => job.id).sort()).toEqual(started.map((job) => job.id).sort());
        for (const job of started) await api('POST', `/api/multiexec/jobs/${job.id}/cancel`);
        for (const job of started) await finalJob(job.id);
    });
});

describe('rollout strategies', () => {
    it('runs batches one after the other', async () => {
        const targets = fleet.slice(0, 6);
        const info = await startJob({ command: 'sleep-ms 150', serverIds: targets, strategy: { concurrency: 5, batch: { size: 2, unit: 'servers' } } });
        expect(info.batches).toBe(3);
        const job = await finalJob(info.id);
        expect(job.status).toBe('done');
        expect(job.servers.map((item) => item.batch)).toEqual([0, 0, 1, 1, 2, 2]);
        for (const batch of [1, 2]) {
            const previous = job.servers.filter((item) => item.batch === batch - 1);
            const current = job.servers.filter((item) => item.batch === batch);
            expect(Math.min(...current.map((item) => item.startedAt!))).toBeGreaterThanOrEqual(Math.max(...previous.map((item) => item.finishedAt!)));
        }
        const audit = await auditFor(info.id);
        expect(audit.map((entry) => entry.meta?.batch).sort()).toEqual([1, 1, 2, 2, 3, 3]);
    });

    it('waits between batches when asked to', async () => {
        const { info, events } = await run({ command: 'echo ok', serverIds: fleet.slice(0, 2), strategy: { batch: { size: 50, unit: 'percent' }, pauseSec: 1 } });
        const waiting = events.find((event) => event.type === 'job' && event.job.nextBatchAt !== null);
        expect(waiting?.type === 'job' && waiting.job.nextBatchAt! - waiting.job.createdAt).toBeGreaterThanOrEqual(900);
        const job = await getJob(info.id);
        expect(job.servers[1].startedAt! - job.servers[0].finishedAt!).toBeGreaterThanOrEqual(900);
    });

    it('pauses after a successful canary until it is approved', async () => {
        const targets = fleet.slice(0, 5);
        const info = await startJob({ command: 'deploy', serverIds: targets, strategy: { canary: { count: 1, onSuccess: 'pause' } } });
        expect(info.batches).toBe(2);
        const paused = await waitForJob(info.id, (job) => job.status === 'paused');
        expect(paused.pause).toMatchObject({ reason: 'canary', expiresAt: expect.any(Number) });
        expect(paused.servers.map((item) => item.status)).toEqual(['ok', 'queued', 'queued', 'queued', 'queued']);

        // Nothing starts while it waits.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect((await getJob(info.id)).servers.filter((item) => item.status !== 'queued')).toHaveLength(1);

        const resumed = await api<{ data: MultiExecJobInfo }>('POST', `/api/multiexec/jobs/${info.id}/resume`);
        expect(resumed.body.data).toMatchObject({ status: 'running', pause: null });
        const job = await finalJob(info.id);
        expect(job.status).toBe('done');
        expect(job.counts.ok).toBe(5);
    });

    // CR-02: the pause is the time to watch the canary before the rest; it
    // started the next batch 12 ms after the canary.
    it('waits the pause after a canary that goes on by itself, as between batches', async () => {
        const { info, events } = await run({ command: 'echo ok', serverIds: fleet.slice(0, 3), strategy: { batch: { size: 1, unit: 'servers' }, pauseSec: 1, canary: { count: 1, onSuccess: 'continue' }, concurrency: 1 } });
        expect(info.batches).toBe(3);
        const job = await getJob(info.id);
        expect(job.servers[1].startedAt! - job.servers[0].finishedAt!).toBeGreaterThanOrEqual(900);
        expect(job.servers[2].startedAt! - job.servers[1].finishedAt!).toBeGreaterThanOrEqual(900);
        expect(events.filter((event) => event.type === 'job' && event.job.nextBatchAt !== null)).toHaveLength(2);
    });

    it('goes on by itself after a successful canary when told to, and waits after a failed one', async () => {
        const auto = await startJob({ command: 'deploy', serverIds: fleet.slice(0, 3), strategy: { canary: { count: 1, onSuccess: 'continue' } } });
        expect((await finalJob(auto.id)).counts.ok).toBe(3);

        const failing = await startJob({ command: 'deploy', serverIds: [ids.broken, ...fleet.slice(0, 3)], strategy: { canary: { count: 1, onSuccess: 'continue' } } });
        const paused = await waitForJob(failing.id, (job) => job.status === 'paused');
        expect(paused.pause?.reason).toBe('canary-failed');
        expect(paused.servers[0]).toMatchObject({ status: 'failed', exitCode: 1, stderr: 'deploy failed: disk full\n' });
        await api('POST', `/api/multiexec/jobs/${failing.id}/cancel`);
        const job = await finalJob(failing.id);
        expect(job.status).toBe('cancelled');
        expect(job.servers.slice(1).map((item) => item.status)).toEqual(['cancelled', 'cancelled', 'cancelled']);
    });

    it('keeps the canary decision when the user paused during the canary', async () => {
        // The canary fails after the user paused: resuming must read as "continue anyway".
        const failing = await startJob({ command: 'fail-after-ms 600', serverIds: fleet.slice(0, 3), strategy: { canary: { count: 1, onSuccess: 'continue' } } });
        await waitForJob(failing.id, (job) => job.servers[0].status === 'running');
        expect((await api<{ data: MultiExecJobInfo }>('POST', `/api/multiexec/jobs/${failing.id}/pause`)).body.data.pause?.reason).toBe('user');
        const gated = await waitForJob(failing.id, (job) => job.servers[0].status === 'failed' && job.pause?.reason !== 'user');
        expect(gated).toMatchObject({ status: 'paused', pause: { reason: 'canary-failed' } });
        expect(gated.servers.slice(1).map((item) => item.status)).toEqual(['queued', 'queued']);
        await api('POST', `/api/multiexec/jobs/${failing.id}/cancel`);
        expect((await finalJob(failing.id)).servers.slice(1).map((item) => item.status)).toEqual(['cancelled', 'cancelled']);

        // A canary that passes while paused asks for its approval.
        const passing = await startJob({ command: 'sleep-ms 500', serverIds: fleet.slice(0, 3), strategy: { canary: { count: 1, onSuccess: 'pause' } } });
        await waitForJob(passing.id, (job) => job.servers[0].status === 'running');
        await api('POST', `/api/multiexec/jobs/${passing.id}/pause`);
        const approval = await waitForJob(passing.id, (job) => job.servers[0].status === 'ok' && job.pause?.reason !== 'user');
        expect(approval.pause?.reason).toBe('canary');
        await api('POST', `/api/multiexec/jobs/${passing.id}/resume`);
        expect((await finalJob(passing.id)).counts.ok).toBe(3);

        // With no decision to ask for, the user's pause stays.
        const auto = await startJob({ command: 'sleep-ms 500', serverIds: fleet.slice(0, 2), strategy: { canary: { count: 1, onSuccess: 'continue' } } });
        await waitForJob(auto.id, (job) => job.servers[0].status === 'running');
        await api('POST', `/api/multiexec/jobs/${auto.id}/pause`);
        await waitForJob(auto.id, (job) => job.servers[0].status === 'ok');
        await new Promise((resolve) => setTimeout(resolve, 200));
        expect((await getJob(auto.id))).toMatchObject({ status: 'paused', pause: { reason: 'user' } });
        await api('POST', `/api/multiexec/jobs/${auto.id}/cancel`);
        await finalJob(auto.id);
    });

    it('stops at the failure limit and leaves the rest out', async () => {
        const harness = await startSshServer({ exec: brokenExec });
        harnesses.push(harness);
        const broken: number[] = [];
        for (let i = 0; i < 3; i += 1) broken.push(await saveServer({ name: `broken-${i}`, port: harness.port }));
        const info = await startJob({
            command: 'deploy',
            serverIds: [...broken, ...fleet.slice(0, 4)],
            strategy: { concurrency: 1, failureLimit: { count: 2, percent: null } },
        });
        const job = await finalJob(info.id);
        expect(job).toMatchObject({ status: 'stopped', stopReason: 'failure-limit' });
        expect(job.servers.map((item) => item.status)).toEqual(['failed', 'failed', 'skipped', 'skipped', 'skipped', 'skipped', 'skipped']);
        expect(job.counts).toMatchObject({ failed: 2, skipped: 5 });
        // Skipped servers never got the command.
        expect(await auditFor(info.id)).toHaveLength(2);
    });

    it('can be paused and resumed by the user', async () => {
        const info = await startJob({ command: 'sleep-ms 200', serverIds: fleet.slice(0, 4), strategy: { concurrency: 1 } });
        await waitForJob(info.id, (job) => job.servers[0].status === 'running');
        const paused = await api<{ data: MultiExecJobInfo }>('POST', `/api/multiexec/jobs/${info.id}/pause`);
        expect(paused.body.data).toMatchObject({ status: 'paused', pause: { reason: 'user' } });
        // The running server finishes; the next one does not start.
        await waitForJob(info.id, (job) => job.servers[0].status === 'ok');
        await new Promise((resolve) => setTimeout(resolve, 400));
        expect((await getJob(info.id)).servers.slice(1).map((item) => item.status)).toEqual(['queued', 'queued', 'queued']);
        await api('POST', `/api/multiexec/jobs/${info.id}/resume`);
        expect((await finalJob(info.id)).counts.ok).toBe(4);
    });

    it('stops a job nobody resumes in time', async () => {
        const { createJobManager } = await import('../../server/multiexec/jobs');
        const { parseJobRequest } = await import('../../server/multiexec/request');
        const jobs = createJobManager({ limits: { pauseTimeoutMs: 300 } });
        const info = await jobs.start(await parseJobRequest({ command: 'deploy', serverIds: fleet.slice(0, 3), strategy: { canary: { count: 1 } } }));
        await waitForJob(info.id, (job) => job.status === 'paused');
        const job = await finalJob(info.id);
        expect(job).toMatchObject({ status: 'stopped', stopReason: 'pause-timeout' });
        expect(job.servers.map((item) => item.status)).toEqual(['ok', 'skipped', 'skipped']);
    });
});

describe('secrets and safety', () => {
    it('runs secret values but never records them: audit log, job history and output', async () => {
        const info = await startJob({
            command: 'echo user={{user}} pass={{password}} key={{apikey:secret}} plain={{label}}',
            variables: { user: 'deploy', password: SECRET, apikey: 'k3y-value-123', label: 'note-xyz' },
            secretVariables: ['label'],
            serverIds: [ids.a, ids.b],
        });
        expect(info).toMatchObject({
            command: 'echo user=deploy pass={{password}} key={{apikey}} plain={{label}}',
            masked: true,
            template: 'echo user={{user}} pass={{password}} key={{apikey:secret}} plain={{label}}',
            variables: { user: 'deploy' },
        });
        expect(info.secretVariables.sort()).toEqual(['apikey', 'label', 'password']);

        const events = await follow(info.id);
        // The server got the real values; what came back is masked.
        expect(harnesses[0].log).toContain(`exec:echo user=deploy pass=${SECRET} key=k3y-value-123 plain=note-xyz`);
        expect(outputOf(events, ids.a)).toBe('user=deploy pass={{password}} key={{apikey}} plain={{label}}\n');
        expect(JSON.stringify(events)).not.toContain(SECRET);

        const job = await getJob(info.id);
        expect(JSON.stringify(job)).not.toContain(SECRET);
        expect(JSON.stringify(job)).not.toContain('k3y-value-123');
        expect(JSON.stringify(job)).not.toContain('note-xyz');
        const audit = await auditFor(info.id);
        expect(audit).toHaveLength(2);
        expect(audit.every((entry) => entry.command === 'echo user=deploy pass={{password}} key={{apikey}} plain={{label}}')).toBe(true);
        expect(JSON.stringify(audit)).not.toContain(SECRET);

        // Nothing on disk either: every table, and the stored outputs unpacked.
        const { dbAll } = await import('../../server/db/sqlite');
        const tables = await dbAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'audit_log_search%'");
        for (const { name } of tables) {
            const rows = await dbAll<Record<string, unknown>>(`SELECT * FROM "${name}"`);
            const text = rows.map((row) => Object.values(row).map((value) => (Buffer.isBuffer(value) ? gunzipSync(value).toString('utf8') : String(value))).join('\u0000')).join('\n');
            expect(text, name).not.toContain(SECRET);
            expect(text, name).not.toContain('k3y-value-123');
        }
        for (const file of fs.readdirSync(server.dataDir).filter((entry) => entry.startsWith('shellmind.db'))) {
            expect(fs.readFileSync(path.join(server.dataDir, file)).includes(Buffer.from(SECRET)), file).toBe(false);
        }
    });

    it('masks a secret value split across two output packets', async () => {
        const { info, events } = await run({ command: 'split-echo {{token}}', variables: { token: SECRET }, serverIds: [ids.c] });
        expect(outputOf(events, ids.c)).toBe('a{{token}}z\n');
        expect((await getJob(info.id)).servers[0].stdout).toBe('a{{token}}z\n');
    });

    it('masks secret-looking text typed straight into a command', async () => {
        const info = await startJob({ command: 'echo connect --password=PlainTextPw1 --verbose', serverIds: [ids.a] });
        expect(info).toMatchObject({ command: 'echo connect --password=[REDACTED] --verbose', masked: true, template: null, templateMasked: false });
        await finalJob(info.id);
        const [entry] = await auditFor(info.id);
        expect(entry.command).toBe('echo connect --password=[REDACTED] --verbose');
    });

    it('masks secret-looking text typed into a template, and keeps its placeholders', async () => {
        const command = 'quiet -u root --password=hunter2xyz -e "select {{n:1}}" -H "Authorization: Bearer {{token}}" AWS_SECRET_ACCESS_KEY=abcdEFGH1234';
        const info = await startJob({ command, variables: { n: '2', token: 'tok-value-9876' }, serverIds: [ids.c] });
        // The secret variable stays a placeholder in the recorded command too:
        // it is not taken for the credential it stands for.
        expect(info).toMatchObject({
            command: 'quiet -u root --password=[REDACTED] -e "select 2" -H "Authorization: Bearer {{token}}" AWS_SECRET_ACCESS_KEY=[REDACTED]',
            template: 'quiet -u root --password=[REDACTED] -e "select {{n:1}}" -H "Authorization: Bearer {{token}}" AWS_SECRET_ACCESS_KEY=[REDACTED]',
            templateMasked: true,
            variables: { n: '2' },
        });
        await finalJob(info.id);
        expect(harnesses[2].log).toContain(`exec:${command.replace('{{n:1}}', '2').replace('{{token}}', 'tok-value-9876')}`);
        const listed = await api<{ data: MultiExecJobInfo[] }>('GET', '/api/multiexec/jobs?limit=200');
        const shown = JSON.stringify([listed.body.data.find((job) => job.id === info.id), await getJob(info.id), await auditFor(info.id)]);
        for (const secret of ['hunter2xyz', 'abcdEFGH1234', 'tok-value-9876']) expect(shown).not.toContain(secret);

        const { dbAll } = await import('../../server/db/sqlite');
        const rows = await dbAll<Record<string, unknown>>('SELECT * FROM multiexec_jobs WHERE id = ?', [info.id]);
        expect(rows[0].template_masked).toBe(1);
        for (const secret of ['hunter2xyz', 'abcdEFGH1234', 'tok-value-9876']) expect(JSON.stringify(rows)).not.toContain(secret);

        // A template whose placeholder reads as part of a secret is masked as a whole.
        const url = await startJob({ command: 'quiet https://{{user}}:{{pw}}@host/x', variables: { user: 'u1', pw: 'pw-value-1234' }, serverIds: [ids.c] });
        expect(url).toMatchObject({ template: 'quiet https://{{user}}:[REDACTED]@host/x', templateMasked: true });
        await finalJob(url.id);

        // Without typed secrets the template is kept as it is.
        const plain = await startJob({ command: 'quiet --password={{pw}} -n {{n:1}}', variables: { pw: 'pw-value-5678' }, serverIds: [ids.c] });
        expect(plain).toMatchObject({ template: 'quiet --password={{pw}} -n {{n:1}}', templateMasked: false, command: 'quiet --password={{pw}} -n 1' });
        await finalJob(plain.id);
    });

    it('masks a secret typed right after a placeholder, whether the variable is a secret or not', async () => {
        const command = 'quiet --password={{env}}hunter2xyz && mysql -u root -p{{x}}Secret99 && export DB_PASS={{env}}Sup3rS3cret';
        const typed = ['hunter2xyz', 'Secret99', 'Sup3rS3cret'];
        const { dbAll } = await import('../../server/db/sqlite');
        for (const secretVariables of [[], ['env', 'x']]) {
            const info = await startJob({ command, variables: { env: 'e1', x: 'x1' }, secretVariables, serverIds: [ids.c] });
            expect(info).toMatchObject({ masked: true, templateMasked: true });
            await finalJob(info.id);
            const [entry] = await auditFor(info.id);
            const rows = await dbAll<Record<string, unknown>>('SELECT * FROM multiexec_jobs WHERE id = ?', [info.id]);
            for (const recorded of [info.command, info.template, (await getJob(info.id)).command, entry.command, JSON.stringify(rows)]) {
                for (const secret of typed) expect(recorded).not.toContain(secret);
            }
        }
        expect(harnesses[2].log).toContain('exec:quiet --password=e1hunter2xyz && mysql -u root -px1Secret99 && export DB_PASS=e1Sup3rS3cret');
    });

    it('records a secret-looking variable the user unmarked as an ordinary one', async () => {
        const info = await startJob({ command: 'quiet --pin {{pin:v1}} --token {{token}}', variables: { pin: 'v2', token: 'tok-value-4321' }, publicVariables: ['pin'], serverIds: [ids.c] });
        expect(info).toMatchObject({ command: 'quiet --pin v2 --token {{token}}', variables: { pin: 'v2' }, secretVariables: ['token'] });
        await finalJob(info.id);
        const declared = await api<{ data: { job: MultiExecJobInfo } }>('POST', '/api/multiexec', {
            command: 'quiet {{key:secret}}', variables: { key: 'k-value-1' }, publicVariables: ['key'], serverIds: [ids.c],
        });
        // A declared secret stays one.
        expect(declared.body.data.job).toMatchObject({ command: 'quiet {{key}}', secretVariables: ['key'] });
        await finalJob(declared.body.data.job.id);
        expect((await api<{ code: string }>('POST', '/api/multiexec', { command: 'ls {{a}}', variables: { a: 'x' }, publicVariables: 'a', serverIds: [ids.c] })).body.code)
            .toBe('INVALID_MULTIEXEC');
    });

    it('refuses a destructive command unless it was confirmed', async () => {
        const refused = await api<{ code: string; details: { reason: string; line: string } }>('POST', '/api/multiexec', {
            command: 'rm -rf {{dir}}/', variables: { dir: '/' }, serverIds: [ids.a],
        });
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'DANGEROUS_COMMAND', details: { reason: 'recursive-delete' } });

        const secretLine = await api<{ details: { line: string } }>('POST', '/api/multiexec', {
            command: 'echo {{password}} && rm -rf /', variables: { password: SECRET }, serverIds: [ids.a],
        });
        expect(secretLine.status).toBe(409);
        expect(secretLine.body.details.line).not.toContain(SECRET);

        const info = await startJob({ command: 'echo all good', serverIds: [ids.a] });
        expect(info.danger).toBeNull();
        const confirmed = await startJob({ command: 'echo nothing; reboot', serverIds: [ids.a], confirmDangerous: true });
        expect(confirmed.danger).toBe('power');
        await finalJob(info.id);
        await finalJob(confirmed.id);
    });
});

describe('job history', () => {
    it('lists, opens and deletes jobs; running ones cannot be deleted', async () => {
        const done = await startJob({ command: 'echo history', serverIds: [ids.a] });
        await finalJob(done.id);
        const running = await startJob({ command: 'hang', serverIds: [ids.b] });
        await waitForJob(running.id, (job) => job.servers[0].status === 'running');

        const list = await api<{ data: MultiExecJobInfo[] }>('GET', '/api/multiexec/jobs?limit=5');
        expect(list.body.data[0]).toMatchObject({ id: running.id, status: 'running', counts: expect.objectContaining({ running: 1 }) });
        expect(list.body.data[1]).toMatchObject({ id: done.id, status: 'done', counts: expect.objectContaining({ ok: 1 }) });
        const older = await api<{ data: MultiExecJobInfo[] }>('GET', `/api/multiexec/jobs?limit=5&before=${list.body.data[1].createdAt}`);
        expect(older.body.data.map((job) => job.id)).not.toContain(done.id);

        expect((await api<{ code: string }>('DELETE', `/api/multiexec/jobs/${running.id}`)).body.code).toBe('MULTIEXEC_JOB_ACTIVE');
        expect((await api('DELETE', `/api/multiexec/jobs/${done.id}`)).status).toBe(200);
        expect((await api('GET', `/api/multiexec/jobs/${done.id}`)).status).toBe(404);
        // The audit log keeps what ran.
        expect(await auditFor(done.id)).toHaveLength(1);

        await api('POST', `/api/multiexec/jobs/${running.id}/cancel`);
        await finalJob(running.id);
        const cleared = await api<{ data: { deleted: number } }>('DELETE', '/api/multiexec/jobs');
        expect(cleared.body.data.deleted).toBeGreaterThan(0);
        expect((await api<{ data: MultiExecJobInfo[] }>('GET', '/api/multiexec/jobs')).body.data).toEqual([]);
    });

    it('marks jobs left running by an earlier process as interrupted', async () => {
        const { dbRun } = await import('../../server/db/sqlite');
        const id = '11111111-2222-4333-8444-555555555555';
        await dbRun(
            `INSERT INTO multiexec_jobs (id, command, timeout_sec, strategy, status, batches, total, created_at)
             VALUES (?, 'uptime', 60, '{}', 'running', 1, 2, ?)`,
            [id, Date.now()]
        );
        await dbRun(`INSERT INTO multiexec_job_results (job_id, position, server_id, server_name, host, server_type, batch, status, started_at)
            VALUES (?, 0, 1, 'one', '10.0.0.1', 'linux', 0, 'running', ?), (?, 1, 2, 'two', '10.0.0.2', 'linux', 0, 'queued', NULL)`, [id, Date.now() - 1000, id]);
        const { createJobManager } = await import('../../server/multiexec/jobs');
        await createJobManager().ready;
        const job = await getJob(id);
        expect(job).toMatchObject({ status: 'interrupted', finishedAt: expect.any(Number) });
        expect(job.servers.map((item) => [item.status, item.errorCode])).toEqual([['cancelled', 'INTERRUPTED'], ['skipped', null]]);
        const events = await follow(id);
        expect(events.map((event) => event.type)).toEqual(['snapshot', 'end']);
    });

    it('records the jobs running at shutdown as interrupted, and starts no more', async () => {
        const { createJobManager } = await import('../../server/multiexec/jobs');
        const { parseJobRequest } = await import('../../server/multiexec/request');
        const jobs = createJobManager();
        await jobs.ready;
        const [a] = harnesses;
        const count = (line: string) => a.log.filter((entry) => entry === line).length;
        const startedBefore = count('exec:hang');
        const closedBefore = count('exec-closed:hang');
        const info = await jobs.start(await parseJobRequest({ command: 'hang', serverIds: [ids.a, ids.b], strategy: { concurrency: 1 } }));
        // (The history has a server's state once it ends: the harness tells when it started.)
        await waitFor(() => count('exec:hang') > startedBefore);

        await jobs.shutdown();
        const job = await getJob(info.id);
        expect(job).toMatchObject({ status: 'interrupted', finishedAt: expect.any(Number) });
        expect(job.servers.map((item) => [item.status, item.errorCode])).toEqual([['cancelled', 'INTERRUPTED'], ['skipped', null]]);
        await waitFor(() => count('exec-closed:hang') > closedBefore);
        await expect(jobs.start(await parseJobRequest({ command: 'echo late', serverIds: [ids.a] }))).rejects.toMatchObject({ code: 'MULTIEXEC_CLOSING', status: 503 });
    });
});

describe('runMultiExec', () => {
    it('gives up on a server that is still connecting when the run is cancelled', async () => {
        const { runMultiExec } = await import('../../server/multiexec/runner');
        const release = vi.fn();
        let resolveLease: (lease: never) => void = () => undefined;
        const record = vi.fn(async () => undefined);
        const controller = new AbortController();
        const events: MultiExecJobEvent[] = [];

        const results = runMultiExec({
            command: 'uptime',
            targets: [{ serverId: 1, name: 'slow', host: '10.0.0.1', type: 'linux' }, { serverId: 2, name: 'next', host: '10.0.0.2', type: 'linux' }],
            timeoutMs: 60_000,
            concurrency: 1,
            signal: controller.signal,
            emit: (event) => events.push(event),
        }, {
            acquire: () => new Promise((resolve) => { resolveLease = resolve; }),
            record,
            complete: vi.fn(async () => undefined),
        });

        await waitFor(() => events.some((event) => event.type === 'running'));
        controller.abort();
        const done: MultiExecResult[] = await results;
        expect(done.map((result) => result.status)).toEqual(['cancelled', 'cancelled']);
        expect(done[1].startedAt).toBeNull();
        expect(record).not.toHaveBeenCalled();

        // The connection that completes afterwards is handed straight back.
        resolveLease({ serverId: 1, client: {}, target: {}, release, onClose: () => () => undefined } as never);
        await waitFor(() => release.mock.calls.length === 1);
    });

    it('counts the timeout from the start, so a server that never connects times out', async () => {
        const { runMultiExec } = await import('../../server/multiexec/runner');
        const release = vi.fn();
        let resolveLease: (lease: never) => void = () => undefined;
        const record = vi.fn(async () => undefined);

        const started = Date.now();
        const [result] = await runMultiExec({
            command: 'uptime',
            targets: [{ serverId: 1, name: 'blackhole', host: '10.255.255.1', type: 'linux' }],
            timeoutMs: 1000,
            concurrency: 1,
            signal: new AbortController().signal,
            emit: () => undefined,
        }, {
            acquire: () => new Promise((resolve) => { resolveLease = resolve; }),
            record,
            complete: vi.fn(async () => undefined),
        });
        expect(result).toMatchObject({ status: 'timeout', exitCode: null, errorCode: 'CONNECT_TIMEOUT', error: 'Could not connect within 1s' });
        expect(Date.now() - started).toBeLessThan(5_000);
        expect(record).not.toHaveBeenCalled();

        resolveLease({ serverId: 1, client: {}, target: {}, release, onClose: () => () => undefined } as never);
        await waitFor(() => release.mock.calls.length === 1);
    });

    it('leaves out the servers it is told to skip', async () => {
        const { runMultiExec } = await import('../../server/multiexec/runner');
        const acquire = vi.fn(async () => { throw new Error('should not connect'); });
        const [result] = await runMultiExec({
            command: 'uptime',
            targets: [{ serverId: 1, name: 'one', host: '10.0.0.1', type: 'linux' }],
            timeoutMs: 1000,
            concurrency: 1,
            signal: new AbortController().signal,
            emit: () => undefined,
            beforeStart: async () => false,
        }, { acquire, record: vi.fn(async () => undefined), complete: vi.fn(async () => undefined) });
        expect(result).toMatchObject({ status: 'skipped', startedAt: null });
        expect(acquire).not.toHaveBeenCalled();
    });

    it('names the kind of connection failure', async () => {
        const { connectionFailureCode } = await import('../../server/multiexec/runner');
        const { HostKeyMismatchError } = await import('../../server/ssh/hostKeys');
        const failure = (fields: Record<string, unknown>) => Object.assign(new Error('x'), fields);
        expect(connectionFailureCode(new HostKeyMismatchError('h', 22, 'ssh-ed25519', 'SHA256:a', 'SHA256:b'))).toBe('HOST_KEY_MISMATCH');
        expect(connectionFailureCode(failure({ level: 'client-authentication' }))).toBe('AUTH_FAILED');
        expect(connectionFailureCode(failure({ level: 'client-timeout' }))).toBe('HANDSHAKE_TIMEOUT');
        expect(connectionFailureCode(failure({ code: 'ECONNREFUSED' }))).toBe('CONNECTION_REFUSED');
        expect(connectionFailureCode(failure({ code: 'ENOTFOUND' }))).toBe('HOST_NOT_FOUND');
        expect(connectionFailureCode(failure({ code: 'EHOSTUNREACH' }))).toBe('HOST_UNREACHABLE');
        expect(connectionFailureCode(failure({ code: 'SECRET_UNREADABLE' }))).toBeNull();
        expect(connectionFailureCode('boom')).toBeNull();
    });

    it('keeps output within the cap without splitting characters', async () => {
        const { clampUtf8 } = await import('../../server/multiexec/runner');
        expect(clampUtf8('añb', 2)).toBe('a');
        expect(clampUtf8('añb', 3)).toBe('añ');
        expect(clampUtf8('abc', 10)).toBe('abc');
        expect(clampUtf8('abc', 0)).toBe('');
    });
});
