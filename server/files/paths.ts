import type { FileEntry } from "../../shared/files";
import { normalizeRemotePath } from "../../shared/remotePaths";

// Lexical path helpers and name rules are shared with the explorer; what
// follows is specific to FTP and S3.
export {
    baseName,
    isWithin,
    joinRemotePath,
    normalizeRemotePath,
    parentPath,
    pathNameProblem,
    temporaryUploadPath
} from "../../shared/remotePaths";

// FTP servers on Windows want "C:/dir" rather than "/C:/dir". Everything else
// is sent as is: quotes and backslashes are legal in names, and changing them
// would make an operation (DELE, RNTO, STOR) hit another file.
export function normalizeFtpPath(path: string): string {
    return /^\/[a-zA-Z]:/.test(path) ? path.substring(1) : path;
}

// A directory as an FTP server reports it (PWD): some Windows servers answer
// "C:\dir", which becomes "/C:/dir".
export function ftpReplyPath(reply: string): string {
    const path = reply.replace(/\\/g, "/");
    return normalizeRemotePath(path.startsWith("/") ? path : `/${path}`);
}

// S3 object key of a path: "/a/b.txt" -> "a/b.txt" (the root is "").
export function s3Key(path: string): string {
    return normalizeRemotePath(path).slice(1);
}

// Prefix of the objects inside a folder path: "/a" -> "a/" (the root is "").
export function s3Prefix(path: string): string {
    const key = s3Key(path);
    return key ? `${key}/` : "";
}

export function encodeS3CopySource(bucket: string, key: string): string {
    return `${bucket}/${encodeURIComponent(key).replace(/%2F/g, "/")}`;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// Folders first, then by name with numbers in natural order (file2 < file10).
export function compareEntries(a: FileEntry, b: FileEntry): number {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

export function sortEntries(entries: FileEntry[]): FileEntry[] {
    return entries.sort(compareEntries);
}
