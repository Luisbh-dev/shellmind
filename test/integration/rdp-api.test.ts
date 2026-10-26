import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Native Remote Desktop over HTTP. Nothing here may actually open a client:
// every launch below fails validation before anything runs.

let server: TestServer;

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

async function saveServer(body: Record<string, unknown>): Promise<number> {
    const created = await call<{ data: { id: number } }>('POST', '/api/servers', body);
    expect(created.status).toBe(200);
    return created.body.data.id;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('GET /api/rdp/native', () => {
    it('says which client this computer would open', async () => {
        const res = await call<{ data: { supported: boolean; client: string | null; platform: string } }>('GET', '/api/rdp/native');
        expect(res.status).toBe(200);
        expect(res.body.data.platform).toBe(process.platform);
        expect(res.body.data.supported).toBe(res.body.data.client !== null);
        if (process.platform === 'win32') expect(res.body.data.client).toBe('mstsc');
    });

    it('requires the session token', async () => {
        const res = await fetch(`${server.baseUrl}/api/rdp/native`);
        expect(res.status).toBe(401);
    });
});

describe('POST /api/rdp/launch', () => {
    it('needs a saved Windows server', async () => {
        expect(await call('POST', '/api/rdp/launch', {})).toMatchObject({ status: 400, body: { code: 'INVALID_SERVER_ID' } });
        expect(await call('POST', '/api/rdp/launch', { serverId: 999999 })).toMatchObject({ status: 404, body: { code: 'SERVER_NOT_FOUND' } });

        const linux = await saveServer({ name: 'lin', ip: '10.0.0.9', type: 'linux', username: 'root', password: 'x' });
        expect(await call('POST', '/api/rdp/launch', { serverId: linux })).toMatchObject({
            status: 400, body: { code: 'UNSUPPORTED_PURPOSE', error: 'A linux server does not support rdp connections.' },
        });
    });

    it('refuses a target that could smuggle arguments, without echoing the password', async () => {
        const windows = await saveServer({ name: 'win', ip: '-evil /admin', type: 'windows', username: 'admin', password: 'Very$ecret' });
        const res = await call('POST', '/api/rdp/launch', { serverId: windows });
        expect(res).toMatchObject({ status: 400, body: { code: 'RDP_INVALID_TARGET' } });
        expect(JSON.stringify(res.body)).not.toContain('Very$ecret');
    });
});
