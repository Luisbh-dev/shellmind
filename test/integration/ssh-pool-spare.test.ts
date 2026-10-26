import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Client, ClientChannel } from 'ssh2';
import { startSshServer, type SshHarness, type SshHarnessOptions } from '../helpers/sshServer';
import { openTempDatabase } from '../helpers/tempDatabase';

// Spare pooled connections for servers that refuse more channels per
// connection (sshd MaxSessions).

vi.setConfig({ testTimeout: 20_000 });

type PoolModule = typeof import('../../server/ssh/pool');

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let poolModule: PoolModule;
let servers: typeof import('../../server/db/serversRepo')['serversRepo'];
let dbRun: typeof import('../../server/db/sqlite')['dbRun'];

const harnesses: SshHarness[] = [];
const pools: InstanceType<PoolModule['SshPool']>[] = [];

async function harness(options?: SshHarnessOptions): Promise<SshHarness> {
    const server = await startSshServer(options);
    harnesses.push(server);
    return server;
}

function pool() {
    const instance = new poolModule.SshPool({ idleTimeoutMs: 200 });
    pools.push(instance);
    return instance;
}

function openShell(client: Client): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
        client.shell({ term: 'xterm' }, (err, stream) => (err ? reject(err) : resolve(stream)));
    });
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = await openTempDatabase();
    poolModule = await import('../../server/ssh/pool');
    servers = (await import('../../server/db/serversRepo')).serversRepo;
    dbRun = (await import('../../server/db/sqlite')).dbRun;
});

afterEach(async () => {
    while (pools.length) pools.pop()!.closeAll();
    while (harnesses.length) await harnesses.pop()!.close();
    await dbRun('DELETE FROM known_hosts');
});

afterAll(async () => {
    await database?.close();
    vi.restoreAllMocks();
});

describe('isChannelRefused', () => {
    it('recognizes MaxSessions refusals and nothing else', () => {
        expect(poolModule.isChannelRefused(Object.assign(new Error('(SSH) Channel open failure: open failed'), { reason: 1 }))).toBe(true);
        expect(poolModule.isChannelRefused(Object.assign(new Error('(SSH) Channel open failure: '), { reason: 1 }))).toBe(true);
        expect(poolModule.isChannelRefused(Object.assign(new Error('(SSH) Channel open failure: '), { reason: 4 }))).toBe(true);
        expect(poolModule.isChannelRefused(new Error('open failed'))).toBe(true);
        expect(poolModule.isChannelRefused(Object.assign(new Error('(SSH) Channel open failure: '), { reason: 2 }))).toBe(false);
        expect(poolModule.isChannelRefused(new Error('Not connected'))).toBe(false);
        expect(poolModule.isChannelRefused(undefined)).toBe(false);
    });
});

describe('SshPool.acquireSpare', () => {
    it('moves to another connection when the server refuses more sessions, reusing spares before opening new ones', async () => {
        const server = await harness({ maxSessions: 1 });
        const id = await servers.create({ name: 'limited', ip: server.host, port: server.port, type: 'linux', username: 'tester', password: 'secret' });
        const sshPool = pool();

        const first = await sshPool.acquire(id);
        await openShell(first.client);
        const second = await sshPool.acquire(id);
        expect(second.client).toBe(first.client);
        const refusal = await openShell(second.client).then(() => null, (err: unknown) => err);
        expect(poolModule.isChannelRefused(refusal)).toBe(true);

        const spare = await sshPool.acquireSpare([second]);
        expect(spare.client).not.toBe(first.client);
        await openShell(spare.client);
        expect(server.connections()).toBe(2);

        // A later refusal on the first connection finds the spare (the server
        // decides whether it has room left).
        const third = await sshPool.acquire(id);
        expect(third.client).toBe(first.client);
        const again = await sshPool.acquireSpare([third]);
        expect(again.client).toBe(spare.client);
        expect(server.connections()).toBe(2);

        // Both refused: a third connection.
        const fresh = await sshPool.acquireSpare([third, again]);
        expect([first.client, spare.client]).not.toContain(fresh.client);
        await openShell(fresh.client);
        expect(sshPool.inspect(id)).toEqual({ connections: 3, refs: 6 });

        for (const lease of [first, second, spare, third, again, fresh]) lease.release();
        expect(sshPool.inspect(id).refs).toBe(0);
        sshPool.invalidate(id, { close: true });
        await vi.waitFor(() => expect(sshPool.inspect(id).connections).toBe(0));
    });

    it('stops offering spares of a server whose row changed', async () => {
        const server = await harness({ maxSessions: 1 });
        const id = await servers.create({ name: 'limited', ip: server.host, port: server.port, type: 'linux', username: 'tester', password: 'secret' });
        const sshPool = pool();

        const first = await sshPool.acquire(id);
        const spare = await sshPool.acquireSpare([first]);
        expect(server.connections()).toBe(2);

        sshPool.invalidate(id);
        const after = await sshPool.acquireSpare([first]);
        expect(after.client).not.toBe(spare.client);
        expect(after.client).not.toBe(first.client);
        for (const lease of [first, spare, after]) lease.release();
    });
});
