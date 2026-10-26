import { describe, expect, it } from 'vitest';
import type { PatchFleetRow, PatchScanSummary, PendingUpdate } from '@shared/patch';
import type { ServerSummary } from '@shared/types';
import { countRows, filterRows, filterUpdates, needsAttention, patchRows, sortRows, totals } from './model';

const servers: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux', group_name: 'web', tags: ['prod'] },
    { id: 2, name: 'db-1', ip: '10.0.0.2', type: 'linux' },
    { id: 3, name: 'win-1', ip: '10.0.0.3', type: 'windows' },
    { id: 4, name: 'bucket', ip: '', type: 's3' },
    { id: 5, name: 'edge', ip: '10.0.0.5', type: 'linux' }
];

const scan = (overrides: Partial<PatchScanSummary> = {}): PatchScanSummary => ({
    serverId: 1, platform: 'linux', manager: 'apt', privilege: 'sudo', total: 10, security: 2, held: 0, patches: 0, rebootRequired: false,
    rebootPackages: [], restartServices: [], lastUpdateAt: 1000, metadataAt: 2000, notices: [], scannedAt: 3000, durationMs: 10, ...overrides
});

const row = (serverId: number, overrides: Partial<PatchFleetRow> = {}): PatchFleetRow => ({
    serverId, scan: null, scanError: null, fleet: null, jumpHostFor: [], jobId: null, scanning: false, ...overrides
});

const rows: Record<number, PatchFleetRow> = {
    1: row(1, { scan: scan({ total: 10, security: 2, rebootRequired: true }) }),
    2: row(2, { scan: scan({ serverId: 2, total: 0, security: 0, privilege: 'sudo-password' }) }),
    3: row(3, { scan: scan({ serverId: 3, platform: 'windows', manager: 'windows-update', total: 1, security: 1, privilege: 'admin' }) }),
    // Never scanned: the fleet board's estimate from the package cache.
    5: row(5, { fleet: { state: 'ok', updates: { manager: 'apk', count: 4, security: null, cacheAt: 500 }, rebootRequired: null, readAt: 600 } })
};

describe('patch center rows', () => {
    it('one row per SSH server, from its scan or the fleet board’s estimate', () => {
        const view = patchRows(servers, rows, {});
        expect(view.map((entry) => entry.server.name)).toEqual(['web-1', 'db-1', 'win-1', 'edge']);
        expect(view[0]).toMatchObject({ manager: 'apt', pending: 10, security: 2, rebootRequired: true, estimated: false, scannedAt: 3000 });
        expect(view[3]).toMatchObject({ manager: 'apk', pending: 4, security: null, estimated: true, scannedAt: null, metadataAt: 500 });
        expect(patchRows(servers, rows, { 5: true })[3].scanning).toBe(true);
    });

    it('filters, counts and totals', () => {
        const view = patchRows(servers, rows, {});
        expect(countRows(view)).toEqual({ all: 4, security: 2, updates: 3, reboot: 1, attention: 0, unscanned: 1 });
        expect(filterRows(view, 'security', '').map((entry) => entry.server.id)).toEqual([1, 3]);
        expect(filterRows(view, 'all', 'PROD').map((entry) => entry.server.id)).toEqual([1]);
        expect(filterRows(view, 'all', 'apk').map((entry) => entry.server.id)).toEqual([5]);
        expect(totals(view)).toEqual({ pending: 15, security: 3, reboot: 1 });
    });

    it('needs attention: a failed scan, lists never downloaded, or updates nobody can install', () => {
        const [web, db] = patchRows(servers, { ...rows, 2: row(2, { scan: scan({ serverId: 2, total: 3, privilege: 'sudo-password' }) }) }, {});
        expect(needsAttention(web)).toBe(false);
        expect(needsAttention(db)).toBe(true);
        expect(needsAttention({ ...web, error: { code: 'AUTH_FAILED', message: 'no', at: 1 } })).toBe(true);
        expect(needsAttention({ ...web, notices: ['metadata-missing'] })).toBe(true);
    });

    it('counts a server whose only scan failed under "needs attention", not "not scanned"', () => {
        const view = patchRows(servers, { ...rows, 5: row(5, { scanError: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED', at: 1 } }) }, {});
        const edge = view.find((entry) => entry.server.id === 5)!;
        expect(edge).toMatchObject({ scannedAt: null, error: { code: 'ECONNREFUSED' } });
        expect(countRows(view)).toMatchObject({ attention: 1, unscanned: 0 });
        expect(filterRows(view, 'unscanned', '')).toEqual([]);
    });

    it('sorts with unknown values last whatever the direction', () => {
        const view = patchRows(servers, rows, {});
        expect(sortRows(view, 'security', 'desc').map((entry) => entry.server.id)).toEqual([1, 3, 2, 5]);
        expect(sortRows(view, 'security', 'asc').map((entry) => entry.server.id)).toEqual([2, 3, 1, 5]);
        expect(sortRows(view, 'name', 'asc').map((entry) => entry.server.name)).toEqual(['db-1', 'edge', 'web-1', 'win-1']);
        // Ties go by name.
        expect(sortRows(view, 'lastUpdate', 'asc').map((entry) => entry.server.id)).toEqual([2, 1, 3, 5]);
    });
});

describe('a server’s updates', () => {
    const updates: PendingUpdate[] = [
        { name: 'zlib', arch: 'amd64', current: '1', available: '2', repository: 'main', security: false, severity: null },
        { name: 'openssl', arch: 'amd64', current: '1', available: '2', repository: 'security', security: true, severity: 'Important' },
        { name: 'bash', arch: 'amd64', current: '1', available: '2', repository: 'main', security: false, severity: null }
    ];

    it('security updates first, then by name; filtered by text or to security only', () => {
        expect(filterUpdates(updates, '', false).map((update) => update.name)).toEqual(['openssl', 'bash', 'zlib']);
        expect(filterUpdates(updates, '', true).map((update) => update.name)).toEqual(['openssl']);
        expect(filterUpdates(updates, 'MAIN', false).map((update) => update.name)).toEqual(['bash', 'zlib']);
    });
});
