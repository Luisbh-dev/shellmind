import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { KnownHost } from '../../shared/types';
import { HARNESS_BANNER, HARNESS_OS, HARNESS_PROMPT, startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// End to end: saved server -> socket start-ssh -> pooled SSH connection to
// the in-process test server.

// SSH handshakes are CPU-bound and slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

let server: TestServer;
let harness: SshHarness;
let sshPool: typeof import('../../server/ssh/pool')['sshPool'];
const sockets: Socket[] = [];
const extraHarnesses: SshHarness[] = [];

function open(): Socket {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    return socket;
}

async function connected(socket: Socket): Promise<Socket> {
    if (!socket.connected) {
        await new Promise<void>((resolve, reject) => {
            socket.once('connect', () => resolve());
            socket.once('connect_error', reject);
        });
    }
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

function collectOutput(socket: Socket): { text: () => string; waitFor: (needle: string) => Promise<void> } {
    let output = '';
    socket.on('ssh-output', (chunk: string) => { output += chunk; });
    return {
        text: () => output,
        waitFor: async (needle) => {
            const deadline = Date.now() + 10_000;
            while (!output.includes(needle)) {
                if (Date.now() > deadline) throw new Error(`Timed out waiting for output "${needle}"; got: ${JSON.stringify(output)}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
    };
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function saveServer(target: SshHarness, extra: Record<string, unknown> = {}): Promise<number> {
    const created = await api<{ data: { id: number } }>('POST', '/api/servers', {
        name: `harness-${target.port}`, ip: target.host, port: target.port, type: 'linux', username: 'tester', password: 'secret', ...extra,
    });
    expect(created.status).toBe(200);
    return created.body.data.id;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    sshPool = (await import('../../server/ssh/pool')).sshPool;
    harness = await startSshServer();
});

afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    for (const extra of extraHarnesses) await extra.close();
    vi.restoreAllMocks();
});

describe('start-ssh with saved SSH servers', () => {
    it('opens a terminal from the saved row and ignores client-supplied target fields', async () => {
        const id = await saveServer(harness);
        const socket = await connected(open());
        const output = collectOutput(socket);
        const trusted = nextEvent(socket, 'host-key-trusted');
        // Session messages travel as data, for the client to translate.
        const connectedNotice = nextEvent(socket, 'terminal-notice');
        const ready = nextEvent(socket, 'connection-ready');
        const os = nextEvent<string>(socket, 'os-detected');

        socket.emit('start-ssh', {
            serverId: id, purpose: 'terminal', cols: 120, rows: 40,
            // Ignored: the target comes from the database only.
            host: 'evil.example', port: 1, type: 'ftp', username: 'root', password: 'stolen',
        });

        await ready;
        await output.waitFor(HARNESS_PROMPT);
        expect(await connectedNotice).toEqual({ kind: 'connected', target: `${harness.host}:${harness.port}`, via: [] });
        expect(output.text()).not.toContain('Connected to');
        expect(output.text()).toContain(HARNESS_BANNER);
        expect(await trusted).toEqual({ host: harness.host, port: harness.port, keyType: 'ssh-ed25519', fingerprint: harness.fingerprint });
        expect(await os).toBe(HARNESS_OS);

        socket.emit('ssh-input', 'uptime\r');
        await output.waitFor('you typed: uptime');

        // A terminal needs no SFTP session.
        expect(harness.log).toContain('shell');
        expect(harness.log).not.toContain('sftp');

        const known = await api<{ data: KnownHost[] }>('GET', '/api/known-hosts');
        expect(known.body.data).toEqual([expect.objectContaining({ host: harness.host, port: harness.port, key_type: 'ssh-ed25519', fingerprint: harness.fingerprint })]);
    });

    it('opens file sessions with SFTP only', async () => {
        const id = await saveServer(harness);
        const before = harness.log.length;
        const socket = await connected(open());
        const ready = nextEvent(socket, 'connection-ready');
        socket.emit('start-ssh', { serverId: id, purpose: 'files' });
        await ready;

        expect(await socket.timeout(10_000).emitWithAck('files-list', { path: '/' })).toEqual({
            ok: true,
            data: {
                path: '/',
                truncated: false,
                entries: [
                    expect.objectContaining({ name: 'docs', isDir: true }),
                    expect.objectContaining({ name: 'hello.txt', isDir: false, size: 5 }),
                ],
            },
        });

        const since = harness.log.slice(before);
        expect(since).toContain('sftp');
        expect(since).not.toContain('shell');
        expect(since.some((entry) => entry.startsWith('exec:'))).toBe(false);
    });

    it('shares one pooled connection between terminals and file sessions', async () => {
        const id = await saveServer(harness);
        const connectionsBefore = harness.connections();

        const sessions = await Promise.all([
            { purpose: 'terminal' }, { purpose: 'terminal' }, { purpose: 'files' },
        ].map(async ({ purpose }) => {
            const socket = await connected(open());
            const ready = nextEvent(socket, 'connection-ready');
            socket.emit('start-ssh', { serverId: id, purpose, cols: 80, rows: 24 });
            await ready;
            return socket;
        }));

        expect(harness.connections() - connectionsBefore).toBe(1);
        expect(sshPool.inspect(id)).toEqual({ connections: 1, refs: 3 });

        // Restarting a session swaps its lease instead of leaking one.
        const restarted = nextEvent(sessions[0], 'connection-ready');
        sessions[0].emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await restarted;
        expect(sshPool.inspect(id).refs).toBe(3);

        for (const socket of sessions) socket.disconnect();
        const deadline = Date.now() + 5000;
        while (sshPool.inspect(id).refs > 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(sshPool.inspect(id).refs).toBe(0);
    });

    it('serves the status dashboard through the pool', async () => {
        const id = await saveServer(harness);
        const status = await api('GET', `/api/servers/${id}/status`);
        // One `sh -s` script; this harness has no shell to run it (status-api.test.ts scripts one).
        expect(status.status).toBe(502);
        expect(status.body).toMatchObject({ code: 'STATUS_UNAVAILABLE' });
        expect(harness.log).toContain('exec:sh -s');
        expect(sshPool.inspect(id).refs).toBe(0);
    });

    it('reports a changed host key and connects again once the pin is removed', async () => {
        const other = await startSshServer();
        extraHarnesses.push(other);
        const id = await saveServer(other);
        const pinned = 'SHA256:BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
        await new Promise<void>((resolve, reject) => server.db.run(
            'INSERT INTO known_hosts (host, port, key_type, fingerprint, created_at) VALUES (?, ?, ?, ?, ?)',
            [other.host, other.port, 'ssh-ed25519', pinned, Date.now()],
            (err) => (err ? reject(err) : resolve()),
        ));

        const socket = await connected(open());
        const mismatch = nextEvent(socket, 'host-key-mismatch');
        const error = nextEvent<string>(socket, 'ssh-error');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });

        expect(await mismatch).toEqual({
            code: 'HOST_KEY_MISMATCH', host: other.host, port: other.port, keyType: 'ssh-ed25519', expected: pinned, actual: other.fingerprint,
        });
        expect(await error).toMatch(/host key of .* has changed/);
        expect(other.log.filter((entry) => entry.startsWith('auth:'))).toEqual([]);

        const status = await api('GET', `/api/servers/${id}/status`);
        expect(status.status).toBe(409);
        expect(status.body).toMatchObject({ code: 'HOST_KEY_MISMATCH', details: { expected: pinned, actual: other.fingerprint } });

        const known = await api<{ data: KnownHost[] }>('GET', '/api/known-hosts');
        const entry = known.body.data.find((row) => row.port === other.port);
        expect(entry).toMatchObject({ fingerprint: pinned });
        expect((await api('DELETE', `/api/known-hosts/${entry?.id}`)).status).toBe(200);
        expect((await api('DELETE', `/api/known-hosts/${entry?.id}`)).status).toBe(404);

        const ready = nextEvent(socket, 'connection-ready');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await ready;
    });

    it('closes the sessions of a deleted server', async () => {
        const id = await saveServer(harness);
        const socket = await connected(open());
        const ready = nextEvent(socket, 'connection-ready');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await ready;

        const closed = nextEvent(socket, 'ssh-closed');
        expect((await api('DELETE', `/api/servers/${id}`)).status).toBe(200);
        await closed;
        expect(sshPool.inspect(id)).toEqual({ connections: 0, refs: 0 });
    });
});

describe('start-ssh without a saved server', () => {
    it('refuses ad-hoc targets, including local shells with a client-chosen command', async () => {
        const socket = await connected(open());

        for (const payload of [
            { host: '127.0.0.1', port: 22, type: 'linux', username: 'root', password: 'x' },
            { type: 'local', command: 'calc.exe', cli_preset: 'custom' },
            { serverId: 'abc', purpose: 'terminal' },
        ]) {
            const error = nextEvent<string>(socket, 'ssh-error');
            socket.emit('start-ssh', payload);
            expect(await error).toBe('A saved server is required for this connection.');
        }

        const missing = nextEvent<string>(socket, 'ssh-error');
        socket.emit('start-ssh', { serverId: 999999, purpose: 'terminal' });
        expect(await missing).toBe('Server #999999 does not exist (it may have been deleted).');
    });

    it('refuses native RDP launches without a saved Windows server', async () => {
        const socket = await connected(open());

        const adHoc = nextEvent<string>(socket, 'rdp-error');
        socket.emit('launch-rdp-native', { host: '10.0.0.1', username: 'admin', password: 'x' });
        expect(await adHoc).toBe('A saved server is required for this connection.');

        const linux = await saveServer(harness);
        const unsupported = nextEvent<string>(socket, 'rdp-error');
        socket.emit('launch-rdp-native', { serverId: linux });
        expect(await unsupported).toBe('A linux server does not support rdp connections.');
    });
});
