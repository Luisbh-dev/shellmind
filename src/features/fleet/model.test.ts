import { describe, expect, it } from 'vitest';
import type { FleetMetrics, FleetSettings, FleetSnapshot, FleetState } from '@shared/fleet';
import type { ServerSummary } from '@shared/types';
import { t } from '@/i18n';
import {
    attentionRows, blockText, countStates, cpuReading, errorText, filterRows, fleetRows, groupRows, isStale, namesOf, NO_FILTERS, opensRejectedLogin,
    sortRows, stateName, stateReason, uptimeSecondsAt
} from './model';

const NOW = 1_800_000_000_000;

const metrics = (overrides: Partial<FleetMetrics> = {}): FleetMetrics => ({
    platform: 'linux', hostname: 'h', os: 'Debian 12', kernel: null, uptimeSeconds: 3600, bootedAt: NOW - 3_600_000, cores: 4, cpuPercent: null,
    load: { one: 1, five: 1, fifteen: 1 }, loadPerCore: 0.25, memory: { usagePercent: 40, totalMB: 1000, availableMB: 600 }, swapPercent: 0,
    disk: { mount: '/', usagePercent: 50, freeGB: 5, totalGB: 10 }, diskCount: 1, failedUnits: 0, loggedInUsers: null, rebootRequired: false,
    updates: null, ...overrides
});

const snapshot = (serverId: number, state: FleetState, overrides: Partial<FleetSnapshot> = {}): FleetSnapshot => ({
    serverId, state, issues: [], metrics: metrics(), checkedAt: NOW - 60_000, lastSeenAt: NOW - 60_000, error: null, handshakeMs: 40,
    durationMs: 900, failures: 0, hold: null, blocked: null, readAt: null, reachedVia: null, sshSeenAt: null, monitored: true, checking: false, nextCheckAt: null, ...overrides
});

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-2', ip: '10.0.0.1', type: 'linux', group_name: 'Prod', tags: ['web'] },
    { id: 2, name: 'web-10', ip: '10.0.0.2', type: 'linux', group_name: 'Prod', tags: ['web', 'eu'] },
    { id: 3, name: 'db', ip: '10.0.0.3', type: 'linux', group_name: 'Data', tags: [] },
    { id: 4, name: 'dc', ip: '10.0.0.4', type: 'windows' },
    { id: 5, name: 'bucket', ip: '', type: 's3' },
    { id: 6, name: 'shell', ip: 'local', type: 'local' }
];

const SNAPSHOTS: Record<number, FleetSnapshot> = {
    1: snapshot(1, 'ok'),
    2: snapshot(2, 'critical', {
        issues: [{ metric: 'disk', tone: 'critical', value: 95, mount: '/var' }, { metric: 'memory', tone: 'critical', value: 92 }],
        metrics: metrics({ disk: { mount: '/var', usagePercent: 95, freeGB: 1, totalGB: 20 }, rebootRequired: true, updates: { manager: 'apt', count: 3, security: 2, cacheAt: null } })
    }),
    3: snapshot(3, 'warn', { issues: [{ metric: 'failedUnits', tone: 'warn', value: 1 }], metrics: metrics({ failedUnits: 1 }) }),
    4: snapshot(4, 'unreachable', { metrics: null, lastSeenAt: null, error: { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 10.0.0.4:22' }, failures: 2 })
};

const rows = () => fleetRows(SERVERS, SNAPSHOTS, {}, NOW);

describe('fleet rows', () => {
    it('has one row per Linux and Windows server, a new one not checked yet', () => {
        const list = fleetRows([...SERVERS, { id: 7, name: 'new', ip: '10.0.0.7', type: 'linux' }], SNAPSHOTS, {}, NOW);
        expect(list.map((row) => [row.server.id, row.state])).toEqual([[1, 'ok'], [2, 'critical'], [3, 'warn'], [4, 'unreachable'], [7, 'unknown']]);
        expect(stateName(t, list[4])).toBe('Not checked');
        expect(stateName(t, { state: 'unknown', snapshot: snapshot(7, 'unknown') })).toBe('Unknown');
    });

    it('shows a check as running from the click until the backend reports it, two minutes at most', () => {
        const asked = fleetRows(SERVERS, SNAPSHOTS, { 1: { at: NOW - 1000, checkedAt: SNAPSHOTS[1].checkedAt } }, NOW);
        expect(asked.find((row) => row.server.id === 1)?.checking).toBe(true);
        const forgotten = fleetRows(SERVERS, SNAPSHOTS, { 1: { at: NOW - 3 * 60_000, checkedAt: null } }, NOW);
        expect(forgotten.find((row) => row.server.id === 1)?.checking).toBe(false);
    });

    it('sorts the most urgent first, then by name', () => {
        expect(sortRows(rows(), 'attention').map((row) => row.server.name)).toEqual(['web-10', 'dc', 'db', 'web-2']);
        expect(sortRows(rows(), 'name').map((row) => row.server.name)).toEqual(['db', 'dc', 'web-2', 'web-10']);
        expect(sortRows(rows(), 'name', 'desc').map((row) => row.server.name)).toEqual(['web-10', 'web-2', 'dc', 'db']);
    });

    it('sorts by a reading, fullest first, servers without one last', () => {
        // 1 and 3 read the same: the one that needs attention comes first.
        expect(sortRows(rows(), 'disk').map((row) => row.server.id)).toEqual([2, 3, 1, 4]);
        expect(sortRows(rows(), 'disk', 'asc').map((row) => row.server.id)).toEqual([3, 1, 2, 4]);
        // Without a reading: by name, after the others.
        expect(sortRows(rows(), 'updates').map((row) => row.server.id)).toEqual([2, 3, 4, 1]);
    });

    it('filters by state, text and signal', () => {
        expect(filterRows(rows(), { ...NO_FILTERS, state: 'attention' }).map((row) => row.server.id)).toEqual([2, 3, 4]);
        expect(filterRows(rows(), { ...NO_FILTERS, state: 'warn' }).map((row) => row.server.id)).toEqual([3]);
        expect(filterRows(rows(), { ...NO_FILTERS, query: 'eu' }).map((row) => row.server.id)).toEqual([2]);
        expect(filterRows(rows(), { ...NO_FILTERS, reboot: true }).map((row) => row.server.id)).toEqual([2]);
        expect(filterRows(rows(), { ...NO_FILTERS, security: true }).map((row) => row.server.id)).toEqual([2]);
    });

    it('groups by group or tag, the unnamed group last', () => {
        expect(groupRows(rows(), 'group').map((group) => [group.name, group.rows.map((row) => row.server.id)])).toEqual([
            ['Data', [3]], ['Prod', [1, 2]], [null, [4]]
        ]);
        expect(groupRows(rows(), 'tag').map((group) => [group.name, group.rows.map((row) => row.server.id)])).toEqual([
            ['eu', [2]], ['web', [1, 2]], [null, [3, 4]]
        ]);
        expect(groupRows(rows(), 'none')).toHaveLength(1);
    });

    it('counts the states', () => {
        expect(countStates(rows())).toEqual({ ok: 1, warn: 1, critical: 1, unreachable: 1, error: 0, unknown: 0, up: 0, attention: 3, all: 4 });
        expect(attentionRows(rows()).map((row) => row.server.id)).toEqual([2, 4, 3]);
    });
});

describe('fleet readings', () => {
    it('reads CPU on Windows and the load per core on Linux, the load a warning at most', () => {
        expect(cpuReading(metrics({ cpuPercent: 95 }))).toEqual({ kind: 'cpu', value: 95, tone: 'critical' });
        expect(cpuReading(metrics({ loadPerCore: 2.5 }))).toEqual({ kind: 'load', value: 2.5, tone: 'warn' });
        expect(cpuReading(metrics({ loadPerCore: 0.2 }))).toEqual({ kind: 'load', value: 0.2, tone: 'ok' });
        expect(cpuReading(metrics({ loadPerCore: null }))).toBeNull();
        expect(cpuReading(null)).toBeNull();
    });

    it('says why a server is in its state', () => {
        expect(stateReason(t, 'en', SNAPSHOTS[2])).toBe('/var 95% full · Memory 92%');
        expect(stateReason(t, 'en', SNAPSHOTS[4])).toBe('The server refused the connection: nothing listens on that port.');
        expect(stateReason(t, 'en', SNAPSHOTS[1])).toBe('');
        expect(stateReason(t, 'en', null)).toBe('');
    });

    it('words a failed check in the user\'s language, the unknown ones as the backend said', () => {
        expect(errorText(t, { code: 'EXEC_TIMEOUT', message: 'The command did not finish within 30s' })).toBe('The check did not finish in time: the server may be overloaded.');
        expect(errorText(t, { code: 'HOST_KEY_MISMATCH', message: 'x', details: { host: '10.0.0.5', port: 22 } })).toBe('The host key of 10.0.0.5:22 has changed.');
        expect(errorText(t, { code: 'SOMETHING_NEW', message: 'Something new happened' })).toBe('Something new happened');
        expect(errorText(t, { code: 'NOT_SSH', message: 'x' })).toBe('Something answers on the SSH port, but it is not an SSH server.');
    });

    it('names the jump host a failure happened at', () => {
        const names = namesOf(SERVERS);
        const error = { code: 'ECONNREFUSED', message: 'connect ECONNREFUSED', jumpServerId: 2 };
        expect(errorText(t, error, names)).toBe('Jump host web-10: The server refused the connection: nothing listens on that port.');
        expect(errorText(t, { ...error, jumpServerId: 99 }, names)).toMatch(/^Jump host #99: /);
        expect(stateReason(t, 'en', snapshot(1, 'unreachable', { error }), 3, names)).toMatch(/^Jump host web-10: /);
    });

    it('says why a server waits for another one', () => {
        const names = namesOf(SERVERS);
        expect(blockText(t, { kind: 'jump-host', serverId: 2, hold: 'auth' }, names)).toBe('Waiting for jump host web-10: its credentials were rejected. Fix them to check this server.');
        expect(blockText(t, { kind: 'jump-host', serverId: 2, hold: 'host-key' }, names)).toMatch(/host key changed/);
        expect(blockText(t, { kind: 'login', user: 'ops', identity: false, servers: 3 })).toMatch(/^Paused: the login "ops" was just rejected on 3 servers in a row/);
        expect(opensRejectedLogin(snapshot(1, 'error', { hold: 'auth' }))).toBe(true);
        expect(opensRejectedLogin(snapshot(1, 'unknown', { blocked: { kind: 'jump-host', serverId: 2, hold: 'auth' } }))).toBe(true);
        expect(opensRejectedLogin(snapshot(1, 'error', { hold: 'host-key' }))).toBe(false);
        expect(opensRejectedLogin(snapshot(1, 'unknown', { blocked: { kind: 'login', user: 'ops', identity: false, servers: 3 } }))).toBe(false);
    });

    it('calls a reading stale after three intervals (a quarter of an hour at least), six hours while the checks are off', () => {
        const on: FleetSettings = { enabled: true, reachability: false, intervalMinutes: 1, notifications: true, excludedServerIds: [] };
        const off: FleetSettings = { ...on, enabled: false };
        expect(isStale(snapshot(1, 'ok', { checkedAt: NOW - 10 * 60_000 }), on, NOW)).toBe(false);
        expect(isStale(snapshot(1, 'ok', { checkedAt: NOW - 16 * 60_000 }), on, NOW)).toBe(true);
        expect(isStale(snapshot(1, 'ok', { checkedAt: NOW - 16 * 60_000 }), { ...on, intervalMinutes: 15 }, NOW)).toBe(false);
        expect(isStale(snapshot(1, 'ok', { checkedAt: NOW - 5 * 60 * 60_000 }), off, NOW)).toBe(false);
        expect(isStale(snapshot(1, 'ok', { checkedAt: null }), on, NOW)).toBe(true);
        expect(isStale(null, on, NOW)).toBe(true);
    });

    it('ages a health verdict by its reading, and a reachable state by the latest check', () => {
        const reach: FleetSettings = { enabled: false, reachability: true, intervalMinutes: 1, notifications: true, excludedServerIds: [] };
        // Reachability checks every 5 minutes at most often: stale after a quarter of an hour.
        expect(isStale(snapshot(1, 'up', { checkedAt: NOW - 14 * 60_000 }), reach, NOW)).toBe(false);
        expect(isStale(snapshot(1, 'up', { checkedAt: NOW - 16 * 60_000 }), reach, NOW)).toBe(true);
        // A verdict read 7 hours ago is stale, however recent the latest reachability check.
        expect(isStale(snapshot(1, 'critical', { checkedAt: NOW - 60_000, readAt: NOW - 7 * 60 * 60_000 }), reach, NOW)).toBe(true);
        expect(isStale(snapshot(1, 'critical', { checkedAt: NOW - 60_000, readAt: NOW - 60 * 60_000 }), reach, NOW)).toBe(false);
    });
});

describe('uptime', () => {
    it('counts from the boot time, so an old reading shows the current uptime', () => {
        expect(uptimeSecondsAt(metrics({ uptimeSeconds: 3600, bootedAt: NOW - 2 * 86_400_000 }), NOW)).toBe(2 * 86_400);
    });

    it('falls back to the reported uptime without a usable boot time', () => {
        expect(uptimeSecondsAt(metrics({ uptimeSeconds: 7200, bootedAt: 0 }), NOW)).toBe(7200);
        expect(uptimeSecondsAt(metrics({ uptimeSeconds: 7200, bootedAt: NOW + 60_000 }), NOW)).toBe(7200);
        expect(uptimeSecondsAt(null, NOW)).toBeNull();
    });
});
