import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// start-ssh on a pooled connection that is already dead but not detected yet
// (after sleep or a network change): the session must fail visibly instead of
// waiting forever.

// SSH handshakes are CPU-bound and slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

let server: TestServer;
let sshPool: typeof import('../../server/ssh/pool')['sshPool'];
const sockets: Socket[] = [];
const harnesses: SshHarness[] = [];

async function harness(): Promise<SshHarness> {
    const started = await startSshServer();
    harnesses.push(started);
    return started;
}

async function open(): Promise<Socket> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    return socket;
}

function nextEvent<T = unknown>(socket: Socket, event: string, timeoutMs = 10_000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
        socket.once(event, (payload: T) => {
            clearTimeout(timer);
            resolve(payload);
        });
    });
}

async function saveServer(target: SshHarness): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `harness-${target.port}`, ip: target.host, port: target.port, type: 'linux', username: 'tester', password: 'secret' }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: number } }).data.id;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await bootTestServer();
    sshPool = (await import('../../server/ssh/pool')).sshPool;
});

afterEach(async () => {
    while (sockets.length) sockets.pop()?.disconnect();
    while (harnesses.length) await harnesses.pop()!.close();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('start-ssh on a dead pooled connection', () => {
    for (const purpose of ['terminal', 'files'] as const) {
        it(`reports the close when it happens while the ${purpose} channel opens`, async () => {
            const target = await harness();
            const id = await saveServer(target);
            // Another holder keeps the pooled connection; then the network goes silent.
            const held = await sshPool.acquire(id);
            target.freeze();

            const socket = await open();
            const output: string[] = [];
            socket.on('ssh-output', (chunk: string) => output.push(chunk));
            // A terminal is told as a notice (the client writes it).
            socket.on('terminal-notice', (notice: { kind: string; target?: string }) => {
                if (notice.kind === 'connected') output.push(`Connected to ${notice.target}`);
            });
            const error = nextEvent<string>(socket, 'ssh-error');
            const closed = nextEvent(socket, 'ssh-closed');
            socket.emit('start-ssh', { serverId: id, purpose });

            // The dead connection was handed out and the channel request sent.
            const deadline = Date.now() + 10_000;
            while (!output.join('').includes('Connected to') && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
            expect(output.join('')).toContain('Connected to');

            // The transport finally dies (what keepalives would detect).
            await target.close();
            harnesses.pop();

            // Why it closed depends on the platform (a reset or a plain close).
            expect(await error).toMatch(/\w/);
            await closed;
            expect(sshPool.inspect(id)).toEqual({ connections: 0, refs: 0 });
            held.release();
        });
    }

    it('gives up on a channel that never opens and stops handing that connection out', async () => {
        const target = await harness();
        const id = await saveServer(target);
        const held = await sshPool.acquire(id);
        target.freeze();

        const readyTimeout = sshPool.options.readyTimeout;
        sshPool.options.readyTimeout = 1000;
        const socket = await open();
        try {
            const error = nextEvent<string>(socket, 'ssh-error');
            socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
            expect(await error).toBe('The server did not open the terminal within 1s.');
        } finally {
            sshPool.options.readyTimeout = readyTimeout;
        }

        // The session let go of its lease; the frozen connection is retired.
        expect(sshPool.inspect(id)).toEqual({ connections: 1, refs: 1 });

        // A retry gets a fresh connection.
        const ready = nextEvent(socket, 'connection-ready');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await ready;
        expect(target.connections()).toBe(2);

        held.release();
        expect(sshPool.inspect(id).refs).toBe(1);
    });
});
