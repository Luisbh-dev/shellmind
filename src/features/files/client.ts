// Typed client of the file manager protocol (shared/files.ts) on one socket:
// requests answered through acknowledgements, uploads with several chunks in
// flight and downloads streamed into a sink (a file on disk or a Blob, see
// saveTarget.ts). Transfers have no overall time limit, only an idle one: a
// transfer fails when nothing moved for a while.
import {
    TRANSFER_IDLE_MS,
    type CountResult,
    type DeleteResult,
    type DownloadStartResult,
    type DownloadChunk,
    type DownloadEnd,
    type DownloadFailure,
    type FileError,
    type FileErrorCode,
    type FileFailure,
    type FileItemRef,
    type FileResult,
    type FileSessionInfo,
    type FileStat,
    type FileVersion,
    type ListResult,
    type ReadResult,
    type StatResult,
    type UploadChunkResult,
    type UploadEndResult,
    type UploadStartResult,
    type WriteResult
} from '@shared/files';
import type { AppSocket } from '@/lib/socket';
import { t } from '@/i18n';

const REQUEST_TIMEOUT_MS = 60_000;
// Listing a huge S3 prefix takes many pages; deleting a tree takes as long as it takes.
const LIST_TIMEOUT_MS = 180_000;
const DELETE_TIMEOUT_MS = 30 * 60_000;
// Finishing an upload may mean completing a large multipart upload; an editor
// save of several MB over a slow link takes a while too.
const UPLOAD_END_TIMEOUT_MS = 5 * 60_000;
// Chunks that arrive before their download is registered (socket.io may
// deliver them in the same batch as the start reply) are kept this long.
const EARLY_EVENT_MS = 10_000;

export class FileClientError extends Error {
    readonly code: FileErrorCode;
    readonly current?: FileStat | null;
    readonly failures?: FileFailure[];
    readonly failureCount?: number;

    constructor(error: FileError) {
        super(error.message);
        this.name = 'FileClientError';
        this.code = error.code;
        if ('current' in error) this.current = error.current;
        if (error.failures) this.failures = error.failures;
        if (error.failureCount !== undefined) this.failureCount = error.failureCount;
    }
}

export function isFileClientError(error: unknown, code?: FileErrorCode): error is FileClientError {
    return error instanceof FileClientError && (code === undefined || error.code === code);
}

// Failures noticed by the client itself carry a message in the UI language
// (the server's own messages are English details).
const cancelledError = () => new FileClientError({ code: 'CANCELLED', message: t('files.errors.CANCELLED') });

// socket.io rejects a timed-out acknowledgement with a plain Error, and one
// whose socket went away with "socket has been disconnected".
function toClientError(error: unknown): FileClientError {
    if (error instanceof FileClientError) return error;
    const message = error instanceof Error ? error.message : String(error);
    if (/timed out/i.test(message)) return new FileClientError({ code: 'TIMEOUT', message: t('files.client.noAnswer') });
    if (/disconnected/i.test(message)) return new FileClientError({ code: 'NOT_CONNECTED', message: t('files.client.connectionLost') });
    return new FileClientError({ code: 'FAILED', message });
}

async function unwrap<T>(pending: Promise<FileResult<T>>): Promise<T> {
    let result: FileResult<T>;
    try {
        result = await pending;
    } catch (error) {
        throw toClientError(error);
    }
    if (!result.ok) throw new FileClientError(result.error);
    return result.data;
}

export type UploadOptions = {
    overwrite: boolean;
    // Accept overwriting the target in place (see NOT_ATOMIC).
    inPlace?: boolean;
    signal?: AbortSignal;
    // Bytes the server has written so far.
    onProgress?: (sent: number) => void;
};

// Where the bytes of a download go, in order. A chunk is acknowledged only
// once write() resolved, so a slow disk holds the server back instead of
// piling chunks up in memory.
export interface DownloadSink {
    write(chunk: Uint8Array<ArrayBuffer>): Promise<void>;
    // Everything was written.
    close(): Promise<void>;
    // The download failed or was cancelled: drop what was written; never rejects.
    abort(): Promise<void>;
}

export type DownloadOptions = {
    sink: DownloadSink;
    signal?: AbortSignal;
    // Bytes stored so far.
    onProgress?: (stored: number, size: number | null) => void;
};

type DownloadListener = {
    chunk: (chunk: DownloadChunk) => void;
    end: (end: DownloadEnd) => void;
    error: (failure: DownloadFailure) => void;
};

type EarlyEvent =
    | { type: 'chunk'; payload: DownloadChunk }
    | { type: 'end'; payload: DownloadEnd }
    | { type: 'error'; payload: DownloadFailure };

export class FileClient {
    private readonly downloads = new Map<string, DownloadListener>();
    private readonly early = new Map<string, { events: EarlyEvent[]; timer: ReturnType<typeof setTimeout> }>();

    constructor(private readonly socket: AppSocket) {
        socket.on('files-download-chunk', this.onChunk);
        socket.on('files-download-end', this.onEnd);
        socket.on('files-download-error', this.onError);
    }

    dispose(): void {
        this.socket.off('files-download-chunk', this.onChunk);
        this.socket.off('files-download-end', this.onEnd);
        this.socket.off('files-download-error', this.onError);
        for (const pending of this.early.values()) clearTimeout(pending.timer);
        this.early.clear();
    }

    session(): Promise<FileSessionInfo> {
        return unwrap(this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-session'));
    }

    list(path: string): Promise<ListResult> {
        return unwrap(this.socket.timeout(LIST_TIMEOUT_MS).emitWithAck('files-list', { path }));
    }

    stat(path: string): Promise<StatResult> {
        return unwrap(this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-stat', { path }));
    }

    read(path: string, maxBytes?: number): Promise<ReadResult> {
        return unwrap(this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-read', { path, maxBytes }));
    }

    write(path: string, data: Uint8Array, expected: FileVersion | null | undefined, force = false): Promise<WriteResult> {
        return unwrap(this.socket.timeout(UPLOAD_END_TIMEOUT_MS).emitWithAck('files-write', { path, data, expected, force }));
    }

    mkdir(path: string): Promise<{ path: string }> {
        return unwrap(this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-mkdir', { path }));
    }

    rename(from: string, to: string, isDir: boolean): Promise<{ from: string; to: string }> {
        return unwrap(this.socket.timeout(DELETE_TIMEOUT_MS).emitWithAck('files-rename', { from, to, isDir }));
    }

    remove(items: FileItemRef[]): Promise<DeleteResult> {
        return unwrap(this.socket.timeout(DELETE_TIMEOUT_MS).emitWithAck('files-delete', { items }));
    }

    count(items: FileItemRef[]): Promise<CountResult> {
        return unwrap(this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-count', { items }));
    }

    // Sends a file in chunks, keeping `window` of them in flight; each one is
    // acknowledged once the server wrote it.
    async upload(file: Blob, path: string, options: UploadOptions): Promise<UploadEndResult> {
        const { signal } = options;
        if (signal?.aborted) throw cancelledError();
        const { transferId, chunkSize, window } = await unwrap<UploadStartResult>(
            this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-upload-start', { path, size: file.size, overwrite: options.overwrite, inPlace: options.inPlace })
        );
        const cancel = () => {
            void this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-upload-cancel', { transferId }).catch(() => undefined);
        };
        // Cancelled while the server was opening the upload: the listener
        // below comes too late for that, so look at the signal itself.
        let aborted = signal?.aborted ?? false;
        const onAbort = () => {
            aborted = true;
            cancel();
        };
        if (aborted) cancel();
        else signal?.addEventListener('abort', onAbort, { once: true });
        try {
            const inflight = new Set<Promise<void>>();
            let failure: unknown = null;
            for (let offset = 0, seq = 0; offset < file.size; offset += chunkSize, seq += 1) {
                if (failure) throw failure;
                if (aborted) throw cancelledError();
                const data = await file.slice(offset, offset + chunkSize).arrayBuffer();
                const sent = unwrap<UploadChunkResult>(this.socket.timeout(TRANSFER_IDLE_MS).emitWithAck('files-upload-chunk', { transferId, seq, data }))
                    .then((ack) => options.onProgress?.(ack.received), (error: unknown) => { failure ??= error; });
                inflight.add(sent);
                void sent.finally(() => inflight.delete(sent));
                if (inflight.size >= window) await Promise.race(inflight);
            }
            await Promise.all(inflight);
            if (failure) throw failure;
            if (aborted) throw cancelledError();
            return await unwrap(this.socket.timeout(UPLOAD_END_TIMEOUT_MS).emitWithAck('files-upload-end', { transferId }));
        } catch (error) {
            // The server drops a failed upload itself; telling it again is harmless.
            if (!aborted) cancel();
            throw aborted ? cancelledError() : toClientError(error);
        } finally {
            signal?.removeEventListener('abort', onAbort);
        }
    }

    // Receives a file as acknowledged chunks into `options.sink` and resolves
    // with its size once the sink is closed. On failure or cancel the sink is
    // aborted.
    async download(path: string, options: DownloadOptions): Promise<number> {
        const { signal, sink } = options;
        let started: DownloadStartResult;
        try {
            if (signal?.aborted) throw cancelledError();
            started = await unwrap<DownloadStartResult>(this.socket.timeout(REQUEST_TIMEOUT_MS).emitWithAck('files-download-start', { path }));
        } catch (error) {
            // Cancelled, or refused (missing file, no free connection...)
            // before anything came: the sink may already be a file on disk
            // (the browser's swap file next to the target), so drop it too.
            await sink.abort();
            throw error;
        }
        const { transferId, size } = started;
        // Cancelled while the server was opening the file.
        if (signal?.aborted) {
            this.socket.emit('files-download-cancel', { transferId });
            await sink.abort();
            throw cancelledError();
        }

        return new Promise<number>((resolve, reject) => {
            let stored = 0;
            // Writes run one after the other, in the order the chunks came.
            let writing = Promise.resolve();
            // The server sent everything (or gave up): nothing more to cancel.
            let ended = false;
            let settled = false;
            let idle: ReturnType<typeof setTimeout> | undefined;

            const settle = (error: FileClientError | null) => {
                if (settled) return;
                settled = true;
                clearTimeout(idle);
                this.downloads.delete(transferId);
                signal?.removeEventListener('abort', onAbort);
                this.socket.off('disconnect', onDisconnect);
                if (!error) {
                    resolve(stored);
                    return;
                }
                if (!ended) this.socket.emit('files-download-cancel', { transferId });
                void sink.abort().finally(() => reject(error));
            };
            const armIdle = () => {
                clearTimeout(idle);
                idle = setTimeout(() => settle(new FileClientError({ code: 'TIMEOUT', message: t('files.client.stalled') })), TRANSFER_IDLE_MS);
            };
            const onAbort = () => settle(cancelledError());
            const onDisconnect = () => {
                ended = true;
                settle(new FileClientError({ code: 'NOT_CONNECTED', message: t('files.client.connectionLost') }));
            };
            const writeFailed = (error: unknown) => settle(toClientError(error));

            signal?.addEventListener('abort', onAbort, { once: true });
            this.socket.on('disconnect', onDisconnect);
            armIdle();
            this.listen(transferId, {
                chunk: ({ seq, data }) => {
                    if (settled) return;
                    armIdle();
                    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : data.slice();
                    writing = writing.then(() => sink.write(bytes)).then(() => {
                        if (settled) return;
                        stored += bytes.byteLength;
                        this.socket.emit('files-download-ack', { transferId, seq });
                        options.onProgress?.(stored, size);
                    });
                    writing.catch(writeFailed);
                },
                end: () => {
                    ended = true;
                    this.downloads.delete(transferId);
                    clearTimeout(idle);
                    // Cancelled while the last chunks were being written: the sink is aborted.
                    writing.then(() => (settled ? undefined : sink.close())).then(() => settle(null), writeFailed);
                },
                error: ({ error }) => {
                    ended = true;
                    settle(new FileClientError(error));
                }
            });
        });
    }

    private listen(transferId: string, listener: DownloadListener): void {
        this.downloads.set(transferId, listener);
        const early = this.early.get(transferId);
        if (!early) return;
        clearTimeout(early.timer);
        this.early.delete(transferId);
        for (const event of early.events) this.dispatch(transferId, event);
    }

    private dispatch(transferId: string, event: EarlyEvent): void {
        const listener = this.downloads.get(transferId);
        if (!listener) {
            const pending = this.early.get(transferId) ?? {
                events: [],
                timer: setTimeout(() => this.early.delete(transferId), EARLY_EVENT_MS)
            };
            pending.events.push(event);
            this.early.set(transferId, pending);
            return;
        }
        if (event.type === 'chunk') listener.chunk(event.payload);
        else if (event.type === 'end') listener.end(event.payload);
        else listener.error(event.payload);
    }

    private readonly onChunk = (payload: DownloadChunk) => this.dispatch(payload.transferId, { type: 'chunk', payload });
    private readonly onEnd = (payload: DownloadEnd) => this.dispatch(payload.transferId, { type: 'end', payload });
    private readonly onError = (payload: DownloadFailure) => this.dispatch(payload.transferId, { type: 'error', payload });
}
