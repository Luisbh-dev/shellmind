// Terminal output on its way to the browser, as bytes (binary socket.io
// frames: no JSON escaping, and xterm decodes UTF-8 itself). Programs print in
// many small pieces (one SSH packet or PTY read each), so output that keeps
// coming is batched (one message per ~16 ms, or per 64 KiB), while a piece
// after a quiet moment (a keystroke's echo, a prompt) goes out right away.
// Output is also flow-controlled: the client acknowledges what xterm has
// written ("ssh-ack", in bytes) and the program is paused while too much is
// unacknowledged, so a flood (`yes`, `cat huge.log`) can neither fill the
// backend's memory nor bury Ctrl+C under megabytes of queued output.

export const TERMINAL_OUTPUT_DEFAULTS = {
    flushMs: 16,
    maxBatchBytes: 64 * 1024,
    // Pause the program above this many unacknowledged bytes...
    highWaterBytes: 128 * 1024,
    // ...and resume it once the client is back under this many.
    lowWaterBytes: 32 * 1024
};

export type TerminalOutputOptions = Partial<typeof TERMINAL_OUTPUT_DEFAULTS>;

// The program producing the output (SSH channel, PTY, child process).
export interface OutputSource {
    pause(): void;
    resume(): void;
    // Drops the output the source received but has not handed over yet
    // (held back while paused); returns how many bytes that was.
    discard?(): number;
}

const EMPTY = Buffer.alloc(0);

export class TerminalOutput {
    private readonly options: typeof TERMINAL_OUTPUT_DEFAULTS;
    private parts: Buffer[] = [];
    private size = 0;
    private timer: NodeJS.Timeout | null = null;
    private immediate: NodeJS.Immediate | null = null;
    private lastFlush = Number.NEGATIVE_INFINITY;
    private unacked = 0;
    // Off until the client acknowledges for the first time: a client that
    // never does (an old one, a test) is simply not throttled.
    private acking = false;
    private paused = false;
    private disposed = false;
    private readonly sources = new Set<OutputSource>();

    constructor(private readonly send: (data: Buffer) => void, options: TerminalOutputOptions = {}) {
        this.options = { ...TERMINAL_OUTPUT_DEFAULTS, ...options };
    }

    // Registers the program to pause while the client lags behind; returns
    // the function that unregisters it.
    attach(source: OutputSource): () => void {
        this.sources.add(source);
        if (this.paused) source.pause();
        return () => {
            this.sources.delete(source);
        };
    }

    write(data: Buffer | string): void {
        if (this.disposed) return;
        const chunk = typeof data === "string" ? Buffer.from(data, "utf8") : data;
        if (chunk.length === 0) return;
        this.parts.push(chunk);
        this.size += chunk.length;
        if (this.size >= this.options.maxBatchBytes) {
            this.flush();
        } else if (!this.timer && !this.immediate) {
            // After a quiet moment the next turn of the event loop sends it
            // (still one message for the pieces of one read); output that
            // keeps streaming waits for the batch timer.
            if (performance.now() - this.lastFlush >= this.options.flushMs) this.immediate = setImmediate(() => this.flush());
            else this.timer = setTimeout(() => this.flush(), this.options.flushMs);
        }
    }

    // Sends what is buffered now (before a state event such as "ssh-closed",
    // so it arrives after the output that led to it).
    flush(): void {
        this.cancelScheduled();
        if (this.disposed || this.size === 0) return;
        const data = this.parts.length === 1 ? this.parts[0] : Buffer.concat(this.parts, this.size);
        this.parts = [];
        this.size = 0;
        this.lastFlush = performance.now();
        this.send(data);
        this.unacked += data.length;
        this.updateFlow();
    }

    // The client has written `bytes` more bytes.
    ack(bytes: unknown): void {
        if (this.disposed || typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return;
        this.acking = true;
        this.unacked = Math.max(0, this.unacked - bytes);
        this.updateFlow();
    }

    // The user interrupted the program (Ctrl+C) while it was paused for a
    // lagging client: what it printed before and the backend still holds is
    // dropped, so its prompt shows up without first drawing megabytes of
    // stale output. Returns the bytes dropped (0 when not paused).
    interrupt(): number {
        if (this.disposed || !this.paused) return 0;
        this.cancelScheduled();
        let dropped = this.size;
        this.parts = [];
        this.size = 0;
        for (const source of this.sources) dropped += source.discard?.() ?? 0;
        return dropped;
    }

    get pendingBytes(): number {
        return this.unacked;
    }

    get isPaused(): boolean {
        return this.paused;
    }

    dispose(): void {
        this.cancelScheduled();
        this.parts = [];
        this.size = 0;
        this.disposed = true;
        this.sources.clear();
    }

    private cancelScheduled(): void {
        if (this.timer) clearTimeout(this.timer);
        if (this.immediate) clearImmediate(this.immediate);
        this.timer = null;
        this.immediate = null;
    }

    private updateFlow(): void {
        if (!this.acking) return;
        if (!this.paused && this.unacked >= this.options.highWaterBytes) {
            this.paused = true;
            for (const source of this.sources) source.pause();
        } else if (this.paused && this.unacked <= this.options.lowWaterBytes) {
            this.paused = false;
            for (const source of this.sources) source.resume();
        }
    }
}

// Length of `data` without a UTF-8 character cut off at its end.
function completeLength(data: Buffer): number {
    // The lead byte of the last character is at most 3 bytes back.
    for (let index = data.length - 1; index >= 0 && index >= data.length - 4; index--) {
        const byte = data[index];
        if ((byte & 0xc0) === 0x80) continue;
        const length = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
        return data.length - index >= length ? data.length : index;
    }
    // Not UTF-8 (more continuation bytes than any character has): as is.
    return data.length;
}

// Holds back the bytes of a UTF-8 character split across two chunks of one
// stream until the rest arrives, so what is written out never ends inside a
// character (a shell's stdout and stderr interleave in the terminal).
export class Utf8Boundary {
    private rest: Buffer | null = null;

    push(chunk: Buffer): Buffer {
        const data = this.rest ? Buffer.concat([this.rest, chunk]) : chunk;
        this.rest = null;
        const complete = completeLength(data);
        if (complete === data.length) return data;
        this.rest = data.subarray(complete);
        return data.subarray(0, complete);
    }

    end(): Buffer {
        const rest = this.rest ?? EMPTY;
        this.rest = null;
        return rest;
    }
}
