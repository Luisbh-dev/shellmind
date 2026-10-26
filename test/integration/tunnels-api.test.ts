import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerHostKey, TunnelView } from '../../shared/tunnels';
import type { AuditEntry } from '../../shared/types';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Tunnels HTTP API: CRUD with validation, start/stop with live status and
// audit entries, end to end through the in-process SSH server; and the host
// key pinned for a server.

vi.setConfig({ testTimeout: 20_000 });

let server: TestServer;
let ssh: SshHarness;
let echoPort: number;
let tunnelManager: typeof import('../../server/tunnels/manager')['tunnelManager'];
const listeners: net.Server[] = [];

type ErrorBody = { error: string; code?: string; details?: Record<string, unknown> };

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

async function listen(handler?: (socket: net.Socket) => void): Promise<number> {
    const listener = net.createServer((socket) => {
        socket.on('error', () => undefined);
        handler?.(socket);
    });
    listeners.push(listener);
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    return (listener.address() as net.AddressInfo).port;
}

async function freePort(): Promise<number> {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address() as net.AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    return port;
}

function exchange(port: number, text: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, '127.0.0.1', () => socket.write(text));
        let received = '';
        socket.on('data', (chunk: Buffer) => {
            received += chunk.toString();
            if (received.length >= text.length) {
                socket.destroy();
                resolve(received);
            }
        });
        socket.once('error', reject);
    });
}

async function createServer(body: Record<string, unknown>): Promise<number> {
    const res = await api<{ data: { id: number } }>('POST', '/api/servers', body);
    expect(res.body.data?.id).toEqual(expect.any(Number));
    return res.body.data.id;
}

const sshServer = () => createServer({ name: 'harness', ip: ssh.host, port: ssh.port, type: 'linux', username: 'tester', password: 'secret' });

async function auditOf(serverId: number): Promise<AuditEntry[]> {
    return (await api<{ data: AuditEntry[] }>('GET', `/api/audit?source=ops&serverId=${serverId}`)).body.data;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    tunnelManager = (await import('../../server/tunnels/manager')).tunnelManager;
    ssh = await startSshServer();
    echoPort = await listen((socket) => socket.pipe(socket));
});

afterAll(async () => {
    await tunnelManager?.stopAll();
    await ssh?.close();
    for (const listener of listeners) listener.close();
    await server?.close();
    vi.restoreAllMocks();
});

describe('tunnels API', () => {
    it('requires the session token', async () => {
        const res = await fetch(`${server.baseUrl}/api/servers/1/tunnels`);
        expect(res.status).toBe(401);
    });

    it('creates tunnels with defaults and validates every field', async () => {
        const serverId = await createServer({ name: 'db-host', ip: '10.9.0.1', type: 'linux' });

        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: 15432, remote_port: 5432 });
        expect(created.status).toBe(201);
        expect(created.body.data).toEqual({
            id: expect.any(Number),
            server_id: serverId,
            name: null,
            local_host: '127.0.0.1',
            local_port: 15432,
            remote_host: '127.0.0.1',
            remote_port: 5432,
            auto_start: false,
            created_at: expect.any(Number),
            status: { state: 'stopped', activeConnections: 0, totalConnections: 0, bytesOut: 0, bytesIn: 0, startedAt: null, lastError: null },
        });

        const normalized = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, {
            name: '  Redis  ', local_host: 'localhost', local_port: '16379', remote_host: '[fd00::5]', remote_port: 6379, auto_start: true,
        });
        expect(normalized.body.data).toMatchObject({ name: 'Redis', local_host: '127.0.0.1', local_port: 16379, remote_host: 'fd00::5', auto_start: true });

        // details.field names the field, so the UI can explain it in the user's language.
        for (const [field, body] of [
            ['local_port', { remote_port: 5432 }],
            ['local_port', { local_port: 0, remote_port: 5432 }],
            ['local_port', { local_port: 70000, remote_port: 5432 }],
            ['local_port', { local_port: 'abc', remote_port: 5432 }],
            ['local_port', { local_port: 1.5, remote_port: 5432 }],
            ['remote_port', { local_port: 15432 }],
            ['remote_host', { local_port: 15432, remote_port: 5432, remote_host: 'bad host!' }],
            ['local_host', { local_port: 15432, remote_port: 5432, local_host: 'example.com' }],
            ['local_host', { local_port: 15432, remote_port: 5432, local_host: '999.1.1.1' }],
            ['name', { local_port: 15432, remote_port: 5432, name: 'x'.repeat(81) }],
            ['auto_start', { local_port: 15432, remote_port: 5432, auto_start: 'yes' }],
        ] as const) {
            const res = await api<ErrorBody>('POST', `/api/servers/${serverId}/tunnels`, body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.body).toMatchObject({ code: 'INVALID_TUNNEL', details: { field } });
        }

        const list = await api<{ data: TunnelView[] }>('GET', `/api/servers/${serverId}/tunnels`);
        expect(list.body.data.map((tunnel) => tunnel.local_port)).toEqual([15432, 16379]);
    });

    it('asks for confirmation before listening on an address other machines can reach', async () => {
        const serverId = await createServer({ name: 'exposed', ip: '10.9.0.2', type: 'linux' });
        const body = { local_host: '0.0.0.0', local_port: 18080, remote_port: 80 };

        const refused = await api<ErrorBody>('POST', `/api/servers/${serverId}/tunnels`, body);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'PUBLIC_BIND_UNCONFIRMED', details: { local_host: '0.0.0.0' } });

        const confirmed = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { ...body, confirm_public_bind: true });
        expect(confirmed.status).toBe(201);
        const id = confirmed.body.data.id;

        // Already confirmed for this address: other edits need no new confirmation.
        const renamed = await api<{ data: TunnelView }>('PUT', `/api/tunnels/${id}`, { name: 'web' });
        expect(renamed.body.data).toMatchObject({ name: 'web', local_host: '0.0.0.0', local_port: 18080, remote_port: 80 });

        const moved = await api<ErrorBody>('PUT', `/api/tunnels/${id}`, { local_host: '192.168.1.10' });
        expect(moved.body.code).toBe('PUBLIC_BIND_UNCONFIRMED');
        const backToLoopback = await api<{ data: TunnelView }>('PUT', `/api/tunnels/${id}`, { local_host: '::1' });
        expect(backToLoopback.body.data.local_host).toBe('::1');
    });

    it('only offers tunnels and host keys for SSH servers', async () => {
        const ftpId = await createServer({ name: 'ftp', ip: '10.9.0.3', type: 'ftp' });
        for (const [method, path] of [
            ['GET', `/api/servers/${ftpId}/tunnels`],
            ['POST', `/api/servers/${ftpId}/tunnels`],
            ['GET', `/api/servers/${ftpId}/host-key`],
        ] as const) {
            const res = await api<ErrorBody>(method, path, method === 'POST' ? { local_port: 2121, remote_port: 21 } : undefined);
            expect(res.status, path).toBe(400);
            expect(res.body.code).toBe('UNSUPPORTED_SERVER');
        }
        expect((await api<ErrorBody>('GET', '/api/servers/99999/tunnels')).body.code).toBe('SERVER_NOT_FOUND');
        expect((await api('GET', '/api/servers/abc/tunnels')).status).toBe(404);
        for (const [method, path] of [['PUT', '/api/tunnels/99999'], ['DELETE', '/api/tunnels/99999'], ['POST', '/api/tunnels/99999/start'], ['POST', '/api/tunnels/99999/stop']] as const) {
            const res = await api<ErrorBody>(method, path, method === 'PUT' ? {} : undefined);
            expect(res.status, `${method} ${path}`).toBe(404);
            expect(res.body.code).toBe('TUNNEL_NOT_FOUND');
        }
    });

    it('starts, forwards, reports and stops a tunnel, and audits each step', async () => {
        const serverId = await sshServer();
        const localPort = await freePort();
        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { name: 'echo', local_port: localPort, remote_port: echoPort });
        const id = created.body.data.id;

        const started = await api<{ data: TunnelView }>('POST', `/api/tunnels/${id}/start`);
        expect(started.status).toBe(200);
        expect(started.body.data.status).toMatchObject({ state: 'listening', lastError: null });

        expect(await exchange(localPort, 'ping through the API')).toBe('ping through the API');
        let view: TunnelView | undefined;
        const deadline = Date.now() + 5000;
        do {
            view = (await api<{ data: TunnelView[] }>('GET', `/api/servers/${serverId}/tunnels`)).body.data.find((tunnel) => tunnel.id === id);
        } while (view?.status.activeConnections !== 0 && Date.now() < deadline);
        expect(view?.status).toMatchObject({ state: 'listening', activeConnections: 0, totalConnections: 1, bytesOut: 20, bytesIn: 20 });

        // Starting again is a no-op.
        expect((await api<{ data: TunnelView }>('POST', `/api/tunnels/${id}/start`)).body.data.status.startedAt).toBe(started.body.data.status.startedAt);

        const stopped = await api<{ data: TunnelView }>('POST', `/api/tunnels/${id}/stop`);
        expect(stopped.body.data.status.state).toBe('stopped');
        await expect(exchange(localPort, 'x')).rejects.toThrow(/ECONNREFUSED/);

        const commands = (await auditOf(serverId)).map((entry) => [entry.command, entry.exit_code]);
        expect(commands).toEqual([
            [`tunnel stop 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, null],
            [`tunnel start 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, 0],
            [`tunnel start 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, 0],
            [`tunnel create 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, null],
        ]);
    });

    it('explains why a tunnel cannot start', async () => {
        const serverId = await sshServer();
        const busyPort = await listen();
        const busy = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: busyPort, remote_port: echoPort });

        const refused = await api<ErrorBody>('POST', `/api/tunnels/${busy.body.data.id}/start`);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'PORT_IN_USE', details: { host: '127.0.0.1', port: busyPort } });
        const list = await api<{ data: TunnelView[] }>('GET', `/api/servers/${serverId}/tunnels`);
        expect(list.body.data[0].status).toMatchObject({ state: 'error', lastError: { code: 'PORT_IN_USE' } });
        expect((await auditOf(serverId))[0]).toMatchObject({ exit_code: 1, meta: expect.objectContaining({ action: 'start', error: 'PORT_IN_USE' }) });

        const badCredentials = await createServer({ name: 'bad', ip: ssh.host, port: ssh.port, type: 'linux', username: 'tester', password: 'wrong' });
        const tunnel = await api<{ data: TunnelView }>('POST', `/api/servers/${badCredentials}/tunnels`, { local_port: await freePort(), remote_port: echoPort });
        const failed = await api<ErrorBody>('POST', `/api/tunnels/${tunnel.body.data.id}/start`);
        expect(failed.status).toBe(502);
        expect(failed.body.code).toBe('SSH_CONNECT_FAILED');
        expect(failed.body.error).toMatch(/Auth failed/);
    });

    it('restarts a running tunnel on edit and frees its port on delete', async () => {
        const serverId = await sshServer();
        const firstPort = await freePort();
        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: firstPort, remote_port: echoPort });
        const id = created.body.data.id;
        await api('POST', `/api/tunnels/${id}/start`);

        const secondPort = await freePort();
        const edited = await api<{ data: TunnelView }>('PUT', `/api/tunnels/${id}`, { local_port: secondPort });
        expect(edited.body.data).toMatchObject({ local_port: secondPort, status: { state: 'listening' } });
        expect(await exchange(secondPort, 'moved')).toBe('moved');
        await expect(exchange(firstPort, 'x')).rejects.toThrow(/ECONNREFUSED/);

        // A restart that fails still saves the edit; the status says why.
        const busyPort = await listen();
        const blocked = await api<{ data: TunnelView }>('PUT', `/api/tunnels/${id}`, { local_port: busyPort });
        expect(blocked.status).toBe(200);
        expect(blocked.body.data).toMatchObject({ local_port: busyPort, status: { state: 'error', lastError: { code: 'PORT_IN_USE' } } });

        await api('PUT', `/api/tunnels/${id}`, { local_port: secondPort });
        await api('POST', `/api/tunnels/${id}/start`);
        expect((await api('DELETE', `/api/tunnels/${id}`)).status).toBe(200);
        await expect(exchange(secondPort, 'x')).rejects.toThrow(/ECONNREFUSED/);
        expect((await api<{ data: TunnelView[] }>('GET', `/api/servers/${serverId}/tunnels`)).body.data).toEqual([]);
    });

    it('cancels a start that a stop overtook, at once, and audits it as failed', async () => {
        // Accepts TCP but never answers the SSH handshake.
        const silent = new Set<net.Socket>();
        const blackHole = await listen((socket) => silent.add(socket));
        const serverId = await createServer({ name: 'slow', ip: '127.0.0.1', port: blackHole, type: 'linux', username: 'tester', password: 'secret' });
        const localPort = await freePort();
        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: localPort, remote_port: echoPort });
        const id = created.body.data.id;

        const starting = api<ErrorBody>('POST', `/api/tunnels/${id}/start`);
        const deadline = Date.now() + 5000;
        while (silent.size === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
        expect(silent.size).toBe(1);
        expect((await api<{ data: TunnelView[] }>('GET', `/api/servers/${serverId}/tunnels`)).body.data[0].status.state).toBe('starting');

        const stopped = await api<{ data: TunnelView }>('POST', `/api/tunnels/${id}/stop`);
        expect(stopped.body.data.status).toMatchObject({ state: 'stopped', lastError: null });
        const cancelled = await starting;
        expect(cancelled.status).toBe(409);
        expect(cancelled.body.code).toBe('TUNNEL_START_CANCELLED');
        await expect(exchange(localPort, 'x')).rejects.toThrow(/ECONNREFUSED/);

        const entries = (await auditOf(serverId)).map((entry) => [entry.command, entry.exit_code, entry.meta?.error ?? null]);
        expect(entries).toHaveLength(3);
        expect(entries).toEqual(expect.arrayContaining([
            [`tunnel start 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, 1, 'TUNNEL_START_CANCELLED'],
            [`tunnel stop 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, null, null],
            [`tunnel create 127.0.0.1:${localPort} -> 127.0.0.1:${echoPort}`, null, null],
        ]));
        for (const socket of silent) socket.destroy();
    });

    it('stops the tunnels of a server that is no longer an SSH server', async () => {
        const serverId = await sshServer();
        const localPort = await freePort();
        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: localPort, remote_port: echoPort });
        await api('POST', `/api/tunnels/${created.body.data.id}/start`);
        const row = { name: 'harness', ip: ssh.host, port: ssh.port, username: 'tester' };

        // Other edits keep it running.
        expect((await api('PUT', `/api/servers/${serverId}`, { ...row, type: 'linux', notes: 'renamed' })).status).toBe(200);
        expect(await exchange(localPort, 'still up')).toBe('still up');

        expect((await api('PUT', `/api/servers/${serverId}`, { ...row, type: 'ftp', keep_secrets: true })).status).toBe(200);
        expect(tunnelManager.isRunning(created.body.data.id)).toBe(false);
        await expect(exchange(localPort, 'x')).rejects.toThrow(/ECONNREFUSED/);
    });

    it('stops the tunnels of a deleted server', async () => {
        const serverId = await sshServer();
        const localPort = await freePort();
        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: localPort, remote_port: echoPort });
        await api('POST', `/api/tunnels/${created.body.data.id}/start`);
        expect(await exchange(localPort, 'alive')).toBe('alive');

        expect((await api('DELETE', `/api/servers/${serverId}`)).status).toBe(200);
        await expect(exchange(localPort, 'x')).rejects.toThrow(/ECONNREFUSED/);
        expect(tunnelManager.isRunning(created.body.data.id)).toBe(false);
    });

    it('shows and forgets the host key pinned for a server', async () => {
        const serverId = await sshServer();
        // Earlier tests connected already: start over from an unknown host.
        const known = await api<{ data: Array<{ id: number; port: number }> }>('GET', '/api/known-hosts');
        for (const entry of known.body.data.filter((host) => host.port === ssh.port)) await api('DELETE', `/api/known-hosts/${entry.id}`);

        const before = await api<{ data: ServerHostKey }>('GET', `/api/servers/${serverId}/host-key`);
        expect(before.body.data).toEqual({ host: ssh.host, port: ssh.port, knownHost: null });

        // Pinned on first use.
        const created = await api<{ data: TunnelView }>('POST', `/api/servers/${serverId}/tunnels`, { local_port: await freePort(), remote_port: echoPort });
        await api('POST', `/api/tunnels/${created.body.data.id}/start`);
        const pinned = await api<{ data: ServerHostKey }>('GET', `/api/servers/${serverId}/host-key`);
        expect(pinned.body.data.knownHost).toMatchObject({ host: ssh.host, port: ssh.port, key_type: 'ssh-ed25519', fingerprint: ssh.fingerprint });
        await api('POST', `/api/tunnels/${created.body.data.id}/stop`);

        expect((await api('DELETE', `/api/known-hosts/${pinned.body.data.knownHost!.id}`)).status).toBe(200);
        expect((await api<{ data: ServerHostKey }>('GET', `/api/servers/${serverId}/host-key`)).body.data.knownHost).toBeNull();

        const windows = await createServer({ name: 'win', ip: '10.9.0.9', type: 'windows', port: 3390, ssh_port: 2222 });
        expect((await api<{ data: ServerHostKey }>('GET', `/api/servers/${windows}/host-key`)).body.data).toEqual({ host: '10.9.0.9', port: 2222, knownHost: null });
        expect((await api<ErrorBody>('GET', '/api/servers/99999/host-key')).body.code).toBe('SERVER_NOT_FOUND');
    });
});
