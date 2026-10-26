import { describe, expect, it } from 'vitest';
import { describeAge, fleetSection } from './fleet';

const NOW = Date.UTC(2026, 9, 24, 20, 0, 0);
const blank = {
    serverId: 7,
    state: 'unreachable' as const,
    issues: [],
    metrics: null,
    checkedAt: NOW - 60_000,
    lastSeenAt: null,
    reachedVia: null,
    sshSeenAt: null,
    readAt: null,
    error: { code: 'ETIMEDOUT', message: 'Connecting to 10.0.0.7:22 timed out after 8s' },
    handshakeMs: null,
    durationMs: 8000,
    failures: 3,
    hold: null
};

describe('the fleet reading of a server that cannot be reached', () => {
    it('is left out when the board never read the server nor saw it answer', () => {
        expect(fleetSection(blank, NOW)).toBeNull();
    });

    it('says when the board last saw a server it never read (reachability checks only)', () => {
        const section = fleetSection({ ...blank, lastSeenAt: NOW - 2 * 3_600_000, state: 'up', error: null }, NOW);
        expect(section).toMatchObject({ id: 'fleet', readAt: NOW - 2 * 3_600_000, title: 'Last fleet health reading (2026-10-24T18:00:00Z)' });
        expect(section?.text).toContain('The board never read its metrics');
        expect(section?.text).toContain('Last answered the board: 2026-10-24T18:00:00Z (2 h 0 min before this evidence)');
        expect(section?.text).toContain('Latest board check: 2026-10-24T19:59:00Z, state up');
        expect(section?.text).not.toContain('Remote Desktop');
    });

    it('says when only the Remote Desktop port of a Windows server answered', () => {
        const rdp = { ...blank, lastSeenAt: NOW - 3_600_000, reachedVia: 'rdp' as const, state: 'up' as const, error: null };
        expect(fleetSection(rdp, NOW)?.text).toContain('Last answered the board: 2026-10-24T19:00:00Z (1 h 0 min before this evidence) (Remote Desktop port only; SSH did not answer)\nSSH never answered the board.');
        expect(fleetSection({ ...rdp, sshSeenAt: NOW - 26 * 3_600_000 }, NOW)?.text).toContain('SSH last answered the board: 2026-10-23T18:00:00Z (26 h 0 min before this evidence)');
    });

    it('words ages for the model', () => {
        expect(describeAge(20_000)).toBe('less than a minute');
        expect(describeAge(42 * 60_000)).toBe('42 min');
        expect(describeAge(26 * 3_600_000 + 5 * 60_000)).toBe('26 h 5 min');
        expect(describeAge(5 * 86_400_000)).toBe('5 days');
    });
});
