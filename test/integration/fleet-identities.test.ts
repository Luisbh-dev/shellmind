import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IdentitySummary } from '../../shared/identities';
import type { ServerSummary } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7 integration (S1 + S2): a fleet hold on rejected credentials lifts when the
// connection changes, and for a server that signs in with an identity that
// includes the identity's credentials (its stamp is credentialMarkers).

let server: TestServer;
let markers: typeof import('../../server/fleet/repo')['credentialMarkers'];
let listSummaries: () => Promise<ServerSummary[]>;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

beforeAll(async () => {
    server = await bootTestServer();
    ({ credentialMarkers: markers } = await import('../../server/fleet/repo'));
    const { serversRepo } = await import('../../server/db/serversRepo');
    listSummaries = () => serversRepo.listSummaries();
});

afterAll(async () => {
    await server?.close();
});

async function markerOf(id: number): Promise<string | undefined> {
    return (await markers(await listSummaries())).get(id);
}

describe('the fleet credential marker of a server signing in with an identity', () => {
    it('changes with the identity\'s secrets, user and agent setting, and not with its name', async () => {
        const identity = (await api<{ data: IdentitySummary }>('POST', '/api/identities', { name: 'ops-team', username: 'ops', password: 'first-Pw-1' })).body.data;
        const created = await api<{ data: ServerSummary }>('POST', '/api/servers', { name: 'fleet-id-1', ip: '10.9.0.1', type: 'linux', identity_id: identity.id });
        expect(created.status, JSON.stringify(created.body)).toBe(200);
        const id = created.body.data.id;
        const own = (await api<{ data: ServerSummary }>('POST', '/api/servers', { name: 'fleet-own-1', ip: '10.9.0.2', type: 'linux', username: 'root', password: 'x-Pw-1' })).body.data.id;

        const first = await markerOf(id);
        expect(first).toContain('|identity:');
        expect(await markerOf(own)).not.toContain('identity');

        // A new password (written again: a new IV) is a new marker.
        await api('PUT', `/api/identities/${identity.id}`, { name: 'ops-team', password: 'second-Pw-2' });
        const second = await markerOf(id);
        expect(second).not.toBe(first);

        // Renaming the identity changes nothing the server connects with.
        await api('PUT', `/api/identities/${identity.id}`, { name: 'ops-renamed' });
        expect(await markerOf(id)).toBe(second);

        await api('PUT', `/api/identities/${identity.id}`, { name: 'ops-renamed', username: 'deploy' });
        expect(await markerOf(id)).not.toBe(second);
    });
});
