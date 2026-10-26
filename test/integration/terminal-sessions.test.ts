import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { Server, type ServerChannel } from 'ssh2';
import type { ConnectionError } from '../../shared/terminal';
import { generateKeyPair, startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Terminal and file sessions that fail: the SFTP channel misbehaving or
// ending on its own while the pooled connection stays up, and the coded
// errors the client translates.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let sshPool: typeof import('../../server/ssh/pool')['sshPool'];
const sockets: Socket[] = [];
const closers: Array<() => Promise<void> | void> = [];

function open(): Socket {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    return socket;
}

async function connected(socket: Socket): Promise<Socket> {
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    return socket;
}

function nextEvent<T extends unknown[] = unknown[]>(socket: Socket, event: string, timeoutMs = 15_000): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for "${event}"`)), timeoutMs);
        socket.once(event, (...args: unknown[]) => {
            clearTimeout(timer);
            resolve(args as T);
        });
    });
}

async function save(body: Record<string, unknown>): Promise<number> {
    const res = await server.fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: number } }).data.id;
}

type SftpBehaviour = 'bad-packet' | 'end';

// An SSH server whose SFTP subsystem answers the version handshake, then
// either sends a packet of an unknown type or ends the channel at the first
// request. Shells and exec work normally.
async function startOddSftpServer(behaviour: SftpBehaviour): Promise<{ port: number; close: () => Promise<void> }> {
    const sshd = new Server({ hostKeys: [generateKeyPair().privateKey] }, (client) => {
        client.on('error', () => undefined);
        client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
        client.on('ready', () => client.on('session', (accept) => {
            const session = accept();
            session.on('exec', (acceptExec, _reject, info) => {
                const channel = acceptExec();
                channel.write(`${info.command}\n`);
                channel.exit(0);
                channel.end();
            });
            session.on('subsystem', (acceptSub) => {
                const channel: ServerChannel = acceptSub();
                let initialized = false;
                channel.on('data', () => {
                    if (!initialized) {
                        initialized = true;
                        // SSH_FXP_VERSION 3
                        const version = Buffer.alloc(9);
                        version.writeUInt32BE(5, 0);
                        version[4] = 2;
                        version.writeUInt32BE(3, 5);
                        channel.write(version);
                        return;
                    }
                    if (behaviour === 'end') {
                        channel.exit(0);
                        channel.end();
                        return;
                    }
                    const bad = Buffer.alloc(9);
                    bad.writeUInt32BE(5, 0);
                    bad[4] = 250;
                    bad.writeUInt32BE(0, 5);
                    channel.write(bad);
                });
            });
        }));
    });
    await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve));
    const { port } = sshd.address() as net.AddressInfo;
    return { port, close: () => new Promise<void>((resolve) => sshd.close(() => resolve())) };
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    sshPool = (await import('../../server/ssh/pool')).sshPool;
});

afterEach(async () => {
    while (sockets.length) sockets.pop()?.disconnect();
    while (closers.length) await closers.pop()!();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('file sessions whose SFTP channel fails', () => {
    for (const behaviour of ['bad-packet', 'end'] as const) {
        it(`reports a ${behaviour === 'end' ? 'channel that ends on its own' : 'malformed SFTP packet'} and keeps the pooled connection (BC-0${behaviour === 'end' ? 9 : 8})`, async () => {
            const odd = await startOddSftpServer(behaviour);
            const id = await save({ name: `sftp-${behaviour}`, ip: '127.0.0.1', port: odd.port, type: 'linux', username: 'tester', password: 'secret' });
            closers.push(async () => {
                sshPool.invalidate(id, { close: true });
                await vi.waitFor(() => expect(sshPool.inspect(id).connections).toBe(0));
                await odd.close();
            });
            // Another user of the same pooled connection (a terminal, status...).
            const held = await sshPool.acquire(id);
            const closedByPool = vi.fn();
            held.onClose(closedByPool);

            const files = await connected(open());
            const ready = nextEvent(files, 'connection-ready');
            files.emit('start-ssh', { serverId: id, purpose: 'files' });
            await ready;

            const error = nextEvent<[string, ConnectionError]>(files, 'ssh-error');
            const closed = nextEvent(files, 'ssh-closed');
            const reply = files.timeout(10_000).emitWithAck('files-list', { path: '/' }).catch((err: unknown) => err);
            const [message, coded] = await error;
            await closed;
            expect(coded.code).toBe(behaviour === 'end' ? 'SFTP_ENDED' : 'SFTP_FAILED');
            expect(message).toMatch(/file session/);
            await reply;

            // The file session let go of its lease; the connection is still up.
            expect(closedByPool).not.toHaveBeenCalled();
            expect(sshPool.inspect(id)).toEqual({ connections: 1, refs: 1 });
            const { exec } = await import('../../server/ssh/exec');
            expect((await exec(held, 'still-up')).stdout).toBe('still-up\n');
            held.release();
        });
    }
});

describe('host keys behind a jump host (BC-02)', () => {
    it('reports and trusts keys per route, leaving the same address on other routes alone', async () => {
        const inner = await startSshServer();
        const bastion = await startSshServer({ forward: () => ({ host: inner.host, port: inner.port }) });
        closers.push(() => inner.close(), () => bastion.close());
        const bastionId = await save({ name: 'bastion', ip: bastion.host, port: bastion.port, type: 'linux', username: 'tester', password: 'secret' });
        const id = await save({ name: 'db', ip: '10.0.0.5', port: 22, type: 'linux', username: 'tester', password: 'secret', jump_server_id: bastionId });
        closers.push(() => {
            sshPool.invalidate(id, { close: true });
            sshPool.invalidate(bastionId, { close: true });
        });
        const via = `${bastion.host}:${bastion.port}`;

        // First use: both keys are pinned, each on its own route.
        const first = await connected(open());
        const trusted: Array<{ host: string; via?: string }> = [];
        first.on('host-key-trusted', (info: { host: string; via?: string }) => trusted.push(info));
        const ready = nextEvent(first, 'connection-ready');
        first.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await ready;
        expect(trusted).toEqual(expect.arrayContaining([
            expect.objectContaining({ host: bastion.host, port: bastion.port }),
            expect.objectContaining({ host: '10.0.0.5', port: 22, via, fingerprint: inner.fingerprint }),
        ]));
        expect(trusted.find((info) => info.host === bastion.host)).not.toHaveProperty('via');
        first.disconnect();
        sshPool.invalidate(id, { close: true });

        // The key of 10.0.0.5 behind the bastion changes; another 10.0.0.5
        // (reached directly) has its own pin.
        const { knownHostsRepo } = await import('../../server/db/knownHostsRepo');
        const OLD = `SHA256:${'A'.repeat(43)}`;
        const DIRECT = `SHA256:${'D'.repeat(43)}`;
        await knownHostsRepo.replace({ host: '10.0.0.5', port: 22, via, key_type: 'ssh-ed25519', fingerprint: OLD }, inner.fingerprint);
        await knownHostsRepo.pin({ host: '10.0.0.5', port: 22, key_type: 'ssh-ed25519', fingerprint: DIRECT });

        const socket = await connected(open());
        const mismatch = nextEvent<[Record<string, unknown>]>(socket, 'host-key-mismatch');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        const [changed] = await mismatch;
        expect(changed).toMatchObject({ host: '10.0.0.5', port: 22, via, expected: OLD, actual: inner.fingerprint });

        const result = await socket.timeout(5000).emitWithAck('trust-host-key', {
            serverId: id, host: '10.0.0.5', port: 22, keyType: changed.keyType, expected: OLD, actual: inner.fingerprint,
        });
        expect(result).toEqual({ ok: true });
        expect((await knownHostsRepo.find('10.0.0.5', 22, via))?.fingerprint).toBe(inner.fingerprint);
        expect((await knownHostsRepo.find('10.0.0.5', 22))?.fingerprint).toBe(DIRECT);

        const again = nextEvent(socket, 'connection-ready');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await again;
    });
});

describe('coded connection errors', () => {
    let harness: SshHarness;

    beforeAll(async () => {
        harness = await startSshServer();
    });

    afterAll(async () => {
        await harness?.close();
    });

    async function failure(payload: Record<string, unknown>): Promise<[string, ConnectionError]> {
        const socket = await connected(open());
        const error = nextEvent<[string, ConnectionError]>(socket, 'ssh-error');
        socket.emit('start-ssh', payload);
        return error;
    }

    it('names the cause with a code next to the English text', async () => {
        const refused = await save({ name: 'closed', ip: '127.0.0.1', port: 1, type: 'linux', username: 'root' });
        const [refusedText, refusedError] = await failure({ serverId: refused, purpose: 'terminal' });
        expect(refusedText).toMatch(/ECONNREFUSED/);
        expect(refusedError).toMatchObject({ code: 'ECONNREFUSED', message: refusedText });

        const badPassword = await save({ name: 'bad', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'wrong' });
        const [authText, authError] = await failure({ serverId: badPassword, purpose: 'terminal' });
        expect(authText).toMatch(/^Auth failed/);
        expect(authError.code).toBe('AUTH_FAILED');

        const [missingText, missingError] = await failure({ serverId: 999999, purpose: 'terminal' });
        expect(missingText).toBe('Server #999999 does not exist (it may have been deleted).');
        expect(missingError.code).toBe('SERVER_NOT_FOUND');

        const [adHocText, adHocError] = await failure({ host: '127.0.0.1', type: 'linux' });
        expect(adHocText).toBe('A saved server is required for this connection.');
        expect(adHocError.code).toBe('INVALID_SERVER_ID');

        const ftp = await save({ name: 'closed-ftp', ip: '127.0.0.1', port: 1, type: 'ftp', username: 'anonymous' });
        const [ftpText, ftpError] = await failure({ serverId: ftp, purpose: 'terminal' });
        // The English text keeps its prefix for older listeners.
        expect(ftpText).toMatch(/^FTP Error: .*ECONNREFUSED/);
        expect(ftpError.code).toBe('ECONNREFUSED');
    });

    it('announces an FTP terminal as a notice, not as English output', async () => {
        const { startFtpServer } = await import('../helpers/ftpServer');
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-ftp-notice-'));
        const ftp = await startFtpServer(root);
        closers.push(async () => {
            await ftp.close();
            fs.rmSync(root, { recursive: true, force: true });
        });
        const id = await save({ name: 'ftp-notice', ip: ftp.host, port: ftp.port, type: 'ftp', username: 'ftpuser', password: 'ftppass' });
        const socket = await connected(open());
        let output = '';
        socket.on('ssh-output', (chunk: string) => { output += chunk; });
        const notice = nextEvent<[{ kind: string; protocol?: string; target: string }]>(socket, 'terminal-notice');
        const ready = nextEvent(socket, 'connection-ready');
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        await ready;
        expect((await notice)[0]).toEqual({ kind: 'connected', protocol: 'ftp', target: `127.0.0.1:${ftp.port}`, via: [] });
        expect(output).not.toMatch(/Connected to/);
    });
});
