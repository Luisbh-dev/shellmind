import { randomBytes } from "crypto";
import { Readable } from "stream";
import { utils, type Attributes, type FileEntryWithStats, type SFTPWrapper } from "ssh2";
import { MAX_LIST_ENTRIES, type DeleteResult, type FileEntry, type FileItemRef, type FileStat, type ListResult } from "../../shared/files";
import { errorMessage } from "../errors";
import { baseName, isWithin, joinRemotePath, parentPath, sortEntries, temporaryUploadPath } from "./paths";
import { FailureLog, FsError, Limiter, Tally, type CountLimits, type DownloadSource, type RemoteFs, type UploadSink, type WriteOptions } from "./remoteFs";

const { STATUS_CODE } = utils.sftp;

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFREG = 0o100000;
const S_IFLNK = 0o120000;

// SFTP requests are capped at about 32 KiB by servers other than OpenSSH;
// staying below that keeps every request a single packet, and keeping many of
// them in flight is what makes transfers fast on high-latency links. 64 reads
// fill ssh2's 2 MiB channel window, the real ceiling of a download per round
// trip.
const IO_PIECE = 32 * 1024;
const READ_AHEAD = 64;
const WALK_CONCURRENCY = 16;
// READDIR requests kept in flight on one folder handle. Servers answer them
// in order with up to ~100 names each (OpenSSH), so a large folder costs one
// round trip per few hundred names; the requests past the end answer EOF.
const READDIR_PIPELINE = 8;
// Symbolic links in a listing are stat-ed to tell folders from files (many at
// once: each one is a round trip); past this many they are shown as plain links.
const LINK_STAT_CONCURRENCY = 64;
const MAX_RESOLVED_LINKS = 2000;

function statusOf(err: unknown): number | undefined {
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === "number" ? code : undefined;
}

export function sftpError(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    switch (statusOf(err)) {
        case STATUS_CODE.NO_SUCH_FILE:
            return new FsError("NOT_FOUND", `${path}: no such file or folder`);
        case STATUS_CODE.PERMISSION_DENIED:
            return new FsError("PERMISSION_DENIED", `${path}: permission denied`);
        case STATUS_CODE.NO_CONNECTION:
        case STATUS_CODE.CONNECTION_LOST:
            return new FsError("NOT_CONNECTED", "The SFTP session is closed");
        case STATUS_CODE.OP_UNSUPPORTED:
            return new FsError("UNSUPPORTED", `${path}: the server does not support this operation`);
        default:
            // ssh2 throws "Server does not support this extended request" itself.
            if (/does not support/i.test(errorMessage(err))) return new FsError("UNSUPPORTED", `${path}: ${errorMessage(err)}`);
            return new FsError("FAILED", `${path}: ${errorMessage(err)}`);
    }
}

function toStat(attrs: Attributes, isLink = false): FileStat {
    const type = attrs.mode & S_IFMT;
    return {
        isDir: type === S_IFDIR,
        isLink: isLink || type === S_IFLNK,
        size: type === S_IFDIR ? 0 : attrs.size ?? 0,
        mtime: attrs.mtime ?? 0,
        permissions: attrs.mode & 0o7777
    };
}

const isRegular = (attrs: Attributes) => (attrs.mode & S_IFMT) === S_IFREG;
const isDirectory = (attrs: Attributes) => (attrs.mode & S_IFMT) === S_IFDIR;

// Calls an SFTP method and maps its error. ssh2 throws synchronously once the
// channel is gone, which becomes a rejection too.
function call<T>(path: string, invoke: (done: (err: Error | null | undefined, value?: T) => void) => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        try {
            invoke((err, value) => (err ? reject(sftpError(err, path)) : resolve(value as T)));
        } catch (err) {
            reject(sftpError(err, path));
        }
    });
}

// Reads a remote file with several requests in flight, delivering the data in
// order. A size of 0 means "unknown" (procfs and friends): it then reads one
// request at a time until EOF.
class SftpReadStream extends Readable {
    private nextOffset = 0;
    private deliverOffset = 0;
    private readonly results = new Map<number, Buffer>();
    private inflight = 0;
    private eof = false;
    private finished = false;
    private wanted = false;

    constructor(private readonly sftp: SFTPWrapper, private readonly handle: Buffer, private readonly size: number, private readonly path: string) {
        super({ highWaterMark: IO_PIECE * READ_AHEAD });
    }

    _read(): void {
        this.wanted = true;
        this.flush();
    }

    _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
        try {
            this.sftp.close(this.handle, () => callback(err));
        } catch {
            callback(err);
        }
    }

    private fill(): void {
        const maxInflight = this.size > 0 ? READ_AHEAD : 1;
        while (this.wanted && !this.destroyed && !this.eof && this.inflight < maxInflight && (this.size === 0 || this.nextOffset < this.size)) {
            const length = this.size > 0 ? Math.min(IO_PIECE, this.size - this.nextOffset) : IO_PIECE;
            this.request(this.nextOffset, length);
            this.nextOffset += length;
        }
    }

    private request(offset: number, length: number): void {
        this.inflight += 1;
        const buffer = Buffer.allocUnsafe(length);
        try {
            this.sftp.read(this.handle, buffer, 0, length, offset, (err, bytesRead) => this.onRead(offset, length, buffer, err, bytesRead));
        } catch (err) {
            this.inflight -= 1;
            this.destroy(sftpError(err, this.path));
        }
    }

    private onRead(offset: number, length: number, buffer: Buffer, err: Error | undefined, bytesRead: number): void {
        this.inflight -= 1;
        if (this.destroyed) return;
        if (err && statusOf(err) !== STATUS_CODE.EOF) {
            this.destroy(sftpError(err, this.path));
            return;
        }
        if (err || !bytesRead) {
            this.eof = true;
        } else {
            this.results.set(offset, buffer.subarray(0, bytesRead));
            // Servers may answer with less than asked: fetch the rest.
            if (bytesRead < length && this.size > 0) this.request(offset + bytesRead, length - bytesRead);
        }
        this.flush();
    }

    private flush(): void {
        let chunk = this.results.get(this.deliverOffset);
        while (chunk && this.wanted) {
            this.results.delete(this.deliverOffset);
            this.deliverOffset += chunk.length;
            this.wanted = this.push(chunk);
            chunk = this.results.get(this.deliverOffset);
        }
        const done = this.eof || (this.size > 0 && this.deliverOffset >= this.size);
        if (done && this.inflight === 0 && this.results.size === 0) {
            if (!this.finished) {
                this.finished = true;
                this.push(null);
            }
            return;
        }
        this.fill();
    }
}

class SftpUploadSink implements UploadSink {
    private offset = 0;
    private readonly pending = new Set<Promise<void>>();
    private failure: FsError | null = null;
    private handleOpen = true;
    private settled = false;

    constructor(
        private readonly fs: SftpFs,
        private readonly handle: Buffer,
        // null: writing straight to the target (no writable temp location).
        private readonly temp: string | null,
        private readonly target: string,
        private readonly overwrite: boolean
    ) {}

    write(chunk: Buffer): Promise<void> {
        if (this.failure) return Promise.reject(this.failure);
        if (this.settled) return Promise.reject(new FsError("INVALID", "The upload is already finished"));
        const start = this.offset;
        this.offset += chunk.length;
        const pieces: Promise<void>[] = [];
        for (let at = 0; at < chunk.length; at += IO_PIECE) {
            pieces.push(this.writePiece(chunk.subarray(at, at + IO_PIECE), start + at));
        }
        const written = Promise.all(pieces).then(() => undefined);
        this.pending.add(written);
        const forget = () => { this.pending.delete(written); };
        written.then(forget, forget);
        return written;
    }

    private writePiece(piece: Buffer, position: number): Promise<void> {
        return call<void>(this.temp ?? this.target, (done) => this.fs.sftp.write(this.handle, piece, 0, piece.length, position, done))
            .catch((err: FsError) => {
                this.failure ??= err;
                throw this.failure;
            });
    }

    async commit(): Promise<void> {
        if (this.settled) throw new FsError("INVALID", "The upload is already finished");
        await Promise.allSettled([...this.pending]);
        if (this.failure) {
            await this.abort();
            throw this.failure;
        }
        this.settled = true;
        try {
            this.handleOpen = false;
            await call<void>(this.target, (done) => this.fs.sftp.close(this.handle, done));
            if (this.temp) await this.fs.moveIntoPlace(this.temp, this.target, this.overwrite);
        } catch (err) {
            await this.discardTemp();
            throw err;
        }
    }

    async abort(): Promise<void> {
        this.settled = true;
        this.failure ??= new FsError("CANCELLED", "The upload was cancelled");
        if (this.handleOpen) {
            this.handleOpen = false;
            await call<void>(this.target, (done) => this.fs.sftp.close(this.handle, done)).catch(() => undefined);
        }
        await this.discardTemp();
    }

    private async discardTemp(): Promise<void> {
        const temp = this.temp;
        if (temp) await call<void>(temp, (done) => this.fs.sftp.unlink(temp, done)).catch(() => undefined);
    }
}

export class SftpFs implements RemoteFs {
    readonly protocol = "sftp";
    readonly transport = "ssh";
    private closed = false;

    constructor(readonly sftp: SFTPWrapper) {}

    home(): Promise<string> {
        return call<string>(".", (done) => this.sftp.realpath(".", done));
    }

    async list(path: string): Promise<ListResult> {
        const listed = await this.readDirectory(path, MAX_LIST_ENTRIES + 1);
        const truncated = listed.length > MAX_LIST_ENTRIES;
        const kept = truncated ? listed.slice(0, MAX_LIST_ENTRIES) : listed;
        const entries: FileEntry[] = kept.map((item) => ({ name: item.filename, ...toStat(item.attrs) }));

        // A link to a folder must open like a folder.
        const links = entries.filter((entry) => entry.isLink).slice(0, MAX_RESOLVED_LINKS);
        const limiter = new Limiter(LINK_STAT_CONCURRENCY);
        await Promise.all(links.map((entry) => limiter.run(async () => {
            const target = await this.stat(joinRemotePath(path, entry.name)).catch(() => null);
            if (target) Object.assign(entry, { isDir: target.isDir, size: target.size, mtime: target.mtime });
        })));
        return { path, entries: sortEntries(entries), truncated };
    }

    // The entries of a folder ("." and ".." left out), at least `limit` of
    // them when there are that many, with READDIR_PIPELINE requests in flight.
    private async readDirectory(path: string, limit = Number.POSITIVE_INFINITY): Promise<FileEntryWithStats[]> {
        const handle = await call<Buffer>(path, (done) => this.sftp.opendir(path, done));
        const items: FileEntryWithStats[] = [];
        try {
            await new Promise<void>((resolve, reject) => {
                let inflight = 0;
                // EOF seen, enough entries or a failure: send no more requests.
                let stop = false;
                let failure: FsError | null = null;
                const onPage = (err: Error | undefined, page: FileEntryWithStats[] | undefined) => {
                    inflight -= 1;
                    if (err) {
                        stop = true;
                        if (statusOf(err) !== STATUS_CODE.EOF) failure ??= sftpError(err, path);
                    } else if (page && items.length < limit) {
                        for (const item of page) items.push(item);
                        if (items.length >= limit) stop = true;
                    }
                    if (inflight === 0 && stop) {
                        if (failure) reject(failure);
                        else resolve();
                        return;
                    }
                    request();
                };
                const request = () => {
                    while (!stop && inflight < READDIR_PIPELINE) {
                        inflight += 1;
                        try {
                            this.sftp.readdir(handle, onPage);
                        } catch (err) {
                            // The channel is gone; the requests in flight fail too.
                            onPage(err as Error, undefined);
                        }
                    }
                };
                request();
            });
        } finally {
            await call<void>(path, (done) => this.sftp.close(handle, done)).catch(() => undefined);
        }
        return items;
    }

    async stat(path: string): Promise<FileStat | null> {
        try {
            return toStat(await this.rawStat(path));
        } catch (err) {
            if (err instanceof FsError && err.code === "NOT_FOUND") return null;
            throw err;
        }
    }

    private rawStat(path: string): Promise<Attributes> {
        return call<Attributes>(path, (done) => this.sftp.stat(path, done));
    }

    private lstat(path: string): Promise<Attributes> {
        return call<Attributes>(path, (done) => this.sftp.lstat(path, done));
    }

    async readFile(path: string, maxBytes: number): Promise<{ data: Buffer; stat: FileStat }> {
        const attrs = await this.rawStat(path);
        if (!isRegular(attrs)) throw new FsError("NOT_A_FILE", `${path} is not a regular file`);
        if ((attrs.size ?? 0) > maxBytes) throw new FsError("TOO_LARGE", `${path} is larger than ${maxBytes} bytes`);
        const { stream } = await this.openStream(path, attrs);
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of stream as AsyncIterable<Buffer>) {
            total += chunk.length;
            if (total > maxBytes) {
                stream.destroy();
                throw new FsError("TOO_LARGE", `${path} is larger than ${maxBytes} bytes`);
            }
            chunks.push(chunk);
        }
        return { data: Buffer.concat(chunks, total), stat: toStat(attrs) };
    }

    async openRead(path: string): Promise<DownloadSource> {
        const attrs = await this.rawStat(path);
        if (!isRegular(attrs)) throw new FsError("NOT_A_FILE", `${path} is not a regular file`);
        return this.openStream(path, attrs);
    }

    private async openStream(path: string, attrs: Attributes): Promise<DownloadSource> {
        const handle = await call<Buffer>(path, (done) => this.sftp.open(path, "r", done));
        const size = attrs.size ?? 0;
        return { stream: new SftpReadStream(this.sftp, handle, size, path), size: size > 0 ? size : null };
    }

    async openWrite(path: string, options: WriteOptions): Promise<UploadSink> {
        let target = path;
        let existing: Attributes | null = null;
        try {
            const link = await this.lstat(path);
            existing = await this.rawStat(path).catch(() => link);
            // Replacing a symbolic link's target, not the link itself.
            if ((link.mode & S_IFMT) === S_IFLNK && existing !== link) {
                target = await call<string>(path, (done) => this.sftp.realpath(path, done));
            }
        } catch (err) {
            if (!(err instanceof FsError && err.code === "NOT_FOUND")) throw err;
        }
        if (existing && isDirectory(existing)) throw new FsError("NOT_A_FILE", `${path} is a folder`);
        if (existing && !options.overwrite) throw new FsError("EXISTS", `${path} already exists`);

        const mode = existing ? existing.mode & 0o7777 : 0o644;
        const temp = temporaryUploadPath(target, randomBytes(4).toString("hex"));
        let handle: Buffer;
        try {
            handle = await call<Buffer>(temp, (done) => this.sftp.open(temp, "wx", { mode }, done));
        } catch (err) {
            // A file we may write in a folder we may not create files in: the
            // only way is to overwrite it in place, which an interrupted
            // upload leaves damaged, so only when the caller accepted that.
            if (!(existing && err instanceof FsError && err.code === "PERMISSION_DENIED")) throw err;
            if (!options.inPlace) {
                throw new FsError("NOT_ATOMIC", `${parentPath(target)} is not writable, so ${baseName(target)} can only be overwritten in place; if the upload is interrupted the file stays damaged`);
            }
            handle = await call<Buffer>(target, (done) => this.sftp.open(target, "w", done));
            return new SftpUploadSink(this, handle, null, target, true);
        }
        // The server applies its umask on create; replacing a file keeps its mode.
        if (existing) await call<void>(temp, (done) => this.sftp.fchmod(handle, mode, done)).catch(() => undefined);
        return new SftpUploadSink(this, handle, temp, target, options.overwrite);
    }

    // Moves a finished upload over its target: atomically with OpenSSH's
    // posix-rename, else by removing the old file first.
    async moveIntoPlace(temp: string, target: string, overwrite: boolean): Promise<void> {
        if (overwrite) {
            try {
                await call<void>(target, (done) => this.sftp.ext_openssh_rename(temp, target, done));
                return;
            } catch (err) {
                if (!(err instanceof FsError && err.code === "UNSUPPORTED")) throw err;
            }
        }
        try {
            await call<void>(target, (done) => this.sftp.rename(temp, target, done));
        } catch (err) {
            // SFTP v3 renames refuse to replace an existing file.
            const [targetExists, tempExists] = await Promise.all([this.stat(target), this.stat(temp)].map((p) => p.catch(() => null)));
            if (!targetExists || !tempExists) throw err;
            if (!overwrite) throw new FsError("EXISTS", `${target} already exists`);
            await call<void>(target, (done) => this.sftp.unlink(target, done));
            await call<void>(target, (done) => this.sftp.rename(temp, target, done));
        }
    }

    async mkdir(path: string): Promise<void> {
        try {
            await call<void>(path, (done) => this.sftp.mkdir(path, done));
        } catch (err) {
            if (await this.stat(path).catch(() => null)) throw new FsError("EXISTS", `${path} already exists`);
            throw err;
        }
    }

    async rename(from: string, to: string, isDir: boolean): Promise<void> {
        if (isDir && isWithin(to, from)) throw new FsError("INVALID", `Cannot move ${from} into itself`);
        if (await this.lstat(to).then(() => true, () => false)) throw new FsError("EXISTS", `${to} already exists`);
        await call<void>(from, (done) => this.sftp.rename(from, to, done));
    }

    async remove(items: FileItemRef[]): Promise<DeleteResult> {
        const failures = new FailureLog();
        const limiter = new Limiter(WALK_CONCURRENCY);
        let deleted = 0;
        const removeTree = async (path: string, known?: Attributes): Promise<boolean> => {
            let attrs = known;
            // Listing attributes may follow links: only lstat says a folder is real.
            if (!attrs || isDirectory(attrs)) {
                try {
                    attrs = await limiter.run(() => this.lstat(path));
                } catch (err) {
                    if (err instanceof FsError && err.code === "NOT_FOUND") return true;
                    failures.add(path, err);
                    return false;
                }
            }
            if (isDirectory(attrs)) {
                let children: FileEntryWithStats[];
                try {
                    children = await limiter.run(() => this.readDirectory(path));
                } catch (err) {
                    failures.add(path, err);
                    return false;
                }
                const results = await Promise.all(children.map((child) => removeTree(joinRemotePath(path, child.filename), child.attrs)));
                // A child that could not be deleted is already reported.
                if (results.includes(false)) return false;
            }
            try {
                const dir = isDirectory(attrs);
                await limiter.run(() => call<void>(path, (done) => (dir ? this.sftp.rmdir(path, done) : this.sftp.unlink(path, done))));
                deleted += 1;
                return true;
            } catch (err) {
                failures.add(path, err);
                return false;
            }
        };
        for (const item of items) await removeTree(item.path);
        return { deleted, failures: failures.items, failureCount: failures.count };
    }

    async count(items: FileItemRef[], limits: CountLimits): Promise<{ files: number; dirs: number; bytes: number; truncated: boolean }> {
        const tally = new Tally(limits);
        const limiter = new Limiter(WALK_CONCURRENCY);
        const walk = async (path: string, known?: Attributes): Promise<void> => {
            if (!tally.ok()) return;
            const attrs = known && !isDirectory(known) ? known : await limiter.run(() => this.lstat(path)).catch(() => null);
            if (!attrs || !tally.add({ isDir: isDirectory(attrs), size: attrs.size ?? 0 }) || !isDirectory(attrs)) return;
            const children = await limiter.run(() => this.readDirectory(path)).catch(() => []);
            await Promise.all(children.map((child) => walk(joinRemotePath(path, child.filename), child.attrs)));
        };
        for (const item of items) await walk(item.path);
        return tally.result();
    }

    close(): void {
        if (this.closed) return;
        this.closed = true;
        try { this.sftp.end(); } catch { /* already closed */ }
    }
}
