import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Audit log: client-reported commands (POST) and server-side recordAudit(),
// listed newest first with filters and id-based paging.

let server: TestServer;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('audit API', () => {
    it('records client-reported commands with the server name looked up server-side', async () => {
        const created = await api<{ data: { id: number } }>('POST', '/api/servers', { name: 'web', ip: '10.8.0.1', type: 'linux' });
        const serverId = created.body.data.id;

        const recorded = await api<{ data: AuditEntry }>('POST', '/api/audit', {
            serverId, source: 'ai-run', command: 'systemctl restart nginx', exitCode: 0, meta: { model: 'MiniMax-M2.7' }, server_name: 'spoofed',
        });
        expect(recorded.status).toBe(201);
        expect(recorded.body.data).toEqual({
            id: expect.any(Number),
            ts: expect.any(Number),
            server_id: serverId,
            server_name: 'web',
            source: 'ai-run',
            command: 'systemctl restart nginx',
            exit_code: 0,
            meta: { model: 'MiniMax-M2.7', reportedBy: 'client' },
        });

        const list = await api<{ data: AuditEntry[] }>('GET', `/api/audit?serverId=${serverId}`);
        expect(list.body.data).toEqual([recorded.body.data]);
    });

    it('validates the source and the payload', async () => {
        for (const body of [
            { source: 'shell', command: 'ls' },
            { source: 'terminal', command: '   ' },
            { source: 'terminal', command: 'x'.repeat(10_001) },
            { source: 'terminal', command: 'ls', exitCode: 'ok' },
            { source: 'terminal', command: 'ls', meta: ['a'] },
            { source: 'terminal', command: 'ls', meta: { blob: 'x'.repeat(5000) } },
            { source: 'terminal', command: 'ls', serverId: -1 },
        ]) {
            const res = await api<{ code: string }>('POST', '/api/audit', body);
            expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
            expect(res.body.code).toBe('INVALID_AUDIT');
        }
        expect((await api('GET', '/api/audit?source=shell')).status).toBe(400);
        expect((await api('GET', '/api/audit?limit=0')).status).toBe(400);
        expect((await api('GET', '/api/audit?limit=501')).status).toBe(400);
    });

    it('filters by source and pages newest first', async () => {
        const { recordAudit } = await import('../../server/db/auditRepo');
        for (let i = 0; i < 5; i += 1) {
            await recordAudit({ source: 'multi-exec', command: `uptime #${i}`, exitCode: i });
        }
        await recordAudit({ source: 'ops', command: 'docker restart web' });

        const firstPage = await api<{ data: AuditEntry[] }>('GET', '/api/audit?source=multi-exec&limit=2');
        expect(firstPage.body.data.map((entry) => entry.command)).toEqual(['uptime #4', 'uptime #3']);

        const before = firstPage.body.data[1].id;
        const secondPage = await api<{ data: AuditEntry[] }>('GET', `/api/audit?source=multi-exec&limit=2&before=${before}`);
        expect(secondPage.body.data.map((entry) => entry.command)).toEqual(['uptime #2', 'uptime #1']);

        const ops = await api<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops');
        expect(ops.body.data).toEqual([expect.objectContaining({ source: 'ops', server_id: null, server_name: null, exit_code: null, meta: null })]);
    });

    // SEC-7: a token holder must not be able to post entries that look like
    // the backend's own records (an RDP connection, a key installed).
    it('takes only the sources the interface reports, and marks them as reported', async () => {
        for (const source of ['fleet', 'identity', 'rdp']) {
            const res = await api<{ code: string; error: string }>('POST', '/api/audit', { source, command: `${source} connect admin@dc01` });
            expect(res.status).toBe(400);
            expect(res.body).toMatchObject({ code: 'INVALID_AUDIT', error: 'source must be one of: ai-run, ai-autorun, snippet, multi-exec, ops, terminal' });
        }
        const created: number[] = [];
        for (const source of ['ai-run', 'ai-autorun', 'snippet', 'multi-exec', 'ops', 'terminal']) {
            const res = await api<{ data: AuditEntry }>('POST', '/api/audit', { source, command: 'uptime', meta: { via: 'terminal', reportedBy: 'backend' } });
            expect(res.status).toBe(201);
            expect(res.body.data.meta).toEqual({ via: 'terminal', reportedBy: 'client' });
            created.push(res.body.data.id);
        }
        const bare = await api<{ data: AuditEntry }>('POST', '/api/audit', { source: 'terminal', command: 'ls' });
        expect(bare.body.data.meta).toEqual({ reportedBy: 'client' });
        // The backend's own entries carry no such mark.
        const { recordAudit } = await import('../../server/db/auditRepo');
        const own = await recordAudit({ source: 'ops', command: 'systemctl restart nginx' });
        expect(own.meta).toBeNull();
        // Out of the way of the filters below.
        const ids = [...created, bare.body.data.id, own.id];
        await new Promise<void>((resolve, reject) => server.db.run(`DELETE FROM audit_log WHERE id IN (${ids.map(() => '?').join(',')})`, ids, (err) => (err ? reject(err) : resolve())));
    });

    it('knows the sources of the fleet board, the keychain and embedded RDP', async () => {
        const { recordAudit } = await import('../../server/db/auditRepo');
        for (const source of ['fleet', 'identity', 'rdp'] as const) {
            await recordAudit({ source, command: `${source} entry` });
            const listed = await api<{ data: AuditEntry[] }>('GET', `/api/audit?source=${source}`);
            expect(listed.status).toBe(200);
            expect(listed.body.data.map((entry) => entry.command)).toEqual([`${source} entry`]);
        }
    });

    it('searches the command and server name literally, case-insensitively', async () => {
        const created = await api<{ data: { id: number } }>('POST', '/api/servers', { name: 'Payments-DB', ip: '10.8.0.2', type: 'linux' });
        const { recordAudit } = await import('../../server/db/auditRepo');
        await recordAudit({ source: 'snippet', command: 'df -h /var/lib/postgresql', serverId: created.body.data.id });
        await recordAudit({ source: 'snippet', command: 'echo 100%_done' });
        await recordAudit({ source: 'snippet', command: 'echo 100 percent done' });

        const search = async (q: string) => (await api<{ data: AuditEntry[] }>('GET', `/api/audit?source=snippet&q=${encodeURIComponent(q)}`)).body.data.map((entry) => entry.command);
        expect(await search('POSTGRES')).toEqual(['df -h /var/lib/postgresql']);
        expect(await search('payments')).toEqual(['df -h /var/lib/postgresql']);
        // % and _ are not wildcards.
        expect(await search('100%_')).toEqual(['echo 100%_done']);
        expect(await search('  ')).toHaveLength(3);
        expect((await api('GET', `/api/audit?q=${'x'.repeat(201)}`)).status).toBe(400);
        // Short terms (below the index's three characters) and quotes.
        expect(await search('df')).toEqual(['df -h /var/lib/postgresql']);
        await recordAudit({ source: 'snippet', command: 'grep "error" /var/log/syslog' });
        expect(await search('"error"')).toEqual(['grep "error" /var/log/syslog']);
        expect(await search('h /var')).toEqual(['df -h /var/lib/postgresql']);
    });

    // perf-db-global-queue-audit-growth: a LIKE '%text%' search scanned the
    // whole table while every other database call waited behind it.
    it('looks text up in the search index instead of scanning the table', async () => {
        const { auditListQuery } = await import('../../server/db/auditRepo');
        const plan = async (search: string) => {
            const { sql: statement, params } = await auditListQuery({ search, source: 'snippet' });
            return (await new Promise<Array<{ detail: string }>>((resolve, reject) => server.db.all(`EXPLAIN QUERY PLAN ${statement}`, params, (err, rows) => (err ? reject(err) : resolve(rows as Array<{ detail: string }>)))))
                .map((row) => row.detail).join('\n');
        };
        expect(await plan('postgres')).toMatch(/audit_log_search VIRTUAL TABLE INDEX/);
        // An entry is searchable as soon as it is recorded, and gone once deleted.
        const { recordAudit } = await import('../../server/db/auditRepo');
        const entry = await recordAudit({ source: 'ops', command: 'zpool scrub tank-7f3' });
        const find = async () => (await api<{ data: AuditEntry[] }>('GET', '/api/audit?q=tank-7f3')).body.data.map((row) => row.id);
        expect(await find()).toEqual([entry.id]);
        await new Promise<void>((resolve, reject) => server.db.run('DELETE FROM audit_log WHERE id = ?', [entry.id], (err) => (err ? reject(err) : resolve())));
        expect(await find()).toEqual([]);
    });

    it('filters by a time range', async () => {
        const { auditRepo } = await import('../../server/db/auditRepo');
        for (const ts of [1_000, 2_000, 3_000]) {
            await auditRepo.insert({ ts, server_id: null, server_name: null, source: 'terminal', command: `at ${ts}`, exit_code: null, meta: null });
        }
        const range = async (query: string) => (await api<{ data: AuditEntry[] }>('GET', `/api/audit?source=terminal&${query}`)).body.data.map((entry) => entry.ts);
        expect(await range('from=2000')).toEqual([3_000, 2_000]);
        expect(await range('from=1500&to=2500')).toEqual([2_000]);
        expect(await range('to=2000')).toEqual([2_000, 1_000]);
        expect(await range('from=0&to=999')).toEqual([]);
        expect((await api('GET', '/api/audit?from=yesterday')).status).toBe(400);
        expect((await api('GET', '/api/audit?to=-5')).status).toBe(400);
    });
});
