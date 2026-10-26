import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuditSettings } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

vi.setConfig({ testTimeout: 20_000 });

// perf-db-global-queue-audit-growth: the audit log grew with every AI run,
// snippet, multi-exec and ops action and was never pruned. It now keeps a
// configurable number of days, and the newest entries up to a cap.

const DAY = 24 * 60 * 60 * 1000;

let server: TestServer;
let auditRepo: typeof import('../../server/db/auditRepo')['auditRepo'];
let retention: typeof import('../../server/db/auditRetention');

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => server.db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));
}

async function seed(ages: number[]): Promise<void> {
    const now = Date.now();
    for (const [index, age] of ages.entries()) {
        await auditRepo.insert({ ts: now - age, server_id: null, server_name: null, source: 'ops', command: `entry ${index} (${Math.round(age / DAY)} d)`, exit_code: 0, meta: null });
    }
}

// `count` entries recorded just now, in one statement ("entry 0 (0 d)", ...).
async function seedMany(count: number): Promise<void> {
    await sql(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
         INSERT INTO audit_log (ts, source, command, exit_code) SELECT ?, 'ops', 'entry ' || i || ' (0 d)', 0 FROM n`,
        [count - 1, Date.now()]
    );
}

const commands = async () => (await sql<{ command: string }>('SELECT command FROM audit_log ORDER BY id')).map((row) => row.command);

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    auditRepo = (await import('../../server/db/auditRepo')).auditRepo;
    retention = await import('../../server/db/auditRetention');
});

beforeEach(async () => {
    await sql('DELETE FROM audit_log');
    await sql("DELETE FROM settings WHERE key = 'AUDIT_RETENTION_DAYS'");
    (await import('../../server/db/settingsRepo')).settingsRepo.clearCache();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('audit log retention', () => {
    it('keeps 90 days by default, and at most the newest 100,000 entries', async () => {
        const settings = await api<{ data: AuditSettings }>('GET', '/api/audit/settings');
        expect(settings).toEqual({ status: 200, body: { message: 'success', data: { retentionDays: 90, maxEntries: 100_000 } } });

        await seed([200 * DAY, 91 * DAY, 89 * DAY, 1000]);
        expect(await retention.pruneAuditLog()).toBe(2);
        expect(await commands()).toEqual(['entry 2 (89 d)', 'entry 3 (0 d)']);
    });

    it('saves another period and applies it at once; 0 removes the age limit', async () => {
        await seed([400 * DAY, 100 * DAY, 40 * DAY, 10 * DAY]);

        const saved = await api<{ data: AuditSettings; pruned: number }>('PUT', '/api/audit/settings', { retentionDays: 30 });
        expect(saved).toEqual({ status: 200, body: { message: 'success', data: { retentionDays: 30, maxEntries: 100_000 }, pruned: 3 } });
        expect(await commands()).toEqual(['entry 3 (10 d)']);

        await seed([400 * DAY]);
        const forever = await api<{ pruned: number }>('PUT', '/api/audit/settings', { retentionDays: 0 });
        expect(forever.body.pruned).toBe(0);
        expect(await commands()).toHaveLength(2);
        expect((await api<{ data: AuditSettings }>('GET', '/api/audit/settings')).body.data.retentionDays).toBe(0);

        for (const retentionDays of [7, '30', -1, null]) {
            const refused = await api<{ code: string; details: unknown }>('PUT', '/api/audit/settings', { retentionDays });
            expect(refused).toMatchObject({ status: 400, body: { code: 'INVALID_AUDIT', details: { field: 'retentionDays' } } });
        }
    });

    it('drops the oldest entries beyond the cap whatever their age, a batch at a time', async () => {
        await seedMany(2500);
        expect(await auditRepo.pruneBeyond(10)).toBe(2490);
        const kept = await commands();
        expect(kept).toHaveLength(10);
        expect(kept[0]).toBe('entry 2490 (0 d)');
        // The search index follows the deletions.
        expect(await sql("SELECT rowid FROM audit_log_search WHERE audit_log_search MATCH '\"entry 12 \"'")).toEqual([]);
        expect((await auditRepo.list({ search: 'entry 2499' })).map((entry) => entry.command)).toEqual(['entry 2499 (0 d)']);
    });

    it('prunes when the backend starts and then once a day', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        try {
            await seed([120 * DAY]);
            const stop = retention.startAuditRetention();
            await vi.waitFor(async () => expect(await commands()).toEqual([]), { timeout: 5000 });

            await seed([95 * DAY]);
            vi.advanceTimersByTime(retention.AUDIT_PRUNE_INTERVAL_MS);
            await vi.waitFor(async () => expect(await commands()).toEqual([]), { timeout: 5000 });

            stop();
            await seed([95 * DAY]);
            vi.advanceTimersByTime(retention.AUDIT_PRUNE_INTERVAL_MS);
            await new Promise((resolve) => setTimeout(resolve, 50));
            expect(await commands()).toHaveLength(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
