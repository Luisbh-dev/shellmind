import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Snippet } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Snippets library: CRUD, validation, scopes and bulk import.

let server: TestServer;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

async function createServer(name: string): Promise<number> {
    const res = await api<{ data: { id: number } }>('POST', '/api/servers', { name, ip: '10.9.0.1', type: 'linux' });
    return res.body.data.id;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('snippets API', () => {
    it('requires the session token', async () => {
        const res = await fetch(`${server.baseUrl}/api/snippets`);
        expect(res.status).toBe(401);
    });

    it('creates, reads, updates and deletes a snippet', async () => {
        const created = await api<{ data: Snippet }>('POST', '/api/snippets', {
            name: '  Disk usage  ',
            command: 'df -h {{path:/}}\r\n  | sort\n\n',
            description: ' Free space ',
            tags: ['disk', ' Disk ', 'ops', ''],
        });
        expect(created.status).toBe(201);
        expect(created.body.data).toEqual({
            id: expect.any(Number),
            name: 'Disk usage',
            // Indentation is kept; CRLF and trailing whitespace are normalized.
            command: 'df -h {{path:/}}\n  | sort',
            description: 'Free space',
            tags: ['disk', 'ops'],
            server_id: null,
            created_at: expect.any(Number),
            updated_at: expect.any(Number),
        });
        const id = created.body.data.id;

        expect((await api<{ data: Snippet }>('GET', `/api/snippets/${id}`)).body.data).toEqual(created.body.data);

        const updated = await api<{ data: Snippet }>('PUT', `/api/snippets/${id}`, { name: 'Disk', command: 'df -h' });
        expect(updated.status).toBe(200);
        expect(updated.body.data).toMatchObject({ id, name: 'Disk', command: 'df -h', description: null, tags: [], server_id: null });

        expect((await api('DELETE', `/api/snippets/${id}`)).status).toBe(200);
        expect((await api('GET', `/api/snippets/${id}`)).status).toBe(404);
        expect((await api('DELETE', `/api/snippets/${id}`)).status).toBe(404);
        expect((await api('PUT', `/api/snippets/${id}`, { name: 'x', command: 'y' })).status).toBe(404);
        expect((await api('GET', '/api/snippets/abc')).status).toBe(404);
    });

    it('rejects invalid snippets, with a reason for the ones the editor can cause', async () => {
        const cases: Array<[Record<string, unknown>, Record<string, unknown> | undefined]> = [
            [{}, { reason: 'nameRequired' }],
            [{ name: 'x' }, { reason: 'commandRequired' }],
            [{ name: '   ', command: 'ls' }, { reason: 'nameRequired' }],
            [{ name: 'x', command: '   \n ' }, { reason: 'commandRequired' }],
            [{ name: 'x'.repeat(121), command: 'ls' }, { reason: 'nameTooLong', max: 120 }],
            [{ name: 'x', command: 'y'.repeat(10_001) }, { reason: 'commandTooLong', max: 10_000 }],
            [{ name: 'x', command: 'ls', description: 'd'.repeat(1001) }, { reason: 'descriptionTooLong', max: 1000 }],
            [{ name: 'x', command: 'ls', description: 5 }, undefined],
            [{ name: 'x', command: 'ls', tags: 'a,b' }, undefined],
            [{ name: 'x', command: 'ls', tags: [1] }, undefined],
            [{ name: 'x', command: 'ls', tags: ['t'.repeat(33)] }, { reason: 'tagTooLong', max: 32 }],
            [{ name: 'x', command: 'ls', tags: Array.from({ length: 17 }, (_, i) => `t${i}`) }, { reason: 'tooManyTags', max: 16 }],
            [{ name: 'x', command: 'ls', server_id: 'abc' }, undefined],
            [{ name: 'x', command: 'ls', server_id: 999_999 }, { reason: 'serverNotFound' }],
        ];
        for (const [body, details] of cases) {
            const res = await api<{ code: string; details?: unknown }>('POST', '/api/snippets', body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(res.body.code).toBe('INVALID_SNIPPET');
            expect(res.body.details, JSON.stringify(body).slice(0, 80)).toEqual(details);
        }
        expect((await api('GET', '/api/snippets?serverId=x')).status).toBe(400);
    });

    it('lists global snippets plus the ones scoped to a server, and deletes scoped ones with their server', async () => {
        const web = await createServer('web');
        const db = await createServer('db');
        const global = (await api<{ data: Snippet }>('POST', '/api/snippets', { name: 'b-global', command: 'uptime' })).body.data;
        const onWeb = (await api<{ data: Snippet }>('POST', '/api/snippets', { name: 'a-web', command: 'nginx -t', server_id: web })).body.data;
        const onDb = (await api<{ data: Snippet }>('POST', '/api/snippets', { name: 'C-db', command: 'psql -c "select 1"', server_id: db })).body.data;

        const forWeb = await api<{ data: Snippet[] }>('GET', `/api/snippets?serverId=${web}`);
        expect(forWeb.body.data.map((s) => s.id)).toEqual([onWeb.id, global.id]);

        const all = await api<{ data: Snippet[] }>('GET', '/api/snippets');
        expect(all.body.data.map((s) => s.name)).toEqual(['a-web', 'b-global', 'C-db']);

        expect((await api('DELETE', `/api/servers/${db}`)).status).toBe(200);
        const after = await api<{ data: Snippet[] }>('GET', '/api/snippets');
        expect(after.body.data.map((s) => s.id)).toEqual([onWeb.id, global.id]);
        expect((await api('GET', `/api/snippets/${onDb.id}`)).status).toBe(404);

        for (const snippet of after.body.data) await api('DELETE', `/api/snippets/${snippet.id}`);
    });

    it('imports snippets in bulk and skips identical ones', async () => {
        const starters = [
            { name: 'Disk usage', command: 'df -h', tags: ['disk'] },
            { name: 'Memory', command: 'free -m' },
        ];
        const first = await api<{ data: { created: number; skipped: number } }>('POST', '/api/snippets/import', { snippets: starters });
        expect(first.body.data).toEqual({ created: 2, skipped: 0 });

        const again = await api<{ data: { created: number; skipped: number } }>('POST', '/api/snippets/import', {
            snippets: [...starters, { name: 'Memory', command: 'free -h' }],
        });
        expect(again.body.data).toEqual({ created: 1, skipped: 2 });

        const list = await api<{ data: Snippet[] }>('GET', '/api/snippets');
        expect(list.body.data.map((s) => `${s.name}: ${s.command}`)).toEqual(['Disk usage: df -h', 'Memory: free -m', 'Memory: free -h']);
    });

    it('rejects an import with an invalid snippet without saving any of it', async () => {
        const before = (await api<{ data: Snippet[] }>('GET', '/api/snippets')).body.data.length;
        const bad = await api<{ error: string; code: string }>('POST', '/api/snippets/import', {
            snippets: [{ name: 'ok', command: 'true' }, { name: 'scoped', command: 'true', server_id: 424_242 }],
        });
        expect(bad.status).toBe(400);
        expect(bad.body.code).toBe('INVALID_SNIPPET');

        const invalid = await api<{ error: string; details: unknown }>('POST', '/api/snippets/import', { snippets: [{ name: 'ok', command: 'true' }, { name: '' }] });
        expect(invalid.status).toBe(400);
        expect(invalid.body.error).toMatch(/^snippet #2: name is required/);
        expect(invalid.body.details).toEqual({ reason: 'nameRequired' });

        expect((await api('POST', '/api/snippets/import', { snippets: [] })).status).toBe(400);
        expect((await api('POST', '/api/snippets/import', { snippets: Array.from({ length: 201 }, () => ({ name: 'n', command: 'c' })) })).status).toBe(400);
        expect((await api<{ data: Snippet[] }>('GET', '/api/snippets')).body.data.length).toBe(before);
    });
});
