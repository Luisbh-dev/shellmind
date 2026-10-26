import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { LogChunkPayload, LogEndPayload, LogErrorPayload } from '../../shared/ops';
import { createOpsHost, sections, type OpsHost } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Live log streams over socket.io: logs-start -> logs-started, logs-chunk
// (acknowledged) ... -> logs-end / logs-error.

vi.setConfig({ testTimeout: 20_000 });

let server: TestServer;
let harness: SshHarness;
let host: OpsHost;
let serverId: number;
let windowsId: number;
const sockets: Socket[] = [];
// Called after each line /var/log/drop.log writes.
let onDropLogWrite: (line: string) => void = () => {};

// The header and a progress record PowerShell writes to stderr under -EncodedCommand.
const WINDOWS_STDERR = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress" RefId="0"><TN RefId="0"><T>System.Management.Automation.PSCustomObject</T><T>System.Object</T></TN><MS><I64 N="SourceId">1</I64><PR N="Record"><AV>Preparing modules for first use.</AV><AI>0</AI><Nil /><PI>-1</PI><PC>-1</PC><T>Completed</T><SR>-1</SR><SD> </SD></PR></MS></Obj></Objs>';

async function open(): Promise<Socket> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    return socket;
}

function nextEvent<T>(socket: Socket, event: string, id: string, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
        const listener = (payload: T & { id: string }) => {
            if (payload.id !== id) return;
            clearTimeout(timer);
            socket.off(event, listener);
            resolve(payload);
        };
        socket.on(event, listener);
    });
}

function collect(socket: Socket, id: string): { text: () => string; waitFor: (needle: string) => Promise<void> } {
    let text = '';
    socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
        if (payload.id === id) text += payload.data;
        ack();
    });
    return {
        text: () => text,
        waitFor: async (needle) => {
            const deadline = Date.now() + 10_000;
            while (!text.includes(needle)) {
                if (Date.now() > deadline) throw new Error(`Timed out waiting for "${needle}"; got ${JSON.stringify(text)}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
    };
}

async function until(check: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

// Waits until a flooding remote command is blocked on write: what it wrote
// stops growing (the backend paused the channel and the SSH window is full).
async function untilRemoteBlocks() {
    let last = -1;
    let since = Date.now();
    await until(() => {
        const now = host.streamedBytes();
        if (now !== last) {
            last = now;
            since = Date.now();
        }
        return now > 0 && Date.now() - since >= 300;
    }, 8000).catch(() => {
        throw new Error(`the remote command kept writing: ${Math.round(host.streamedBytes() / (1024 * 1024))} MB`);
    });
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    host = createOpsHost();
    host.respond((script) => {
        if (script.includes('m uid')) return { stdout: sections({ uid: '0', systemd: 'yes', journal: 'yes', docker: 'ok 26.1.4' }) };
        if (script.includes('docker=$null;compose=$false')) return { stdout: '{"admin":true,"docker":"ok 24.0.7","compose":false}' };
        return undefined;
    });
    host.stream((script) => {
        if (script.includes('journalctl -f')) return { lines: ['May 06 10:00:00 web-01 nginx[1]: ready'] };
        if (script.includes("'logs' '-f'")) return { lines: ['first', 'second'], exitCode: 0 };
        if (script.includes("/var/log/flood.log")) return { lines: [], flood: 'x'.repeat(16 * 1024) };
        if (script.includes('/var/log/drop.log')) return { lines: ['line-one', 'line-two', 'line-three'], intervalMs: 300, onWrite: (line) => onDropLogWrite(line) };
        if (script.includes('tail -n 200 -F')) return { lines: ['tick'], intervalMs: 50 };
        // Windows: PowerShell's CLIXML on stderr, as Windows Server 2025 prints it.
        if (script.includes("Get-Content -LiteralPath 'C:\\logs\\app.log'")) return { stderr: `${WINDOWS_STDERR}\r\n`, lines: ['app started', 'request served'], intervalMs: 30 };
        if (script.includes("Get-Content -LiteralPath 'C:\\logs\\missing.log'")) {
            return { stderr: WINDOWS_STDERR, lines: ["Cannot find path 'C:\\logs\\missing.log' because it does not exist."], exitCode: 1 };
        }
        return undefined;
    });
    harness = await startSshServer({ exec: host.exec });
    const save = async (body: Record<string, unknown>) => {
        const res = await server.fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return ((await res.json()) as { data: { id: number } }).data.id;
    };
    serverId = await save({ name: 'logs', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' });
    windowsId = await save({ name: 'logs-win', ip: harness.host, ssh_port: harness.port, type: 'windows', username: 'tester', password: 'secret' });
});

afterEach(async () => {
    onDropLogWrite = () => {};
    while (sockets.length) sockets.pop()?.disconnect();
    await until(() => host.openStreams() === 0);
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    vi.restoreAllMocks();
});

describe('live log streams', () => {
    it('streams a unit journal until stopped, then closes the remote command', async () => {
        const socket = await open();
        const output = collect(socket, 'j1');
        const started = nextEvent(socket, 'logs-started', 'j1');
        socket.emit('logs-start', { id: 'j1', serverId, source: { kind: 'journal', unit: 'nginx' } });
        await started;
        await output.waitFor('nginx[1]: ready');
        expect(host.scripts.at(-1)?.script).toContain("journalctl -f -n 200 --no-pager -o short-iso -u 'nginx.service'");

        const ended = nextEvent<LogEndPayload>(socket, 'logs-end', 'j1');
        socket.emit('logs-stop', { id: 'j1' });
        expect(await ended).toEqual({ id: 'j1', code: null });
        await until(() => host.openStreams() === 0);
    });

    it('reports the exit status when the remote command ends by itself', async () => {
        const socket = await open();
        const output = collect(socket, 'c1');
        const ended = nextEvent<LogEndPayload>(socket, 'logs-end', 'c1');
        socket.emit('logs-start', { id: 'c1', serverId, source: { kind: 'container', container: 'web-proxy-1' } });
        expect(await ended).toEqual({ id: 'c1', code: 0 });
        expect(output.text()).toBe('first\nsecond\n');
    });

    it('stops every stream of a socket that disconnects', async () => {
        const socket = await open();
        const output = collect(socket, 'f1');
        socket.emit('logs-start', { id: 'f1', serverId, source: { kind: 'file', path: '/var/log/syslog' } });
        await output.waitFor('tick');
        expect(host.openStreams()).toBe(1);
        socket.disconnect();
        await until(() => host.openStreams() === 0);
    });

    it('refuses invalid sources without running anything', async () => {
        const socket = await open();
        const scriptsBefore = host.scripts.length;
        const errors = [
            nextEvent<LogErrorPayload>(socket, 'logs-error', 'bad1'),
            nextEvent<LogErrorPayload>(socket, 'logs-error', 'bad2'),
            nextEvent<LogErrorPayload>(socket, 'logs-error', 'bad3'),
        ];
        socket.emit('logs-start', { id: 'bad1', serverId, source: { kind: 'file', path: "/var/log/x'; reboot" } });
        socket.emit('logs-start', { id: 'bad2', serverId, source: { kind: 'command', command: 'id' } as never });
        socket.emit('logs-start', { id: 'bad3', serverId, source: { kind: 'container', container: '$(id)' } });
        const [path, kind, container] = await Promise.all(errors);
        expect(path).toMatchObject({ code: 'OPS_INVALID_INPUT', message: expect.stringMatching(/absolute file path/) });
        expect(kind).toMatchObject({ code: 'OPS_INVALID_INPUT', message: 'Unknown log source.' });
        expect(container).toMatchObject({ code: 'OPS_INVALID_INPUT' });
        expect(host.scripts.slice(scriptsBefore).filter((entry) => entry.kind === 'stream')).toEqual([]);
    });

    it('limits streams per socket and per connection (EXEC_STREAMS_BUSY)', async () => {
        const first = await open();
        const second = await open();
        const source = { kind: 'file', path: '/var/log/syslog' } as const;
        for (const id of ['a1', 'a2', 'a3']) {
            const started = nextEvent(first, 'logs-started', id);
            first.emit('logs-start', { id, serverId, source });
            await started;
        }
        const limited = nextEvent<LogErrorPayload>(first, 'logs-error', 'a4');
        first.emit('logs-start', { id: 'a4', serverId, source });
        expect(await limited).toMatchObject({ code: 'LOGS_LIMIT' });

        // The pooled connection already runs three streams.
        const busy = nextEvent<LogErrorPayload>(second, 'logs-error', 'b1');
        second.emit('logs-start', { id: 'b1', serverId, source });
        expect(await busy).toMatchObject({ code: 'EXEC_STREAMS_BUSY' });
    });

    it('streams a Windows file as text, without PowerShell\'s CLIXML, until stopped', async () => {
        const socket = await open();
        const output = collect(socket, 'w1');
        socket.emit('logs-start', { id: 'w1', serverId: windowsId, source: { kind: 'file', path: 'C:\\logs\\app.log' } });
        await output.waitFor('request served');
        expect(output.text()).toMatch(/^app started\nrequest served\n/);
        expect(output.text()).not.toMatch(/CLIXML|<Objs|Preparing modules/);
        // The script watches its own stdin to end the follow.
        expect(host.scripts.at(-1)).toMatchObject({ kind: 'stream', script: expect.stringContaining('[Console]::OpenStandardInput()') });

        const ended = nextEvent<LogEndPayload>(socket, 'logs-end', 'w1');
        socket.emit('logs-stop', { id: 'w1' });
        expect(await ended).toEqual({ id: 'w1', code: null });
        await until(() => host.openStreams() === 0);
    });

    it('shows why a Windows stream ended, as text', async () => {
        const socket = await open();
        const output = collect(socket, 'w2');
        const ended = nextEvent<LogEndPayload>(socket, 'logs-end', 'w2');
        socket.emit('logs-start', { id: 'w2', serverId: windowsId, source: { kind: 'file', path: 'C:\\logs\\missing.log' } });
        expect(await ended).toEqual({ id: 'w2', code: 1 });
        expect(output.text()).toBe("Cannot find path 'C:\\logs\\missing.log' because it does not exist.\n");
    });

    // perf-log-stream-no-backpressure: a client that lagged behind made the
    // backend read the remote output at full speed and drop it.
    it('pauses the remote command while the client does not acknowledge, and still stops at once', async () => {
        const MB = 1024 * 1024;
        const socket = await open();
        let received = 0;
        // Never acknowledged, like a hidden or overloaded tab.
        socket.on('logs-chunk', (payload: LogChunkPayload) => {
            if (payload.id === 'p1') received += payload.data.length;
        });
        const started = nextEvent(socket, 'logs-started', 'p1');
        socket.emit('logs-start', { id: 'p1', serverId, source: { kind: 'file', path: '/var/log/flood.log' } });
        await started;

        // The remote command blocks once the SSH window is full.
        await untilRemoteBlocks();
        expect(host.streamedBytes()).toBeLessThan(16 * MB);
        expect(received).toBe(2 * 64 * 1024);

        const ended = nextEvent<LogEndPayload>(socket, 'logs-end', 'p1', 1500);
        socket.emit('logs-stop', { id: 'p1' });
        expect(await ended).toEqual({ id: 'p1', code: null });
        await until(() => host.openStreams() === 0, 1500);
    });

    // A lost connection threw away the output the backend had received but
    // not sent yet: the last lines before a server reboots or drops.
    it('delivers the last lines before reporting a lost connection', async () => {
        const { sshPool } = await import('../../server/ssh/pool');
        const socket = await open();
        const output = collect(socket, 'd1');
        const lost = nextEvent<LogErrorPayload>(socket, 'logs-error', 'd1');
        // The connection drops while `line-two` waits for its batch (100 ms).
        onDropLogWrite = (line) => {
            if (line === 'line-two') setTimeout(() => sshPool.invalidate(serverId, { close: true }), 30);
        };
        socket.emit('logs-start', { id: 'd1', serverId, source: { kind: 'file', path: '/var/log/drop.log' } });
        expect(await lost).toMatchObject({ code: 'SSH_CLOSED' });
        expect(output.text()).toBe('line-one\nline-two\n');
    });

    it('delivers the backlog of a lagging client before reporting a lost connection', async () => {
        const { sshPool } = await import('../../server/ssh/pool');
        const { MAX_PENDING_CHARS, PAUSE_PENDING_CHARS } = await import('../../server/sockets/logs');
        const BATCH = 64 * 1024;
        const socket = await open();
        let received = 0;
        // Never acknowledged: the backlog piles up in the backend.
        socket.on('logs-chunk', (payload: LogChunkPayload) => {
            if (payload.id === 'd2') received += payload.data.length;
        });
        const started = nextEvent(socket, 'logs-started', 'd2');
        socket.emit('logs-start', { id: 'd2', serverId, source: { kind: 'file', path: '/var/log/flood.log' } });
        await started;
        await untilRemoteBlocks();
        expect(received).toBe(2 * BATCH);

        const lost = nextEvent<LogErrorPayload>(socket, 'logs-error', 'd2');
        sshPool.invalidate(serverId, { close: true });
        expect(await lost).toMatchObject({ code: 'SSH_CLOSED' });
        // The paused backlog (at least the pause level, at most the cap) came first.
        expect(received).toBeGreaterThanOrEqual(2 * BATCH + PAUSE_PENDING_CHARS);
        expect(received).toBeLessThanOrEqual(2 * BATCH + MAX_PENDING_CHARS);
    });

    it('reports a connection failure with its cause', async () => {
        const res = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'logs-bad-pass', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'wrong' }),
        });
        const badId = ((await res.json()) as { data: { id: number } }).data.id;
        const socket = await open();
        const error = nextEvent<LogErrorPayload>(socket, 'logs-error', 'p1');
        socket.emit('logs-start', { id: 'p1', serverId: badId, source: { kind: 'journal' } });
        expect(await error).toEqual({ id: 'p1', code: 'SSH_FAILED', message: expect.stringMatching(/^Auth failed/), connection: { code: 'AUTH_FAILED' } });
    });

    it('reports an unknown server', async () => {
        const socket = await open();
        const error = nextEvent<LogErrorPayload>(socket, 'logs-error', 'x1');
        socket.emit('logs-start', { id: 'x1', serverId: 999999, source: { kind: 'journal' } });
        expect(await error).toMatchObject({ code: 'SERVER_NOT_FOUND' });
    });
});
