import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_TEST_TIMEOUT_MS } from '../setup/timeouts';

// The real entry point (server.ts) forked the way the Electron shell forks the
// compiled one: with an IPC channel, reporting {type:'ready'|'fatal'}.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const tsxCli = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');

type ParentMessage = { type: 'ready'; port: number } | { type: 'fatal'; message: string };

const children: ChildProcess[] = [];
const tmpDirs: string[] = [];

afterEach(() => {
    for (const child of children.splice(0)) if (child.exitCode === null) child.kill();
    for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Settings of the developer's shell that would change what is under test.
const INHERITED_BACKEND_VARS = ['SHELLMIND_AUTH_TOKEN', 'PORT', 'HOST', 'ALLOWED_HOSTS', 'ALLOWED_ORIGINS', 'SERVE_WEB', 'WEB_DIR', 'LOG_LEVEL', 'SHELLMIND_DEBUG'];

function startBackend(env: Record<string, string>, entry = 'server.ts') {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-ipc-'));
    tmpDirs.push(tmpDir);
    const inherited = { ...process.env };
    for (const name of INHERITED_BACKEND_VARS) delete inherited[name];
    const child = fork(tsxCli, ['--tsconfig', 'tsconfig.server.json', entry], {
        cwd: repoRoot,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: {
            ...inherited,
            HOST: '127.0.0.1',
            DB_PATH: path.join(tmpDir, 'shellmind.db'),
            DOTENV_CONFIG_PATH: path.join(tmpDir, 'missing.env'),
            DOTENV_CONFIG_QUIET: 'true',
            ...env,
        },
    });
    children.push(child);

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    const message = new Promise<ParentMessage>((resolve, reject) => {
        child.once('message', (msg) => resolve(msg as ParentMessage));
        child.once('exit', (code) => reject(new Error(`backend exited (${code}) before reporting:\n${stdout}\n${stderr}`)));
    });
    const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    return { child, message, exit, stdout: () => stdout, stderr: () => stderr };
}

describe('backend startup under a parent process', () => {
    it('reports the port it listens on, prints a generated token once, and stops on request', async () => {
        const backend = startBackend({ PORT: '0' });

        const ready = await backend.message;
        expect(ready).toEqual({ type: 'ready', port: expect.any(Number) });
        const { port } = ready as { port: number };
        expect(port).toBeGreaterThan(0);

        const printed = [...backend.stdout().matchAll(/Access token: (\S+)/g)].map((match) => match[1]);
        expect(printed).toEqual([expect.any(String)]);
        const token = printed[0]!;

        const base = `http://127.0.0.1:${port}`;
        expect((await fetch(`${base}/api/session`)).status).toBe(401);
        expect((await fetch(`${base}/api/session`, { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);

        backend.child.send({ type: 'shutdown' });
        expect(await backend.exit).toBe(0);
    }, PROCESS_TEST_TIMEOUT_MS);

    it('reports a taken port as fatal and exits non-zero instead of lingering', async () => {
        const blocker = net.createServer();
        await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
        const { port } = blocker.address() as net.AddressInfo;

        try {
            const backend = startBackend({ PORT: String(port), SHELLMIND_AUTH_TOKEN: 'test-token-0123456789' });
            expect(await backend.message).toEqual({
                type: 'fatal',
                message: `Port 127.0.0.1:${port} is already in use.`,
            });
            expect(await backend.exit).not.toBe(0);
            expect(backend.stdout()).not.toContain('Access token');
        } finally {
            blocker.close();
        }
    }, PROCESS_TEST_TIMEOUT_MS);

    // BC-10: a failure after the database opened used to be an unhandled
    // rejection, and the process then ended with code 0 without a word.
    it('reports a startup failure after the database opened as fatal and exits 1', async () => {
        const missing = path.join(os.tmpdir(), 'shellmind-no-such-web-build');
        const backend = startBackend({ PORT: '0', SERVE_WEB: '1', WEB_DIR: missing, SHELLMIND_AUTH_TOKEN: 'test-token-0123456789' });

        const message = await backend.message;
        expect(message).toEqual({ type: 'fatal', message: expect.stringMatching(/^Could not start: SERVE_WEB is set but no web build was found/) });
        expect(await backend.exit).toBe(1);
        expect(backend.stderr()).not.toContain('Unhandled promise rejection');
    }, PROCESS_TEST_TIMEOUT_MS);

    it('logs an unhandled rejection but exits fatally on an uncaught exception', async () => {
        const backend = startBackend({}, 'test/fixtures/crashingBackend.ts');

        expect(await backend.message).toEqual({ type: 'fatal', message: 'Uncaught exception: boom' });
        expect(await backend.exit).toBe(1);
        expect(backend.stderr()).toContain('Unhandled promise rejection');
        expect(backend.stderr()).toContain('ignored rejection');
    }, PROCESS_TEST_TIMEOUT_MS);
});
