// The fleet table of the patch center, as pure functions: one row per SSH
// server from its latest scan (or, until it is scanned, the counts the fleet
// board's health check read from the package cache), filters, sorting and
// the summary counts.
import { canInstall, isPatchServerType, type PatchFleetRow, type PatchManager, type PatchPrivilege, type PatchScanError, type PendingUpdate } from '@shared/patch';
import type { ServerSummary } from '@shared/types';

// Package lists older than this are worth refreshing before a run.
export const STALE_LISTS_MS = 7 * 24 * 3600 * 1000;

export type PatchRowView = {
    server: ServerSummary;
    manager: PatchManager | null;
    pending: number | null;
    security: number | null;
    // The counts come from the fleet board's check, not from a scan.
    estimated: boolean;
    rebootRequired: boolean | null;
    privilege: PatchPrivilege | null;
    lastUpdateAt: number | null;
    metadataAt: number | null;
    scannedAt: number | null;
    scanning: boolean;
    jobId: string | null;
    error: PatchScanError | null;
    // Notices of the latest scan (codes).
    notices: string[];
    jumpHostFor: number[];
};

export function patchRows(servers: readonly ServerSummary[], rows: Readonly<Record<number, PatchFleetRow>>, streaming: Readonly<Record<number, true>>): PatchRowView[] {
    return servers.filter((server) => isPatchServerType(server.type)).map((server) => {
        const row = rows[server.id];
        const scan = row?.scan ?? null;
        const fleet = row?.fleet ?? null;
        const estimate = !scan && fleet?.updates ? fleet.updates : null;
        return {
            server,
            manager: scan?.manager ?? estimate?.manager ?? null,
            pending: scan ? scan.total : estimate?.count ?? null,
            security: scan ? scan.security : estimate?.security ?? null,
            estimated: !scan && Boolean(estimate),
            rebootRequired: scan?.rebootRequired ?? fleet?.rebootRequired ?? null,
            privilege: scan?.privilege ?? null,
            lastUpdateAt: scan?.lastUpdateAt ?? null,
            metadataAt: scan?.metadataAt ?? estimate?.cacheAt ?? null,
            scannedAt: scan?.scannedAt ?? null,
            scanning: Boolean(streaming[server.id] || row?.scanning),
            jobId: row?.jobId ?? null,
            error: row?.scanError ?? null,
            notices: scan?.notices.map((notice) => notice.code) ?? [],
            jumpHostFor: row?.jumpHostFor ?? []
        };
    });
}

export type PatchFilter = 'all' | 'security' | 'updates' | 'reboot' | 'attention' | 'unscanned';

export const PATCH_FILTERS: readonly PatchFilter[] = ['all', 'security', 'updates', 'reboot', 'attention', 'unscanned'];

// A row a sysadmin has to look at: its scan failed, it cannot be patched as
// it is (sudo asks for a password, no privilege), or its lists are missing.
export function needsAttention(row: PatchRowView): boolean {
    if (row.error) return true;
    if (row.privilege && row.server.type === 'linux' && !canInstall(row.privilege) && (row.pending ?? 0) > 0) return true;
    return row.notices.includes('metadata-missing') || row.notices.includes('listing-failed');
}

export function matches(row: PatchRowView, filter: PatchFilter): boolean {
    switch (filter) {
        case 'security': return (row.security ?? 0) > 0;
        case 'updates': return (row.pending ?? 0) > 0;
        case 'reboot': return row.rebootRequired === true;
        case 'attention': return needsAttention(row);
        // A server whose scan failed is in "needs attention", not here.
        case 'unscanned': return row.scannedAt === null && !row.error;
        default: return true;
    }
}

export function countRows(rows: readonly PatchRowView[]): Record<PatchFilter, number> {
    return Object.fromEntries(PATCH_FILTERS.map((filter) => [filter, rows.filter((row) => matches(row, filter)).length])) as Record<PatchFilter, number>;
}

export function filterRows(rows: readonly PatchRowView[], filter: PatchFilter, query: string): PatchRowView[] {
    const needle = query.trim().toLowerCase();
    return rows.filter((row) => matches(row, filter) && (!needle || [row.server.name, row.server.ip, row.server.group_name ?? '', ...(row.server.tags ?? []), row.manager ?? '']
        .some((text) => text.toLowerCase().includes(needle))));
}

export type SortKey = 'name' | 'pending' | 'security' | 'reboot' | 'lastUpdate';
export type SortDirection = 'asc' | 'desc';

// Most to patch first by default.
export const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = { name: 'asc', pending: 'desc', security: 'desc', reboot: 'desc', lastUpdate: 'asc' };

export function sortRows(rows: readonly PatchRowView[], key: SortKey, direction: SortDirection): PatchRowView[] {
    const value = (row: PatchRowView): number | string | null => {
        switch (key) {
            case 'name': return row.server.name.toLowerCase();
            case 'pending': return row.pending;
            case 'security': return row.security;
            case 'reboot': return row.rebootRequired === null ? null : row.rebootRequired ? 1 : 0;
            default: return row.lastUpdateAt;
        }
    };
    const sign = direction === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
        const left = value(a);
        const right = value(b);
        // Unknown values go last whatever the direction.
        if (left === null || right === null) return left === right ? a.server.name.localeCompare(b.server.name) : left === null ? 1 : -1;
        if (left === right) return a.server.name.localeCompare(b.server.name);
        return (left < right ? -1 : 1) * sign;
    });
}

export function totals(rows: readonly PatchRowView[]): { pending: number; security: number; reboot: number } {
    return {
        pending: rows.reduce((sum, row) => sum + (row.pending ?? 0), 0),
        security: rows.reduce((sum, row) => sum + (row.security ?? 0), 0),
        reboot: rows.filter((row) => row.rebootRequired === true).length
    };
}

// The updates list of one server: filtered by text and, optionally, to
// security updates; security ones first, then by name.
export function filterUpdates(updates: readonly PendingUpdate[], query: string, securityOnly: boolean): PendingUpdate[] {
    const needle = query.trim().toLowerCase();
    return updates
        .filter((update) => (!securityOnly || update.security) && (!needle || `${update.name} ${update.repository ?? ''} ${update.available}`.toLowerCase().includes(needle)))
        .sort((a, b) => Number(Boolean(b.security)) - Number(Boolean(a.security)) || a.name.localeCompare(b.name));
}
