import {
    LOG_STREAM_ID_PATTERN,
    MAX_LOG_STREAMS_PER_SOCKET,
    type LogChunkPayload,
    type LogErrorPayload,
    type LogStreamSource
} from "../../shared/ops";
import type { ConnectionCause } from "../../shared/terminal";
import { loadConnectionTarget } from "../connections/target";
import { AppError, errorMessage } from "../errors";
import { streamPodLogs } from "../k8s/logs";
import { createLogger } from "../logger";
import { getCapabilities } from "../ops/capabilities";
import { composeLogStream, logStreamCommand, parseLogSource } from "../ops/logs";
import { createClixmlFilter, type TextFilter } from "../ops/remote";
import { sshFailure } from "../ssh/connectionErrors";
import { execStream, type StreamFlow } from "../ssh/exec";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { sshPool, type SshLease } from "../ssh/pool";
import type { SocketSession } from "./session";

const log = createLogger("logs");

// Live log tails (journalctl -f, tail -F, docker logs -f) of saved servers.
// Each stream leases the server's pooled connection and runs one stream
// channel until the client stops it, the socket disconnects or the
// connection drops. Output is batched, and the next batch waits for the
// client's acknowledgement. While the client lags behind, the remote command
// is paused (the SSH window closes and it blocks on write) instead of being
// read at full speed and thrown away; what still arrives beyond the cap (the
// window already in flight) is dropped, oldest first, and counted.

const FLUSH_INTERVAL_MS = 100;
const MAX_BATCH_CHARS = 64 * 1024;
// Unsent output that pauses the remote command, and the level it resumes at.
export const PAUSE_PENDING_CHARS = 256 * 1024;
export const RESUME_PENDING_CHARS = 64 * 1024;
// Above this the oldest whole chunks go: a resumed channel hands over the
// window it buffered (up to a few MB) at once.
export const MAX_PENDING_CHARS = 1024 * 1024;
const MAX_UNACKED_BATCHES = 2;
const ACK_TIMEOUT_MS = 10_000;

type Batcher = {
    push: (text: string) => void;
    flush: () => void;
    // Sends everything still pending now, acknowledged or not (the stream
    // ended: at most MAX_PENDING_CHARS are left).
    flushAll: () => void;
    // The source to pause while the client lags behind (the stream's channel).
    attach: (flow: StreamFlow) => void;
    // Lets a paused source run (and close) again and never pauses it after,
    // keeping what is pending for flushAll (the connection dropped: its last
    // output still goes to the client).
    release: () => void;
    // Stops sending, discards what is pending and releases the source.
    dispose: () => void;
};

export function createBatcher(send: (chunk: Omit<LogChunkPayload, "id">, done: () => void) => void): Batcher {
    // Unsent output as received, from `head` on (`offset` chars of the head
    // chunk are already sent). Chunks are never concatenated or re-sliced as
    // a whole: dropping and sending are proportional to what goes.
    let chunks: string[] = [];
    let head = 0;
    let offset = 0;
    let pendingChars = 0;
    let dropped = 0;
    let unacked = 0;
    let timer: NodeJS.Timeout | null = null;
    let disposed = false;
    let flushing = false;
    let flow: StreamFlow | null = null;
    let paused = false;
    let released = false;

    const setPaused = (value: boolean) => {
        if (paused === value) return;
        paused = value;
        if (value) flow?.pause();
        else flow?.resume();
    };
    const updatePressure = () => {
        if (pendingChars >= PAUSE_PENDING_CHARS) setPaused(!released);
        else if (pendingChars <= RESUME_PENDING_CHARS) setPaused(false);
    };
    const release = () => {
        released = true;
        setPaused(false);
    };

    // Lets go of the chunks before `head` (sent or dropped) once they are
    // the larger part of the array.
    const compact = () => {
        if (head > 64 && head * 2 > chunks.length) {
            chunks = chunks.slice(head);
            head = 0;
        }
    };

    const take = (max: number): string => {
        let data = "";
        while (head < chunks.length && data.length < max) {
            const chunk = chunks[head];
            const part = chunk.slice(offset, offset + max - data.length);
            data += part;
            offset += part.length;
            if (offset >= chunk.length) {
                head += 1;
                offset = 0;
            }
        }
        pendingChars -= data.length;
        compact();
        return data;
    };

    const dropOldest = () => {
        while (pendingChars > MAX_PENDING_CHARS && chunks.length - head > 1) {
            const gone = chunks[head].length - offset;
            dropped += gone;
            pendingChars -= gone;
            head += 1;
            offset = 0;
        }
        // A single chunk larger than the cap keeps its end.
        if (pendingChars > MAX_PENDING_CHARS) {
            const gone = pendingChars - MAX_PENDING_CHARS;
            dropped += gone;
            pendingChars -= gone;
            offset += gone;
        }
        compact();
    };

    const flush = (all = false) => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        if (flushing) return;
        flushing = true;
        try {
            while (!disposed && (pendingChars > 0 || dropped > 0) && (all || unacked < MAX_UNACKED_BATCHES)) {
                const data = take(MAX_BATCH_CHARS);
                const chunk = dropped ? { data, dropped } : { data };
                dropped = 0;
                unacked += 1;
                let settled = false;
                send(chunk, () => {
                    if (settled) return;
                    settled = true;
                    unacked -= 1;
                    // A backlog goes out at the client's pace; a trickle is still coalesced.
                    if (pendingChars >= MAX_BATCH_CHARS) flush();
                    else if (pendingChars > 0 || dropped > 0) schedule();
                });
            }
        } finally {
            flushing = false;
        }
        updatePressure();
    };
    const schedule = () => {
        if (!timer && !disposed) timer = setTimeout(flush, FLUSH_INTERVAL_MS);
    };

    return {
        push: (text) => {
            if (disposed || !text) return;
            chunks.push(text);
            pendingChars += text.length;
            if (pendingChars > MAX_PENDING_CHARS) dropOldest();
            updatePressure();
            schedule();
        },
        flush: () => flush(),
        flushAll: () => flush(true),
        attach: (source) => {
            flow = source;
            if (paused) source.pause();
        },
        release,
        dispose: () => {
            disposed = true;
            if (timer) clearTimeout(timer);
            timer = null;
            chunks = [];
            head = 0;
            offset = 0;
            pendingChars = 0;
            release();
        }
    };
}

function streamError(err: unknown): Omit<LogErrorPayload, "id"> {
    if (err instanceof AppError) return { code: err.code, message: err.message };
    if (err instanceof HostKeyMismatchError) return { code: err.code, message: err.message };
    const { message, connection } = sshFailure(err);
    return { code: "SSH_FAILED", message: message || errorMessage(err), ...(connection ? { connection } : {}) };
}

export function registerLogHandlers(session: SocketSession): void {
    const { socket } = session;
    const streams = new Map<string, AbortController>();

    const fail = (id: string, code: string, message: string, connection?: ConnectionCause) =>
        socket.emit("logs-error", connection ? { id, code, message, connection } : { id, code, message });

    const start = async (id: string, serverId: unknown, source: LogStreamSource) => {
        const controller = new AbortController();
        streams.set(id, controller);
        const { signal } = controller;
        // Stopped while connecting: end quietly.
        const stillWanted = () => {
            if (signal.aborted) throw new Error("stopped");
        };
        let lease: SshLease | null = null;
        let batcher: Batcher | null = null;
        let stderr: TextFilter | null = null;
        let connectionLost = false;
        const send = (chunk: Omit<LogChunkPayload, "id">, done: () => void) => {
            socket.timeout(ACK_TIMEOUT_MS).emit("logs-chunk", { id, ...chunk }, () => done());
        };
        try {
            // W8-T2: a pod's logs come from kubectl, on the server or (a local
            // kubectl server) on this machine; batched and acknowledged alike.
            if (source.kind === "pod") {
                const stream = batcher = createBatcher(send);
                signal.addEventListener("abort", () => (connectionLost ? stream.release() : stream.dispose()), { once: true });
                const code = await streamPodLogs(serverId, source, {
                    signal,
                    push: stream.push,
                    attach: stream.attach,
                    onStarted: () => socket.emit("logs-started", { id }),
                    onConnectionLost: () => {
                        connectionLost = true;
                        controller.abort();
                    }
                });
                stream.flushAll();
                if (connectionLost) fail(id, "SSH_CLOSED", "The connection to the server was lost.");
                else socket.emit("logs-end", { id, code });
                return;
            }
            const target = await loadConnectionTarget(serverId, "exec");
            stillWanted();
            lease = await sshPool.acquire(target.serverId);
            stillWanted();
            lease.onClose(() => {
                connectionLost = true;
                controller.abort();
            });
            const caps = await getCapabilities(lease, target.os, { signal });
            // W7-S3: a Compose project's logs need its files looked up first.
            const { command, input } = source.kind === "compose" ? { command: await composeLogStream(lease, caps, source, signal), input: undefined } : logStreamCommand(caps, source);
            stillWanted();

            const stream = batcher = createBatcher(send);
            // Linux streams merge stderr into stdout; PowerShell's own stderr is
            // CLIXML under the -EncodedCommand fallback.
            stderr = caps.platform === "windows" ? createClixmlFilter(stream.push) : { write: stream.push, end: () => {} };
            // Ending must not wait for the client: a paused channel only
            // closes once it runs again. A stop discards what is pending; a
            // lost connection keeps it, to send it before SSH_CLOSED (the
            // last lines before a server drops or reboots).
            signal.addEventListener("abort", () => (connectionLost ? stream.release() : stream.dispose()), { once: true });
            socket.emit("logs-started", { id });
            log.debug(`Stream ${id} on server #${target.serverId}: ${source.kind}`);
            const result = await execStream(lease, command, { input, onData: stream.push, onStderr: stderr.write, signal, onFlow: stream.attach });
            stderr.end();
            stderr = null;
            stream.flushAll();
            if (connectionLost) fail(id, "SSH_CLOSED", "The connection to the server was lost.");
            else socket.emit("logs-end", { id, code: result.code });
        } catch (err) {
            // A lost connection still delivers what it had, a held-back
            // PowerShell error record included.
            if (connectionLost) stderr?.end();
            batcher?.flushAll();
            if (connectionLost) {
                fail(id, "SSH_CLOSED", "The connection to the server was lost.");
            } else if (signal.aborted) {
                socket.emit("logs-end", { id, code: null });
            } else {
                const { code, message, connection } = streamError(err);
                if (!(err instanceof AppError)) log.warn(`Log stream ${id} failed: ${message}`);
                fail(id, code, message, connection);
            }
        } finally {
            batcher?.dispose();
            if (streams.get(id) === controller) streams.delete(id);
            lease?.release();
        }
    };

    socket.on("logs-start", (payload) => {
        const id = typeof payload?.id === "string" ? payload.id : "";
        if (!LOG_STREAM_ID_PATTERN.test(id)) {
            fail(id.slice(0, 40), "OPS_INVALID_INPUT", "Invalid stream id.");
            return;
        }
        if (streams.has(id)) {
            fail(id, "OPS_INVALID_INPUT", "This stream is already running.");
            return;
        }
        if (streams.size >= MAX_LOG_STREAMS_PER_SOCKET) {
            fail(id, "LOGS_LIMIT", `At most ${MAX_LOG_STREAMS_PER_SOCKET} log streams can run at once; stop one first.`);
            return;
        }
        let source: LogStreamSource;
        try {
            source = parseLogSource(payload.source);
        } catch (err) {
            fail(id, "OPS_INVALID_INPUT", errorMessage(err));
            return;
        }
        start(id, payload.serverId, source).catch((err) => log.error("Log stream crashed:", err));
    });

    socket.on("logs-stop", (payload) => {
        const id = typeof payload?.id === "string" ? payload.id : "";
        streams.get(id)?.abort();
    });

    socket.on("disconnect", () => {
        for (const controller of streams.values()) controller.abort();
        streams.clear();
    });
}
