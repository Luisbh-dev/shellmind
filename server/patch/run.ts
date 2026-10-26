import { MULTIEXEC_LIMITS, type MultiExecJobEvent, type MultiExecJobInfo } from "../../shared/multiexec";
import {
    isPatchServerType,
    minPatchTimeoutSec,
    PATCH_LIMITS,
    summarizeScan,
    type PatchApplyResponse,
    type PatchFleet,
    type PatchFleetRow,
    type PatchScan,
    type PatchServerState
} from "../../shared/patch";
import { recordAudit } from "../db/auditRepo";
import { serversRepo } from "../db/serversRepo";
import { AppError, errorMessage } from "../errors";
import { fleetMonitor } from "../fleet/monitor";
import { createLogger } from "../logger";
import { backendJobManager, type JobManager } from "../multiexec/jobs";
import { parseStrategy, type JobRequest } from "../multiexec/request";
import { cleanStderr } from "../ops/remote";
import { exec, type ExecResult } from "../ssh/exec";
import { sshPool } from "../ssh/pool";
import { invalid, jumpDependents, parseOptions, parseSeconds, parseServerIds, planRun } from "./plan";
import { cachedScan, forgetScansExcept, isScanning, notPatchable, scanMany, scanServer } from "./scan";
import { buildApplyScript, describeRun } from "./scripts";
import { createPatchStep, defaultStepDeps, type StepDeps } from "./step";

// Patch runs are multi-exec jobs (server/multiexec): batches, a canary, a
// failure limit, pause, resume and cancel, the job history and its event
// stream all come from there; the patch center adds the step each server
// runs (step.ts) and records it in the audit log as an operation ("ops",
// meta.patch). While a run goes on its servers are busy (no second run
// starts on them); once it ends they are read again, and the fleet board
// checks them again when its health checks are on.

const log = createLogger("patch");

const REFRESH_TIMEOUT_MS = 10 * 60_000;

// Server id -> the patch job running on it.
const busy = new Map<number, string>();
// Servers a run is being started on (between its plan and its job).
const reserved = new Set<number>();

const isBusy = (serverId: number) => busy.has(serverId) || reserved.has(serverId);

export function busyServers(): ReadonlySet<number> {
    return new Set([...busy.keys(), ...reserved]);
}

export type RunDeps = {
    jobs: () => JobManager;
    step: StepDeps;
    // What follows a run (read its servers again); tests replace it.
    afterRun: (serverIds: number[]) => Promise<void>;
};

async function afterRun(serverIds: number[]): Promise<void> {
    if (!serverIds.length) return;
    await scanMany(serverIds, () => undefined, new AbortController().signal);
    try {
        if ((await fleetMonitor.getSettings()).enabled) await fleetMonitor.refresh(serverIds);
    } catch (err) {
        log.warn(`Could not ask the fleet board to check the patched servers again: ${errorMessage(err)}`);
    }
}

const defaultRunDeps: RunDeps = { jobs: backendJobManager, step: defaultStepDeps, afterRun };

export async function startPatchRun(body: Record<string, unknown>, deps: RunDeps = defaultRunDeps): Promise<PatchApplyResponse> {
    const ids = parseServerIds(body.serverIds);
    const options = parseOptions(body);
    if (typeof body.confirm !== "number" || !Number.isInteger(body.confirm)) throw invalid("confirm must be the number of servers the run starts on", "confirm");
    const timeoutSec = parseSeconds(body.timeoutSec, "timeoutSec", PATCH_LIMITS.minTimeoutSec, MULTIEXEC_LIMITS.maxTimeoutSec, PATCH_LIMITS.defaultTimeoutSec);
    const rebootWaitSec = parseSeconds(body.rebootWaitSec, "rebootWaitSec", PATCH_LIMITS.minRebootWaitSec, PATCH_LIMITS.maxRebootWaitSec, PATCH_LIMITS.defaultRebootWaitSec);
    // The time per server covers the reboot and the wait for SSH: a shorter
    // one would cut the wait and report the server as timed out.
    const minTimeoutSec = minPatchTimeoutSec(options, rebootWaitSec);
    if (timeoutSec < minTimeoutSec) {
        throw new AppError("INVALID_PATCH", `With a reboot that waits up to ${rebootWaitSec} s for SSH, timeoutSec must be at least ${minTimeoutSec} s`, 400, { field: "timeoutSec", min: minTimeoutSec });
    }

    const plan = await planRun(ids, options, busyServers());
    if (!plan.eligible) {
        throw new AppError("PATCH_NOTHING_TO_RUN", "None of these servers can be patched now.", 409, {
            skipped: plan.servers.map(({ serverId, skip }) => ({ serverId, skip }))
        });
    }
    if (body.confirm !== plan.eligible) {
        throw new AppError("PATCH_CONFIRM_MISMATCH", `The run would start on ${plan.eligible} server(s), not ${body.confirm}: review it again.`, 409, { expected: plan.eligible });
    }
    const targets = plan.eligibleServers.map(({ serverId, name, host, type }) => ({ serverId, name, host, type }));
    const strategy = parseStrategy(body.strategy, undefined, targets.length);
    const jumpHosts = new Set(plan.eligibleServers.filter((server) => server.jumpHostFor.length).map((server) => server.serverId));
    const request: JobRequest = {
        command: plan.script,
        // The script as it runs: its first line says what the run does.
        recorded: plan.script,
        masked: false,
        template: null,
        templateMasked: false,
        variables: null,
        secretVariables: [],
        secrets: [],
        targets,
        timeoutSec,
        strategy,
        snippet: null,
        danger: options.reboot ? "power" : null,
        rerunOf: null,
        step: createPatchStep({ script: plan.script, reboot: options.reboot, rebootWaitMs: rebootWaitSec * 1000, jumpHosts }, deps.step),
        auditSource: "ops",
        auditCommand: `patch center: ${describeRun(options)}`,
        auditMeta: { patch: true, mode: options.mode, refresh: options.refresh, reboot: options.reboot }
    };

    // Two runs started at once on one server: the second finds it taken (no
    // await between this check and the reservation).
    const taken = targets.filter((target) => isBusy(target.serverId)).map((target) => target.serverId);
    if (taken.length) throw new AppError("PATCH_BUSY", "A patch run is going on on some of these servers: review the run again.", 409, { serverIds: taken });
    for (const target of targets) reserved.add(target.serverId);
    const jobs = deps.jobs();
    let job: MultiExecJobInfo;
    try {
        job = await jobs.start(request);
    } finally {
        for (const target of targets) reserved.delete(target.serverId);
    }
    for (const target of targets) busy.set(target.serverId, job.id);
    // The servers stay busy until they are read again, so what the patch
    // center shows next is their state after the run.
    const release = async () => {
        const finished = await jobs.get(job.id).catch(() => null);
        const ran = finished?.servers.filter((server) => server.startedAt !== null).map((server) => server.serverId) ?? [];
        await deps.afterRun(ran).catch((err: unknown) => log.warn(`Could not read the patched servers again: ${errorMessage(err)}`));
        for (const [serverId, jobId] of busy) if (jobId === job.id) busy.delete(serverId);
    };
    let ended = false;
    const onEvent = (event: MultiExecJobEvent) => {
        if (event.type !== "end" || ended) return;
        ended = true;
        void release();
    };
    const unsubscribe = await jobs.follow(job.id, onEvent);
    if (!unsubscribe && !ended) {
        ended = true;
        void release();
    }
    return { job, targets, skipped: plan.servers.filter((server) => server.skip !== null) };
}

// GET /api/patch/fleet: every saved Linux/Windows server with its latest
// scan, the fleet board's reading and whether a run holds it.
export async function patchFleet(): Promise<PatchFleet> {
    const all = await serversRepo.listSummaries();
    const servers = all.filter((server) => isPatchServerType(server.type));
    forgetScansExcept(new Set(servers.map((server) => server.id)));
    const dependents = jumpDependents(all);
    const snapshots = new Map<number, Awaited<ReturnType<typeof fleetMonitor.board>>["snapshots"][number]>();
    try {
        for (const snapshot of (await fleetMonitor.board()).snapshots) snapshots.set(snapshot.serverId, snapshot);
    } catch (err) {
        log.warn(`The fleet board's readings are not available: ${errorMessage(err)}`);
    }
    const rows: PatchFleetRow[] = servers.map((server) => {
        const { scan, error } = cachedScan(server);
        const snapshot = snapshots.get(server.id);
        return {
            serverId: server.id,
            scan: scan ? summarizeScan(scan) : null,
            scanError: error,
            fleet: snapshot
                ? {
                    state: snapshot.state,
                    updates: snapshot.metrics?.updates ?? null,
                    rebootRequired: snapshot.metrics?.rebootRequired ?? null,
                    readAt: snapshot.readAt
                }
                : null,
            jumpHostFor: dependents.get(server.id) ?? [],
            jobId: busy.get(server.id) ?? null,
            scanning: isScanning(server.id)
        };
    });
    return { rows };
}

// The latest scan of one server (null: none yet).
export async function serverPatchState(serverId: number): Promise<PatchServerState> {
    const server = await serversRepo.getSummary(serverId);
    if (!server) throw new AppError("SERVER_NOT_FOUND", "Server not found", 404);
    if (!isPatchServerType(server.type)) throw notPatchable();
    const { scan, error } = cachedScan(server);
    return { scan, error, jobId: busy.get(serverId) ?? null, scanning: isScanning(serverId) };
}

export type RefreshResult = { exitCode: number | null; output: string; scan: PatchScan };

// Refreshes one server's package lists (Windows: searches Windows Update
// online), recorded in the audit log, and reads its updates again.
export async function refreshServer(serverId: number, signal: AbortSignal): Promise<RefreshResult> {
    const server = await serversRepo.getSummary(serverId);
    if (!server) throw new AppError("SERVER_NOT_FOUND", "Server not found", 404);
    if (!isPatchServerType(server.type)) throw notPatchable();
    if (isBusy(serverId)) throw new AppError("PATCH_BUSY", "A patch run is going on on this server.", 409, { jobId: busy.get(serverId) ?? null });
    const audit = (exitCode: number | null, meta: Record<string, unknown>) => recordAudit({
        serverId, source: "ops", command: "patch center: refresh the package lists", exitCode, meta: { patch: true, action: "refresh", ...meta }
    }).catch((err: unknown) => log.error(`Could not record the refresh of server #${serverId} in the audit log`, err));
    const failed = async (err: unknown, meta: Record<string, unknown> = {}) => {
        if (!signal.aborted) await audit(null, { ...meta, error: errorMessage(err).slice(0, 300) });
        return err;
    };

    if (server.type === "windows") {
        try {
            const scan = await scanServer(serverId, { signal, online: true });
            await audit(0, { online: true });
            return { exitCode: 0, output: "", scan };
        } catch (err) {
            throw await failed(err, { online: true });
        }
    }

    const lease = await sshPool.acquire(serverId);
    let result: ExecResult;
    try {
        result = await exec(lease, "sh -s", {
            stdin: buildApplyScript({ mode: "refresh", refresh: true, reboot: false }),
            timeoutMs: REFRESH_TIMEOUT_MS,
            signal,
            truncateOutput: true,
            maxOutputBytes: 1024 * 1024
        });
    } catch (err) {
        throw await failed(err);
    } finally {
        lease.release();
    }
    const output = [result.stdout.trim(), cleanStderr(result.stderr)].filter(Boolean).join("\n").slice(-20_000);
    await audit(result.code, result.code === 0 ? {} : { error: cleanStderr(result.stderr).slice(0, 300) });
    if (result.code === 77) throw new AppError("PATCH_PRIVILEGE", "Refreshing the package lists needs root or sudo without a password (sudo -n).", 403, { output });
    if (result.code !== 0) throw new AppError("PATCH_REFRESH_FAILED", `Refreshing the package lists failed (exit status ${result.code ?? "unknown"}).`, 502, { output, exitCode: result.code });
    return { exitCode: result.code, output, scan: await scanServer(serverId, { signal }) };
}
