import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerHostKey } from '../../shared/tunnels';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The host key shown for a saved server (GET /api/servers/:id/host-key) is
// the one pinned for the server's own route: a server behind a jump host has
// its pin on that route (BC-02), and the same address behind another bastion,
// or reached directly, is another machine.

vi.setConfig({ testTimeout: 20_000 });

let server: TestServer;
const harnesses: SshHarness[] = [];
let sshPool: typeof import('../../server/ssh/pool')['sshPool'];
let savedRouteVia: typeof import('../../server/ssh/savedRoute')['savedRouteVia'];
let routeVia: typeof import('../../server/ssh/hostKeys')['routeVia'];
let loadSshTarget: typeof import('../../server/connections/target')['loadSshTarget'];
let serversRepo: typeof import('../../server/db/serversRepo')['serversRepo'];
let dbRun: typeof import('../../server/db/sqlite')['dbRun'];

async function harness(options?: Parameters<typeof startSshServer>[0]): Promise<SshHarness> {
    const started = await startSshServer(options);
    harnesses.push(started);
    return started;
}

async function createServer(body: Record<string, unknown>): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'linux', username: 'tester', password: 'secret', ...body }),
    });
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: { id: number } }).data.id;
}

async function hostKeyOf(id: number): Promise<ServerHostKey> {
    const res = await server.fetch(`/api/servers/${id}/host-key`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { data: ServerHostKey }).data;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    ({ sshPool } = await import('../../server/ssh/pool'));
    ({ savedRouteVia } = await import('../../server/ssh/savedRoute'));
    ({ routeVia } = await import('../../server/ssh/hostKeys'));
    ({ loadSshTarget } = await import('../../server/connections/target'));
    ({ serversRepo } = await import('../../server/db/serversRepo'));
    ({ dbRun } = await import('../../server/db/sqlite'));
});

afterAll(async () => {
    await server?.close();
    while (harnesses.length) await harnesses.pop()!.close();
    vi.restoreAllMocks();
});

describe('GET /api/servers/:id/host-key', () => {
    it('shows the key pinned for the server’s own jump route (BC-02)', async () => {
        // 10.0.0.5:22 is another machine on each site.
        const siteA = await harness();
        const siteB = await harness();
        const bastionA = await harness({ forward: () => ({ host: siteA.host, port: siteA.port }) });
        const bastionB = await harness({ forward: () => ({ host: siteB.host, port: siteB.port }) });
        const a = await createServer({ name: 'bastion-a', ip: bastionA.host, port: bastionA.port });
        const b = await createServer({ name: 'bastion-b', ip: bastionB.host, port: bastionB.port });
        const behindA = await createServer({ name: 'db-a', ip: '10.0.0.5', port: 22, jump_server_id: a });
        const behindB = await createServer({ name: 'db-b', ip: '10.0.0.5', port: 22, jump_server_id: b });
        const direct = await createServer({ name: 'db-direct', ip: '10.0.0.5', port: 22 });

        (await sshPool.acquire(behindA)).release();
        (await sshPool.acquire(behindB)).release();

        const keyA = await hostKeyOf(behindA);
        expect(keyA).toMatchObject({ host: '10.0.0.5', port: 22 });
        expect(keyA.knownHost).toMatchObject({ fingerprint: siteA.fingerprint, via: `${bastionA.host}:${bastionA.port}` });
        expect((await hostKeyOf(behindB)).knownHost).toMatchObject({ fingerprint: siteB.fingerprint, via: `${bastionB.host}:${bastionB.port}` });
        // Never connected directly: nothing is pinned for that route.
        expect((await hostKeyOf(direct)).knownHost).toBeNull();
        // The bastions' own keys, pinned on the way.
        expect((await hostKeyOf(a)).knownHost).toMatchObject({ fingerprint: bastionA.fingerprint, via: '' });
    });

    it('works the route out like the connection does, without the secrets', async () => {
        const first = await createServer({ name: 'hop-1', ip: ' 192.0.2.10 ', port: 2201 });
        const second = await createServer({ name: 'hop-2', type: 'windows', ip: '192.0.2.11', port: 3390, ssh_port: 2222, jump_server_id: first });
        const target = await createServer({ name: 'inner', ip: '10.1.0.7', jump_server_id: second });
        for (const id of [first, second, target]) {
            const summary = (await serversRepo.getSummary(id))!;
            expect(await savedRouteVia(summary), `server ${id}`).toBe(routeVia(await loadSshTarget(id)));
        }
        expect(await savedRouteVia((await serversRepo.getSummary(target))!)).toBe('192.0.2.10:2201>192.0.2.11:2222');

        // A chain the connection refuses has no route, so no pin (saving one
        // is refused; the row is edited behind the API's back).
        const looped = await createServer({ name: 'loop-a', ip: '10.1.0.8' });
        const other = await createServer({ name: 'loop-b', ip: '10.1.0.9', jump_server_id: looped });
        await dbRun('UPDATE servers SET jump_server_id = ? WHERE id = ?', [other, looped]);
        await expect(loadSshTarget(looped)).rejects.toMatchObject({ code: 'JUMP_HOST' });
        expect(await savedRouteVia((await serversRepo.getSummary(looped))!)).toBeNull();
        expect((await hostKeyOf(looped)).knownHost).toBeNull();
    });
});
