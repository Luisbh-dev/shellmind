import { randomUUID } from "crypto";
import {
    DOWNLOAD_WINDOW,
    FILE_CHUNK_BYTES,
    TRANSFER_IDLE_MS,
    type DownloadChunk,
    type DownloadEnd,
    type DownloadFailure,
    type UploadChunkResult,
    type UploadEndResult
} from "../../shared/files";
import { FsError, toFileError, type DownloadSource, type UploadSink } from "./remoteFs";

// Transfers of one socket session. The server gives up on a transfer that saw
// no progress for twice the client's idle limit (the client went away).
const SERVER_IDLE_MS = TRANSFER_IDLE_MS * 2;
const MAX_TRANSFERS = 8;
const ABORT_GRACE_MS = 5000;

export class UploadTransfer {
    readonly id = randomUUID();
    private nextSeq = 0;
    private received = 0;
    private finished = false;
    private idleTimer: NodeJS.Timeout | null = null;

    constructor(readonly path: string, readonly size: number, private readonly sink: UploadSink, private readonly onIdle: (transfer: UploadTransfer) => void) {
        this.touch();
    }

    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.onIdle(this), SERVER_IDLE_MS);
        this.idleTimer.unref();
    }

    private stopTimer(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
    }

    // Chunks arrive in order (one socket); several may be in flight. A chunk
    // is acknowledged once it was written, so its error reaches the client.
    async chunk(seq: number, data: Buffer): Promise<UploadChunkResult> {
        if (this.finished) throw new FsError("INVALID", "The upload is already finished");
        this.touch();
        if (seq !== this.nextSeq) throw new FsError("INVALID", `Chunk ${seq} arrived out of order (expected ${this.nextSeq})`);
        if (this.received + data.length > this.size) throw new FsError("INVALID", "The upload is larger than announced");
        this.nextSeq += 1;
        this.received += data.length;
        await this.sink.write(data);
        this.touch();
        return { seq, received: this.received };
    }

    async end(): Promise<UploadEndResult> {
        if (this.finished) throw new FsError("INVALID", "The upload is already finished");
        this.finished = true;
        this.stopTimer();
        if (this.received !== this.size) {
            await this.sink.abort();
            throw new FsError("INVALID", `The upload is incomplete (${this.received} of ${this.size} bytes)`);
        }
        try {
            await this.sink.commit();
        } catch (err) {
            await this.sink.abort();
            throw err;
        }
        return { path: this.path, size: this.received };
    }

    async abort(): Promise<void> {
        this.finished = true;
        this.stopTimer();
        await this.sink.abort();
    }
}

export type DownloadEmitter = {
    chunk: (chunk: DownloadChunk) => void;
    end: (end: DownloadEnd) => void;
    error: (failure: DownloadFailure) => void;
};

// Pushes a file in chunks of FILE_CHUNK_BYTES, keeping at most `window`
// chunks unacknowledged: the source is paused until the client catches up.
export class DownloadTransfer {
    readonly id = randomUUID();
    private seq = 0;
    private acked = -1;
    private bytes = 0;
    private frame: Buffer[] = [];
    private frameBytes = 0;
    private finished = false;
    private started = false;
    private earlyError: unknown = null;
    private idleTimer: NodeJS.Timeout | null = null;

    constructor(
        private readonly source: DownloadSource,
        private readonly emit: DownloadEmitter,
        private readonly onDone: (transfer: DownloadTransfer) => void,
        readonly window = DOWNLOAD_WINDOW
    ) {
        // Listening right away: an error before start() must not go unhandled.
        source.stream.on("error", (err: Error) => {
            if (this.started) this.fail(err);
            else this.earlyError ??= err;
        });
    }

    get size(): number | null {
        return this.source.size;
    }

    // Starts pushing data; call it once the client knows the transfer id.
    start(): void {
        if (this.started || this.finished) return;
        this.started = true;
        if (this.earlyError) {
            this.fail(this.earlyError);
            return;
        }
        const { stream } = this.source;
        stream.on("data", (chunk: Buffer) => this.onData(chunk));
        stream.once("end", () => {
            if (this.finished) return;
            this.flushFrame();
            this.finish();
            this.emit.end({ transferId: this.id, bytes: this.bytes });
        });
        this.touch();
    }

    private touch(): void {
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.fail(new FsError("TIMEOUT", "The download stalled")), SERVER_IDLE_MS);
        this.idleTimer.unref();
    }

    private onData(chunk: Buffer): void {
        if (this.finished) return;
        this.touch();
        this.frame.push(chunk);
        this.frameBytes += chunk.length;
        while (this.frameBytes >= FILE_CHUNK_BYTES) {
            const joined = Buffer.concat(this.frame, this.frameBytes);
            this.frame = [joined.subarray(FILE_CHUNK_BYTES)];
            this.frameBytes = joined.length - FILE_CHUNK_BYTES;
            this.send(joined.subarray(0, FILE_CHUNK_BYTES));
        }
    }

    private flushFrame(): void {
        if (!this.frameBytes) return;
        this.send(Buffer.concat(this.frame, this.frameBytes));
        this.frame = [];
        this.frameBytes = 0;
    }

    private send(data: Buffer): void {
        this.bytes += data.length;
        this.emit.chunk({ transferId: this.id, seq: this.seq, data });
        this.seq += 1;
        if (this.inflight() >= this.window) this.source.stream.pause();
    }

    private inflight(): number {
        return this.seq - this.acked - 1;
    }

    ack(seq: number): void {
        if (this.finished || !Number.isInteger(seq) || seq <= this.acked || seq >= this.seq) return;
        this.acked = seq;
        this.touch();
        if (this.inflight() < this.window) this.source.stream.resume();
    }

    private finish(): void {
        this.finished = true;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.onDone(this);
    }

    private fail(err: unknown): void {
        if (this.finished) return;
        this.finish();
        this.source.stream.destroy();
        this.emit.error({ transferId: this.id, error: toFileError(err) });
    }

    cancel(): void {
        if (this.finished) return;
        this.finish();
        this.source.stream.destroy();
    }
}

export class TransferRegistry {
    private readonly uploads = new Map<string, UploadTransfer>();
    private readonly downloads = new Map<string, DownloadTransfer>();

    // Checked before the remote sink is opened: a refused upload must not
    // leave a temporary file (or an open handle) behind.
    canUpload(): void {
        if (this.uploads.size >= MAX_TRANSFERS) throw new FsError("FAILED", "Too many uploads in progress");
    }

    addUpload(path: string, size: number, sink: UploadSink): UploadTransfer {
        this.canUpload();
        const transfer = new UploadTransfer(path, size, sink, (idle) => {
            this.uploads.delete(idle.id);
            void idle.abort();
        });
        this.uploads.set(transfer.id, transfer);
        return transfer;
    }

    upload(id: unknown): UploadTransfer {
        const transfer = typeof id === "string" ? this.uploads.get(id) : undefined;
        if (!transfer) throw new FsError("NOT_FOUND", "No such upload (it was cancelled or timed out)");
        return transfer;
    }

    takeUpload(id: unknown): UploadTransfer | undefined {
        const transfer = typeof id === "string" ? this.uploads.get(id) : undefined;
        if (transfer) this.uploads.delete(transfer.id);
        return transfer;
    }

    canDownload(): void {
        if (this.downloads.size >= MAX_TRANSFERS) throw new FsError("FAILED", "Too many downloads in progress");
    }

    addDownload(source: DownloadSource, emit: DownloadEmitter): DownloadTransfer {
        const transfer = new DownloadTransfer(source, emit, (done) => this.downloads.delete(done.id));
        this.downloads.set(transfer.id, transfer);
        return transfer;
    }

    download(id: unknown): DownloadTransfer | undefined {
        return typeof id === "string" ? this.downloads.get(id) : undefined;
    }

    get active(): boolean {
        return this.uploads.size + this.downloads.size > 0;
    }

    // The session's connection is going away: nothing can finish any more.
    // Resolves once partial uploads were removed (or after a few seconds).
    abortAll(): Promise<void> {
        const aborts = [...this.uploads.values()].map((upload) => upload.abort().catch(() => undefined));
        for (const download of this.downloads.values()) download.cancel();
        this.uploads.clear();
        this.downloads.clear();
        if (!aborts.length) return Promise.resolve();
        return new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, ABORT_GRACE_MS);
            timer.unref();
            void Promise.all(aborts).then(() => {
                clearTimeout(timer);
                resolve();
            });
        });
    }
}
