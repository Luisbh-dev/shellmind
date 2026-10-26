import { randomBytes } from "crypto";
import { PassThrough, Writable } from "stream";
import { Client as FtpClient, FileType, FTPError, type FileInfo } from "basic-ftp";
import { MAX_LIST_ENTRIES, type DeleteResult, type FileEntry, type FileItemRef, type FileStat, type FileTransport, type ListResult } from "../../shared/files";
import { errorMessage } from "../errors";
import { createLogger, isLogLevelEnabled } from "../logger";
import { ftpModifiedTime } from "./ftpTime";
import { OpQueue } from "./opQueue";
import { baseName, ftpReplyPath, isWithin, joinRemotePath, normalizeFtpPath, normalizeRemotePath, parentPath, sortEntries, temporaryUploadPath } from "./paths";
import { FailureLog, FsError, Tally, type CountLimits, type DownloadSource, type RemoteFs, type UploadSink, type WriteOptions } from "./remoteFs";

const log = createLogger("ftp");

const FTP_TIMEOUT_MS = 30_000;
const STREAM_BUFFER = 1024 * 1024;
// Connections for transfers besides the browsing one (the explorer runs an
// upload and a download at the same time).
const MAX_TRANSFER_CONNECTIONS = 3;
// Links in a listing are probed (CWD) to tell folders from files; FTP has no
// stat, so past this many they are shown as plain links.
const MAX_PROBED_LINKS = 100;
const TEMP_RETRY_MS = 1000;

// FTPS: explicit (AUTH TLS on the normal port) or implicit (TLS from the
// first byte, usually port 990). Certificates are verified.
export type FtpSecurity = false | true | "implicit";

export type FtpConnectOptions = {
    host: string;
    port: number;
    user: string;
    password?: string;
    secure: FtpSecurity;
};

export function ftpError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    const message = errorMessage(err);
    if (err instanceof FTPError) {
        if (err.code === 421) return new FsError("NOT_CONNECTED", `The FTP server closed the session: ${message}`);
        if (err.code === 530) return new FsError("PERMISSION_DENIED", `${path}: ${message}`);
        if (err.code === 550 || err.code === 553) {
            if (/no such|not found|not exist|cannot find|can't find/i.test(message)) return new FsError("NOT_FOUND", `${path}: no such file or folder`);
            if (/permission|denied|access|not allowed/i.test(message)) return new FsError("PERMISSION_DENIED", `${path}: permission denied`);
        }
        return new FsError("FAILED", `${path}: ${message}`);
    }
    // basic-ftp v6 refuses a PASV reply that points at another host (FTP
    // bounce); servers behind NAT need EPSV or a correct passive address.
    if (/PASV returned another host/.test(message)) {
        return new FsError("UNSUPPORTED", "The FTP server asked for data connections to another address, which is refused for security. Enable EPSV or set the server's passive address to its public one.");
    }
    if (/timeout/i.test(message)) return new FsError("TIMEOUT", `${path}: the FTP server did not answer in time`);
    if (/client is closed|closed connection|not connected|ECONNRESET|ECONNREFUSED|socket hang up/i.test(message)) {
        return new FsError("NOT_CONNECTED", `The FTP connection was lost: ${message}`);
    }
    return new FsError("FAILED", `${path}: ${message}`);
}

const cancelled = () => new FsError("CANCELLED", "The transfer was cancelled");

export async function openFtpClient(options: FtpConnectOptions): Promise<FtpClient> {
    const client = new FtpClient(FTP_TIMEOUT_MS);
    client.ftp.verbose = isLogLevelEnabled("debug");
    try {
        await client.access({
            host: options.host,
            port: options.port,
            user: options.user,
            password: options.password,
            secure: options.secure,
            secureOptions: options.secure ? { rejectUnauthorized: true } : undefined
        });
        return client;
    } catch (err) {
        client.close();
        throw err;
    }
}

// One FTP connection and the queue every call on it goes through. A closed
// connection (server timeout, cancelled transfer) is reopened by the next call.
class FtpLane {
    private readonly queue = new OpQueue();
    private client: FtpClient | null;
    // Taken by one transfer from its start until it settled.
    reserved = false;

    constructor(private readonly connect: () => Promise<FtpClient>, client: FtpClient | null) {
        this.client = client;
    }

    run<T>(path: string, op: (client: FtpClient) => Promise<T>): Promise<T> {
        return this.runCancellable(path, op).result;
    }

    // cancel(): a queued call never starts; a running one fails as CANCELLED
    // by dropping the connection (basic-ftp cannot abort a transfer otherwise).
    runCancellable<T>(path: string, op: (client: FtpClient) => Promise<T>): { result: Promise<T>; cancel: () => void } {
        let isCancelled = false;
        let running = false;
        const result = this.queue.run(async () => {
            if (isCancelled) throw cancelled();
            running = true;
            try {
                const client = await this.ready();
                if (isCancelled) throw cancelled();
                return await op(client);
            } catch (err) {
                throw isCancelled ? cancelled() : ftpError(err, path);
            } finally {
                running = false;
            }
        });
        const cancel = () => {
            isCancelled = true;
            if (running) this.reset();
        };
        return { result, cancel };
    }

    private async ready(): Promise<FtpClient> {
        if (this.client && !this.client.closed) return this.client;
        this.client = null;
        const client = await this.connect();
        this.client = client;
        return client;
    }

    reset(): void {
        const client = this.client;
        this.client = null;
        client?.close();
    }

    close(): void {
        this.queue.close(new FsError("NOT_CONNECTED", "The FTP session is closed"));
        this.reset();
    }
}

function permissionsOf(info: FileInfo): number {
    const p = info.permissions;
    return p ? (p.user << 6) | (p.group << 3) | p.world : 0;
}

function toEntry(info: FileInfo): FileEntry {
    const isDir = info.type === FileType.Directory;
    return {
        name: info.name,
        isDir,
        isLink: info.type === FileType.SymbolicLink,
        size: isDir ? 0 : info.size || 0,
        mtime: ftpModifiedTime(info),
        permissions: permissionsOf(info)
    };
}

const DIR_STAT: FileStat = { isDir: true, isLink: false, size: 0, mtime: 0, permissions: 0 };

// Waits until a stream accepted a chunk (or until `failed` settles first).
function writeWithBackpressure(stream: PassThrough, chunk: Buffer, failed: Promise<never>): Promise<void> {
    if (stream.write(chunk)) return Promise.resolve();
    return Promise.race([new Promise<void>((resolve) => stream.once("drain", resolve)), failed]);
}

const sessionClosed = () => new FsError("NOT_CONNECTED", "The FTP session is closed");

export class FtpFs implements RemoteFs {
    readonly protocol = "ftp";
    readonly transport: FileTransport;
    private readonly control: FtpLane;
    // Each transfer runs on a connection of its own, so browsing, an upload
    // and a download never wait for each other. Opened on demand, up to
    // `laneLimit` (lowered when the server refuses another login).
    private readonly transferLanes: FtpLane[] = [];
    private laneLimit = MAX_TRANSFER_CONNECTIONS;
    private opening = 0;
    // The server refused to rename a finished upload into place (upload-only
    // drop boxes): new files are then written under their name directly.
    private directUploads = false;
    private closed = false;

    constructor(private readonly options: FtpConnectOptions, client: FtpClient) {
        this.transport = options.secure === "implicit" ? "ftps-implicit" : options.secure ? "ftps" : "ftp";
        this.control = new FtpLane(() => openFtpClient(options), client);
    }

    static async connect(options: FtpConnectOptions): Promise<FtpFs> {
        return new FtpFs(options, await openFtpClient(options));
    }

    // Runs a call on the browsing connection's queue (the virtual shell too).
    run<T>(path: string, op: (client: FtpClient) => Promise<T>): Promise<T> {
        return this.control.run(path, op);
    }

    // A connection for one transfer, held until the caller releases it. A
    // transfer never queues behind another one (its client would give up
    // waiting): when every connection the server allows is busy, it is
    // refused with BUSY and the client starts it again after its other one.
    private async reserveLane(): Promise<FtpLane> {
        if (this.closed) throw sessionClosed();
        const idle = this.transferLanes.find((lane) => !lane.reserved);
        if (idle) {
            idle.reserved = true;
            return idle;
        }
        if (this.transferLanes.length + this.opening < this.laneLimit) {
            this.opening += 1;
            let client: FtpClient | null = null;
            try {
                client = await openFtpClient(this.options);
            } catch (err) {
                this.laneLimit = Math.min(this.laneLimit, this.transferLanes.length + this.opening - 1);
                log.info(`The FTP server refused another connection (${errorMessage(err)}); transfers use ${this.laneLimit || "the browsing"} connection(s)`);
            } finally {
                this.opening -= 1;
            }
            if (client) {
                if (this.closed) {
                    client.close();
                    throw sessionClosed();
                }
                const lane = new FtpLane(() => openFtpClient(this.options), client);
                lane.reserved = true;
                this.transferLanes.push(lane);
                return lane;
            }
        }
        // A server that takes a single login: one transfer at a time on the
        // browsing connection.
        if (!this.transferLanes.length && !this.control.reserved) {
            this.control.reserved = true;
            return this.control;
        }
        throw new FsError("BUSY", "Every connection the FTP server allows is busy with another transfer");
    }

    async home(): Promise<string> {
        return ftpReplyPath(await this.control.run(".", (client) => client.pwd()));
    }

    async list(path: string): Promise<ListResult> {
        return this.control.run(path, async (client) => {
            const raw = (await client.list(normalizeFtpPath(path))).filter((info) => info.name !== "." && info.name !== "..");
            const truncated = raw.length > MAX_LIST_ENTRIES;
            const entries = (truncated ? raw.slice(0, MAX_LIST_ENTRIES) : raw).map(toEntry);
            // A link to a folder must open like a folder.
            for (const entry of entries.filter((e) => e.isLink).slice(0, MAX_PROBED_LINKS)) {
                entry.isDir = await client.cd(normalizeFtpPath(joinRemotePath(path, entry.name))).then(() => true, (err: unknown) => {
                    if (err instanceof FTPError) return false;
                    throw err;
                });
            }
            return { path, entries: sortEntries(entries), truncated };
        });
    }

    async stat(path: string): Promise<FileStat | null> {
        if (normalizeRemotePath(path) === "/") return DIR_STAT;
        return this.control.run(path, async (client) => {
            const ftpPath = normalizeFtpPath(path);
            try {
                const size = await client.size(ftpPath);
                const mtime = await client.lastMod(ftpPath).then((date) => Math.floor(date.getTime() / 1000) || 0, () => 0);
                return { isDir: false, isLink: false, size, mtime, permissions: 0 };
            } catch (err) {
                // Not a file, missing, or SIZE unsupported: look it up in its folder.
                if (!(err instanceof FTPError)) throw err;
            }
            let siblings: FileInfo[];
            try {
                siblings = await client.list(normalizeFtpPath(parentPath(path)));
            } catch (err) {
                if (err instanceof FTPError) return null;
                throw err;
            }
            const info = siblings.find((candidate) => candidate.name === baseName(path));
            if (!info) return null;
            const { name: _name, ...stat } = toEntry(info);
            return stat;
        });
    }

    async readFile(path: string, maxBytes: number): Promise<{ data: Buffer; stat: FileStat }> {
        const stat = await this.stat(path);
        if (!stat) throw new FsError("NOT_FOUND", `${path}: no such file or folder`);
        if (stat.isDir) throw new FsError("NOT_A_FILE", `${path} is not a regular file`);
        if (stat.size > maxBytes) throw new FsError("TOO_LARGE", `${path} is larger than ${maxBytes} bytes`);
        const chunks: Buffer[] = [];
        let total = 0;
        const collector = new Writable({
            write(chunk: Buffer, _encoding, callback) {
                total += chunk.length;
                // basic-ftp closes the connection on this error; the next call reconnects.
                if (total > maxBytes) return callback(new FsError("TOO_LARGE", `${path} is larger than ${maxBytes} bytes`));
                chunks.push(chunk);
                callback();
            }
        });
        await this.control.run(path, (client) => client.downloadTo(collector, normalizeFtpPath(path)));
        return { data: Buffer.concat(chunks, total), stat };
    }

    // Checks a file before a transfer, holding the reserved connection: a
    // failed check gives it back.
    private async checked<T>(lane: FtpLane | null, check: () => Promise<T>): Promise<T> {
        try {
            return await check();
        } catch (err) {
            if (lane) lane.reserved = false;
            throw err;
        }
    }

    async openRead(path: string): Promise<DownloadSource> {
        // The connection comes first: with none free the download is refused
        // (BUSY) right away instead of its checks queueing behind a transfer
        // that occupies the browsing connection.
        const lane = await this.reserveLane();
        const stat = await this.checked(lane, async () => {
            const found = await this.stat(path);
            if (!found) throw new FsError("NOT_FOUND", `${path}: no such file or folder`);
            if (found.isDir) throw new FsError("NOT_A_FILE", `${path} is not a regular file`);
            return found;
        });

        // basic-ftp ends its destination even when the transfer fails, so it
        // writes into a relay and the stream handed out only ends on success.
        const stream = new PassThrough({ highWaterMark: STREAM_BUFFER });
        const relay = new Writable({
            highWaterMark: STREAM_BUFFER,
            write(chunk: Buffer, _encoding, callback) {
                if (stream.write(chunk)) callback();
                else stream.once("drain", () => callback());
            }
        });
        let settled = false;
        const transfer = lane.runCancellable(path, (client) => client.downloadTo(relay, normalizeFtpPath(path)));
        // The connection is free again before the client hears the end.
        transfer.result.then(
            () => { settled = true; lane.reserved = false; stream.end(); },
            (err: unknown) => { settled = true; lane.reserved = false; stream.destroy(ftpError(err, path)); }
        );
        // The reader went away early: stop the transfer.
        stream.on("close", () => { if (!settled) transfer.cancel(); });
        return { stream, size: stat.size };
    }

    async openWrite(path: string, options: WriteOptions): Promise<UploadSink> {
        // A whole write (an editor save) is short: it goes over the browsing
        // connection rather than taking, or waiting for, a transfer one.
        // Uploads reserve their connection before checking (see openRead).
        const reserved = options.whole ? null : await this.reserveLane();
        const lane = reserved ?? this.control;
        const release = () => { if (reserved) reserved.reserved = false; };
        const existing = await this.checked(reserved, async () => {
            const found = await this.stat(path);
            if (found?.isDir) throw new FsError("NOT_A_FILE", `${path} is a folder`);
            if (found && !options.overwrite) throw new FsError("EXISTS", `${path} already exists`);
            return found;
        });
        // New files go straight to their name on servers that refuse renames.
        const direct = this.directUploads && !existing;
        const destination = direct ? path : temporaryUploadPath(path, randomBytes(4).toString("hex"));
        const source = new PassThrough({ highWaterMark: STREAM_BUFFER });
        const transfer = lane.runCancellable(destination, (client) => client.uploadFrom(source, normalizeFtpPath(destination)));
        transfer.result.then(release, release);
        let failure: FsError | null = null;
        const failed = transfer.result.then(
            () => new Promise<never>(() => undefined),
            (err: unknown) => {
                failure ??= ftpError(err, path);
                throw failure;
            }
        );
        failed.catch(() => undefined);
        let settled = false;

        // A server may still hold the aborted file open for a moment (Windows
        // servers then refuse to delete it): try once more after a pause.
        // Resolves to whether the partial file is gone.
        const removeOnce = () => this.control.run(destination, (client) => client.remove(normalizeFtpPath(destination)));
        let removal: Promise<boolean> | null = null;
        const removePartial = () => (removal ??= removeOnce().then(() => true, async () => {
            await new Promise((resolve) => setTimeout(resolve, TEMP_RETRY_MS));
            return removeOnce().then(() => true, () => false);
        }));

        return {
            write: (chunk) => {
                if (failure) return Promise.reject(failure);
                if (settled) return Promise.reject(new FsError("INVALID", "The upload is already finished"));
                return writeWithBackpressure(source, chunk, failed);
            },
            commit: async () => {
                if (settled) throw new FsError("INVALID", "The upload is already finished");
                settled = true;
                source.end();
                try {
                    await transfer.result;
                    if (!direct) await this.moveIntoPlace(destination, path, options.overwrite, existing === null);
                } catch (err) {
                    const removed = await removePartial();
                    const error = failure ?? ftpError(err, path);
                    if (error.code === "UNSUPPORTED" && !removed) {
                        throw new FsError("UNSUPPORTED", `${error.message} Its temporary copy ${baseName(destination)} could not be removed either.`);
                    }
                    throw error;
                }
            },
            abort: async () => {
                if (settled && !failure) return;
                settled = true;
                failure ??= cancelled();
                transfer.cancel();
                source.destroy();
                await transfer.result.catch(() => undefined);
                await removePartial();
            }
        };
    }

    // Moves a finished upload over its target. An existing file is never
    // removed before the new one is in place: a server that will not rename
    // over it gets it moved aside first (and back if the move fails).
    private moveIntoPlace(temp: string, target: string, overwrite: boolean, isNew: boolean): Promise<void> {
        return this.control.run(target, async (client) => {
            const tempPath = normalizeFtpPath(temp);
            const targetPath = normalizeFtpPath(target);
            // RNTO silently replaces on most servers: check first. Without
            // SIZE, what the upload found when it started has to do.
            const taken = await client.size(targetPath).then(() => true, () => !isNew);
            if (taken && !overwrite) throw new FsError("EXISTS", `${target} already exists`);
            try {
                await client.rename(tempPath, targetPath);
                return;
            } catch (err) {
                if (!(err instanceof FTPError)) throw err;
                if (!taken) {
                    // Allowed to upload but not to rename (a drop box).
                    this.directUploads = true;
                    throw new FsError("UNSUPPORTED", `The FTP server refused to rename the upload into place (${errorMessage(err)}). Uploading it again writes it directly under its name.`);
                }
            }
            const aside = normalizeFtpPath(temporaryUploadPath(target, `${randomBytes(4).toString("hex")}.old`));
            await client.rename(targetPath, aside);
            try {
                await client.rename(tempPath, targetPath);
            } catch (err) {
                await client.rename(aside, targetPath).catch((restore: unknown) => log.warn(`Could not move ${aside} back to ${target}: ${errorMessage(restore)}`));
                throw err;
            }
            await client.remove(aside).catch((leftover: unknown) => log.warn(`Could not remove the replaced file ${aside}: ${errorMessage(leftover)}`));
        });
    }

    async mkdir(path: string): Promise<void> {
        if (await this.stat(path)) throw new FsError("EXISTS", `${path} already exists`);
        await this.control.run(path, (client) => client.send(`MKD ${normalizeFtpPath(path)}`));
    }

    async rename(from: string, to: string, isDir: boolean): Promise<void> {
        if (isDir && isWithin(to, from)) throw new FsError("INVALID", `Cannot move ${from} into itself`);
        if (await this.stat(to)) throw new FsError("EXISTS", `${to} already exists`);
        await this.control.run(from, (client) => client.rename(normalizeFtpPath(from), normalizeFtpPath(to)));
    }

    async remove(items: FileItemRef[]): Promise<DeleteResult> {
        const failures = new FailureLog();
        let deleted = 0;
        const removeTree = async (path: string, isDir: boolean): Promise<boolean> => {
            if (isDir) {
                let children: FileInfo[];
                try {
                    children = await this.control.run(path, (client) => client.list(normalizeFtpPath(path)));
                } catch (err) {
                    failures.add(path, err);
                    return false;
                }
                let complete = true;
                for (const child of children) {
                    if (child.name === "." || child.name === "..") continue;
                    // Links are removed themselves, never followed.
                    if (!(await removeTree(joinRemotePath(path, child.name), child.type === FileType.Directory))) complete = false;
                }
                if (!complete) return false;
            }
            try {
                await this.control.run(path, (client) => (isDir ? client.removeEmptyDir(normalizeFtpPath(path)) : client.remove(normalizeFtpPath(path))));
                deleted += 1;
                return true;
            } catch (err) {
                failures.add(path, err);
                return false;
            }
        };
        for (const item of items) await removeTree(item.path, item.isDir && !item.isLink);
        return { deleted, failures: failures.items, failureCount: failures.count };
    }

    async count(items: FileItemRef[], limits: CountLimits): Promise<{ files: number; dirs: number; bytes: number; truncated: boolean }> {
        const tally = new Tally(limits);
        const walk = async (path: string, isDir: boolean, size: number): Promise<void> => {
            if (!tally.add({ isDir, size }) || !isDir) return;
            const children = await this.control.run(path, (client) => client.list(normalizeFtpPath(path))).catch(() => [] as FileInfo[]);
            for (const child of children) {
                if (child.name === "." || child.name === "..") continue;
                if (!tally.ok()) return;
                await walk(joinRemotePath(path, child.name), child.type === FileType.Directory, child.size || 0);
            }
        };
        for (const item of items) {
            const stat = item.isDir ? null : await this.stat(item.path).catch(() => null);
            await walk(item.path, item.isDir && !item.isLink, stat?.size ?? 0);
        }
        return tally.result();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        this.control.close();
        for (const lane of this.transferLanes) lane.close();
    }
}
