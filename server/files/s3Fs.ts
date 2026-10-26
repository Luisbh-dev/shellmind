import { PassThrough, Readable } from "stream";
import {
    AbortMultipartUploadCommand,
    CompleteMultipartUploadCommand,
    CopyObjectCommand,
    CreateMultipartUploadCommand,
    DeleteObjectCommand,
    DeleteObjectsCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    UploadPartCopyCommand,
    type ListObjectsV2CommandOutput,
    type S3Client,
    type _Object
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { MAX_LIST_ENTRIES, type DeleteResult, type FileEntry, type FileItemRef, type FileStat, type FileTransport, type ListResult } from "../../shared/files";
import { errorMessage } from "../errors";
import { encodeS3CopySource, isWithin, normalizeRemotePath, s3Key, s3Prefix, sortEntries } from "./paths";
import { FailureLog, FsError, mapLimit, Tally, type CountLimits, type DownloadSource, type RemoteFs, type UploadSink, type WriteOptions } from "./remoteFs";

// S3 has no folders: "a/b/" prefixes act as folders and an empty "a/b/"
// object marks one created on purpose. Every listing is paginated (1000 keys
// per page) and bulk deletes check the per-key errors S3 reports with a 200.

const COPY_CONCURRENCY = 8;
// CopyObject handles up to 5 GiB; larger objects are copied in parts.
const MAX_SINGLE_COPY = 5 * 1024 ** 3;
const COPY_PART_SIZE = 512 * 1024 ** 2;
const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
// DeleteObjects takes at most 1000 keys.
const DELETE_BATCH = 1000;
const STREAM_BUFFER = 1024 * 1024;

type S3ErrorShape = { name?: string; Code?: string; code?: string; $metadata?: { httpStatusCode?: number } };

export function s3Error(err: unknown, path: string): FsError {
    if (err instanceof FsError) return err;
    const shape = (err ?? {}) as S3ErrorShape;
    const name = shape.name || shape.Code || "";
    const status = shape.$metadata?.httpStatusCode;
    const message = errorMessage(err);
    if (name === "NoSuchBucket") return new FsError("NOT_FOUND", `The bucket does not exist: ${message}`);
    if (name === "NoSuchKey" || name === "NotFound" || status === 404) return new FsError("NOT_FOUND", `${path}: no such file or folder`);
    if (["AccessDenied", "InvalidAccessKeyId", "SignatureDoesNotMatch", "AllAccessDisabled"].includes(name) || status === 403) {
        return new FsError("PERMISSION_DENIED", `${path}: access denied (${message})`);
    }
    if (name === "AbortError") return new FsError("CANCELLED", "The transfer was cancelled");
    if (name === "TimeoutError" || /timed? ?out/i.test(message)) return new FsError("TIMEOUT", `${path}: the storage service did not answer in time`);
    if (["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET"].includes(shape.code ?? "")) {
        return new FsError("NOT_CONNECTED", `Cannot reach the storage service: ${message}`);
    }
    return new FsError("FAILED", `${path}: ${message}`);
}

const DIR_STAT: FileStat = { isDir: true, isLink: false, size: 0, mtime: 0, permissions: 0 };

function fileStat(size: number | undefined, modified: Date | undefined): FileStat {
    return { isDir: false, isLink: false, size: size ?? 0, mtime: modified ? Math.floor(modified.getTime() / 1000) : 0, permissions: 0 };
}

function nameOf(key: string): string {
    return key.replace(/\/+$/, "").split("/").pop() ?? "";
}

export class S3Fs implements RemoteFs {
    readonly protocol = "s3";
    readonly transport: FileTransport;

    constructor(readonly client: S3Client, readonly bucket: string, secure: boolean) {
        this.transport = secure ? "https" : "http";
    }

    private async send<T>(path: string, run: () => Promise<T>): Promise<T> {
        try {
            return await run();
        } catch (err) {
            throw s3Error(err, path);
        }
    }

    // Every object under `prefix`, a page (up to 1000 keys) at a time.
    private async *pages(prefix: string, delimiter?: string): AsyncGenerator<ListObjectsV2CommandOutput> {
        let token: string | undefined;
        do {
            const page = await this.send(`/${prefix}`, () => this.client.send(new ListObjectsV2Command({
                Bucket: this.bucket, Prefix: prefix, Delimiter: delimiter, ContinuationToken: token
            })));
            yield page;
            token = page.IsTruncated ? page.NextContinuationToken : undefined;
        } while (token);
    }

    async home(): Promise<string> {
        return "/";
    }

    async list(path: string): Promise<ListResult> {
        const prefix = s3Prefix(path);
        const entries = new Map<string, FileEntry>();
        let hasMarker = false;
        let truncated = false;
        for await (const page of this.pages(prefix, "/")) {
            for (const common of page.CommonPrefixes ?? []) {
                const name = nameOf(common.Prefix ?? "");
                if (name) entries.set(`d:${name}`, { name, ...DIR_STAT });
            }
            for (const object of page.Contents ?? []) {
                const key = object.Key ?? "";
                if (key === prefix) {
                    hasMarker = true;
                    continue;
                }
                const name = nameOf(key);
                if (!name) continue;
                if (key.endsWith("/")) entries.set(`d:${name}`, { name, ...DIR_STAT });
                else entries.set(`f:${name}`, { name, ...fileStat(object.Size, object.LastModified) });
            }
            if (entries.size >= MAX_LIST_ENTRIES) {
                truncated = !!page.IsTruncated || entries.size > MAX_LIST_ENTRIES;
                break;
            }
        }
        // Prefixes only exist through their objects: nothing at all means the
        // folder does not exist (a typo in the path, a deleted folder).
        if (prefix && !hasMarker && entries.size === 0) throw new FsError("NOT_FOUND", `${path}: no such folder`);
        return { path, entries: sortEntries([...entries.values()].slice(0, MAX_LIST_ENTRIES)), truncated };
    }

    private async head(path: string): Promise<FileStat | null> {
        try {
            const head = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: s3Key(path) }));
            return fileStat(head.ContentLength, head.LastModified);
        } catch (err) {
            const mapped = s3Error(err, path);
            if (mapped.code === "NOT_FOUND") return null;
            throw mapped;
        }
    }

    private async prefixExists(path: string): Promise<boolean> {
        const page = await this.send(path, () => this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: s3Prefix(path), MaxKeys: 1 })));
        return (page.KeyCount ?? page.Contents?.length ?? 0) > 0;
    }

    async stat(path: string): Promise<FileStat | null> {
        if (normalizeRemotePath(path) === "/") return DIR_STAT;
        const object = await this.head(path);
        if (object) return object;
        return (await this.prefixExists(path)) ? DIR_STAT : null;
    }

    async readFile(path: string, maxBytes: number): Promise<{ data: Buffer; stat: FileStat }> {
        const stat = await this.head(path);
        if (!stat) throw new FsError((await this.prefixExists(path)) ? "NOT_A_FILE" : "NOT_FOUND", `${path}: no such file`);
        if (stat.size > maxBytes) throw new FsError("TOO_LARGE", `${path} is larger than ${maxBytes} bytes`);
        const { stream } = await this.openRead(path);
        const chunks: Buffer[] = [];
        let total = 0;
        try {
            for await (const chunk of stream as AsyncIterable<Uint8Array>) {
                total += chunk.length;
                if (total > maxBytes) throw new FsError("TOO_LARGE", `${path} is larger than ${maxBytes} bytes`);
                chunks.push(Buffer.from(chunk));
            }
        } catch (err) {
            stream.destroy();
            throw s3Error(err, path);
        }
        // An empty object is an empty file, not an error.
        return { data: Buffer.concat(chunks, total), stat };
    }

    async openRead(path: string): Promise<DownloadSource> {
        const abort = new AbortController();
        const object = await this.send(path, () => this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: s3Key(path) }), { abortSignal: abort.signal }));
        const body = object.Body;
        const stream = body instanceof Readable ? body : Readable.from([]);
        let ended = false;
        stream.once("end", () => { ended = true; });
        stream.once("close", () => { if (!ended) abort.abort(); });
        return { stream, size: object.ContentLength ?? null };
    }

    async openWrite(path: string, options: WriteOptions): Promise<UploadSink> {
        const key = s3Key(path);
        if (!key) throw new FsError("INVALID", "A file needs a name");
        if (!options.overwrite && (await this.head(path))) throw new FsError("EXISTS", `${path} already exists`);

        // Parts go out while data arrives and the object only appears once the
        // upload completes, so S3 uploads are atomic by themselves.
        const source = new PassThrough({ highWaterMark: STREAM_BUFFER });
        const upload = new Upload({
            client: this.client,
            params: { Bucket: this.bucket, Key: key, Body: source },
            queueSize: 4,
            partSize: UPLOAD_PART_SIZE,
            leavePartsOnError: false
        });
        let failure: FsError | null = null;
        let settled = false;
        const done = upload.done().then(() => undefined, (err: unknown) => {
            failure ??= s3Error(err, path);
            throw failure;
        });
        const failed = done.then(() => new Promise<never>(() => undefined));
        failed.catch(() => undefined);

        return {
            write: (chunk) => {
                if (failure) return Promise.reject(failure);
                if (settled) return Promise.reject(new FsError("INVALID", "The upload is already finished"));
                if (source.write(chunk)) return Promise.resolve();
                return Promise.race([new Promise<void>((resolve) => source.once("drain", resolve)), failed]);
            },
            commit: async () => {
                if (settled) throw new FsError("INVALID", "The upload is already finished");
                settled = true;
                source.end();
                await done;
            },
            abort: async () => {
                if (settled && !failure) return;
                settled = true;
                failure ??= new FsError("CANCELLED", "The upload was cancelled");
                await upload.abort().catch(() => undefined);
                source.destroy();
                await done.catch(() => undefined);
            }
        };
    }

    async mkdir(path: string): Promise<void> {
        const prefix = s3Prefix(path);
        if (!prefix) throw new FsError("EXISTS", "The bucket root already exists");
        if (await this.stat(path)) throw new FsError("EXISTS", `${path} already exists`);
        await this.send(path, () => this.client.send(new PutObjectCommand({ Bucket: this.bucket, Key: prefix, Body: Buffer.alloc(0) })));
    }

    private async copyObject(sourceKey: string, targetKey: string, size: number): Promise<void> {
        const copySource = encodeS3CopySource(this.bucket, sourceKey);
        if (size <= MAX_SINGLE_COPY) {
            await this.client.send(new CopyObjectCommand({ Bucket: this.bucket, CopySource: copySource, Key: targetKey }));
            return;
        }
        const { UploadId } = await this.client.send(new CreateMultipartUploadCommand({ Bucket: this.bucket, Key: targetKey }));
        try {
            const parts: { ETag?: string; PartNumber: number }[] = [];
            for (let start = 0, part = 1; start < size; start += COPY_PART_SIZE, part += 1) {
                const end = Math.min(start + COPY_PART_SIZE, size) - 1;
                const copied = await this.client.send(new UploadPartCopyCommand({
                    Bucket: this.bucket, Key: targetKey, UploadId, PartNumber: part, CopySource: copySource, CopySourceRange: `bytes=${start}-${end}`
                }));
                parts.push({ ETag: copied.CopyPartResult?.ETag, PartNumber: part });
            }
            await this.client.send(new CompleteMultipartUploadCommand({ Bucket: this.bucket, Key: targetKey, UploadId, MultipartUpload: { Parts: parts } }));
        } catch (err) {
            await this.client.send(new AbortMultipartUploadCommand({ Bucket: this.bucket, Key: targetKey, UploadId })).catch(() => undefined);
            throw err;
        }
    }

    // Deletes keys in one DeleteObjects call (at most 1000) and records the
    // keys S3 reports as failed. Returns how many were deleted.
    private async deleteKeys(keys: string[], failures: FailureLog): Promise<number> {
        if (!keys.length) return 0;
        let result;
        try {
            result = await this.client.send(new DeleteObjectsCommand({
                Bucket: this.bucket,
                Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true }
            }));
        } catch (err) {
            for (const key of keys) failures.add(`/${key}`, s3Error(err, `/${key}`));
            return 0;
        }
        const errors = result.Errors ?? [];
        for (const error of errors) failures.add(`/${error.Key ?? ""}`, new Error(`${error.Code ?? "Error"}: ${error.Message ?? "not deleted"}`));
        return keys.length - errors.length;
    }

    async rename(from: string, to: string, isDir: boolean): Promise<void> {
        if (!isDir) {
            const source = await this.head(from);
            if (!source) throw new FsError("NOT_FOUND", `${from}: no such file`);
            if (await this.stat(to)) throw new FsError("EXISTS", `${to} already exists`);
            await this.send(from, () => this.copyObject(s3Key(from), s3Key(to), source.size));
            await this.send(from, () => this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: s3Key(from) })));
            return;
        }

        if (isWithin(to, from)) throw new FsError("INVALID", `Cannot move ${from} into itself`);
        if (await this.stat(to)) throw new FsError("EXISTS", `${to} already exists`);
        const sourcePrefix = s3Prefix(from);
        const targetPrefix = s3Prefix(to);
        const failures = new FailureLog();
        let moved = 0;
        // Page by page: copy (bounded), then delete only the sources whose
        // copy succeeded, so a failure never loses data.
        for await (const page of this.pages(sourcePrefix)) {
            const copied: string[] = [];
            await mapLimit(page.Contents ?? [], COPY_CONCURRENCY, async (object: _Object) => {
                const key = object.Key ?? "";
                try {
                    await this.copyObject(key, targetPrefix + key.slice(sourcePrefix.length), object.Size ?? 0);
                    copied.push(key);
                } catch (err) {
                    failures.add(`/${key}`, s3Error(err, `/${key}`));
                }
            });
            moved += await this.deleteKeys(copied, failures);
        }
        if (failures.count) {
            throw new FsError("PARTIAL", `${failures.count} object(s) of ${from} could not be moved (${moved} moved)`, { failures: failures.items, failureCount: failures.count });
        }
        if (!moved) throw new FsError("NOT_FOUND", `${from}: no such folder`);
    }

    async remove(items: FileItemRef[]): Promise<DeleteResult> {
        const failures = new FailureLog();
        let deleted = 0;
        // Selected files go in DeleteObjects batches like folder contents.
        const keys = items.filter((item) => !item.isDir).map((item) => s3Key(item.path)).filter(Boolean);
        for (let start = 0; start < keys.length; start += DELETE_BATCH) {
            deleted += await this.deleteKeys(keys.slice(start, start + DELETE_BATCH), failures);
        }
        for (const item of items) {
            if (!item.isDir) continue;
            const prefix = s3Prefix(item.path);
            if (!prefix) {
                failures.add(item.path, new Error("The bucket root cannot be deleted"));
                continue;
            }
            try {
                for await (const page of this.pages(prefix)) {
                    deleted += await this.deleteKeys((page.Contents ?? []).map((object) => object.Key ?? "").filter(Boolean), failures);
                }
            } catch (err) {
                failures.add(item.path, err);
            }
        }
        return { deleted, failures: failures.items, failureCount: failures.count };
    }

    async count(items: FileItemRef[], limits: CountLimits): Promise<{ files: number; dirs: number; bytes: number; truncated: boolean }> {
        const tally = new Tally(limits);
        for (const item of items) {
            if (!item.isDir) {
                const stat = await this.head(item.path).catch(() => null);
                if (!tally.add({ isDir: false, size: stat?.size ?? 0 })) break;
                continue;
            }
            if (!tally.add({ isDir: true, size: 0 })) break;
            const prefix = s3Prefix(item.path);
            pages: for await (const page of this.pages(prefix)) {
                for (const object of page.Contents ?? []) {
                    const key = object.Key ?? "";
                    if (key === prefix) continue;
                    if (!tally.add({ isDir: key.endsWith("/"), size: object.Size ?? 0 })) break pages;
                }
            }
        }
        return tally.result();
    }

    close(): void {
        this.client.destroy();
    }
}
