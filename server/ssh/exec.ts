import { StringDecoder } from "string_decoder";
import type { Client, ClientChannel } from "ssh2";
import { AppError } from "../errors";
import { createLogger } from "../logger";
import { isChannelRefused, MAX_SPARE_CONNECTIONS, pooledLease, type SshLease } from "./pool";

const log = createLogger("ssh");

// Remote commands on a leased connection. Output is decoded as UTF-8 across
// chunk boundaries, and every command can be bounded by a timeout or an
// AbortSignal that also covers the wait for a channel (a running channel is
// killed and closed). Channels are capped per connection so pooled terminals
// and SFTP keep their slots under the server's MaxSessions (OpenSSH default
// 10): commands queue for one of MAX_EXEC_CHANNELS, while long-lived streams
// (log tails) get their own MAX_STREAM_CHANNELS and never hold commands up.
// A server that refuses the channel anyway (a lower MaxSessions) gets the
// command on a spare pooled connection, like a terminal tab.

export const MAX_EXEC_CHANNELS = 4;
export const MAX_STREAM_CHANNELS = 3;
// What exec() collects at most: a hostile or broken server printing without
// end must not fill the backend's memory (the process serves every session).
export const EXEC_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
// A channel request unanswered this long when its command times out means a
// dead connection (a healthy sshd answers in milliseconds).
const STALLED_OPEN_MS = 5000;

export type ExecResult = {
    stdout: string;
    stderr: string;
    // Exit status, or null when the command ended by a signal.
    code: number | null;
    signal: string | null;
    // Only with `truncateOutput`: the output went past maxOutputBytes and the
    // command was stopped there.
    truncated?: true;
};

export type ExecOptions = {
    // Counted from the call, including the wait for a free channel.
    timeoutMs?: number;
    signal?: AbortSignal;
    // Written to the command's stdin, which is then closed (e.g. a script for
    // `sh -s`). Without it stdin stays open until the channel closes.
    stdin?: string;
    // exec(): bytes of output (stdout and stderr together) collected at most,
    // EXEC_MAX_OUTPUT_BYTES by default. A command printing more is stopped and
    // fails with EXEC_OUTPUT_TOO_LARGE, or with `truncateOutput` resolves with
    // what came before and `truncated: true`. Streams are not capped here:
    // their callers forward the output as it arrives and cap it themselves.
    maxOutputBytes?: number;
    truncateOutput?: boolean;
};

export type ExecStreamOptions = Omit<ExecOptions, "maxOutputBytes" | "truncateOutput"> & {
    // Written to stdin, which stays open (unlike `stdin`): a Windows log
    // stream reads its script there, then watches stdin to notice the
    // channel closing.
    input?: string;
    onData: (text: string) => void;
    onStderr?: (text: string) => void;
    // slice V4b: backpressure. Called once the channel is open with its
    // pause/resume: while paused the SSH window closes and the remote command
    // blocks on write instead of being read (and dropped) at full speed.
    onFlow?: (flow: StreamFlow) => void;
};

export type StreamFlow = { pause: () => void; resume: () => void };

type Leased = { client: Client };

type ChannelOutcome = { code: number | null; signal: string | null; truncated: boolean };

export class ExecTimeoutError extends AppError {
    constructor(command: string, timeoutMs: number) {
        super("EXEC_TIMEOUT", `The command did not finish within ${Math.round(timeoutMs / 1000)}s: ${command.slice(0, 80)}`, 504);
        this.name = "ExecTimeoutError";
    }
}

export class ExecAbortedError extends AppError {
    constructor() {
        super("EXEC_ABORTED", "The command was cancelled", 499);
        this.name = "ExecAbortedError";
    }
}

export class ExecStreamsBusyError extends AppError {
    constructor() {
        super("EXEC_STREAMS_BUSY", `At most ${MAX_STREAM_CHANNELS} live streams can run on one connection; stop one first.`, 429);
        this.name = "ExecStreamsBusyError";
    }
}

export class ExecOutputTooLargeError extends AppError {
    constructor(maxBytes: number) {
        super("EXEC_OUTPUT_TOO_LARGE", `The command printed more than ${Math.round(maxBytes / (1024 * 1024))} MiB of output and was stopped.`, 502, { maxBytes });
        this.name = "ExecOutputTooLargeError";
    }
}

// The server refused the channel on every connection tried.
export class ExecChannelRefusedError extends AppError {
    constructor(cause: Error) {
        super(
            "SSH_CHANNEL_REFUSED",
            `The server refused to open another channel (its sshd MaxSessions limit may be too low): ${cause.message}`,
            503
        );
        this.name = "ExecChannelRefusedError";
    }
}

// FIFO channel slots of one connection. A waiter whose command is cancelled
// leaves the queue, so timeouts and aborts also bound the wait for a slot.
class ChannelLimiter {
    private active = 0;
    private readonly max: number;
    private readonly waiting: Array<() => void> = [];

    constructor(max: number) {
        this.max = max;
    }

    acquire(signal: AbortSignal): Promise<void> {
        if (signal.aborted) return Promise.reject(signal.reason);
        if (this.tryAcquire()) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const grant = () => {
                signal.removeEventListener("abort", cancel);
                this.active += 1;
                resolve();
            };
            const cancel = () => {
                const index = this.waiting.indexOf(grant);
                if (index !== -1) this.waiting.splice(index, 1);
                reject(signal.reason);
            };
            this.waiting.push(grant);
            signal.addEventListener("abort", cancel, { once: true });
        });
    }

    tryAcquire(): boolean {
        if (this.active >= this.max) return false;
        this.active += 1;
        return true;
    }

    release(): void {
        this.active -= 1;
        this.waiting.shift()?.();
    }
}

type Limiters = { command: ChannelLimiter; stream: ChannelLimiter };

const limiters = new WeakMap<Client, Limiters>();

function limitersFor(client: Client): Limiters {
    let entry = limiters.get(client);
    if (!entry) {
        entry = { command: new ChannelLimiter(MAX_EXEC_CHANNELS), stream: new ChannelLimiter(MAX_STREAM_CHANNELS) };
        limiters.set(client, entry);
    }
    return entry;
}

// One signal for both ways a command ends early: its timeout or the caller's
// signal. Its reason is the error the command fails with.
function cancellation(command: string, options: ExecOptions): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const { timeoutMs, signal } = options;
    const onAbort = () => controller.abort(new ExecAbortedError());
    const timer = timeoutMs ? setTimeout(() => controller.abort(new ExecTimeoutError(command, timeoutMs)), timeoutMs) : null;
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    return {
        signal: controller.signal,
        dispose: () => {
            if (timer) clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
    };
}

// `promise`, unless `signal` aborts first; what it delivers late goes to `late`.
function unlessAborted<T>(promise: Promise<T>, signal: AbortSignal, late: (value: T) => void): Promise<T> {
    if (signal.aborted) {
        promise.then(late, () => undefined);
        return Promise.reject(signal.reason);
    }
    return new Promise<T>((resolve, reject) => {
        let done = false;
        const onAbort = () => {
            if (done) return;
            done = true;
            reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        promise.then(
            (value) => {
                signal.removeEventListener("abort", onAbort);
                if (done) late(value);
                else {
                    done = true;
                    resolve(value);
                }
            },
            (err: unknown) => {
                signal.removeEventListener("abort", onAbort);
                if (done) return;
                done = true;
                reject(err);
            }
        );
    });
}

function kill(channel: ClientChannel): void {
    // A paused channel only closes once its buffered output has been read.
    channel.resume();
    channel.stderr.resume();
    try {
        channel.signal("KILL");
    } catch {
        // Not every server supports signals; closing the channel ends the command.
    }
    try {
        channel.close();
    } catch {
        // Already closed.
    }
}

type ChannelIo = {
    onStdout: (text: string) => void;
    onStderr: (text: string) => void;
    stdin?: string;
    // See ExecStreamOptions.input.
    input?: string;
    // Output bytes accepted before the command is stopped (null: no limit),
    // and whether that ends it as a success with what came before.
    maxOutputBytes: number | null;
    truncate: boolean;
    // How long an unanswered channel request makes the connection suspect.
    stalledAfterMs: number;
    // The command was cancelled while its channel request stayed unanswered.
    onOpenStalled: () => void;
    // slice V4b: backpressure, see ExecStreamOptions.onFlow.
    onFlow?: (flow: StreamFlow) => void;
};

function runChannel(client: Client, command: string, cancel: AbortSignal, io: ChannelIo): Promise<ChannelOutcome> {
    return new Promise((resolve, reject) => {
        const stdout = new StringDecoder("utf8");
        const stderr = new StringDecoder("utf8");
        let channel: ClientChannel | null = null;
        let requestedAt = 0;
        let code: number | null = null;
        let exitSignal: string | null = null;
        let failure: Error | null = null;
        let stopping = false;
        // The output limit or a consumer that threw ended the command: what
        // the channel still delivers is dropped. A cancel (timeout, abort, a
        // lost connection) still hands on what was already on its way, as a
        // log stream sends the last lines before reporting the loss.
        let discarding = false;
        let truncated = false;
        let received = 0;
        let settled = false;
        let forceTimer: NodeJS.Timeout | null = null;

        const finish = () => {
            if (settled) return;
            settled = true;
            if (forceTimer) clearTimeout(forceTimer);
            cancel.removeEventListener("abort", onAbort);
            if (!(discarding && failure)) {
                try {
                    const restOut = stdout.end();
                    if (restOut) io.onStdout(restOut);
                    const restErr = stderr.end();
                    if (restErr) io.onStderr(restErr);
                } catch (err) {
                    failure ??= err as Error;
                }
            }
            if (failure) reject(failure);
            else resolve({ code, signal: exitSignal, truncated });
        };
        // Ends the command early, failing with `err` (or, with null, keeping
        // what it printed). A dead connection never confirms the close: give
        // up after a grace period.
        const stop = (err: Error | null) => {
            if (stopping || settled) return;
            stopping = true;
            failure = err;
            if (!channel) {
                if (requestedAt && err instanceof ExecTimeoutError && Date.now() - requestedAt >= io.stalledAfterMs) io.onOpenStalled();
                finish();
                return;
            }
            kill(channel);
            forceTimer = setTimeout(finish, 2000);
        };
        const onAbort = () => stop(cancel.reason as Error);
        if (cancel.aborted) {
            onAbort();
            return;
        }
        cancel.addEventListener("abort", onAbort, { once: true });

        // Counts the raw bytes, so the cap holds whatever the encoding.
        const accept = (chunk: Buffer): boolean => {
            if (discarding) return false;
            if (io.maxOutputBytes !== null && received + chunk.length > io.maxOutputBytes) {
                discarding = true;
                if (io.truncate) {
                    truncated = true;
                    stop(null);
                } else {
                    stop(new ExecOutputTooLargeError(io.maxOutputBytes));
                }
                return false;
            }
            received += chunk.length;
            return true;
        };
        // A consumer that throws fails its command; the error must not reach
        // ssh2's packet parser, which would close the shared connection.
        const deliver = (handler: (text: string) => void, text: string) => {
            if (!text) return;
            try {
                handler(text);
            } catch (err) {
                discarding = true;
                stop(err as Error);
            }
        };

        const onOpen = (err: Error | undefined, opened: ClientChannel) => {
            requestedAt = 0;
            if (err) {
                failure ??= err;
                finish();
                return;
            }
            // Timed out or aborted while the channel was opening.
            if (settled) {
                kill(opened);
                return;
            }
            // Listeners go on synchronously: output, exit status and close
            // can all arrive in the same packet batch as the open confirmation.
            channel = opened;
            opened.on("data", (chunk: Buffer) => {
                if (accept(chunk)) deliver(io.onStdout, stdout.write(chunk));
            });
            opened.stderr.on("data", (chunk: Buffer) => {
                if (accept(chunk)) deliver(io.onStderr, stderr.write(chunk));
            });
            opened.on("exit", (exitCode: number | null, signalName?: string) => {
                code = typeof exitCode === "number" ? exitCode : null;
                exitSignal = signalName ?? null;
            });
            opened.on("error", (channelErr: Error) => stop(channelErr));
            opened.on("close", finish);
            if (io.stdin !== undefined) opened.end(io.stdin);
            else if (io.input) opened.write(io.input);
            io.onFlow?.({
                pause: () => { opened.pause(); opened.stderr.pause(); },
                resume: () => { opened.resume(); opened.stderr.resume(); }
            });
        };

        try {
            requestedAt = Date.now();
            client.exec(command, onOpen);
        } catch (err) {
            requestedAt = 0;
            failure ??= err as Error;
            finish();
        }
    });
}

type RunSettings = {
    kind: keyof Limiters;
    onStdout: (text: string) => void;
    onStderr: (text: string) => void;
    maxOutputBytes: number | null;
    truncate: boolean;
    input?: string;
    onFlow?: (flow: StreamFlow) => void;
};

// The command on one connection, in one of its channel slots.
async function runOn(client: Client, command: string, cancel: AbortSignal, options: ExecOptions, settings: RunSettings, onOpenStalled: () => void): Promise<ChannelOutcome> {
    const limiter = limitersFor(client)[settings.kind];
    if (settings.kind === "command") {
        await limiter.acquire(cancel);
    } else {
        // A stream may run for hours: waiting for one to end is no use.
        if (cancel.aborted) throw cancel.reason as Error;
        if (!limiter.tryAcquire()) throw new ExecStreamsBusyError();
    }
    try {
        return await runChannel(client, command, cancel, {
            onStdout: settings.onStdout,
            onStderr: settings.onStderr,
            stdin: options.stdin,
            input: settings.input,
            maxOutputBytes: settings.maxOutputBytes,
            truncate: settings.truncate,
            stalledAfterMs: Math.min(STALLED_OPEN_MS, (options.timeoutMs ?? STALLED_OPEN_MS) / 2),
            onOpenStalled,
            onFlow: settings.onFlow
        });
    } finally {
        limiter.release();
    }
}

async function run(lease: Leased, command: string, options: ExecOptions, settings: RunSettings): Promise<ChannelOutcome> {
    const cancel = cancellation(command, options);
    const pooled = pooledLease(lease);
    const spares: SshLease[] = [];
    try {
        let current: Leased = lease;
        for (;;) {
            const used = current;
            try {
                return await runOn(used.client, command, cancel.signal, options, settings, () => {
                    // The next user of the server gets a fresh connection.
                    if (!pooled) return;
                    log.warn(`A connection to server #${pooled.lease.serverId} did not open a channel in time; retiring it`);
                    pooled.pool.retireConnection(used as SshLease);
                });
            } catch (err) {
                if (!isChannelRefused(err)) throw err;
                // A refused channel never opened, so nothing ran or printed yet.
                if (!pooled || spares.length >= MAX_SPARE_CONNECTIONS) throw new ExecChannelRefusedError(err as Error);
                log.info(`Server #${pooled.lease.serverId} refused a command channel on a connection; trying another one`);
                const spare = await unlessAborted(pooled.pool.acquireSpare([pooled.lease, ...spares]), cancel.signal, (late) => late.release());
                spares.push(spare);
                current = spare;
            }
        }
    } finally {
        for (const spare of spares) spare.release();
        cancel.dispose();
    }
}

export async function exec(lease: Leased, command: string, options: ExecOptions = {}): Promise<ExecResult> {
    let stdout = "";
    let stderr = "";
    const outcome = await run(lease, command, options, {
        kind: "command",
        onStdout: (text) => { stdout += text; },
        onStderr: (text) => { stderr += text; },
        maxOutputBytes: options.maxOutputBytes ?? EXEC_MAX_OUTPUT_BYTES,
        truncate: options.truncateOutput ?? false
    });
    const result: ExecResult = { stdout, stderr, code: outcome.code, signal: outcome.signal };
    if (outcome.truncated) result.truncated = true;
    return result;
}

// Streams output as it arrives (e.g. `journalctl -f`) until the command ends,
// the timeout fires or the signal aborts it. Fails with ExecStreamsBusyError
// when the connection already runs MAX_STREAM_CHANNELS streams.
export async function execStream(lease: Leased, command: string, options: ExecStreamOptions): Promise<{ code: number | null; signal: string | null }> {
    const { code, signal } = await run(lease, command, options, {
        kind: "stream",
        onStdout: options.onData,
        onStderr: options.onStderr ?? (() => undefined),
        maxOutputBytes: null,
        truncate: false,
        input: options.input,
        onFlow: options.onFlow
    });
    return { code, signal };
}

// stdout (trimmed) of a command that must succeed: a non-zero exit with
// stderr output rejects with that output.
export async function execOutput(lease: Leased, command: string, options: ExecOptions = {}): Promise<string> {
    const result = await exec(lease, command, options);
    if (result.code !== null && result.code !== 0 && result.stderr.trim()) throw new Error(result.stderr.trim());
    return result.stdout.trim();
}

// Tolerant variant: "" instead of an error, so one unsupported command (e.g.
// on busybox) degrades a single value instead of failing a whole report.
export async function execOutputSafe(lease: Leased, command: string, options: ExecOptions = {}): Promise<string> {
    try {
        return await execOutput(lease, command, options);
    } catch {
        return "";
    }
}

// Like exec(), but hands the output over as it arrives instead of collecting
// it, so the caller can forward and cap it (multi-exec). It queues for a
// command channel like exec(), not for a stream slot.
export async function execCommandStream(lease: Leased, command: string, options: ExecStreamOptions): Promise<{ code: number | null; signal: string | null }> {
    const { code, signal } = await run(lease, command, options, {
        kind: "command",
        onStdout: options.onData,
        onStderr: options.onStderr ?? (() => undefined),
        maxOutputBytes: null,
        truncate: false,
        input: options.input
    });
    return { code, signal };
}
