import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { TerminalNotice } from '../../shared/terminal';
import type { AppSocket } from '../../src/lib/socket';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// A saved local CLI preset opened through the terminal protocol (start-ssh):
// the backend starts a scoped console for the tool instead of a shell. The
// tool is a stand-in `kubectl` that prints the arguments it got, and the only
// tool on PATH: whether this machine has the real kubectl or gcloud (a CI
// runner image comes with both) must not matter.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let binDir: string;
let originalPath: string | undefined;
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
const sockets: AppSocket[] = [];
// Starting a process takes a while on a loaded Windows runner.
const WAIT = { timeout: 10_000, interval: 20 };

type Console = {
    socket: AppSocket;
    output: () => string;
    notices: TerminalNotice[];
    closed: () => boolean;
    // Types a line once the console shows a new prompt: what is typed while a
    // command runs goes to that command's stdin.
    run: (line: string) => Promise<void>;
};

async function openConsole(serverId: number, bin: string): Promise<Console> {
    const socket = io(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } }) as AppSocket;
    sockets.push(socket);
    let output = '';
    let closed = false;
    const notices: TerminalNotice[] = [];
    // Consoles send bytes, acknowledged by their count.
    const decoder = new TextDecoder();
    socket.on('ssh-output', (chunk) => {
        if (typeof chunk === 'string') {
            output += chunk;
            socket.emit('ssh-ack', chunk.length);
            return;
        }
        const bytes = chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk;
        output += decoder.decode(bytes, { stream: true });
        socket.emit('ssh-ack', bytes.byteLength);
    });
    socket.on('terminal-notice', (notice) => notices.push(notice));
    socket.on('ssh-closed', () => { closed = true; });
    await new Promise<void>((resolve, reject) => {
        socket.once('connection-ready', () => resolve());
        socket.once('ssh-error', (message) => reject(new Error(message)));
        socket.on('connect', () => socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: 100, rows: 30 }));
    });

    const prompts = () => output.split(`${bin}>`).length - 1;
    let seen = 0;
    const run = async (line: string) => {
        await vi.waitFor(() => expect(prompts()).toBeGreaterThan(seen), WAIT);
        seen = prompts();
        socket.emit('ssh-input', line);
    };
    return { socket, output: () => output, notices, closed: () => closed, run };
}

async function saveConsole(preset: string): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `${preset}-console`, ip: 'local', type: 'local', cli_preset: preset }),
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-contract-bin-'));
    const script = path.join(binDir, 'fake-kubectl.cjs');
    fs.writeFileSync(script, "process.stdout.write('ARGS ' + JSON.stringify(process.argv.slice(2)) + '\\n');\n");
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'kubectl.cmd'), `@"${process.execPath}" "${script}" %*\r\n`);
    } else {
        fs.writeFileSync(path.join(binDir, 'kubectl'), `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
    }
    originalPath = process.env[pathKey];
    // Windows keeps System32 for taskkill, which stops a command's process tree.
    const system = process.platform === 'win32' ? [path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')] : [];
    process.env[pathKey] = [binDir, ...system].join(path.delimiter);
    server = await bootTestServer();
});

afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    process.env[pathKey] = originalPath;
    fs.rmSync(binDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    vi.restoreAllMocks();
});

describe('scoped CLI console over the terminal protocol', () => {
    it('opens a console for the tool, runs its commands without a shell and refuses shell syntax', async () => {
        const cli = await openConsole(await saveConsole('kubectl'), 'kubectl');

        // "kubectl get ..." and "get ..." both run `kubectl get ...`; quotes group.
        await cli.run('kubectl get pods -n "kube system"\r');
        await vi.waitFor(() => expect(cli.output()).toContain('ARGS ["get","pods","-n","kube system"]'), WAIT);
        expect(cli.notices[0]).toEqual({ kind: 'cli-console', name: 'kubectl', bin: 'kubectl' });

        await cli.run('get pods | grep api\r');
        await vi.waitFor(() => expect(cli.notices).toContainEqual({ kind: 'cli-refused', bin: 'kubectl', reason: 'operator', detail: '|' }), WAIT);
        expect(cli.output()).not.toMatch(/ARGS .*grep/);

        // Tab completes the subcommand.
        await cli.run('desc\t');
        await vi.waitFor(() => expect(cli.output()).toContain('kubectl>\u001b[0m describe '), WAIT);
    });

    it('remembers the command history of the console for its next session', async () => {
        const id = await saveConsole('kubectl');
        const first = await openConsole(id, 'kubectl');
        await first.run('version --client\r');
        await vi.waitFor(() => expect(first.output()).toContain('ARGS ["version","--client"]'), WAIT);
        await first.run('exit\r');
        await vi.waitFor(() => expect(first.closed()).toBe(true), WAIT);
        expect(first.notices.at(-1)).toEqual({ kind: 'session-ended' });

        const second = await openConsole(id, 'kubectl');
        // History keeps every line, `exit` included: two arrows up recall the
        // command before it, Enter runs it.
        await second.run('\u001b[A\u001b[A');
        await vi.waitFor(() => expect(second.output()).toContain('version --client'), WAIT);
        second.socket.emit('ssh-input', '\r');
        await vi.waitFor(() => expect(second.output()).toContain('ARGS ["version","--client"]'), WAIT);
    });

    it('points to the install docs when the tool is missing, and refuses to run it', async () => {
        const cli = await openConsole(await saveConsole('gcloud'), 'gcloud');
        await cli.run('config list\r');
        await vi.waitFor(() => expect(cli.notices).toContainEqual({ kind: 'cli-refused', bin: 'gcloud', reason: 'not-found' }), WAIT);
        expect(cli.notices[0]).toMatchObject({ kind: 'cli-console', bin: 'gcloud', installUrl: expect.stringMatching(/^https:\/\/cloud\.google\.com\//) });
    });
});
