import { holdForCode } from "../../shared/fleet";
import { patchMarker } from "../../shared/patch";
import type { AuditInput } from "../../shared/types";
import { auditEntryId, completeAudit, recordAudit, type AuditCompletion } from "../db/auditRepo";
import { errorMessage } from "../errors";
import { fleetMonitor } from "../fleet/monitor";
import { createLogger } from "../logger";
import type { ServerStep, ServerStepContext, ServerStepOutcome } from "../multiexec/runner";
import { cleanStderr, parseSections } from "../ops/remote";
import { connectionError } from "../ssh/connectionErrors";
import { exec, execCommandStream, type ExecResult } from "../ssh/exec";
import { describeSshError, sshPool, type SshLease } from "../ssh/pool";
import { BOOT_CHECK_SCRIPT, REBOOT_SCRIPT } from "./scripts";

// What a patch job runs on each server: the run's script (scripts.ts), then,
// when the run reboots and the server says a reboot is required, the reboot:
// it closes the server's pooled connections, waits for SSH to come back
// (polling with backoff, up to the run's wait), checks that the server did
// boot again (the kernel's boot id, or the start of PID 1 in a container),
// waits for systemd to finish starting and reports the uptime, the system's
// state and its failed units. A server that answers with more failed units
// than before, or in a state such as "maintenance", fails: a canary that
// comes back broken holds the rollout. Jump hosts are never rebooted here.
//
// What it says in the output, and why a server's reboot failed, are marker
// lines (shared/patch.ts) the client words in its language: "reboot=start",
// "reboot=back after=42 up=9 state=running failed=0", "reboot-failed=timeout
// wait=600 | <the last connection error>"... Durations are in seconds.

const log = createLogger("patch");

export const REBOOT_AUDIT_COMMAND = "reboot (patch center)";

const BOOT_CHECK_TIMEOUT_MS = 20_000;
const REBOOT_COMMAND_TIMEOUT_MS = 20_000;
// A server still on the same boot this long after the reboot command did not
// reboot (a slow shutdown keeps sshd answering for a while).
const SAME_BOOT_LIMIT_MS = 300_000;
// While a host shuts down, and early in its boot, pam_nologin refuses logins
// other than root's: a refused login is only final once it keeps happening.
const MAX_REFUSED_LOGINS = 5;
// How long systemd may keep "starting" once SSH answers.
const SETTLE_LIMIT_MS = 120_000;
const FIRST_POLL_MS = 3000;
const MAX_POLL_MS = 30_000;
const PROGRESS_EVERY_MS = 30_000;

export type StepDeps = {
    stream: (lease: SshLease, script: string, options: { signal: AbortSignal; onData: (text: string) => void; onStderr: (text: string) => void }) => Promise<{ code: number | null; signal: string | null }>;
    run: (lease: SshLease, script: string, options: { signal: AbortSignal; timeoutMs: number }) => Promise<ExecResult>;
    acquire: (serverId: number) => Promise<SshLease>;
    // Closes every pooled connection to the server (it is going down).
    close: (serverId: number) => void;
    sleep: (ms: number, signal: AbortSignal) => Promise<void>;
    now: () => number;
    // Returns the entry (its id is what complete takes).
    record: (entry: AuditInput) => Promise<unknown>;
    complete: (id: number, completion: AuditCompletion) => Promise<unknown>;
    // The fleet board's planned maintenance of a server while it reboots
    // (FleetMonitor.beginMaintenance): no alert, no login hold meanwhile.
    maintenance: { begin: (serverId: number, untilMs: number) => void; end: (serverId: number) => void };
};

function sleep(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(done, ms);
        function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });
}

export const defaultStepDeps: StepDeps = {
    stream: (lease, script, options) => execCommandStream(lease, "sh -s", { ...options, stdin: script }),
    run: (lease, script, options) => exec(lease, "sh -s", { ...options, stdin: script }),
    acquire: (serverId) => sshPool.acquire(serverId),
    close: (serverId) => sshPool.invalidate(serverId, { close: true }),
    sleep,
    now: () => Date.now(),
    record: recordAudit,
    complete: completeAudit,
    maintenance: {
        begin: (serverId, untilMs) => fleetMonitor.beginMaintenance([serverId], untilMs),
        end: (serverId) => fleetMonitor.endMaintenance([serverId])
    }
};

export type PatchStepOptions = {
    script: string;
    reboot: boolean;
    rebootWaitMs: number;
    // Servers other saved servers are reached through.
    jumpHosts: ReadonlySet<number>;
};

export type BootState = {
    bootId: string | null;
    // Start of PID 1, in clock ticks since the kernel booted.
    pid1: string | null;
    hz: number;
    uptimeSec: number | null;
    // systemd's state (null without systemd).
    state: string | null;
    failed: number | null;
};

export function parseBootState(output: string): BootState {
    const sections = parseSections(output);
    const value = (name: string) => sections.get(name)?.trim().split("\n")[0]?.trim() || null;
    const hz = Number(value("hz"));
    const uptime = Number(value("uptime"));
    const state = value("state");
    const failed = value("failed");
    return {
        bootId: value("boot"),
        pid1: /^\d+$/.test(value("pid1") ?? "") ? value("pid1") : null,
        hz: Number.isFinite(hz) && hz > 0 ? hz : 100,
        uptimeSec: Number.isFinite(uptime) && uptime > 0 ? uptime : null,
        state: state && /^[a-z-]+$/.test(state) ? state : null,
        failed: failed && /^\d+$/.test(failed) ? Number(failed) : null
    };
}

// Whether `after` is another boot than `before`.
export function bootedAgain(before: BootState, after: BootState): boolean {
    if (before.bootId && after.bootId && before.bootId !== after.bootId) return true;
    return Boolean(before.pid1 && after.pid1 && before.pid1 !== after.pid1);
}

// How long the system has been up: since PID 1 started where that is known
// (a container's /proc/uptime is its host's).
export function upSeconds(state: BootState): number | null {
    if (state.uptimeSec === null) return null;
    if (state.pid1 === null) return Math.round(state.uptimeSec);
    return Math.max(0, Math.round(state.uptimeSec - Number(state.pid1) / state.hz));
}

const secondsOf = (ms: number) => Math.max(0, Math.round(ms / 1000));

// What a failed connection attempt means while the server reboots: worth
// waiting on (refused, unreachable, a login refused while it shuts down or
// boots), or final: a changed host key, a configuration that cannot be used
// (the fleet board's holds), credentials refused again and again.
function attemptFailure(err: unknown): "wait" | "login" | "final" {
    const hold = holdForCode(connectionError(err).code);
    if (hold === "auth") return "login";
    return hold ? "final" : "wait";
}

// Watches the output for the run's "reboot-required=" line.
function rebootVerdict() {
    let partial = "";
    let verdict: "yes" | "no" | "unknown" | null = null;
    const line = (text: string) => {
        const match = /^\[shellmind\] reboot-required=(yes|no|unknown)\s*$/.exec(text);
        if (match) verdict = match[1] as "yes" | "no" | "unknown";
    };
    return {
        push: (text: string) => {
            partial += text;
            let index = partial.indexOf("\n");
            while (index !== -1) {
                line(partial.slice(0, index));
                partial = partial.slice(index + 1);
                index = partial.indexOf("\n");
            }
            if (partial.length > 4096) partial = partial.slice(-4096);
        },
        result: () => {
            if (partial) line(partial);
            return verdict;
        }
    };
}

// A reboot that went wrong: its marker line is the server's error.
class RebootFailure extends Error {
    constructor(value: string, params: Record<string, string | number | null> = {}, detail?: string) {
        super(patchMarker("reboot-failed", value, params, detail));
    }
}

async function rebootAndWait(context: ServerStepContext, options: PatchStepOptions, deps: StepDeps): Promise<ServerStepOutcome> {
    const { target, signal } = context;
    const check = async (on: SshLease) => parseBootState((await deps.run(on, BOOT_CHECK_SCRIPT, { signal, timeoutMs: BOOT_CHECK_TIMEOUT_MS })).stdout);
    const before = await check(context.lease);
    if (!before.bootId && !before.pid1) {
        context.onData(`${patchMarker("reboot", "skip-no-boot-id")}\n`);
        return { code: 0, signal: null };
    }

    // The reboot is recorded in the audit log before it is sent, and the
    // entry completed when it ends (see runner.ts): a backend that stops
    // while the server is down still says it was rebooted.
    const entry = { serverId: target.serverId, source: "ops" as const, command: REBOOT_AUDIT_COMMAND };
    const metaOf = (meta: Record<string, unknown>) => ({ ...context.auditMeta, patch: true, action: "reboot", ...meta });
    let entryId: number | null = null;
    let ended = false;
    const audit = async (exitCode: number | null, meta: Record<string, unknown>) => {
        ended = true;
        try {
            if (entryId === null) await deps.record({ ...entry, exitCode, meta: metaOf(meta) });
            else await deps.complete(entryId, { exitCode, meta: metaOf(meta) });
        } catch (err) {
            log.error(`Could not record the reboot of server #${target.serverId} in the audit log`, err);
        }
    };
    context.onData(`${patchMarker("reboot", "start")}\n`);
    try {
        entryId = auditEntryId(await deps.record({ ...entry, exitCode: null, meta: metaOf({ status: "running" }) }));
    } catch (err) {
        log.error(`Could not record the reboot of server #${target.serverId} in the audit log`, err);
    }
    // The longest the reboot can take here: the command, the wait for SSH
    // and for the services to settle.
    deps.maintenance.begin(target.serverId, deps.now() + REBOOT_COMMAND_TIMEOUT_MS + options.rebootWaitMs + SETTLE_LIMIT_MS);
    try {
        return await rebootSteps(context, options, deps, before, check, audit);
    } finally {
        deps.maintenance.end(target.serverId);
        // Cancelled (or ShellMind quitting) on the way.
        if (!ended) await audit(null, { status: signal.aborted ? "cancelled" : "failed" });
    }
}

async function rebootSteps(
    context: ServerStepContext,
    options: PatchStepOptions,
    deps: StepDeps,
    before: BootState,
    check: (on: SshLease) => Promise<BootState>,
    audit: (exitCode: number | null, meta: Record<string, unknown>) => Promise<void>
): Promise<ServerStepOutcome> {
    const { target, lease, signal, onData, onStderr } = context;
    const say = (value: string, params: Record<string, string | number | null> = {}) => onData(`${patchMarker("reboot", value, params)}\n`);
    const started = deps.now();
    try {
        const result = await deps.run(lease, REBOOT_SCRIPT, { signal, timeoutMs: REBOOT_COMMAND_TIMEOUT_MS });
        if (result.code !== null && result.code !== 0) {
            const reason = (cleanStderr(result.stderr) || result.stdout.trim()).slice(0, 500);
            onStderr(`${patchMarker("reboot-failed", "command", { code: result.code })}\n${reason ? `${reason}\n` : ""}`);
            await audit(result.code, { error: reason || `exit status ${result.code}` });
            return { code: result.code, signal: null };
        }
    } catch (err) {
        // The connection going down with the server (or a command that never
        // returns while it shuts down) is what a reboot looks like.
        if (signal.aborted) throw err;
    }
    deps.close(target.serverId);
    say("waiting");

    const deadline = started + options.rebootWaitMs;
    let delay = FIRST_POLL_MS;
    let lastProgress = deps.now();
    let lastProblem = "";
    let refusedLogins = 0;
    let back: { lease: SshLease; state: BootState } | null = null;
    try {
        await deps.sleep(FIRST_POLL_MS, signal);
        while (!back) {
            if (signal.aborted) throw new RebootFailure("cancelled");
            if (deps.now() >= deadline) throw new RebootFailure("timeout", { wait: secondsOf(options.rebootWaitMs) }, lastProblem);
            let next: SshLease | null = null;
            let sameBoot = false;
            try {
                next = await deps.acquire(target.serverId);
                const state = await check(next);
                if (bootedAgain(before, state)) back = { lease: next, state };
                else sameBoot = true;
            } catch (err) {
                if (signal.aborted) throw err;
                const failure = attemptFailure(err);
                if (failure === "login") refusedLogins += 1;
                if (failure === "final" || refusedLogins > MAX_REFUSED_LOGINS) throw new RebootFailure("connection", {}, describeSshError(err));
                lastProblem = describeSshError(err).slice(0, 200);
            } finally {
                if (next && !back) next.release();
            }
            if (back) break;
            if (sameBoot) {
                // Still going down, or it never did.
                deps.close(target.serverId);
                if (deps.now() - started > SAME_BOOT_LIMIT_MS) throw new RebootFailure("same-boot", { after: secondsOf(SAME_BOOT_LIMIT_MS) });
            }
            if (deps.now() - lastProgress >= PROGRESS_EVERY_MS) {
                lastProgress = deps.now();
                say("still-waiting", { after: secondsOf(deps.now() - started) });
            }
            await deps.sleep(Math.max(0, Math.min(delay, deadline - deps.now())), signal);
            delay = Math.min(Math.round(delay * 1.5), MAX_POLL_MS);
        }
    } catch (err) {
        await audit(null, { error: errorMessage(err), waitedSec: secondsOf(deps.now() - started) });
        throw err;
    }

    const backAfterMs = deps.now() - started;
    let state = back.state;
    try {
        const settleUntil = Math.min(deps.now() + SETTLE_LIMIT_MS, deadline);
        while ((state.state === "starting" || state.state === "initializing") && deps.now() < settleUntil && !signal.aborted) {
            await deps.sleep(5000, signal);
            state = await check(back.lease);
        }
    } catch (err) {
        back.lease.release();
        if (signal.aborted) throw err;
        await audit(null, { error: errorMessage(err), backAfterSec: secondsOf(backAfterMs) });
        throw new RebootFailure("check", {}, describeSshError(err));
    }

    const up = upSeconds(state);
    say("back", { after: secondsOf(backAfterMs), up, state: state.state, failed: state.failed });

    let code = 0;
    if (state.state && !["running", "degraded", "starting", "initializing"].includes(state.state)) {
        onStderr(`${patchMarker("reboot-check", "state", { state: state.state })}\n`);
        code = 1;
    } else if (state.failed !== null && state.failed > (before.failed ?? 0)) {
        onStderr(`${patchMarker("reboot-check", "failed-units", { before: before.failed ?? 0, after: state.failed })}\n`);
        code = 1;
    } else if (state.state === "starting" || state.state === "initializing") {
        onData(`${patchMarker("reboot-check", "still-starting", { after: secondsOf(SETTLE_LIMIT_MS) })}\n`);
    }
    await audit(code, { backAfterSec: secondsOf(backAfterMs), uptimeSec: up, state: state.state, failedUnits: state.failed });
    return { code, signal: null, lease: back.lease };
}

export function createPatchStep(options: PatchStepOptions, deps: StepDeps = defaultStepDeps): ServerStep {
    return async (context) => {
        const verdict = rebootVerdict();
        const outcome = await deps.stream(context.lease, options.script, {
            signal: context.signal,
            onData: (text) => {
                verdict.push(text);
                context.onData(text);
            },
            onStderr: context.onStderr
        });
        const required = verdict.result();
        if (outcome.code !== 0 || !options.reboot) return outcome;
        // "reboot-required=no" already said there is nothing to do.
        if (required === "no") return outcome;
        const say = (value: string) => context.onData(`${patchMarker("reboot", value)}\n`);
        if (required !== "yes") {
            say("skip-unknown");
            return outcome;
        }
        if (options.jumpHosts.has(context.target.serverId)) {
            say("skip-jump-host");
            return outcome;
        }
        return rebootAndWait(context, options, deps);
    };
}
