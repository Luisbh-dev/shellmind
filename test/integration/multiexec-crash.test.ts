import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MultiExecJob } from '../../shared/multiexec';
import type { AuditEntry } from '../../shared/types';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { PROCESS_TEST_TIMEOUT_MS } from '../setup/timeouts';

// CR-01: a backend that dies while a multi-exec command runs (an uncaught
// exception, a kill, a power cut) must leave the job history and the audit
// log saying the command was sent there, not "not run". The real entry point
// runs in a process of its own, is killed with SIGKILL while the command
// hangs on the server, and is started again on the same database.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;
const INHERITED_BACKEND_VARS = ['SHELLMIND_AUTH_TOKEN', 'PORT', 'HOST', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'SERVE_WEB', 'WEB_DIR', 'LOG_LEVEL', 'SHELLMIND_DEBUG', 'DB_PATH'];

let harness: SshHarness;
let tmpDir: string;
const token = randomBytes(24).toString('base64url');
const children: ChildProcess[] = [];

type Backend = { child: ChildProcess; base: string; exit: Promise<number | null> };

// The backend itself in the forked process (no tsx wrapper process), so
// that killing the child kills the backend.
async function startBackend(): Promise<Backend> {
    const inherited = { ...process.env };
    for (const name of INHERITED_BACKEND_VARS) delete inherited[name];
    const child = fork(path.join(repoRoot, 'server.ts'), [], {
        cwd: repoRoot,
        execArgv: ['--import', tsxLoader],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
            ...inherited,
            TSX_TSCONFIG_PATH: path.join(repoRoot, 'tsconfig.server.json'),
            HOST: '127.0.0.1',
            PORT: '0',
            SHELLMIND_AUTH_TOKEN: token,
            DB_PATH: path.join(tmpDir, 'shellmind.db'),
            DOTENV_CONFIG_PATH: path.join(tmpDir, 'missing.env'),
            DOTENV_CONFIG_QUIET: 'true',
        },
    });
    children.push(child);
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const port = await new Promise<number>((resolve, reject) => {
        child.once('message', (message) => {
            const msg = message as { type: string; port?: number; message?: string };
            if (msg.type === 'ready' && msg.port) resolve(msg.port);
            else reject(new Error(`backend did not start: ${msg.message ?? JSON.stringify(msg)}\n${output}`));
        });
        child.once('exit', (code) => reject(new Error(`backend exited (${code}) before it was ready:\n${output}`)));
    });
    return { child, base: `http://127.0.0.1:${port}`, exit };
}

async function call<T>(backend: Backend, method: string, urlPath: string, body?: unknown): Promise<T> {
    const res = await fetch(`${backend.base}${urlPath}`, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${urlPath}: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
}

async function until(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('timed out');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-crash-'));
    harness = await startSshServer({});
});

afterAll(async () => {
    await Promise.all(children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill('SIGKILL');
    })));
    await harness?.close();
    fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

describe('a backend killed while a multi-exec command runs', () => {
    it('leaves the server interrupted (not "not run") and the command in the audit log', async () => {
        const first = await startBackend();
        const created = await call<{ data: { id: number } }>(first, 'POST', '/api/servers', { name: 'web', ip: '127.0.0.1', port: harness.port, type: 'linux', username: 'tester', password: 'secret' });
        const started = await call<{ data: { job: { id: string } } }>(first, 'POST', '/api/multiexec', { command: 'hang', serverIds: [created.data.id] });
        const jobId = started.data.job.id;
        await until(() => harness.log.includes('exec:hang'));

        // Written before the command was sent.
        const running = await call<{ data: MultiExecJob }>(first, 'GET', `/api/multiexec/jobs/${jobId}`);
        expect(running.data.servers[0]).toMatchObject({ status: 'running', startedAt: expect.any(Number) });
        const sent = await call<{ data: AuditEntry[] }>(first, 'GET', '/api/audit?source=multi-exec');
        expect(sent.data.filter((entry) => entry.command === 'hang')).toEqual([expect.objectContaining({ exit_code: null, meta: expect.objectContaining({ jobId, status: 'running' }) })]);

        first.child.kill('SIGKILL');
        await first.exit;

        const second = await startBackend();
        try {
            const after = await call<{ data: MultiExecJob }>(second, 'GET', `/api/multiexec/jobs/${jobId}`);
            expect(after.data.status).toBe('interrupted');
            expect(after.data.servers[0]).toMatchObject({ status: 'cancelled', errorCode: 'INTERRUPTED', startedAt: running.data.servers[0].startedAt, durationMs: expect.any(Number) });
            const audit = await call<{ data: AuditEntry[] }>(second, 'GET', '/api/audit?source=multi-exec');
            expect(audit.data.filter((entry) => entry.command === 'hang')).toEqual([expect.objectContaining({ exit_code: null, meta: expect.objectContaining({ jobId, status: 'interrupted' }) })]);
        } finally {
            second.child.send({ type: 'shutdown' });
            await second.exit;
        }
    }, PROCESS_TEST_TIMEOUT_MS);
});
