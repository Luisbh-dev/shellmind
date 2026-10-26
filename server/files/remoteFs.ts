import type { Readable } from "stream";
import type {
    CountResult,
    DeleteResult,
    FileError,
    FileErrorCode,
    FileFailure,
    FileItemRef,
    FileProtocol,
    FileStat,
    FileTransport,
    ListResult
} from "../../shared/files";
import { AppError, errorMessage } from "../errors";

// One file session (SFTP, FTP or S3) behind a protocol-neutral interface, so
// the socket handlers implement each operation once. Paths are normalized
// absolute paths (server/files/paths.ts); failures are FsErrors.

export type DownloadSource = {
    stream: Readable;
    // null when the server does not say (the stream still ends at EOF).
    size: number | null;
};

// An upload in progress. Data goes to a temporary location that commit()
// moves over the target, so an aborted upload leaves the target untouched.
export interface UploadSink {
    // Resolves once the chunk is stored (or accepted with backpressure);
    // rejects with the first write error, after which every call rejects.
    write(chunk: Buffer): Promise<void>;
    commit(): Promise<void>;
    // Discards the partial upload; never rejects.
    abort(): Promise<void>;
}

export type CountLimits = { maxEntries: number; deadline: number };

export type WriteOptions = {
    // Replace an existing file; refused with EXISTS otherwise.
    overwrite: boolean;
    size: number;
    // All data is written right away (an editor save), so the write is short:
    // FTP sends it over the browsing connection, never behind a transfer.
    whole?: boolean;
    // Accepted to overwrite the target directly when no temporary file can be
    // created next to it; refused with NOT_ATOMIC otherwise.
    inPlace?: boolean;
};

export interface RemoteFs {
    readonly protocol: FileProtocol;
    readonly transport: FileTransport;
    home(): Promise<string>;
    list(path: string): Promise<ListResult>;
    // null when nothing exists at `path`.
    stat(path: string): Promise<FileStat | null>;
    // Whole small files (the editor): refuses folders, devices and anything
    // above maxBytes, also when the server under-reports the size.
    readFile(path: string, maxBytes: number): Promise<{ data: Buffer; stat: FileStat }>;
    openRead(path: string): Promise<DownloadSource>;
    openWrite(path: string, options: WriteOptions): Promise<UploadSink>;
    mkdir(path: string): Promise<void>;
    // Refused with EXISTS when `to` exists.
    rename(from: string, to: string, isDir: boolean): Promise<void>;
    // Deletes files and whole folder trees (symbolic links are removed, never
    // followed); keeps going after a failure and reports every failure.
    remove(items: FileItemRef[]): Promise<DeleteResult>;
    count(items: FileItemRef[], limits: CountLimits): Promise<CountResult>;
    close(): void;
}

const MAX_REPORTED_FAILURES = 50;

export class FsError extends AppError {
    declare readonly code: FileErrorCode;
    readonly current?: FileStat | null;
    readonly failures?: FileFailure[];
    readonly failureCount?: number;

    constructor(code: FileErrorCode, message: string, extra: { current?: FileStat | null; failures?: FileFailure[]; failureCount?: number } = {}) {
        super(code, message, code === "NOT_FOUND" ? 404 : code === "CONFLICT" || code === "EXISTS" ? 409 : 400);
        this.name = "FsError";
        if ("current" in extra) this.current = extra.current;
        if (extra.failures) this.failures = extra.failures;
        if (extra.failureCount !== undefined) this.failureCount = extra.failureCount;
    }
}

export function toFileError(err: unknown): FileError {
    if (err instanceof FsError) {
        return {
            code: err.code,
            message: err.message,
            ...(err.current !== undefined ? { current: err.current } : {}),
            ...(err.failures ? { failures: err.failures, failureCount: err.failureCount ?? err.failures.length } : {})
        };
    }
    return { code: "FAILED", message: errorMessage(err) };
}

// Collects per-item failures of a bulk operation, keeping the first ones.
export class FailureLog {
    readonly items: FileFailure[] = [];
    count = 0;

    add(path: string, err: unknown): void {
        this.count += 1;
        if (this.items.length < MAX_REPORTED_FAILURES) this.items.push({ path, message: errorMessage(err) });
    }
}

// Bounds the requests a recursive walk keeps in flight, however deep it goes.
// A finishing call hands its slot straight to the next waiter.
export class Limiter {
    private active = 0;
    private readonly waiting: Array<() => void> = [];

    constructor(private readonly max: number) {}

    async run<T>(fn: () => Promise<T>): Promise<T> {
        if (this.active < this.max) this.active += 1;
        else await new Promise<void>((resolve) => this.waiting.push(resolve));
        try {
            return await fn();
        } finally {
            const next = this.waiting.shift();
            if (next) next();
            else this.active -= 1;
        }
    }
}

// Runs fn over items with at most `limit` calls in flight.
export async function mapLimit<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const item = items[next++];
            await fn(item);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

// Counting state shared by the recursive count() walks.
export class Tally {
    files = 0;
    dirs = 0;
    bytes = 0;
    truncated = false;

    constructor(private readonly limits: CountLimits) {}

    // False once a limit is reached: the walk should stop.
    add(stat: { isDir: boolean; size: number }): boolean {
        if (stat.isDir) this.dirs += 1;
        else {
            this.files += 1;
            this.bytes += stat.size;
        }
        return this.ok();
    }

    ok(): boolean {
        if (this.files + this.dirs >= this.limits.maxEntries || Date.now() > this.limits.deadline) this.truncated = true;
        return !this.truncated;
    }

    result(): CountResult {
        return { files: this.files, dirs: this.dirs, bytes: this.bytes, truncated: this.truncated };
    }
}
