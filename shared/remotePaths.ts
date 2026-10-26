// Paths of the file manager, used by the backend and the explorer alike:
// absolute POSIX paths ("/srv/app/x.conf"). They are normalized lexically:
// "." and ".." segments are resolved (never above "/") and repeated or
// trailing slashes are dropped, so "/srv//app/./x/.." becomes "/srv/app".

import type { FileProtocol } from "./files";

export function normalizeRemotePath(path: string): string {
    const parts: string[] = [];
    for (const segment of path.split("/")) {
        if (!segment || segment === ".") continue;
        if (segment === "..") parts.pop();
        else parts.push(segment);
    }
    return "/" + parts.join("/");
}

export function parentPath(path: string): string {
    const normalized = normalizeRemotePath(path);
    const cut = normalized.lastIndexOf("/");
    return cut <= 0 ? "/" : normalized.slice(0, cut);
}

export function baseName(path: string): string {
    const normalized = normalizeRemotePath(path);
    return normalized.slice(normalized.lastIndexOf("/") + 1);
}

export function joinRemotePath(parent: string, name: string): string {
    return normalizeRemotePath(`${parent}/${name}`);
}

// True when `path` is `ancestor` itself or lies inside it.
export function isWithin(path: string, ancestor: string): boolean {
    const a = normalizeRemotePath(ancestor);
    const p = normalizeRemotePath(path);
    return a === "/" || p === a || p.startsWith(`${a}/`);
}

// Longest file name ext4, XFS, Btrfs and most servers accept (NAME_MAX). It
// counts bytes of the name's UTF-8 form, not characters.
export const MAX_NAME_BYTES = 255;
// S3 limits no single name, only an object's whole key (the path below the
// bucket): 1024 bytes of UTF-8.
export const MAX_S3_KEY_BYTES = 1024;

const encoder = new TextEncoder();

export function utf8Length(text: string): number {
    return encoder.encode(text).length;
}

// UTF-8 size of one code point (a lone surrogate is written as U+FFFD).
function codePointBytes(codePoint: number): number {
    if (codePoint < 0x80) return 1;
    if (codePoint < 0x800) return 2;
    return codePoint < 0x10000 ? 3 : 4;
}

// The longest start of `text` that fits in `maxBytes` UTF-8 bytes, never
// cutting a character (or a surrogate pair) in two.
export function truncateUtf8(text: string, maxBytes: number): string {
    let bytes = 0;
    let end = 0;
    for (const char of text) {
        const size = codePointBytes(char.codePointAt(0) ?? 0);
        if (bytes + size > maxBytes) break;
        bytes += size;
        end += char.length;
    }
    return text.slice(0, end);
}

// tooLong: beyond NAME_MAX (SFTP, FTP); keyTooLong: the S3 key would be.
export type NameProblem = "empty" | "slash" | "dots" | "tooLong" | "keyTooLong";

// Why `name` cannot be a single path segment a user creates in the folder
// `parent` (null: it can). SFTP and FTP servers limit each name to
// MAX_NAME_BYTES; S3 only the key, and its check keeps one byte for the "/"
// that ends a folder's key.
export function nameProblem(name: string, protocol: FileProtocol = "sftp", parent = "/"): NameProblem | null {
    if (!name) return "empty";
    if (name.includes("/") || name.includes("\0")) return "slash";
    if (name === "." || name === "..") return "dots";
    if (protocol === "s3") return utf8Length(joinRemotePath(parent, name)) > MAX_S3_KEY_BYTES ? "keyTooLong" : null;
    return utf8Length(name) > MAX_NAME_BYTES ? "tooLong" : null;
}

// The rule above for the last name of `path` (an upload target, a new
// folder, a rename target).
export function pathNameProblem(path: string, protocol: FileProtocol): NameProblem | null {
    return nameProblem(baseName(path), protocol, parentPath(path));
}

// Hidden sibling an upload is written to before it replaces `target`:
// ".<name>.shellmind-<suffix>.part", with the name shortened when the whole
// would not be a valid name any more.
export function temporaryUploadPath(target: string, suffix: string): string {
    const affix = `.shellmind-${suffix}.part`;
    const room = MAX_NAME_BYTES - utf8Length(affix) - 1;
    return joinRemotePath(parentPath(target), `.${truncateUtf8(baseName(target), room)}${affix}`);
}
