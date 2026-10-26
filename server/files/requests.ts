import type { FileItemRef, FileReply, FileVersion } from "../../shared/files";
import { createLogger } from "../logger";
import { normalizeRemotePath } from "./paths";
import { FsError, toFileError } from "./remoteFs";

// Validation of file manager requests (they come from the network) and the
// single place that answers them.

const log = createLogger("files");

const MAX_PATH = 4096;
const MAX_ITEMS = 10_000;

type Body = Record<string, unknown>;

export function body(value: unknown): Body {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Body : {};
}

// An absolute path without control characters (a CR/LF would end an FTP
// command and start another one).
export function parsePath(value: unknown, field = "path"): string {
    if (typeof value !== "string" || !value || value.length > MAX_PATH) throw new FsError("INVALID", `${field} must be a path`);
    // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
    if (/[\u0000-\u001f\u007f]/.test(value)) throw new FsError("INVALID", `${field} contains control characters`);
    if (!value.startsWith("/")) throw new FsError("INVALID", `${field} must be an absolute path`);
    return normalizeRemotePath(value);
}

export function parseItems(value: unknown): FileItemRef[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > MAX_ITEMS) throw new FsError("INVALID", "items must be a non-empty list");
    return value.map((raw) => {
        const item = body(raw);
        const path = parsePath(item.path, "items.path");
        if (path === "/") throw new FsError("INVALID", "The root folder cannot be changed this way");
        return { path, isDir: item.isDir === true, isLink: item.isLink === true };
    });
}

export function parseCount(value: unknown, field: string): number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new FsError("INVALID", `${field} must be a non-negative integer`);
    return value;
}

export function parseVersion(value: unknown): FileVersion | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const version = body(value);
    return { size: parseCount(version.size, "expected.size"), mtime: parseCount(version.mtime, "expected.mtime") };
}

// Binary payloads arrive as a Buffer (or an ArrayBuffer from some clients).
export function parseBytes(value: unknown, maxBytes: number): Buffer {
    let bytes: Buffer | null = null;
    if (Buffer.isBuffer(value)) bytes = value;
    else if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
    else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (!bytes) throw new FsError("INVALID", "data must be binary");
    if (bytes.length > maxBytes) throw new FsError("TOO_LARGE", `data is larger than ${maxBytes} bytes`);
    return bytes;
}

// Answers one request through its acknowledgement. A request sent without
// one is ignored (there is nobody to answer, and calling it would throw).
// Whatever `work` throws, synchronously or not, becomes the error answer.
export function respond<T>(event: string, reply: unknown, work: () => Promise<T>): void {
    if (typeof reply !== "function") return;
    const answer = reply as FileReply<T>;
    new Promise<T>((resolve) => resolve(work())).then(
        (data) => answer({ ok: true, data }),
        (err: unknown) => {
            const error = toFileError(err);
            if (error.code === "FAILED") log.warn(`${event} failed: ${error.message}`);
            else log.debug(`${event}: ${error.code} ${error.message}`);
            answer({ ok: false, error });
        }
    );
}
