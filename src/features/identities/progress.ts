// The state of an install / rotate stream as the dialogs show it: one row per
// server, updated by each InstallEvent. Pure, so it is tested directly.
import type { InstallEvent, InstallResult, RemoveResult } from '@shared/identities';

export type InstallPhase = 'waiting' | 'installing' | 'verifying' | 'done';

// removal: rotate only, the previous key taken out of the server's authorized_keys.
export type InstallRow = { serverId: number; name: string; phase: InstallPhase; result?: InstallResult; removal?: RemoveResult };

export type InstallRun = {
    rows: InstallRow[];
    // Of the key being installed (the new key while rotating).
    fingerprint: string | null;
    // Rotate only, once known.
    rotated: { replaced: boolean; fingerprint: string | null } | null;
    done: boolean;
    cancelled: boolean;
    error: string | null;
};

export function startRun(servers: Array<{ serverId: number; name: string }>): InstallRun {
    return { rows: servers.map((server) => ({ ...server, phase: 'waiting' })), fingerprint: null, rotated: null, done: false, cancelled: false, error: null };
}

const updateRow = (run: InstallRun, serverId: number, patch: Partial<InstallRow>): InstallRun => ({
    ...run,
    rows: run.rows.map((row) => (row.serverId === serverId ? { ...row, ...patch } : row))
});

export function applyInstallEvent(run: InstallRun, event: InstallEvent): InstallRun {
    switch (event.type) {
        case 'start': {
            const known = new Map(run.rows.map((row) => [row.serverId, row]));
            return {
                ...run,
                fingerprint: event.fingerprint,
                rows: event.servers.map((server) => known.get(server.serverId) ?? { ...server, phase: 'waiting' })
            };
        }
        case 'progress':
            return updateRow(run, event.serverId, { phase: event.phase });
        case 'result':
            return updateRow(run, event.result.serverId, { phase: 'done', result: event.result });
        case 'rotated':
            return { ...run, rotated: { replaced: event.replaced, fingerprint: event.fingerprint } };
        case 'removed':
            return updateRow(run, event.result.serverId, { removal: event.result });
        case 'done':
            return { ...run, done: true, cancelled: event.cancelled };
        case 'error':
            return { ...run, done: true, error: event.message };
        default:
            return run;
    }
}

// How a finished server went: the key signs in (installed now or already
// there), it was written but did not sign in, or the install failed.
export type RowOutcome = 'installed' | 'present' | 'unverified' | 'failed' | 'cancelled';

export function rowOutcome(result: InstallResult): RowOutcome {
    if (result.status === 'failed') return result.errorCode === 'CANCELLED' ? 'cancelled' : 'failed';
    if (result.verified === false) return 'unverified';
    return result.status;
}

export function summarize(run: InstallRun): Record<RowOutcome, number> & { pending: number } {
    const counts = { installed: 0, present: 0, unverified: 0, failed: 0, cancelled: 0, pending: 0 };
    for (const row of run.rows) {
        if (!row.result) counts.pending += 1;
        else counts[rowOutcome(row.result)] += 1;
    }
    return counts;
}

// Servers whose key signs in after the run (candidates for using the identity).
export function verifiedServers(run: InstallRun): number[] {
    return run.rows.filter((row) => row.result && (rowOutcome(row.result) === 'installed' || rowOutcome(row.result) === 'present')).map((row) => row.serverId);
}
