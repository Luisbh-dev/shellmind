import {
    MULTIEXEC_LIMITS,
    type MultiExecErrorCode,
    type MultiExecJobEvent,
    type MultiExecResult,
    type MultiExecStatus,
    type MultiExecTarget
} from "../../shared/multiexec";
import { outputHashes } from "../../shared/multiexecOutput";
import type { AuditInput, AuditSource } from "../../shared/types";
import { auditEntryId, completeAudit, recordAudit, type AuditCompletion } from "../db/auditRepo";
import { createLogger } from "../logger";
import { ExecAbortedError, exec, execCommandStream } from "../ssh/exec";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { describeSshError, sshPool, type SshLease } from "../ssh/pool";
import { createSecretMasker, type SecretValue } from "./secretMasker";

// Runs one command on several saved SSH servers: a few at a time, each on a
// lease of its pooled connection, bounded by a timeout and by the run's
// AbortSignal. The timeout of a server counts from its start, so connecting,
// waiting for a channel and the command all fit in it. Output is buffered
// per server, capped, masked of the job's secret values and handed to `emit`
// in batches; every command that reached a server is recorded in the audit
// log (in its recorded form, see auditCommand) before it is sent, and the
// entry completed with its exit code when it ends, so a backend that stops in
// between still says it was sent; and so is the host name probe
// (HOSTNAME_COMMAND). A job (jobs.ts) runs each of its batches through here.

const log = createLogger("multiexec");

export type MultiExecDeps = {
    acquire: (serverId: number) => Promise<SshLease>;
    // Returns the entry (its id is what complete takes).
    record: (entry: AuditInput) => Promise<unknown>;
    complete: (id: number, completion: AuditCompletion) => Promise<unknown>;
};

const defaultDeps: MultiExecDeps = {
    acquire: (serverId) => sshPool.acquire(serverId),
    record: recordAudit,
    complete: completeAudit
};

export type MultiExecServerEvent = Extract<MultiExecJobEvent, { type: "running" | "output" | "result" }>;

// W8-T3: what a job runs on each server instead of its plain command (the
// patch center installs updates, then reboots and waits for SSH to come
// back). It gets the server's lease and the attempt's signal (its cancel and
// timeout), writes its output like a command and ends with an exit status.
// A lease of its own it hands back (the connection after a reboot) is used
// for what follows and released by the runner.
export type ServerStepContext = {
    target: MultiExecTarget;
    lease: SshLease;
    signal: AbortSignal;
    onData: (text: string) => void;
    onStderr: (text: string) => void;
    // The meta of the run's audit entries (job id, batch).
    auditMeta: Record<string, unknown>;
};

export type ServerStepOutcome = { code: number | null; signal: string | null; lease?: SshLease };

export type ServerStep = (context: ServerStepContext) => Promise<ServerStepOutcome>;

export type MultiExecRunOptions = {
    // What runs on the servers.
    command: string;
    // What the audit log records instead (secret values masked); defaults to `command`.
    auditCommand?: string;
    targets: MultiExecTarget[];
    timeoutMs: number;
    concurrency: number;
    signal: AbortSignal;
    emit: (event: MultiExecServerEvent) => void;
    maxOutputBytes?: number;
    // How often buffered output is emitted.
    flushIntervalMs?: number;
    // Added to the meta of every audit entry (job id, snippet, batch).
    auditMeta?: Record<string, unknown>;
    // Values masked in the output (the job's secret variables).
    secrets?: readonly SecretValue[];
    // Asked before each server starts (it may wait, e.g. while the job is
    // paused): false leaves the server out ("skipped").
    beforeStart?: (target: MultiExecTarget) => Promise<boolean>;
    // Awaited once the server's connection is ready, before the command is
    // sent (the job writes that the server is running to its history first).
    beforeDispatch?: (target: MultiExecTarget) => Promise<void>;
    // W8-T3: runs on each server instead of `command` (see ServerStep).
    step?: ServerStep;
    // W8-T3: the source of the audit entries ("multi-exec" by default).
    auditSource?: AuditSource;
};

const MAX_AUDIT_ERROR_LENGTH = 300;

// What a server calls itself, so the normalized output hash can mask it (it
// may differ from the name it is saved under). Asked once per pooled
// connection, only when a command printed something to group, and recorded
// in the audit log like every command ShellMind runs. An answer that is no
// host name (a forced command, a banner) is ignored.
const HOSTNAME_COMMAND = "hostname";
const HOSTNAME_TIMEOUT_MS = 2000;
const HOSTNAME = /^(?=.{1,253}$)[A-Za-z0-9][\w-]{0,62}(?:\.[\w-]{1,63})*$/;
const hostnames = new WeakMap<object, Promise<string>>();

type OutputBuffer = {
    bytes: number;
    truncated: boolean;
    // Not yet emitted.
    stdout: string;
    stderr: string;
    // Everything kept, for the output hashes.
    allStdout: string;
    allStderr: string;
    maskers: Record<"stdout" | "stderr", ReturnType<typeof createSecretMasker>>;
};

// The longest prefix of `text` that fits in `maxBytes` of UTF-8 without
// splitting a character.
export function clampUtf8(text: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes) return text;
    let end = maxBytes;
    while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
    return bytes.subarray(0, end).toString("utf8");
}

// A lease for the server, unless the attempt ends first (cancelled or out of
// time): then the connection is left to finish on its own and its lease
// handed back.
function leaseUnlessCancelled(acquiring: Promise<SshLease>, signal: AbortSignal): Promise<SshLease> {
    return new Promise((resolve, reject) => {
        let cancelled = false;
        const onAbort = () => {
            cancelled = true;
            reject(new ExecAbortedError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        acquiring.then(
            (lease) => {
                signal.removeEventListener("abort", onAbort);
                if (cancelled) lease.release();
                else resolve(lease);
            },
            (err: unknown) => {
                signal.removeEventListener("abort", onAbort);
                if (!cancelled) reject(err);
            }
        );
    });
}

// The kind of a connection failure (see MultiExecErrorCode), if it is a known one.
export function connectionFailureCode(err: unknown): MultiExecErrorCode | null {
    if (err instanceof HostKeyMismatchError) return "HOST_KEY_MISMATCH";
    const { level, code } = (err ?? {}) as { level?: unknown; code?: unknown };
    if (level === "client-authentication") return "AUTH_FAILED";
    if (level === "client-timeout") return "HANDSHAKE_TIMEOUT";
    switch (code) {
        case "ECONNREFUSED":
            return "CONNECTION_REFUSED";
        case "ENOTFOUND":
        case "EAI_AGAIN":
            return "HOST_NOT_FOUND";
        case "EHOSTUNREACH":
        case "ENETUNREACH":
        case "EHOSTDOWN":
        case "ETIMEDOUT":
            return "HOST_UNREACHABLE";
        default:
            return null;
    }
}

export function emptyResult(serverId: number, status: MultiExecStatus): MultiExecResult {
    return {
        serverId,
        status,
        exitCode: null,
        signal: null,
        error: null,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        truncated: false,
        outputHash: null,
        normalizedHash: null
    };
}

export async function runMultiExec(options: MultiExecRunOptions, deps: MultiExecDeps = defaultDeps): Promise<MultiExecResult[]> {
    const { command, targets, signal, timeoutMs } = options;
    const maxOutputBytes = options.maxOutputBytes ?? MULTIEXEC_LIMITS.maxOutputBytes;
    const auditSource = options.auditSource ?? "multi-exec";
    const results = new Map<number, MultiExecResult>(targets.map((target) => [target.serverId, emptyResult(target.serverId, "queued")]));
    const buffers = new Map<number, OutputBuffer>();
    const queue = [...targets];

    const emit = (event: MultiExecServerEvent) => {
        try {
            options.emit(event);
        } catch (err) {
            log.warn("Could not deliver a multi-exec event", err);
        }
    };

    const flush = (serverId: number) => {
        const buffer = buffers.get(serverId);
        if (!buffer) return;
        if (buffer.stdout) emit({ type: "output", serverId, stream: "stdout", data: buffer.stdout });
        if (buffer.stderr) emit({ type: "output", serverId, stream: "stderr", data: buffer.stderr });
        buffer.stdout = "";
        buffer.stderr = "";
    };

    // Keeps masked text within the cap (whatever does not fit is dropped).
    const keep = (buffer: OutputBuffer, stream: "stdout" | "stderr", text: string) => {
        if (buffer.truncated || !text) return;
        let kept = text;
        const size = Buffer.byteLength(text, "utf8");
        if (buffer.bytes + size > maxOutputBytes) {
            kept = clampUtf8(text, maxOutputBytes - buffer.bytes);
            buffer.truncated = true;
        }
        buffer.bytes += Buffer.byteLength(kept, "utf8");
        buffer[stream] += kept;
        if (stream === "stdout") buffer.allStdout += kept;
        else buffer.allStderr += kept;
    };

    const append = (buffer: OutputBuffer, stream: "stdout" | "stderr", text: string) => {
        keep(buffer, stream, buffer.maskers[stream].push(text));
    };

    const finish = (result: MultiExecResult) => {
        flush(result.serverId);
        buffers.delete(result.serverId);
        results.set(result.serverId, result);
        emit({ type: "result", result });
    };

    const audit = async (entry: AuditInput) => {
        try {
            await deps.record(entry);
        } catch (err) {
            log.error(`Could not record the multi-exec command on server #${entry.serverId} in the audit log`, err);
        }
    };

    // The entry of a command about to be sent: its id, null when it could
    // not be written (then the end is recorded as an entry of its own).
    const recordSent = async (target: MultiExecTarget): Promise<number | null> => {
        try {
            return auditEntryId(await deps.record({ serverId: target.serverId, source: auditSource, command: options.auditCommand ?? command, exitCode: null, meta: { ...options.auditMeta, status: "running" } }));
        } catch (err) {
            log.error(`Could not record the multi-exec command on server #${target.serverId} in the audit log`, err);
            return null;
        }
    };

    const recordEnd = async (target: MultiExecTarget, entryId: number | null, result: MultiExecResult) => {
        const meta: Record<string, unknown> = { ...options.auditMeta, status: result.status, durationMs: result.durationMs };
        if (result.error) meta.error = result.error.slice(0, MAX_AUDIT_ERROR_LENGTH);
        if (result.signal) meta.signal = result.signal;
        if (result.truncated) meta.truncated = true;
        if (entryId === null) {
            await audit({ serverId: target.serverId, source: auditSource, command: options.auditCommand ?? command, exitCode: result.exitCode, meta });
            return;
        }
        try {
            await deps.complete(entryId, { exitCode: result.exitCode, meta });
        } catch (err) {
            log.error(`Could not complete the audit entry of the multi-exec command on server #${target.serverId}`, err);
        }
    };

    // See HOSTNAME_COMMAND. "" when the server gave no host name.
    const hostnameOf = (lease: SshLease, target: MultiExecTarget): Promise<string> => {
        const known = hostnames.get(lease.client);
        if (known) return known;
        const asking = (async () => {
            let exitCode: number | null = null;
            let name = "";
            try {
                const answer = await exec(lease, HOSTNAME_COMMAND, { timeoutMs: HOSTNAME_TIMEOUT_MS, signal, maxOutputBytes: 1024 });
                exitCode = answer.code;
                const first = answer.stdout.trim();
                if (answer.code === 0 && HOSTNAME.test(first)) name = first;
            } catch (err) {
                log.debug(`No host name from server #${target.serverId}: ${describeSshError(err)}`);
                // Asked again by the next job if this one was cancelled meanwhile.
                if (signal.aborted) hostnames.delete(lease.client);
            }
            await audit({ serverId: target.serverId, source: auditSource, command: HOSTNAME_COMMAND, exitCode, meta: { ...options.auditMeta, probe: true } });
            return name;
        })();
        hostnames.set(lease.client, asking);
        return asking;
    };

    const runOne = async (target: MultiExecTarget) => {
        const buffer: OutputBuffer = {
            bytes: 0,
            truncated: false,
            stdout: "",
            stderr: "",
            allStdout: "",
            allStderr: "",
            maskers: { stdout: createSecretMasker(options.secrets ?? []), stderr: createSecretMasker(options.secrets ?? []) }
        };
        buffers.set(target.serverId, buffer);
        const startedAt = Date.now();
        results.set(target.serverId, { ...emptyResult(target.serverId, "running"), startedAt });
        emit({ type: "running", serverId: target.serverId, startedAt });

        // Ends this server's attempt on the run's cancel or when its time is up,
        // whether it is still connecting or already running the command.
        const attempt = new AbortController();
        let timedOut = false;
        const timer = setTimeout(() => {
            if (attempt.signal.aborted) return;
            timedOut = true;
            attempt.abort();
        }, timeoutMs);
        const onCancel = () => attempt.abort();
        if (signal.aborted) onCancel();
        else signal.addEventListener("abort", onCancel, { once: true });

        let lease: SshLease | null = null;
        // A lease the step handed back (see ServerStep).
        let stepLease: SshLease | null = null;
        let dispatched = false;
        let entryId: number | null = null;
        let status: MultiExecStatus;
        let exitCode: number | null = null;
        let exitSignal: string | null = null;
        let error: string | null = null;
        let errorCode: MultiExecErrorCode | null = null;
        let commandEnded: number | null = null;
        let hostname = "";
        let printed = false;
        try {
            lease = await leaseUnlessCancelled(deps.acquire(target.serverId), attempt.signal);
            await options.beforeDispatch?.(target);
            if (attempt.signal.aborted) throw new ExecAbortedError();
            entryId = await recordSent(target);
            dispatched = true;
            const io = {
                onData: (text: string) => {
                    printed ||= text.length > 0;
                    append(buffer, "stdout", text);
                },
                onStderr: (text: string) => {
                    printed ||= text.length > 0;
                    append(buffer, "stderr", text);
                }
            };
            const outcome: ServerStepOutcome = options.step
                ? await options.step({ target, lease, signal: attempt.signal, auditMeta: { ...options.auditMeta }, ...io })
                : await execCommandStream(lease, command, { signal: attempt.signal, ...io });
            stepLease = outcome.lease ?? null;
            exitCode = outcome.code;
            exitSignal = outcome.signal;
            if (exitCode === 0) {
                status = "ok";
            } else {
                status = "failed";
                if (exitCode === null) {
                    error = exitSignal ? `Ended by signal ${exitSignal}` : "The server did not report an exit status";
                    errorCode = exitSignal ? "SIGNAL" : "NO_EXIT_STATUS";
                }
            }
            commandEnded = Date.now();
            if (exitCode !== null && printed && !signal.aborted) hostname = await hostnameOf(stepLease ?? lease, target);
        } catch (err) {
            const seconds = Math.round(timeoutMs / 1000);
            if (timedOut) {
                status = "timeout";
                error = dispatched ? `The command did not finish within ${seconds}s` : `Could not connect within ${seconds}s`;
                errorCode = dispatched ? "TIMEOUT" : "CONNECT_TIMEOUT";
            } else if (err instanceof ExecAbortedError || signal.aborted) {
                status = "cancelled";
            } else {
                status = "failed";
                error = describeSshError(err);
                errorCode = connectionFailureCode(err);
            }
        } finally {
            clearTimeout(timer);
            signal.removeEventListener("abort", onCancel);
            stepLease?.release();
            lease?.release();
        }

        keep(buffer, "stdout", buffer.maskers.stdout.end());
        keep(buffer, "stderr", buffer.maskers.stderr.end());
        const finishedAt = commandEnded ?? Date.now();
        const result: MultiExecResult = {
            serverId: target.serverId,
            status,
            exitCode,
            signal: exitSignal,
            error,
            errorCode,
            startedAt,
            finishedAt,
            durationMs: finishedAt - startedAt,
            truncated: buffer.truncated,
            ...(dispatched ? outputHashes(buffer.allStdout, buffer.allStderr, { ...target, hostname }) : { outputHash: null, normalizedHash: null })
        };
        finish(result);
        if (dispatched) await recordEnd(target, entryId, result);
    };

    // Servers still waiting when the run is cancelled end right away.
    const cancelQueued = () => {
        while (queue.length) finish(emptyResult(queue.shift()!.serverId, "cancelled"));
    };
    signal.addEventListener("abort", cancelQueued, { once: true });

    const flushTimer = setInterval(() => {
        for (const serverId of buffers.keys()) flush(serverId);
    }, options.flushIntervalMs ?? 100);
    flushTimer.unref?.();

    const worker = async () => {
        for (let target = queue.shift(); target; target = queue.shift()) {
            const go = options.beforeStart ? await options.beforeStart(target) : true;
            if (signal.aborted) finish(emptyResult(target.serverId, "cancelled"));
            else if (!go) finish(emptyResult(target.serverId, "skipped"));
            else await runOne(target);
        }
    };

    try {
        if (signal.aborted) cancelQueued();
        const workers = Math.max(1, Math.min(options.concurrency, targets.length));
        await Promise.all(Array.from({ length: workers }, worker));
    } finally {
        clearInterval(flushTimer);
        signal.removeEventListener("abort", cancelQueued);
    }

    return targets.map((target) => results.get(target.serverId)!);
}
