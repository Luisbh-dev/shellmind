// Multi-exec: one command on several SSH servers, run as a background job.
// POST /api/multiexec starts a job and answers with its id; the job runs on
// the backend whatever the client does, and GET /api/multiexec/jobs/:id/events
// streams it (a snapshot, then live events) as Server-Sent Events of
// MultiExecJobEvent. Jobs roll out in batches (an optional canary first,
// then batches of N servers or N %), stop at a failure limit, can be paused,
// resumed and cancelled, and stay in the job history with their output.

import type { DangerReason } from "./commandSafety";
import type { ServerType } from "./types";

export const MULTIEXEC_LIMITS = {
    maxTargets: 200,
    maxConcurrency: 20,
    defaultConcurrency: 5,
    maxTimeoutSec: 3600,
    defaultTimeoutSec: 60,
    maxCommandLength: 10_000,
    // stdout + stderr kept per server while a job runs; the rest is dropped (result.truncated).
    maxOutputBytes: 256 * 1024,
    // What the job history keeps of it per server (MultiExecServerRun.outputTrimmed).
    storedOutputBytes: 64 * 1024,
    maxPauseSec: 3600,
    maxVariables: 50,
    maxVariableLength: 4096
} as const;

export const MULTIEXEC_JOB_LIMITS = {
    // Jobs that are running or paused at the same time.
    maxActiveJobs: 4,
    // A job paused (by the user, or waiting for approval after its canary)
    // is stopped when nobody resumes it within this time.
    pauseTimeoutMs: 30 * 60_000,
    // No job outlives this, whatever its timeouts and pauses add up to.
    maxLifetimeMs: 24 * 60 * 60_000,
    // Finished jobs kept in the history; older ones are deleted (and jobs
    // older than the audit log's retention period).
    maxHistory: 200
} as const;

// Server types multi-exec can run on (reached over SSH).
export const MULTIEXEC_SERVER_TYPES: readonly ServerType[] = ["linux", "windows"];

// skipped: never started because the job stopped first (failure limit,
// pause timeout); cancelled: the user cancelled it (running or not yet).
export type MultiExecStatus = "queued" | "running" | "ok" | "failed" | "timeout" | "cancelled" | "skipped";

export const MULTIEXEC_STATUSES: readonly MultiExecStatus[] = ["queued", "running", "ok", "failed", "timeout", "cancelled", "skipped"];

export const MULTIEXEC_FINAL_STATUSES: readonly MultiExecStatus[] = ["ok", "failed", "timeout", "cancelled", "skipped"];

// What counts towards a job's failure limit.
export const isFailureStatus = (status: MultiExecStatus): boolean => status === "failed" || status === "timeout";

// How a job rolls out. Servers run in batches, one batch after the other;
// within a batch up to `concurrency` at a time.
export type MultiExecStrategy = {
    concurrency: number;
    // Servers per batch after the canary; null: all of them in one batch.
    batch: { size: number; unit: "servers" | "percent" } | null;
    // Wait between two batches, in seconds: also between a canary that goes
    // on by itself and the next batch (one approved by the user goes on at
    // once).
    pauseSec: number;
    // The first `count` servers run on their own first. Then the job waits
    // for approval ("pause") or goes on by itself if they all succeeded
    // ("continue"); a failed canary always waits for a decision.
    canary: { count: number; onSuccess: "pause" | "continue" } | null;
    // The job stops starting servers once this many failed (or this share
    // of all its servers). null on both: no limit.
    failureLimit: { count: number | null; percent: number | null } | null;
};

export const DEFAULT_STRATEGY: MultiExecStrategy = {
    concurrency: MULTIEXEC_LIMITS.defaultConcurrency,
    batch: null,
    pauseSec: 0,
    canary: null,
    failureLimit: null
};

export type MultiExecRequest = {
    // The command, or a template whose {{placeholders}} the backend fills in
    // from `variables` (shared/placeholders.ts) when they are given.
    command: string;
    variables?: Record<string, string> | null;
    // Variables to treat as secrets besides the declared and secret-looking
    // ones: their values run, but are never recorded.
    secretVariables?: string[];
    // Secret-looking variables the user said are not secrets (a declared
    // `{{name:secret}}` stays one).
    publicVariables?: string[];
    serverIds: number[];
    timeoutSec?: number;
    // Shorthand for strategy.concurrency.
    concurrency?: number;
    strategy?: Partial<MultiExecStrategy> | null;
    // The snippet the command comes from (recorded with the job).
    snippet?: { id?: number | null; name: string } | null;
    // The command was flagged as destructive (shared/commandSafety.ts) and
    // the user confirmed it; without this such a job is refused.
    confirmDangerous?: boolean;
    // The job this one runs again (on the servers where it failed).
    rerunOf?: string | null;
};

export type MultiExecTarget = {
    serverId: number;
    name: string;
    host: string;
    type: ServerType;
};

// The kind of failure behind `error`, so the UI can explain it in the user's
// language (`error` keeps the technical text). null: no known kind.
export type MultiExecErrorCode =
    // The command ran longer than the timeout and was stopped.
    | "TIMEOUT"
    // No connection within the timeout: the command never ran.
    | "CONNECT_TIMEOUT"
    // The SSH handshake did not finish within the connection pool's limit.
    | "HANDSHAKE_TIMEOUT"
    // Ended by a signal (see `signal`).
    | "SIGNAL"
    | "NO_EXIT_STATUS"
    | "AUTH_FAILED"
    | "HOST_KEY_MISMATCH"
    | "CONNECTION_REFUSED"
    | "HOST_NOT_FOUND"
    | "HOST_UNREACHABLE"
    // ShellMind stopped while the command ran.
    | "INTERRUPTED";

export type MultiExecResult = {
    serverId: number;
    status: MultiExecStatus;
    exitCode: number | null;
    // Signal that ended the command, if any.
    signal: string | null;
    // Why it failed when there is no exit code (connection, auth, timeout...).
    error: string | null;
    errorCode: MultiExecErrorCode | null;
    startedAt: number | null;
    finishedAt: number | null;
    durationMs: number | null;
    // Output beyond MULTIEXEC_LIMITS.maxOutputBytes was dropped.
    truncated: boolean;
    // Hashes of the whole output (stdout and stderr), to group servers that
    // printed the same: exactly, and once host names, times and PIDs are
    // masked (shared/multiexecOutput.ts). null until it ran.
    outputHash: string | null;
    normalizedHash: string | null;
};

// One server of a job: who, which batch, how it went and what it printed.
export type MultiExecServerRun = MultiExecTarget & Omit<MultiExecResult, "serverId"> & {
    batch: number;
    stdout: string;
    stderr: string;
    // The job history keeps only the first MULTIEXEC_LIMITS.storedOutputBytes
    // of the output; this one had more.
    outputTrimmed: boolean;
};

// running: servers are being started; paused: none are started until it is
// resumed (those running finish). The others are final: done (every server
// had its turn), stopped (failure limit, pause timeout or lifetime),
// cancelled (by the user), interrupted (ShellMind quit while it ran).
export type MultiExecJobStatus = "running" | "paused" | "done" | "stopped" | "cancelled" | "interrupted";

export const MULTIEXEC_JOB_FINAL_STATUSES: readonly MultiExecJobStatus[] = ["done", "stopped", "cancelled", "interrupted"];

export const isJobFinal = (status: MultiExecJobStatus): boolean => MULTIEXEC_JOB_FINAL_STATUSES.includes(status);

// user: paused from the UI; canary: the canary succeeded and the job waits
// for approval; canary-failed: the canary had failures and the job waits for
// a decision.
export type MultiExecPauseReason = "user" | "canary" | "canary-failed";

export type MultiExecStopReason = "failure-limit" | "pause-timeout" | "lifetime";

export type MultiExecCounts = Record<MultiExecStatus, number>;

export const emptyCounts = (): MultiExecCounts => ({ queued: 0, running: 0, ok: 0, failed: 0, timeout: 0, cancelled: 0, skipped: 0 });

// A job without its servers (list rows, job-level events).
export type MultiExecJobInfo = {
    id: string;
    // The command as recorded: secret variables keep their {{placeholder}}
    // and secret-looking text is masked. `masked`: it differs from what ran,
    // so it cannot simply be run again.
    command: string;
    masked: boolean;
    // When the command was filled in from a template: the template, the
    // values of its non-secret variables and the names of the secret ones
    // (whose values were not kept). Secret-looking text typed into the
    // template is masked like in `command`; `templateMasked`: some was, so
    // the template cannot simply be run again either.
    template: string | null;
    templateMasked: boolean;
    variables: Record<string, string> | null;
    secretVariables: string[];
    snippet: { id: number | null; name: string } | null;
    timeoutSec: number;
    strategy: MultiExecStrategy;
    status: MultiExecJobStatus;
    pause: { reason: MultiExecPauseReason; since: number; expiresAt: number } | null;
    stopReason: MultiExecStopReason | null;
    // The batch running now (or the last one); null before the first.
    batch: number | null;
    batches: number;
    // Waiting between two batches (strategy.pauseSec): when the next starts.
    nextBatchAt: number | null;
    danger: DangerReason | null;
    rerunOf: string | null;
    createdAt: number;
    finishedAt: number | null;
    total: number;
    counts: MultiExecCounts;
};

export type MultiExecJob = MultiExecJobInfo & { servers: MultiExecServerRun[] };

export type MultiExecJobEvent =
    // First event of every stream: the job as it is now.
    | { type: "snapshot"; job: MultiExecJob }
    // The job-level state changed (status, pause, batch, counts).
    | { type: "job"; job: MultiExecJobInfo }
    | { type: "running"; serverId: number; startedAt: number }
    | { type: "output"; serverId: number; stream: "stdout" | "stderr"; data: string }
    | { type: "result"; result: MultiExecResult }
    // The job is over (a final "job" event came before): the stream ends.
    | { type: "end" }
    // Keeps idle connections (proxies) from timing the stream out.
    | { type: "ping" };

// POST /api/multiexec answer (data).
export type MultiExecStartResponse = { job: MultiExecJobInfo };

// The size of each batch for `total` servers: the canary first, then batches
// of the configured size (a percentage of all the servers, at least one).
export function planBatches(total: number, strategy: Pick<MultiExecStrategy, "batch" | "canary">): number[] {
    if (total <= 0) return [];
    const sizes: number[] = [];
    let left = total;
    if (strategy.canary && strategy.canary.count < total) {
        sizes.push(strategy.canary.count);
        left -= strategy.canary.count;
    }
    const size = !strategy.batch
        ? left
        : strategy.batch.unit === "percent"
            ? Math.max(1, Math.ceil((total * strategy.batch.size) / 100))
            : strategy.batch.size;
    while (left > 0) {
        const next = Math.min(size, left);
        sizes.push(next);
        left -= next;
    }
    return sizes;
}

// Index of the batch of every position (0-based) of the server list.
export function batchOfPositions(sizes: readonly number[]): number[] {
    return sizes.flatMap((size, batch) => Array.from({ length: size }, () => batch));
}

// Whether `failures` out of `total` servers reach the job's failure limit.
export function reachesFailureLimit(limit: MultiExecStrategy["failureLimit"], failures: number, total: number): boolean {
    if (!limit || failures === 0) return false;
    if (limit.count !== null && failures >= limit.count) return true;
    return limit.percent !== null && total > 0 && (failures * 100) / total >= limit.percent;
}

export function countStatuses(statuses: Iterable<MultiExecStatus>): MultiExecCounts {
    const counts = emptyCounts();
    for (const status of statuses) counts[status] += 1;
    return counts;
}
