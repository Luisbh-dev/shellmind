import net from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { HostKeyMismatchPayload } from '../../shared/protocol';
import type { TrustHostKeyResult } from '../../shared/terminal';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// FE-03: a file session trusts a changed host key the way a terminal does:
// the pin is swapped for exactly the key the user compared, so a third key
// answering the reconnect is refused instead of being pinned on first use.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let first: SshHarness;
let third: SshHarness;
let proxy: net.Server;
let upstream = 0;
const OLD = `SHA256:${'A'.repeat(43)}`;

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    first = await startSshServer();
    third = await startSshServer();
    // One address whose host key changes when the proxy switches servers.
    proxy = net.createServer((client) => {
        const target = net.connect(upstream, '127.0.0.1');
        client.pipe(target).pipe(client);
        client.on('error', () => target.destroy());
        target.on('error', () => client.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
});

afterAll(async () => {
    await server?.close();
    await first?.close();
    await third?.close();
    proxy?.close();
    vi.restoreAllMocks();
});

function filesSocket(): Socket {
    return connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
}

// Opens a file session of `id` and resolves with its host key mismatch.
async function mismatchOf(socket: Socket, id: number): Promise<HostKeyMismatchPayload> {
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    const changed = new Promise<HostKeyMismatchPayload>((resolve, reject) => {
        socket.once('host-key-mismatch', resolve);
        socket.once('connection-ready', () => reject(new Error('the file session opened')));
    });
    socket.emit('start-ssh', { serverId: id, purpose: 'files' });
    return changed;
}

describe('trusting a changed host key from a file session', () => {
    it('pins the confirmed key, and a different key answering the reconnect is refused again', async () => {
        const port = (proxy.address() as net.AddressInfo).port;
        const created = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'moved', ip: '127.0.0.1', port, type: 'linux', username: 'tester', password: 'secret' }),
        }).then((res) => res.json() as Promise<{ data: { id: number } }>);
        const id = created.data.id;
        const { knownHostsRepo } = await import('../../server/db/knownHostsRepo');
        await knownHostsRepo.pin({ host: '127.0.0.1', port, key_type: 'ssh-ed25519', fingerprint: OLD });

        upstream = first.port;
        const socket = filesSocket();
        try {
            const changed = await mismatchOf(socket, id);
            expect(changed).toMatchObject({ expected: OLD, actual: first.fingerprint });

            // Before the user confirms, the address starts presenting a third key.
            upstream = third.port;
            const { host, keyType, expected, actual } = changed;
            const result = await socket.timeout(10_000).emitWithAck('trust-host-key', { serverId: id, host, port, keyType, expected, actual }) as TrustHostKeyResult;
            expect(result).toEqual({ ok: true });
            expect((await knownHostsRepo.find('127.0.0.1', port))?.fingerprint).toBe(first.fingerprint);
        } finally {
            socket.disconnect();
        }

        const again = filesSocket();
        try {
            expect(await mismatchOf(again, id)).toMatchObject({ expected: first.fingerprint, actual: third.fingerprint });
            expect((await knownHostsRepo.find('127.0.0.1', port))?.fingerprint).toBe(first.fingerprint);
        } finally {
            again.disconnect();
        }
    });
});
