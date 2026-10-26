import fs from 'node:fs';
import path from 'node:path';
import { utils, type Attributes, type SFTPWrapper } from 'ssh2';

// A writable SFTP server for tests, backed by a local directory: "/" is
// `root`, REALPATH(".") is `home`. It behaves like OpenSSH's sftp-server where
// it matters here (RENAME refuses to replace a file, readdir uses lstat) and
// can inject write failures (a full disk) and slow reads.

const { STATUS_CODE } = utils.sftp;

export type SftpDirectoryOptions = {
    home?: string;
    // Called before each WRITE; return true to fail it (like ENOSPC).
    failWrite?: (remotePath: string, offset: number) => boolean;
    // Delay (ms) before answering each READ / WRITE / STAT / READDIR.
    readDelayMs?: number;
    writeDelayMs?: number;
    statDelayMs?: number;
    readdirDelayMs?: number;
    // Counts the requests of each type waiting for their answer.
    stats?: SftpDirectoryStats;
    // Return true to refuse creating this (missing) file, like a folder that
    // is not writable; existing files in it can still be opened.
    denyCreate?: (remotePath: string) => boolean;
    // Longest name (in UTF-8 bytes) OPEN accepts; longer ones fail like
    // OpenSSH reports ENAMETOOLONG (SSH2_FX_BAD_MESSAGE).
    nameMax?: number;
    // Files READDIR reports as symbolic links (to themselves), without
    // needing the right to create real ones.
    reportAsLink?: (name: string) => boolean;
};

export type SftpDirectoryLog = string[];

// Requests in flight per type (READ, WRITE, STAT, READDIR) and the most seen at once.
export type SftpDirectoryStats = { inflight: Record<string, number>; peak: Record<string, number> };

export const createSftpStats = (): SftpDirectoryStats => ({ inflight: {}, peak: {} });

type Handle =
    | { kind: 'file'; fd: number; remote: string }
    | { kind: 'dir'; local: string; names: string[] | null };

// Like OpenSSH: a READDIR reply carries at most this many names (all of a
// large folder would not fit in one SSH packet).
const READDIR_BATCH = 100;

function statusFor(err: unknown): number {
    switch ((err as NodeJS.ErrnoException).code) {
        case 'ENOENT':
        case 'ENOTDIR':
            return STATUS_CODE.NO_SUCH_FILE;
        case 'EACCES':
        case 'EPERM':
            return STATUS_CODE.PERMISSION_DENIED;
        default:
            return STATUS_CODE.FAILURE;
    }
}

function attrsOf(stats: fs.Stats): Attributes {
    return {
        mode: stats.mode,
        uid: 0,
        gid: 0,
        size: stats.isDirectory() ? 0 : stats.size,
        atime: Math.floor(stats.atimeMs / 1000),
        mtime: Math.floor(stats.mtimeMs / 1000),
    };
}

export function serveSftpDirectory(sftp: SFTPWrapper, root: string, options: SftpDirectoryOptions = {}, log: SftpDirectoryLog = []): void {
    const handles = new Map<string, Handle>();
    let nextHandle = 0;
    const home = options.home ?? '/';

    const toLocal = (remote: string) => {
        const normalized = path.posix.normalize(`/${remote}`);
        return path.join(root, ...normalized.split('/').filter(Boolean));
    };
    const newHandle = (handle: Handle) => {
        const id = String(nextHandle++);
        handles.set(id, handle);
        return Buffer.from(id);
    };
    const listedAttrs = (name: string, stats: fs.Stats): Attributes => {
        const attrs = attrsOf(stats);
        return options.reportAsLink?.(name) ? { ...attrs, mode: (attrs.mode & ~0o170000) | 0o120000 } : attrs;
    };
    // Answers a request after `delayMs`, counting it as in flight meanwhile.
    const later = (type: string, delayMs: number | undefined, answer: () => void) => {
        const stats = options.stats;
        if (stats) {
            stats.inflight[type] = (stats.inflight[type] ?? 0) + 1;
            stats.peak[type] = Math.max(stats.peak[type] ?? 0, stats.inflight[type]);
        }
        const run = () => {
            if (stats) stats.inflight[type] -= 1;
            answer();
        };
        if (delayMs) setTimeout(run, delayMs);
        else run();
    };
    const attempt = (reqid: number, op: () => void) => {
        try {
            op();
        } catch (err) {
            sftp.status(reqid, statusFor(err));
        }
    };

    sftp.on('REALPATH', (reqid, remote) => {
        const resolved = path.posix.normalize(remote === '.' || remote === '' ? home : remote.startsWith('/') ? remote : `${home}/${remote}`);
        sftp.name(reqid, [{ filename: resolved, longname: resolved, attrs: { mode: 0o40755, uid: 0, gid: 0, size: 0, atime: 0, mtime: 0 } }]);
    });
    sftp.on('STAT', (reqid, remote) => later('STAT', options.statDelayMs, () => attempt(reqid, () => sftp.attrs(reqid, attrsOf(fs.statSync(toLocal(remote)))))));
    sftp.on('LSTAT', (reqid, remote) => attempt(reqid, () => sftp.attrs(reqid, attrsOf(fs.lstatSync(toLocal(remote))))));
    sftp.on('OPEN', (reqid, remote, flags, attrs) => attempt(reqid, () => {
        const mode = utils.sftp.flagsToString(flags) ?? 'r';
        if (options.nameMax !== undefined && Buffer.byteLength(path.posix.basename(remote)) > options.nameMax) {
            log.push(`open-refused:name-too-long:${remote}`);
            return sftp.status(reqid, STATUS_CODE.BAD_MESSAGE, 'Bad message');
        }
        if (options.denyCreate?.(remote) && !fs.existsSync(toLocal(remote))) {
            throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        }
        const fd = fs.openSync(toLocal(remote), mode, attrs?.mode ?? 0o644);
        log.push(`open:${mode}:${remote}`);
        sftp.handle(reqid, newHandle({ kind: 'file', fd, remote }));
    }));
    sftp.on('READ', (reqid, raw, offset, length) => {
        const handle = handles.get(raw.toString());
        if (handle?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
        const answer = () => attempt(reqid, () => {
            const buffer = Buffer.alloc(length);
            const read = fs.readSync(handle.fd, buffer, 0, length, offset);
            if (!read) sftp.status(reqid, STATUS_CODE.EOF);
            else sftp.data(reqid, buffer.subarray(0, read));
        });
        later('READ', options.readDelayMs, answer);
    });
    sftp.on('WRITE', (reqid, raw, offset, data) => {
        const handle = handles.get(raw.toString());
        if (handle?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
        if (options.failWrite?.(handle.remote, offset)) return sftp.status(reqid, STATUS_CODE.FAILURE, 'No space left on device');
        const answer = () => attempt(reqid, () => {
            fs.writeSync(handle.fd, data, 0, data.length, offset);
            sftp.status(reqid, STATUS_CODE.OK);
        });
        later('WRITE', options.writeDelayMs, answer);
    });
    sftp.on('FSTAT', (reqid, raw) => {
        const handle = handles.get(raw.toString());
        if (handle?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
        attempt(reqid, () => sftp.attrs(reqid, attrsOf(fs.fstatSync(handle.fd))));
    });
    sftp.on('FSETSTAT', (reqid, raw, attrs) => {
        const handle = handles.get(raw.toString());
        if (handle?.kind !== 'file') return sftp.status(reqid, STATUS_CODE.FAILURE);
        attempt(reqid, () => {
            if (attrs.mode !== undefined) fs.fchmodSync(handle.fd, attrs.mode & 0o7777);
            log.push(`fsetstat:${handle.remote}:${(attrs.mode ?? 0).toString(8)}`);
            sftp.status(reqid, STATUS_CODE.OK);
        });
    });
    sftp.on('SETSTAT', (reqid, remote, attrs) => attempt(reqid, () => {
        if (attrs.mode !== undefined) fs.chmodSync(toLocal(remote), attrs.mode & 0o7777);
        sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('CLOSE', (reqid, raw) => {
        const handle = handles.get(raw.toString());
        handles.delete(raw.toString());
        if (!handle) return sftp.status(reqid, STATUS_CODE.FAILURE);
        attempt(reqid, () => {
            if (handle.kind === 'file') fs.closeSync(handle.fd);
            sftp.status(reqid, STATUS_CODE.OK);
        });
    });
    sftp.on('OPENDIR', (reqid, remote) => attempt(reqid, () => {
        const local = toLocal(remote);
        if (!fs.statSync(local).isDirectory()) throw Object.assign(new Error('not a directory'), { code: 'ENOTDIR' });
        sftp.handle(reqid, newHandle({ kind: 'dir', local, names: null }));
    }));
    sftp.on('READDIR', (reqid, raw) => {
        const handle = handles.get(raw.toString());
        if (handle?.kind !== 'dir') return sftp.status(reqid, STATUS_CODE.FAILURE);
        // Answered in order, the next batch each time (like sftp-server).
        later('READDIR', options.readdirDelayMs, () => attempt(reqid, () => {
            handle.names ??= fs.readdirSync(handle.local);
            const names = handle.names.splice(0, READDIR_BATCH);
            if (!names.length) return sftp.status(reqid, STATUS_CODE.EOF);
            sftp.name(reqid, names.map((name) => ({
                filename: name,
                longname: name,
                attrs: listedAttrs(name, fs.lstatSync(path.join(handle.local, name))),
            })));
        }));
    });
    sftp.on('REMOVE', (reqid, remote) => attempt(reqid, () => {
        fs.unlinkSync(toLocal(remote));
        log.push(`remove:${remote}`);
        sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('RMDIR', (reqid, remote) => attempt(reqid, () => {
        fs.rmdirSync(toLocal(remote));
        log.push(`rmdir:${remote}`);
        sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('MKDIR', (reqid, remote) => attempt(reqid, () => {
        fs.mkdirSync(toLocal(remote));
        sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('RENAME', (reqid, from, to) => attempt(reqid, () => {
        if (fs.existsSync(toLocal(to))) return sftp.status(reqid, STATUS_CODE.FAILURE);
        fs.renameSync(toLocal(from), toLocal(to));
        log.push(`rename:${from}->${to}`);
        sftp.status(reqid, STATUS_CODE.OK);
    }));
    sftp.on('READLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
    sftp.on('SYMLINK', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
    sftp.on('EXTENDED', (reqid) => sftp.status(reqid, STATUS_CODE.OP_UNSUPPORTED));
}
