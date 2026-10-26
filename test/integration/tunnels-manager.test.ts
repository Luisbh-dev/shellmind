import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { Server as SshServer, type Connection } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Tunnel } from '../../shared/types';
import { generateKeyPair, startSshServer, type SshHarness, type SshHarnessOptions } from '../helpers/sshServer';
import { openTempDatabase } from '../helpers/tempDatabase';

// TunnelManager (SSH local port forwarding) against the in-process ssh2 test
// server, which forwards direct-tcpip channels to local TCP services.

// SSH handshakes are CPU-bound and slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

type ManagerModule = typeof import('../../server/tunnels/manager');
type PoolModule = typeof import('../../server/ssh/pool');
type ServersRepo = typeof import('../../server/db/serversRepo')['serversRepo'];

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let managerModule: ManagerModule;
let poolModule: PoolModule;
let servers: ServersRepo;
let knownHosts: typeof import('../../server/db/knownHostsRepo')['knownHostsRepo'];
let tunnelsRepo: typeof import('../../server/tunnels/repo')['tunnelsRepo'];
let dbRun: typeof import('../../server/db/sqlite')['dbRun'];

type Pool = InstanceType<PoolModule['SshPool']>;
type Manager = InstanceType<ManagerModule['TunnelManager']>;

const cleanups: Array<() => Promise<void> | void> = [];
let nextTunnelId = 1;

async function harness(options?: SshHarnessOptions): Promise<SshHarness> {
    const server = await startSshServer(options);
    cleanups.push(() => server.close());
    return server;
}

function setup(options: ConstructorParameters<ManagerModule['TunnelManager']>[0] = {}): { pool: Pool; manager: Manager } {
    const pool = new poolModule.SshPool({ idleTimeoutMs: 200 });
    const manager = new managerModule.TunnelManager({ pool, audit: async () => undefined, lingerMs: 500, ...options });
    cleanups.push(async () => {
        await manager.stopAll();
        pool.closeAll();
    });
    return { pool, manager };
}

// The first acquire waits until open() is called, like a slow SSH handshake;
// lateAcquire settles once that delayed acquire did.
function setupGated() {
    const pool = new poolModule.SshPool({ idleTimeoutMs: 200 });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    let lateAcquire: Promise<unknown> = Promise.resolve();
    let acquires = 0;
    const gated = {
        acquire: (serverId: number) => {
            acquires += 1;
            if (acquires > 1) return pool.acquire(serverId);
            const late = gate.then(() => pool.acquire(serverId));
            lateAcquire = late.then(() => undefined, () => undefined);
            return late;
        },
    };
    const manager = new managerModule.TunnelManager({ pool: gated, audit: async () => undefined, lingerMs: 500 });
    cleanups.push(async () => {
        open();
        await lateAcquire;
        await manager.stopAll();
        pool.closeAll();
    });
    return { pool, manager, open, lateAcquire: () => lateAcquire, acquires: () => acquires };
}

// Lets every pending promise callback run.
const settle = () => new Promise((resolve) => setImmediate(resolve));

async function saveServer(target: { host: string; port: number }, extra: Record<string, unknown> = {}): Promise<number> {
    return servers.create({ name: `h${target.port}`, ip: target.host, port: target.port, type: 'linux', username: 'tester', password: 'secret', ...extra });
}

// An SSH server that accepts any login but forwards nothing, like OpenSSH with
// AllowTcpForwarding no (ssh2 refuses the channels as administratively prohibited).
async function noForwardingServer(): Promise<{ host: string; port: number }> {
    const clients = new Set<Connection>();
    const server = new SshServer({ hostKeys: [generateKeyPair().privateKey] }, (client) => {
        clients.add(client);
        client.on('close', () => clients.delete(client));
        client.on('error', () => undefined);
        client.on('authentication', (ctx) => ctx.accept());
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    cleanups.push(() => new Promise<void>((resolve) => {
        for (const client of clients) client.end();
        server.close(() => resolve());
    }));
    return { host: '127.0.0.1', port: (server.address() as net.AddressInfo).port };
}

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

async function listenOn(server: net.Server, port = 0): Promise<number> {
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, '127.0.0.1', () => resolve());
    });
    const address = server.address() as net.AddressInfo;
    cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    return address.port;
}

// A TCP echo service; `open()` counts its open connections.
async function echoServer(): Promise<{ port: number; open: () => number }> {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => undefined);
        socket.pipe(socket);
    });
    cleanups.push(() => { for (const socket of sockets) socket.destroy(); });
    return { port: await listenOn(server), open: () => sockets.size };
}

function tunnelFor(serverId: number, localPort: number, remotePort: number, overrides: Partial<Tunnel> = {}): Tunnel {
    return {
        id: nextTunnelId++,
        server_id: serverId,
        name: 'test tunnel',
        local_host: '127.0.0.1',
        local_port: localPort,
        remote_host: '127.0.0.1',
        remote_port: remotePort,
        auto_start: false,
        created_at: Date.now(),
        ...overrides,
    };
}

function connect(port: number): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('connect', () => resolve(socket));
        socket.once('error', reject);
    });
}

// Sends `payload` and resolves with as many bytes as were sent back.
function roundTrip(socket: net.Socket, payload: Buffer): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let received = 0;
        const onData = (chunk: Buffer) => {
            chunks.push(chunk);
            received += chunk.length;
            if (received >= payload.length) {
                socket.off('data', onData);
                resolve(Buffer.concat(chunks));
            }
        };
        socket.on('data', onData);
        socket.once('error', reject);
        socket.once('close', () => reject(new Error(`closed after ${received} of ${payload.length} bytes`)));
        socket.write(payload);
    });
}

async function exchange(port: number, payload: Buffer): Promise<Buffer> {
    const socket = await connect(port);
    try {
        return await roundTrip(socket, payload);
    } finally {
        socket.destroy();
    }
}

function closed(socket: net.Socket): Promise<void> {
    return new Promise((resolve) => {
        if (socket.destroyed) resolve();
        else socket.once('close', () => resolve());
    });
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function canListen(port: number): Promise<boolean> {
    const probe = net.createServer();
    try {
        await new Promise<void>((resolve, reject) => {
            probe.once('error', reject);
            probe.listen(port, '127.0.0.1', () => resolve());
        });
        await new Promise<void>((resolve) => probe.close(() => resolve()));
        return true;
    } catch {
        return false;
    }
}

function rejection(promise: Promise<unknown>): Promise<Error & { code?: string; status?: number }> {
    return promise.then(
        () => { throw new Error('expected a rejection'); },
        (err: Error & { code?: string; status?: number }) => err,
    );
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    database = await openTempDatabase();
    managerModule = await import('../../server/tunnels/manager');
    poolModule = await import('../../server/ssh/pool');
    servers = (await import('../../server/db/serversRepo')).serversRepo;
    knownHosts = (await import('../../server/db/knownHostsRepo')).knownHostsRepo;
    tunnelsRepo = (await import('../../server/tunnels/repo')).tunnelsRepo;
    dbRun = (await import('../../server/db/sqlite')).dbRun;
});

afterEach(async () => {
    while (cleanups.length) await cleanups.pop()!();
    // A later harness may get a closed one's port, with a different host key.
    await dbRun('DELETE FROM known_hosts');
});

afterAll(async () => {
    await database?.close();
    vi.restoreAllMocks();
});

describe('TunnelManager', () => {
    it('forwards a local connection to the remote service and counts its bytes', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { pool, manager } = setup();
        const tunnel = tunnelFor(serverId, await freePort(), echo.port);

        const started = await manager.start(tunnel);
        expect(started).toMatchObject({ state: 'listening', activeConnections: 0, lastError: null });
        expect(started.startedAt).toEqual(expect.any(Number));
        // The connection is held open while the tunnel listens.
        expect(pool.inspect(serverId)).toEqual({ connections: 1, refs: 1 });

        const reply = await exchange(tunnel.local_port, Buffer.from('hello through the tunnel'));
        expect(reply.toString()).toBe('hello through the tunnel');
        expect(ssh.log).toContain(`tcpip:127.0.0.1:${echo.port}`);

        await waitFor(() => manager.status(tunnel.id).activeConnections === 0);
        expect(manager.status(tunnel.id)).toMatchObject({ state: 'listening', totalConnections: 1, bytesOut: 24, bytesIn: 24 });
        expect(pool.inspect(serverId).refs).toBe(1);

        const stopped = await manager.stop(tunnel.id);
        expect(stopped).toMatchObject({ state: 'stopped', startedAt: null, activeConnections: 0 });
        expect(pool.inspect(serverId).refs).toBe(0);
        expect(await canListen(tunnel.local_port)).toBe(true);
    });

    it('serves concurrent connections over one SSH connection, large transfers included', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const { manager } = setup();
        const tunnel = tunnelFor(await saveServer(ssh), await freePort(), echo.port);
        await manager.start(tunnel);

        const payloads = [randomBytes(2 * 1024 * 1024), ...Array.from({ length: 7 }, (_, i) => Buffer.from(`client ${i} `.repeat(50 + i)))];
        const replies = await Promise.all(payloads.map((payload) => exchange(tunnel.local_port, payload)));

        replies.forEach((reply, index) => expect(reply.equals(payloads[index]), `client ${index}`).toBe(true));
        expect(ssh.connections()).toBe(1);
        const total = payloads.reduce((sum, payload) => sum + payload.length, 0);
        await waitFor(() => manager.status(tunnel.id).activeConnections === 0);
        expect(manager.status(tunnel.id)).toMatchObject({ totalConnections: 8, bytesOut: total, bytesIn: total });
    });

    it('still delivers the answer after the client half-closes its side', async () => {
        const ssh = await harness();
        // Answers once the request is complete (like `nc -N` clients expect).
        const service = net.createServer({ allowHalfOpen: true }, (socket) => {
            let length = 0;
            socket.on('data', (chunk: Buffer) => { length += chunk.length; });
            socket.on('end', () => socket.end(`got ${length} bytes`));
            socket.on('error', () => undefined);
        });
        const servicePort = await listenOn(service);
        const { manager } = setup();
        const tunnel = tunnelFor(await saveServer(ssh), await freePort(), servicePort);
        await manager.start(tunnel);

        const socket = await connect(tunnel.local_port);
        const answer = new Promise<string>((resolve) => {
            let text = '';
            socket.on('data', (chunk: Buffer) => { text += chunk.toString(); });
            socket.on('end', () => resolve(text));
        });
        socket.end('request body');
        expect(await answer).toBe('got 12 bytes');
        await closed(socket);
    });

    it('drops active connections when stopped and frees the port', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { pool, manager } = setup();
        const tunnel = tunnelFor(serverId, await freePort(), echo.port);
        await manager.start(tunnel);

        const clients = await Promise.all([connect(tunnel.local_port), connect(tunnel.local_port)]);
        for (const client of clients) expect((await roundTrip(client, Buffer.from('ping'))).toString()).toBe('ping');
        expect(manager.status(tunnel.id).activeConnections).toBe(2);
        await waitFor(() => echo.open() === 2);

        await manager.stop(tunnel.id);
        await Promise.all(clients.map(closed));
        expect(manager.status(tunnel.id)).toMatchObject({ state: 'stopped', activeConnections: 0 });
        expect(pool.inspect(serverId).refs).toBe(0);
        await waitFor(() => echo.open() === 0);
        await expect(connect(tunnel.local_port)).rejects.toThrow(/ECONNREFUSED/);

        // And it starts again on the same port.
        await manager.start(tunnel);
        expect((await exchange(tunnel.local_port, Buffer.from('again'))).toString()).toBe('again');
    });

    it('reports a local port that is already in use, by another program or another tunnel', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { manager } = setup();

        const busyPort = await listenOn(net.createServer());
        const blocked = tunnelFor(serverId, busyPort, echo.port);
        const err = await rejection(manager.start(blocked));
        expect(err).toMatchObject({ code: 'PORT_IN_USE', status: 409 });
        expect(err.message).toContain(`127.0.0.1:${busyPort} is already in use`);
        // The address it is about, kept with the error (the tunnel may be edited later).
        expect(manager.status(blocked.id)).toMatchObject({
            state: 'error',
            lastError: { code: 'PORT_IN_USE', details: { host: '127.0.0.1', port: busyPort } },
        });
        // Nothing was opened for a tunnel that cannot listen.
        expect(ssh.connections()).toBe(0);

        const port = await freePort();
        const first = tunnelFor(serverId, port, echo.port, { name: 'db primary' });
        const second = tunnelFor(serverId, port, echo.port, { name: 'db replica', local_host: '0.0.0.0' });
        await manager.start(first);
        const clash = await rejection(manager.start(second));
        expect(clash).toMatchObject({ code: 'PORT_IN_USE', status: 409 });
        expect(clash.message).toContain('"db primary"');
        expect(manager.status(second.id).lastError?.details).toEqual({ host: '0.0.0.0', port, tunnelId: first.id, tunnelName: 'db primary' });
        expect((await exchange(port, Buffer.from('still mine'))).toString()).toBe('still mine');
    });

    it('keeps listening when the remote service refuses and reports why', async () => {
        const ssh = await harness();
        const { manager } = setup();
        const closedPort = await freePort();
        const tunnel = tunnelFor(await saveServer(ssh), await freePort(), closedPort);
        await manager.start(tunnel);

        const socket = await connect(tunnel.local_port);
        await closed(socket);

        const status = manager.status(tunnel.id);
        expect(status.state).toBe('listening');
        expect(status.lastError).toMatchObject({ code: 'REMOTE_UNREACHABLE', at: expect.any(Number) });
        expect(status.lastError?.message).toContain(`127.0.0.1:${closedPort}`);
        await waitFor(() => manager.status(tunnel.id).activeConnections === 0);
    });

    it('tells a server that does not allow port forwarding apart from an unreachable service', async () => {
        const sshd = await noForwardingServer();
        const echo = await echoServer();
        const { manager } = setup();
        const tunnel = tunnelFor(await saveServer(sshd), await freePort(), echo.port);
        await manager.start(tunnel);

        await closed(await connect(tunnel.local_port));
        await waitFor(() => manager.status(tunnel.id).lastError !== null);
        const { state, lastError } = manager.status(tunnel.id);
        expect(state).toBe('listening');
        expect(lastError?.code).toBe('FORWARDING_DENIED');
        expect(lastError?.message).toContain(`forwarding to 127.0.0.1:${echo.port}`);
        // The service itself was never contacted.
        expect(echo.open()).toBe(0);
    });

    it('fails to start, and frees the port, when the SSH connection cannot be opened', async () => {
        const ssh = await harness();
        const { manager } = setup();
        const tunnel = tunnelFor(await saveServer(ssh, { password: 'wrong' }), await freePort(), 80);

        const err = await rejection(manager.start(tunnel));
        expect(err).toMatchObject({ code: 'SSH_CONNECT_FAILED', status: 502 });
        expect(err.message).toMatch(/Auth failed/);
        expect(manager.status(tunnel.id)).toMatchObject({ state: 'error', lastError: { code: 'SSH_CONNECT_FAILED' } });
        expect(await canListen(tunnel.local_port)).toBe(true);
    });

    it('refuses a server whose host key changed', async () => {
        const ssh = await harness();
        const serverId = await saveServer(ssh);
        await knownHosts.pin({ host: ssh.host, port: ssh.port, key_type: 'ssh-ed25519', fingerprint: 'SHA256:somebody-else' });
        const { manager } = setup();
        const tunnel = tunnelFor(serverId, await freePort(), 80);

        const err = await rejection(manager.start(tunnel));
        expect(err.code).toBe('HOST_KEY_MISMATCH');
        expect(manager.status(tunnel.id)).toMatchObject({ state: 'error', lastError: { code: 'HOST_KEY_MISMATCH' } });
    });

    it('drops forwarded connections when the SSH connection dies and reconnects for the next one', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { pool, manager } = setup();
        const tunnel = tunnelFor(serverId, await freePort(), echo.port);
        await manager.start(tunnel);

        const client = await connect(tunnel.local_port);
        await roundTrip(client, Buffer.from('before'));
        pool.invalidate(serverId, { close: true });
        await closed(client);
        await waitFor(() => manager.status(tunnel.id).lastError?.code === 'SSH_DISCONNECTED');
        expect(manager.status(tunnel.id).state).toBe('listening');

        expect((await exchange(tunnel.local_port, Buffer.from('after'))).toString()).toBe('after');
        expect(ssh.connections()).toBe(2);
        // The new connection is held again once the client is gone.
        await waitFor(() => pool.inspect(serverId).refs === 1);
        expect(pool.inspect(serverId).connections).toBe(1);
    });

    it('reaches the service through a jump host', async () => {
        const jump = await harness();
        const target = await harness();
        const echo = await echoServer();
        const jumpId = await saveServer(jump);
        const targetId = await saveServer(target, { jump_server_id: jumpId });
        const { manager } = setup();
        const tunnel = tunnelFor(targetId, await freePort(), echo.port);
        await manager.start(tunnel);

        expect((await exchange(tunnel.local_port, Buffer.from('via jump'))).toString()).toBe('via jump');
        expect(jump.log).toContain(`tcpip:${target.host}:${target.port}`);
        expect(target.log).toContain(`tcpip:127.0.0.1:${echo.port}`);
    });

    it('restarts a running tunnel whose endpoints changed, and only then', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const { manager } = setup();
        const tunnel = tunnelFor(await saveServer(ssh), await freePort(), echo.port);
        const { startedAt } = await manager.start(tunnel);

        const renamed = await manager.reconfigure({ ...tunnel, name: 'renamed' });
        expect(renamed.startedAt).toBe(startedAt);

        const moved = { ...tunnel, local_port: await freePort() };
        expect((await manager.reconfigure(moved)).state).toBe('listening');
        expect(await canListen(tunnel.local_port)).toBe(true);
        expect((await exchange(moved.local_port, Buffer.from('moved'))).toString()).toBe('moved');

        // A stopped tunnel stays stopped.
        await manager.stop(tunnel.id);
        expect((await manager.reconfigure({ ...moved, local_port: await freePort() })).state).toBe('stopped');
    });

    it('drops the failure of a stopped tunnel once its endpoints change', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const { manager } = setup();
        const busyPort = await listenOn(net.createServer());
        const tunnel = tunnelFor(await saveServer(ssh), busyPort, echo.port);
        await rejection(manager.start(tunnel));

        // Renamed: the failure still applies.
        expect(await manager.reconfigure({ ...tunnel, name: 'renamed' })).toMatchObject({ state: 'error', lastError: { code: 'PORT_IN_USE' } });
        // Moved to another port: it said nothing about that one.
        expect(await manager.reconfigure({ ...tunnel, local_port: await freePort() })).toMatchObject({ state: 'stopped', lastError: null });
    });

    it('gives up a start that is stopped halfway, at once', async () => {
        const ssh = await harness();
        const serverId = await saveServer(ssh);
        const { pool, manager, open, lateAcquire, acquires } = setupGated();
        const tunnel = tunnelFor(serverId, await freePort(), 80);

        const starting = rejection(manager.start(tunnel));
        expect(manager.isRunning(tunnel.id)).toBe(true);
        expect(manager.status(tunnel.id).state).toBe('starting');
        // Listening, and waiting for its SSH connection.
        await waitFor(() => acquires() === 1);
        await manager.stop(tunnel.id);
        // Cancelled without waiting for the SSH connection it was opening.
        expect(await starting).toMatchObject({ code: 'TUNNEL_START_CANCELLED', status: 409 });
        expect(manager.status(tunnel.id)).toMatchObject({ state: 'stopped', lastError: null });
        expect(manager.isRunning(tunnel.id)).toBe(false);
        expect(await canListen(tunnel.local_port)).toBe(true);

        // The connection it was waiting for goes back to the pool when it opens.
        open();
        await lateAcquire();
        await settle();
        expect(pool.inspect(serverId).refs).toBe(0);
    });

    it('cancels a start stopped while it binds its port, and starts again', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const { manager } = setup();
        const tunnel = tunnelFor(await saveServer(ssh), await freePort(), echo.port);

        const first = rejection(manager.start(tunnel));
        await manager.stop(tunnel.id);
        expect(await first).toMatchObject({ code: 'TUNNEL_START_CANCELLED' });
        expect(await canListen(tunnel.local_port)).toBe(true);

        expect(await manager.start(tunnel)).toMatchObject({ state: 'listening' });
        expect((await exchange(tunnel.local_port, Buffer.from('bound again'))).toString()).toBe('bound again');
    });

    it('starts afresh when started again after a stop cancelled a start', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { pool, manager, open, lateAcquire, acquires } = setupGated();
        const tunnel = tunnelFor(serverId, await freePort(), echo.port);

        const first = rejection(manager.start(tunnel));
        await waitFor(() => acquires() === 1);
        await manager.stop(tunnel.id);
        expect(await manager.start(tunnel)).toMatchObject({ state: 'listening', lastError: null });
        expect(acquires()).toBe(2);
        expect(await first).toMatchObject({ code: 'TUNNEL_START_CANCELLED' });
        expect((await exchange(tunnel.local_port, Buffer.from('fresh start'))).toString()).toBe('fresh start');

        open();
        await lateAcquire();
        await settle();
        // Only the running tunnel holds the connection.
        await waitFor(() => manager.status(tunnel.id).activeConnections === 0);
        expect(pool.inspect(serverId)).toEqual({ connections: 1, refs: 1 });
    });

    it('shares a start in progress, and restarts it when edited meanwhile', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { pool, manager, open, lateAcquire, acquires } = setupGated();
        const tunnel = tunnelFor(serverId, await freePort(), echo.port);

        const first = rejection(manager.start(tunnel));
        const second = rejection(manager.start({ ...tunnel, name: 'same endpoints' }));
        await waitFor(() => acquires() === 1);
        await settle();
        expect(acquires()).toBe(1);

        const moved = { ...tunnel, local_port: await freePort() };
        expect(await manager.reconfigure(moved)).toMatchObject({ state: 'listening' });
        for (const cancelled of await Promise.all([first, second])) expect(cancelled.code).toBe('TUNNEL_START_CANCELLED');
        expect(await canListen(tunnel.local_port)).toBe(true);
        expect((await exchange(moved.local_port, Buffer.from('edited while starting'))).toString()).toBe('edited while starting');

        open();
        await lateAcquire();
        await settle();
        await waitFor(() => manager.status(tunnel.id).activeConnections === 0);
        expect(pool.inspect(serverId)).toEqual({ connections: 1, refs: 1 });
    });

    it('stops the tunnels of a server that is no longer an SSH server, and lets go of an edited one\'s old connection', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { pool, manager } = setup();
        const tunnel = tunnelFor(serverId, await freePort(), echo.port);
        await manager.start(tunnel);
        expect(ssh.openConnections()).toBe(1);

        // Edited: the pool no longer hands out the old connection, and the tunnel
        // stops holding it; the next client opens one with the new settings.
        pool.invalidate(serverId);
        await manager.serverUpdated({ id: serverId, type: 'linux' });
        await waitFor(() => ssh.openConnections() === 0);
        expect(manager.status(tunnel.id).state).toBe('listening');
        expect((await exchange(tunnel.local_port, Buffer.from('new settings'))).toString()).toBe('new settings');
        expect(ssh.connections()).toBe(2);
        await waitFor(() => pool.inspect(serverId).refs === 1);

        await manager.serverUpdated({ id: serverId, type: 'ftp' });
        expect(manager.isRunning(tunnel.id)).toBe(false);
        expect(await canListen(tunnel.local_port)).toBe(true);
    });

    it('starts the auto-start tunnels at startup and audits each outcome', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const busyPort = await listenOn(net.createServer());
        const good = tunnelFor(serverId, await freePort(), echo.port, { auto_start: true });
        const busy = tunnelFor(serverId, busyPort, echo.port, { auto_start: true });
        const audit = vi.fn(async () => undefined);
        const { manager } = setup({ audit, loadAutoStart: async () => [good, busy] });

        expect(await manager.startAutoStart()).toEqual({ started: 1, failed: 1 });
        expect(manager.status(good.id).state).toBe('listening');
        expect(manager.status(busy.id)).toMatchObject({ state: 'error', lastError: { code: 'PORT_IN_USE' } });
        expect(audit).toHaveBeenCalledTimes(2);
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({
            serverId, source: 'ops', exitCode: 0, command: `tunnel auto-start 127.0.0.1:${good.local_port} -> 127.0.0.1:${echo.port}`,
        }));
        expect(audit).toHaveBeenCalledWith(expect.objectContaining({
            serverId, source: 'ops', exitCode: 1, meta: expect.objectContaining({ tunnelId: busy.id, error: 'PORT_IN_USE' }),
        }));

        const failing = setup({ loadAutoStart: async () => { throw new Error('db gone'); } });
        vi.spyOn(console, 'error').mockImplementationOnce(() => {});
        expect(await failing.manager.startAutoStart()).toEqual({ started: 0, failed: 0 });
    });

    it('starts automatically only the tunnels of SSH servers', async () => {
        const linux = await servers.create({ name: 'auto-linux', ip: '10.1.0.1', type: 'linux' });
        const ftp = await servers.create({ name: 'auto-ftp', ip: '10.1.0.2', type: 'ftp' });
        const fields = { name: null, local_host: '127.0.0.1', local_port: 15000, remote_host: '127.0.0.1', remote_port: 5432, auto_start: true };
        const kept = await tunnelsRepo.create(linux, fields);
        await tunnelsRepo.create(ftp, { ...fields, local_port: 15001 });
        await tunnelsRepo.create(linux, { ...fields, local_port: 15002, auto_start: false });

        expect((await tunnelsRepo.listAutoStart()).map((tunnel) => tunnel.id)).toEqual([kept.id]);
    });

    it('stops every tunnel of a deleted server', async () => {
        const ssh = await harness();
        const echo = await echoServer();
        const serverId = await saveServer(ssh);
        const { manager } = setup();
        const tunnels = [tunnelFor(serverId, await freePort(), echo.port), tunnelFor(serverId, await freePort(), echo.port)];
        for (const tunnel of tunnels) await manager.start(tunnel);

        await manager.forgetServer(serverId);
        for (const tunnel of tunnels) {
            expect(manager.isRunning(tunnel.id)).toBe(false);
            expect(await canListen(tunnel.local_port)).toBe(true);
        }
    });
});
