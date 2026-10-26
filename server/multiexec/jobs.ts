import { randomUUID } from "crypto";
import {
    MULTIEXEC_JOB_LIMITS,
    MULTIEXEC_LIMITS,
    batchOfPositions,
    countStatuses,
    isFailureStatus,
    isJobFinal,
    planBatches,
    reachesFailureLimit,
    type MultiExecJob,
    type MultiExecJobEvent,
    type MultiExecJobInfo,
    type MultiExecPauseReason,
    type MultiExecResult,
    type MultiExecServerRun,
    type MultiExecStopReason,
    type MultiExecTarget
} from "../../shared/multiexec";
import { getAuditSettings } from "../db/auditRetention";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { jobsRepo } from "./jobsRepo";
import type { JobRequest } from "./request";
import { clampUtf8, runMultiExec, type MultiExecDeps, type MultiExecServerEvent } from "./runner";

// Multi-exec jobs run on the backend, independent of any request: a client
// starts one, follows it (and comes back to it) through its event stream,
// and can pause, resume or cancel it. A job runs its servers batch after
// batch (planBatches), stops starting servers once its failure limit is
// reached, waits for approval after a canary, and keeps every state change
// and result in the job history (jobsRepo) as it happens.

const log = createLogger("multiexec");

const DAY_MS = 24 * 60 * 60 * 1000;

export type JobListener = (event: MultiExecJobEvent) => void;

export type JobLimits = {
    maxActiveJobs: number;
    pauseTimeoutMs: number;
    maxLifetimeMs: number;
    maxHistory: number;
    storedOutputBytes: number;
};

const DEFAULT_LIMITS: JobLimits = { ...MULTIEXEC_JOB_LIMITS, storedOutputBytes: MULTIEXEC_LIMITS.storedOutputBytes };

export type JobManagerOptions = {
    deps?: MultiExecDeps;
    limits?: Partial<JobLimits>;
};

function notFound(): AppError {
    return new AppError("MULTIEXEC_JOB_NOT_FOUND", "This job does not exist (it may have been deleted).", 404);
}

function finished(): AppError {
    return new AppError("MULTIEXEC_JOB_FINISHED", "This job has already finished.", 409);
}

const toTarget = ({ serverId, name, host, type }: MultiExecServerRun): MultiExecTarget => ({ serverId, name, host, type });

class Job {
    readonly info: MultiExecJobInfo;
    readonly servers: MultiExecServerRun[];
    private readonly position = new Map<number, number>();
    private readonly listeners = new Set<JobListener>();
    private readonly controller = new AbortController();
    private readonly waiters = new Set<() => void>();
    private pauseTimer: NodeJS.Timeout | null = null;
    private lifetimeTimer: NodeJS.Timeout | null = null;
    private persisting: Promise<void> = Promise.resolve();
    private storedBytes = new Map<number, number>();
    // ShellMind is quitting (see interrupt).
    private interrupted = false;

    constructor(
        id: string,
        private readonly request: JobRequest,
        private readonly limits: JobLimits,
        private readonly deps: MultiExecDeps | undefined
    ) {
        const sizes = planBatches(request.targets.length, request.strategy);
        const batches = batchOfPositions(sizes);
        this.servers = request.targets.map((target, index) => ({
            ...target,
            batch: batches[index],
            status: "queued",
            exitCode: null,
            signal: null,
            error: null,
            errorCode: null,
            startedAt: null,
            finishedAt: null,
            durationMs: null,
            truncated: false,
            outputHash: null,
            normalizedHash: null,
            stdout: "",
            stderr: "",
            outputTrimmed: false
        }));
        request.targets.forEach((target, index) => this.position.set(target.serverId, index));
        this.info = {
            id,
            command: request.recorded,
            masked: request.masked,
            template: request.template,
            templateMasked: request.templateMasked,
            variables: request.variables,
            secretVariables: request.secretVariables,
            snippet: request.snippet,
            timeoutSec: request.timeoutSec,
            strategy: request.strategy,
            status: "running",
            pause: null,
            stopReason: null,
            batch: null,
            batches: sizes.length,
            nextBatchAt: null,
            danger: request.danger,
            rerunOf: request.rerunOf,
            createdAt: Date.now(),
            finishedAt: null,
            total: this.servers.length,
            counts: countStatuses(this.servers.map((server) => server.status))
        };
    }

    get id(): string {
        return this.info.id;
    }

    current(): MultiExecJobInfo {
        return { ...this.info, counts: countStatuses(this.servers.map((server) => server.status)) };
    }

    snapshot(): MultiExecJob {
        return { ...this.current(), servers: this.servers.map((server) => ({ ...server })) };
    }

    subscribe(listener: JobListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(event: MultiExecJobEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (err) {
                log.warn(`Could not deliver an event of job ${this.id}`, err);
            }
        }
    }

    // Writes run one after the other, so the history ends in the last state.
    private persist(task: () => Promise<void>): void {
        this.persisting = this.persisting.then(task).catch((err: unknown) => {
            log.warn(`Could not save job ${this.id} in the history: ${errorMessage(err)}`);
        });
    }

    private changed(): void {
        const job = this.current();
        this.emit({ type: "job", job });
        this.persist(() => jobsRepo.updateState(job));
    }

    private notify(): void {
        for (const wake of [...this.waiters]) wake();
    }

    // Resolves once `done()` holds (checked on every state change) or after `timeoutMs`.
    private waitUntil(done: () => boolean, timeoutMs?: number): Promise<void> {
        if (done()) return Promise.resolve();
        return new Promise((resolve) => {
            let timer: NodeJS.Timeout | undefined;
            const finish = () => {
                this.waiters.delete(check);
                if (timer) clearTimeout(timer);
                resolve();
            };
            const check = () => {
                if (done()) finish();
            };
            this.waiters.add(check);
            if (timeoutMs !== undefined) {
                timer = setTimeout(finish, timeoutMs);
                timer.unref?.();
            }
        });
    }

    // Cancelled, or stopped: no more servers start.
    private ended(): boolean {
        return this.controller.signal.aborted || this.info.stopReason !== null;
    }

    private failures(): number {
        return this.servers.filter((server) => isFailureStatus(server.status)).length;
    }

    pause(reason: MultiExecPauseReason): MultiExecJobInfo {
        if (isJobFinal(this.info.status) || this.ended()) throw finished();
        if (this.info.status !== "paused") this.hold(reason);
        return this.current();
    }

    // Holds the job for `reason`, with a fresh pause timeout.
    private hold(reason: MultiExecPauseReason): void {
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        const since = Date.now();
        this.info.status = "paused";
        this.info.pause = { reason, since, expiresAt: since + this.limits.pauseTimeoutMs };
        this.pauseTimer = setTimeout(() => this.stop("pause-timeout"), this.limits.pauseTimeoutMs);
        this.pauseTimer.unref?.();
        log.debug(`Job ${this.id} paused (${reason})`);
        this.changed();
    }

    // The decision the canary asks for. It takes the place of a pause of the
    // user's that is already on: resuming must read as approving the rollout,
    // or continuing despite a failed canary, never as ending a plain pause.
    private gate(reason: "canary" | "canary-failed"): void {
        if (this.info.pause?.reason !== reason) this.hold(reason);
    }

    resume(): MultiExecJobInfo {
        if (isJobFinal(this.info.status) || this.ended()) throw finished();
        if (this.info.status !== "paused") return this.current();
        this.clearPause();
        log.debug(`Job ${this.id} resumed`);
        this.changed();
        this.notify();
        return this.current();
    }

    cancel(): MultiExecJobInfo {
        if (isJobFinal(this.info.status)) throw finished();
        if (!this.controller.signal.aborted) {
            log.debug(`Job ${this.id} cancelled`);
            this.clearPause();
            this.controller.abort();
            this.changed();
            this.notify();
        }
        return this.current();
    }

    // ShellMind is quitting: the commands running are stopped and the job
    // ends as interrupted, as a job found running at the next start would.
    interrupt(): void {
        if (isJobFinal(this.info.status) || this.interrupted) return;
        log.debug(`Job ${this.id} interrupted`);
        this.interrupted = true;
        this.clearPause();
        this.controller.abort();
        this.notify();
    }

    private clearPause(): void {
        if (this.pauseTimer) clearTimeout(this.pauseTimer);
        this.pauseTimer = null;
        if (this.info.status === "paused") this.info.status = "running";
        this.info.pause = null;
    }

    // No more servers start; those running finish (cancelled too after the lifetime).
    private stop(reason: MultiExecStopReason): void {
        if (this.ended()) return;
        log.debug(`Job ${this.id} stopping (${reason})`);
        this.info.stopReason = reason;
        this.clearPause();
        if (reason === "lifetime") this.controller.abort();
        this.changed();
        this.notify();
    }

    // Keeps what the job history stores of a server's output.
    private store(server: MultiExecServerRun, stream: "stdout" | "stderr", data: string): void {
        if (server.outputTrimmed) return;
        const used = this.storedBytes.get(server.serverId) ?? 0;
        const size = Buffer.byteLength(data, "utf8");
        let kept = data;
        if (used + size > this.limits.storedOutputBytes) {
            kept = clampUtf8(data, this.limits.storedOutputBytes - used);
            server.outputTrimmed = true;
        }
        this.storedBytes.set(server.serverId, used + Buffer.byteLength(kept, "utf8"));
        server[stream] += kept;
    }

    private onServerEvent(received: MultiExecServerEvent): void {
        const event: MultiExecServerEvent = received.type === "result" && this.interrupted ? { ...received, result: interruptedResult(received.result) } : received;
        const serverId = event.type === "result" ? event.result.serverId : event.serverId;
        const index = this.position.get(serverId);
        if (index === undefined) return;
        const server = this.servers[index];
        if (event.type === "running") {
            server.status = "running";
            server.startedAt = event.startedAt;
            // In the history before the command is sent (see beforeDispatch in
            // run): a backend that dies while it runs leaves "running", which
            // the next start turns into interrupted, not into "not run".
            const snapshot = { ...server };
            this.persist(() => jobsRepo.updateServer(this.id, index, snapshot));
        } else if (event.type === "output") {
            this.store(server, event.stream, event.data);
        } else {
            Object.assign(server, resultFields(event.result));
            const snapshot = { ...server };
            this.persist(() => jobsRepo.updateServer(this.id, index, snapshot));
        }
        this.emit(event);
        if (event.type === "result" && isFailureStatus(server.status)
            && reachesFailureLimit(this.request.strategy.failureLimit, this.failures(), this.servers.length)) {
            this.stop("failure-limit");
        }
    }

    // Runs the job to its end; never rejects.
    async run(): Promise<void> {
        const { strategy } = this.request;
        this.lifetimeTimer = setTimeout(() => this.stop("lifetime"), this.limits.maxLifetimeMs);
        this.lifetimeTimer.unref?.();
        const beforeStart = async () => {
            await this.waitUntil(() => this.info.status !== "paused" || this.ended());
            return !this.ended();
        };
        try {
            for (let batch = 0; batch < this.info.batches; batch++) {
                await this.waitUntil(() => this.info.status !== "paused" || this.ended());
                if (this.ended()) break;
                this.info.batch = batch;
                this.info.nextBatchAt = null;
                this.changed();
                await runMultiExec({
                    command: this.request.command,
                    auditCommand: this.request.auditCommand ?? this.request.recorded,
                    targets: this.servers.filter((server) => server.batch === batch).map(toTarget),
                    timeoutMs: this.request.timeoutSec * 1000,
                    concurrency: strategy.concurrency,
                    signal: this.controller.signal,
                    emit: (event) => this.onServerEvent(event),
                    secrets: this.request.secrets,
                    beforeStart,
                    // The writes queued so far, the server's "running" among them.
                    beforeDispatch: () => this.persisting,
                    step: this.request.step,
                    auditSource: this.request.auditSource,
                    auditMeta: {
                        ...this.request.auditMeta,
                        jobId: this.id,
                        servers: this.servers.length,
                        ...(this.info.batches > 1 ? { batch: batch + 1, batches: this.info.batches } : {}),
                        ...(this.request.snippet ? { snippetId: this.request.snippet.id, snippetName: this.request.snippet.name } : {}),
                        ...(this.request.rerunOf ? { rerunOf: this.request.rerunOf } : {})
                    }
                }, this.deps);
                if (this.ended() || batch === this.info.batches - 1) continue;
                if (batch === 0 && strategy.canary) {
                    const canaryFailed = this.servers.some((server) => server.batch === 0 && server.status !== "ok");
                    if (canaryFailed) this.gate("canary-failed");
                    else if (strategy.canary.onSuccess === "pause") this.gate("canary");
                    // A canary that goes on by itself is watched for the
                    // pause too, as between two batches.
                    else await this.soak(strategy.pauseSec);
                } else {
                    await this.soak(strategy.pauseSec);
                }
            }
        } catch (err) {
            log.error(`Job ${this.id} failed`, err);
            this.controller.abort();
        } finally {
            await this.finalize();
        }
    }

    // The wait before the next batch (strategy.pauseSec), ended early by a
    // cancel or a stop.
    private async soak(seconds: number): Promise<void> {
        if (seconds <= 0) return;
        this.info.nextBatchAt = Date.now() + seconds * 1000;
        this.changed();
        await this.waitUntil(() => this.ended(), seconds * 1000);
    }

    private async finalize(): Promise<void> {
        if (this.lifetimeTimer) clearTimeout(this.lifetimeTimer);
        this.clearPause();
        const cancelled = this.controller.signal.aborted && this.info.stopReason === null && !this.interrupted;
        for (const [index, server] of this.servers.entries()) {
            if (server.status !== "queued" && server.status !== "running") continue;
            server.status = cancelled ? "cancelled" : "skipped";
            const snapshot = { ...server };
            this.persist(() => jobsRepo.updateServer(this.id, index, snapshot));
            this.emit({ type: "result", result: { serverId: server.serverId, ...resultFields(server) } });
        }
        this.info.status = this.interrupted ? "interrupted" : this.info.stopReason ? "stopped" : cancelled ? "cancelled" : "done";
        this.info.nextBatchAt = null;
        this.info.finishedAt = Date.now();
        log.debug(`Job ${this.id} ${this.info.status}`);
        this.changed();
        await this.persisting;
        this.emit({ type: "end" });
        this.listeners.clear();
    }
}

function resultFields(source: Omit<MultiExecResult, "serverId">): Omit<MultiExecResult, "serverId"> {
    const { status, exitCode, signal, error, errorCode, startedAt, finishedAt, durationMs, truncated, outputHash, normalizedHash } = source;
    return { status, exitCode, signal, error, errorCode, startedAt, finishedAt, durationMs, truncated, outputHash, normalizedHash };
}

// A server stopped because ShellMind quit: cancelled while it ran
// (INTERRUPTED), not run if it had not started.
function interruptedResult(result: MultiExecResult): MultiExecResult {
    if (result.status !== "cancelled") return result;
    return result.startedAt === null ? { ...result, status: "skipped" } : { ...result, errorCode: "INTERRUPTED" };
}

export type JobManager = ReturnType<typeof createJobManager>;

// The jobs of one backend: the live ones in memory, the rest in the history.
export function createJobManager(options: JobManagerOptions = {}) {
    const limits: JobLimits = { ...DEFAULT_LIMITS, ...options.limits };
    const live = new Map<string, Job>();
    // Each live job's run, settled once it is recorded as finished.
    const runs = new Map<string, Promise<void>>();
    let closing = false;

    const prune = async () => {
        try {
            const { retentionDays } = await getAuditSettings();
            const removed = await jobsRepo.prune(retentionDays > 0 ? Date.now() - retentionDays * DAY_MS : null, limits.maxHistory);
            if (removed > 0) log.info(`Pruned ${removed} multi-exec job(s) from the history`);
        } catch (err) {
            log.warn(`Could not prune the multi-exec job history: ${errorMessage(err)}`);
        }
    };

    // Jobs a previous process left running are over; nothing new is created
    // before that is recorded.
    const ready = (async () => {
        try {
            const interrupted = await jobsRepo.markInterrupted(Date.now());
            if (interrupted > 0) log.info(`Marked ${interrupted} multi-exec job(s) as interrupted`);
        } catch (err) {
            log.warn(`Could not check the multi-exec job history: ${errorMessage(err)}`);
        }
        await prune();
    })();

    const liveJob = async (id: string): Promise<Job> => {
        const job = live.get(id);
        if (job) return job;
        throw (await jobsRepo.get(id)) ? finished() : notFound();
    };

    return {
        ready,

        async start(request: JobRequest): Promise<MultiExecJobInfo> {
            await ready;
            if (closing) throw new AppError("MULTIEXEC_CLOSING", "ShellMind is shutting down: no new jobs start.", 503);
            if (live.size >= limits.maxActiveJobs) {
                throw new AppError("MULTIEXEC_BUSY", `At most ${limits.maxActiveJobs} multi-exec jobs can run at once; wait for one to finish.`, 429);
            }
            const job = new Job(randomUUID(), request, limits, options.deps);
            live.set(job.id, job);
            try {
                await jobsRepo.insert(job.snapshot());
            } catch (err) {
                live.delete(job.id);
                throw err;
            }
            log.debug(`Job ${job.id} started on ${request.targets.length} server(s)`);
            runs.set(job.id, job.run().finally(() => {
                live.delete(job.id);
                runs.delete(job.id);
                if (!closing) void prune();
            }));
            return job.current();
        },

        // The job as it is now (live, or from the history).
        async get(id: string): Promise<MultiExecJob | null> {
            return live.get(id)?.snapshot() ?? jobsRepo.get(id);
        },

        // Calls `listener` with a snapshot and then, while the job runs, with
        // its events up to "end". Returns the unsubscribe function, or null
        // when there is no such job.
        async follow(id: string, listener: JobListener): Promise<(() => void) | null> {
            const job = live.get(id);
            if (job) {
                listener({ type: "snapshot", job: job.snapshot() });
                return job.subscribe(listener);
            }
            const stored = await jobsRepo.get(id);
            if (!stored) return null;
            listener({ type: "snapshot", job: stored });
            listener({ type: "end" });
            return () => undefined;
        },

        async list(query: { limit: number; before?: number; active?: boolean }): Promise<MultiExecJobInfo[]> {
            const rows = await jobsRepo.list(query);
            return rows.map((row) => live.get(row.id)?.current() ?? row);
        },

        pause: async (id: string) => (await liveJob(id)).pause("user"),
        resume: async (id: string) => (await liveJob(id)).resume(),
        cancel: async (id: string) => (await liveJob(id)).cancel(),

        async remove(id: string): Promise<void> {
            if (live.has(id)) throw new AppError("MULTIEXEC_JOB_ACTIVE", "Cancel the job before deleting it.", 409);
            if (!(await jobsRepo.remove(id))) throw notFound();
        },

        clearFinished: () => jobsRepo.removeFinished(),

        // ShellMind is quitting: no job starts any more, the live ones are
        // interrupted, and this resolves once they are recorded as such.
        async shutdown(): Promise<void> {
            closing = true;
            for (const job of live.values()) job.interrupt();
            await Promise.all(runs.values());
        }
    };
}

let backendJobs: JobManager | null = null;

// The jobs of this backend (the router's, unless a test brings its own).
export function backendJobManager(): JobManager {
    backendJobs ??= createJobManager();
    return backendJobs;
}

// Shutdown: the backend's running jobs end as interrupted.
export async function stopMultiExecJobs(): Promise<void> {
    await backendJobs?.shutdown();
}
