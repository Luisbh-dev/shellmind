// The fleet board's rows: which servers, in what order, filtered and grouped
// how, and the tone of each reading (pure functions, shared by the board,
// the sidebar and the welcome screen).
import {
    fleetStateRank,
    isFleetServerType,
    needsAttention,
    reachIntervalMinutes,
    type FleetBlock,
    type FleetError,
    type FleetMetrics,
    type FleetSettings,
    type FleetSnapshot,
    type FleetState
} from '@shared/fleet';
import { classify, THRESHOLDS, type HealthIssue, type Tone } from '@shared/thresholds';
import type { ServerSummary } from '@shared/types';
import type { TranslateFn } from '@/i18n';
import { describeConnectionError } from '@/lib/connectionErrors';
import { formatPercent } from '@/lib/format';
import { formatRelativeTime } from '@/lib/relativeTime';
import { formatAgo, formatLoad } from '@/features/status/format';
import { compareNames, matchesQuery } from '@/features/organization/organize';
import { REQUEST_PENDING_MS, type CheckRequest } from './feed';

export type FleetRow = {
    server: ServerSummary;
    snapshot: FleetSnapshot | null;
    state: FleetState;
    // A check is running, queued, or was just asked for.
    checking: boolean;
};

// One row per saved Linux/Windows server, in the saved order.
export function fleetRows(
    servers: ServerSummary[],
    snapshots: Record<number, FleetSnapshot>,
    requested: Record<number, CheckRequest> = {},
    now = Date.now()
): FleetRow[] {
    return servers.filter((server) => isFleetServerType(server.type)).map((server) => {
        const snapshot = snapshots[server.id] ?? null;
        const asked = requested[server.id];
        const pending = asked !== undefined && now - asked.at < REQUEST_PENDING_MS;
        return { server, snapshot, state: snapshot?.state ?? 'unknown', checking: Boolean(snapshot?.checking) || pending };
    });
}

// --- readings -------------------------------------------------------------------

// The CPU column: processor load on Windows, the load average per core on
// Linux (a warning at most, as the health verdict counts it).
export function cpuReading(metrics: FleetMetrics | null): { kind: 'cpu' | 'load'; value: number; tone: Tone } | null {
    if (!metrics) return null;
    if (metrics.cpuPercent !== null) return { kind: 'cpu', value: metrics.cpuPercent, tone: classify(metrics.cpuPercent, THRESHOLDS.cpu) };
    if (metrics.loadPerCore !== null) {
        const tone = classify(metrics.loadPerCore, THRESHOLDS.loadPerCore);
        return { kind: 'load', value: metrics.loadPerCore, tone: tone === 'critical' ? 'warn' : tone };
    }
    return null;
}

export const memoryTone = (metrics: FleetMetrics | null): Tone => (metrics?.memory ? classify(metrics.memory.usagePercent, THRESHOLDS.memory) : 'ok');
export const diskTone = (metrics: FleetMetrics | null): Tone => (metrics?.disk ? classify(metrics.disk.usagePercent, THRESHOLDS.disk) : 'ok');
export const failedTone = (metrics: FleetMetrics | null): Tone => (metrics?.failedUnits != null ? classify(metrics.failedUnits, THRESHOLDS.failedUnits) : 'ok');

// What a health issue says, in the words of the status dashboard.
export function issueText(t: TranslateFn, language: string, issue: HealthIssue): string {
    const value = formatPercent(issue.value, language);
    if (issue.metric === 'failedUnits') {
        return issue.value === 1 ? t('status.health.issues.failedUnitsOne') : t('status.health.issues.failedUnits', { count: issue.value });
    }
    if (issue.metric === 'load') return t('status.health.issues.load', { value: formatLoad(issue.value, language) });
    if (issue.metric === 'disk') {
        return issue.mount ? t('status.health.issues.disk', { mount: issue.mount, value }) : t('status.health.issues.diskTotal', { value });
    }
    return t(`status.health.issues.${issue.metric}`, { value });
}

// The name of a saved server by id (to name a jump host), if known.
export type NameLookup = (serverId: number) => string | null | undefined;

export function namesOf(servers: ServerSummary[]): NameLookup {
    const names = new Map(servers.map((server) => [server.id, server.name]));
    return (serverId) => names.get(serverId);
}

const nameOr = (names: NameLookup | undefined, serverId: number) => names?.(serverId) ?? `#${serverId}`;

// Failures of the check itself (the connection ones are worded like a terminal's).
const CHECK_ERRORS = new Set(['EXEC_TIMEOUT', 'CHECK_TIMEOUT', 'STATUS_UNAVAILABLE', 'SSH_CHANNEL_REFUSED', 'NOT_SSH']);

// Why a check failed, in the user's language when the code is a known one.
export function errorText(t: TranslateFn, error: FleetError, names?: NameLookup): string {
    const text = CHECK_ERRORS.has(error.code)
        ? t(`fleet.errors.${error.code}`)
        : describeConnectionError({ code: error.code, message: error.message, details: error.details }, t);
    return error.jumpServerId === undefined ? text : t('fleet.errors.viaJump', { name: nameOr(names, error.jumpServerId), reason: text });
}

// Why the health checks of a server wait for another one.
export function blockText(t: TranslateFn, block: FleetBlock, names?: NameLookup): string {
    if (block.kind === 'jump-host') {
        return t(`fleet.blocked.${block.hold === 'host-key' ? 'jumpHostKey' : block.hold === 'auth' ? 'jumpAuth' : 'jumpConfig'}`, { name: nameOr(names, block.serverId) });
    }
    return t(block.identity ? 'fleet.blocked.identity' : 'fleet.blocked.login', { user: block.user, count: block.servers });
}

// One line on why a server is in its state (empty when it is fine).
export function stateReason(t: TranslateFn, language: string, snapshot: FleetSnapshot | null, max = 3, names?: NameLookup): string {
    if (!snapshot) return '';
    if (snapshot.error && (snapshot.state === 'unreachable' || snapshot.state === 'error')) return errorText(t, snapshot.error, names);
    return snapshot.issues.slice(0, max).map((issue) => issueText(t, language, issue)).join(' · ');
}

// Opening the server would log in with credentials that were just rejected
// (its own, or those of a jump host of its route): its status and terminal
// connect as soon as it opens.
export function opensRejectedLogin(snapshot: FleetSnapshot | null): boolean {
    return snapshot?.hold === 'auth' || (snapshot?.blocked?.kind === 'jump-host' && snapshot.blocked.hold === 'auth');
}

// The state's name; "Not checked" for a server never checked, "RDP only"
// for one whose SSH port did not answer while its Remote Desktop port did.
export function stateName(t: TranslateFn, row: Pick<FleetRow, 'state' | 'snapshot'>): string {
    if (row.state === 'unknown' && !row.snapshot?.checkedAt) return t('fleet.state.unchecked');
    if (row.state === 'up' && row.snapshot?.reachedVia === 'rdp') return t('fleet.state.upRdp');
    return t(`fleet.state.${row.state}`);
}

// How long ago, short for the recent past ("12 s ago", "3 h ago") and in
// days, weeks... beyond a day.
export function agoText(at: number, now: number, t: TranslateFn, language: string): string {
    return now - at < 24 * 60 * 60_000 ? formatAgo(at, now, t) : formatRelativeTime(at, now, language);
}

const VERDICTS = new Set<FleetState>(['ok', 'warn', 'critical']);

// A state no longer current: older than three intervals (a quarter of an
// hour at least) while the checks that keep it current are on, older than
// six hours while they are off, or never taken. A health verdict is as old
// as the reading it came from; any other state, as the latest check.
export function isStale(snapshot: FleetSnapshot | null, settings: FleetSettings | null, now = Date.now()): boolean {
    if (!snapshot?.checkedAt) return true;
    const verdict = VERDICTS.has(snapshot.state);
    const at = verdict ? snapshot.readAt ?? snapshot.checkedAt : snapshot.checkedAt;
    const minutes = !settings ? null
        : settings.enabled ? settings.intervalMinutes
            : settings.reachability && !verdict ? reachIntervalMinutes(settings) : null;
    const limit = minutes !== null ? Math.max(3 * minutes * 60_000, 15 * 60_000) : 6 * 60 * 60_000;
    return now - at > limit;
}

// --- sorting ----------------------------------------------------------------------

export type SortKey = 'attention' | 'name' | 'cpu' | 'memory' | 'disk' | 'failed' | 'updates' | 'uptime' | 'lastSeen';
export type SortDirection = 'asc' | 'desc';

// The direction a column sorts in when it is first picked: most urgent,
// fullest or highest first; names A-Z.
export const DEFAULT_DIRECTION: Record<SortKey, SortDirection> = {
    attention: 'asc', name: 'asc', cpu: 'desc', memory: 'desc', disk: 'desc', failed: 'desc', updates: 'desc', uptime: 'desc', lastSeen: 'asc'
};

const tally = (issues: HealthIssue[], tone: HealthIssue['tone']) => issues.filter((issue) => issue.tone === tone).length;

function sortValue(row: FleetRow, key: Exclude<SortKey, 'attention' | 'name'>): number | null {
    const metrics = row.snapshot?.metrics ?? null;
    switch (key) {
        case 'cpu': {
            const reading = cpuReading(metrics);
            // Comparable across platforms: load per core as a share of every core busy.
            return reading ? (reading.kind === 'cpu' ? reading.value : reading.value * 100) : null;
        }
        case 'memory':
            return metrics?.memory?.usagePercent ?? null;
        case 'disk':
            return metrics?.disk?.usagePercent ?? null;
        case 'failed':
            return metrics?.failedUnits ?? null;
        case 'updates':
            return metrics?.updates ? metrics.updates.count + (metrics.updates.security ?? 0) * 1000 : null;
        case 'uptime':
            return uptimeSecondsAt(metrics, Date.now());
        case 'lastSeen':
            return row.snapshot?.lastSeenAt ?? null;
    }
}

// Uptime as of `now`: counted from the boot time when the probe reported it,
// so a reading taken hours ago (health checks off) still shows today's value.
export function uptimeSecondsAt(metrics: { uptimeSeconds?: number | null; bootedAt?: number | null } | null | undefined, now: number): number | null {
    if (metrics?.bootedAt && metrics.bootedAt > 0 && metrics.bootedAt <= now) return Math.floor((now - metrics.bootedAt) / 1000);
    return metrics?.uptimeSeconds ?? null;
}

// Most urgent first: the state, then how many critical and warning
// readings, then the name.
function compareAttention(a: FleetRow, b: FleetRow): number {
    const issuesA = a.snapshot?.issues ?? [];
    const issuesB = b.snapshot?.issues ?? [];
    return fleetStateRank(a.state) - fleetStateRank(b.state)
        || tally(issuesB, 'critical') - tally(issuesA, 'critical')
        || tally(issuesB, 'warn') - tally(issuesA, 'warn');
}

export function sortRows(rows: FleetRow[], key: SortKey, direction: SortDirection = DEFAULT_DIRECTION[key]): FleetRow[] {
    const sign = direction === 'asc' ? 1 : -1;
    const byName = (a: FleetRow, b: FleetRow) => compareNames(a.server.name, b.server.name) || a.server.id - b.server.id;
    return [...rows].sort((a, b) => {
        if (key === 'name') return sign * byName(a, b);
        if (key === 'attention') return sign * compareAttention(a, b) || byName(a, b);
        const va = sortValue(a, key);
        const vb = sortValue(b, key);
        // Servers without the reading go last, whichever the direction.
        if (va === null || vb === null) return (va === null ? 1 : 0) - (vb === null ? 1 : 0) || byName(a, b);
        return sign * (va - vb) || compareAttention(a, b) || byName(a, b);
    });
}

// --- filtering and grouping -------------------------------------------------------

export type StateFilter = 'all' | 'attention' | FleetState;

export type FleetFilters = {
    state: StateFilter;
    query: string;
    reboot: boolean;
    security: boolean;
};

export const NO_FILTERS: FleetFilters = { state: 'all', query: '', reboot: false, security: false };

export const hasReboot = (row: FleetRow) => row.snapshot?.metrics?.rebootRequired === true;
export const hasSecurityUpdates = (row: FleetRow) => (row.snapshot?.metrics?.updates?.security ?? 0) > 0;

export function matchesState(row: FleetRow, filter: StateFilter): boolean {
    if (filter === 'all') return true;
    if (filter === 'attention') return needsAttention(row.state);
    return row.state === filter;
}

export function filterRows(rows: FleetRow[], filters: FleetFilters): FleetRow[] {
    return rows.filter((row) => matchesState(row, filters.state)
        && matchesQuery(row.server, filters.query)
        && (!filters.reboot || hasReboot(row))
        && (!filters.security || hasSecurityUpdates(row)));
}

export function isFiltered(filters: FleetFilters): boolean {
    return filters.state !== 'all' || filters.query.trim() !== '' || filters.reboot || filters.security;
}

export type GroupMode = 'none' | 'group' | 'tag';

export type FleetGroup = {
    key: string;
    // null: servers without a group (or a tag), or the only group when not grouping.
    name: string | null;
    rows: FleetRow[];
};

// Groups in name order, the ones without a name last. By tag, a server
// shows under each of its tags.
export function groupRows(rows: FleetRow[], mode: GroupMode): FleetGroup[] {
    if (mode === 'none') return [{ key: 'all', name: null, rows }];
    const groups = new Map<string, FleetGroup>();
    const add = (name: string | null, row: FleetRow) => {
        const key = name === null ? '' : name.toLowerCase();
        const group = groups.get(key) ?? { key: `${mode}:${key}`, name, rows: [] };
        group.rows.push(row);
        groups.set(key, group);
    };
    for (const row of rows) {
        if (mode === 'group') add(row.server.group_name?.trim() || null, row);
        else if (row.server.tags?.length) for (const tag of row.server.tags) add(tag, row);
        else add(null, row);
    }
    return [...groups.values()].sort((a, b) => (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || compareNames(a.name ?? '', b.name ?? ''));
}

export type StateCounts = Record<FleetState, number> & { attention: number; all: number };

export function countStates(rows: FleetRow[]): StateCounts {
    const counts: StateCounts = { ok: 0, warn: 0, critical: 0, unreachable: 0, error: 0, unknown: 0, up: 0, attention: 0, all: rows.length };
    for (const row of rows) {
        counts[row.state] += 1;
        if (needsAttention(row.state)) counts.attention += 1;
    }
    return counts;
}

// The servers that need attention, most urgent first (welcome screen).
export function attentionRows(rows: FleetRow[]): FleetRow[] {
    return sortRows(rows.filter((row) => needsAttention(row.state)), 'attention');
}
