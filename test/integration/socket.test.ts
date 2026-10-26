import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The per-socket session wiring.

let server: TestServer;
const sockets: Socket[] = [];

function open(options: Parameters<typeof connect>[1] = {}): Socket {
    const socket = connect(server.baseUrl, {
        transports: ['websocket'],
        reconnection: false,
        forceNew: true,
        auth: { token: server.token },
        ...options,
    });
    sockets.push(socket);
    return socket;
}

async function connected(socket: Socket): Promise<void> {
    if (socket.connected) return;
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
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

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('socket session', () => {
    it('answers file requests before any connection was opened', async () => {
        const socket = open();
        await connected(socket);
        const ask = (event: string, payload: unknown) => socket.timeout(5000).emitWithAck(event, payload);

        expect(await ask('files-list', { path: '/' })).toEqual({ ok: false, error: { code: 'NOT_CONNECTED', message: 'No file session is open' } });
        expect(await ask('files-read', { path: '/etc/hostname' })).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
        expect(await ask('files-upload-chunk', { transferId: 'none', seq: 0, data: Buffer.from('hello') }))
            .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(await ask('files-rename', { from: '/tmp/a', to: '/tmp/a', isDir: false }))
            .toMatchObject({ ok: false, error: { code: 'INVALID', message: 'The new name is the same as the old one' } });
    });

    it('runs a saved local session in a PTY and streams its output', async () => {
        // Quoted arguments with spaces, and a bare program name resolved on
        // PATH (with PATHEXT on Windows): local-command-naive-split is fixed.
        const command = 'node -e "setTimeout(console.log, 300, process.version)"';
        const created = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'local', ip: 'localhost', type: 'local', command, cli_preset: 'custom' }),
        }).then((res) => res.json() as Promise<{ data: { id: number } }>);

        const socket = open();
        await connected(socket);

        let output = '';
        socket.on('ssh-output', (chunk: string) => { output += chunk; });
        const notices: unknown[] = [];
        socket.on('terminal-notice', (notice: unknown) => { notices.push(notice); });
        const ready = nextEvent(socket, 'connection-ready');
        const closed = nextEvent(socket, 'ssh-closed', 20_000);

        // Same payload as Terminal.tsx: the command comes from the saved row.
        socket.emit('start-ssh', { serverId: created.data.id, purpose: 'terminal', cols: 100, rows: 30 });

        await ready;
        await closed;
        expect(output).toMatch(/v\d+\.\d+\.\d+/);
        // Written by the client, in the user's language.
        expect(notices).toEqual([{ kind: 'session-ended' }]);
    }, 30_000);

    it('reports SSH and FTP connection failures as ssh-error', async () => {
        const save = (body: object) => server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }).then((res) => res.json() as Promise<{ data: { id: number } }>);
        const sshServer = await save({ name: 'closed-ssh', ip: '127.0.0.1', port: 1, type: 'linux', username: 'root' });
        const ftpServer = await save({ name: 'closed-ftp', ip: '127.0.0.1', port: 1, type: 'ftp', username: 'anonymous' });

        const ssh = open();
        await connected(ssh);
        const sshError = nextEvent<string>(ssh, 'ssh-error');
        ssh.emit('start-ssh', { serverId: sshServer.data.id, purpose: 'terminal' });
        expect(await sshError).toMatch(/ECONNREFUSED/);

        const ftp = open();
        await connected(ftp);
        const ftpError = nextEvent<string>(ftp, 'ssh-error');
        ftp.emit('start-ssh', { serverId: ftpServer.data.id, purpose: 'files' });
        expect(await ftpError).toMatch(/^FTP Error: .*ECONNREFUSED/);

        // The failed SSH attempt is remembered for later file operations.
        expect(await ssh.timeout(5000).emitWithAck('files-list', { path: '/' }))
            .toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED', message: expect.stringMatching(/^No file session is open: .*ECONNREFUSED/) } });
    });

    it('rejects handshakes from other origins', async () => {
        const socket = open({ extraHeaders: { origin: 'https://evil.example' } });
        await expect(connected(socket)).rejects.toThrow();
    });
});
