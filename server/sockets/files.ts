import { MAX_EDIT_BYTES, type FileSessionInfo, type FileStat, type FileVersion } from "../../shared/files";
import { baseName, pathNameProblem } from "../files/paths";
import { FsError, type RemoteFs } from "../files/remoteFs";
import { body, parseBytes, parseCount, parseItems, parsePath, parseVersion, respond } from "../files/requests";
import type { SocketSession } from "./session";

// Deleting a tree can take a while; counting it for the confirmation is cut
// short instead (the dialog then says "at least").
const COUNT_MAX_ENTRIES = 100_000;
const COUNT_MAX_MS = 15_000;
// An edited file may grow past what the editor opens, within reason.
const MAX_WRITE_BYTES = 4 * MAX_EDIT_BYTES;

export function requireFs(session: SocketSession): RemoteFs {
    if (session.fs) return session.fs;
    const reason = session.connectionError ? `: ${session.connectionError}` : "";
    throw new FsError("NOT_CONNECTED", `No file session is open${reason}`);
}

// A new name (mkdir, rename target, new file) must be a plain file name the
// protocol accepts there (see shared/remotePaths.ts).
function requireValidName(path: string, fs: RemoteFs): void {
    if (pathNameProblem(path, fs.protocol)) throw new FsError("INVALID", `"${baseName(path)}" is not a valid name`);
}

function changedSince(current: FileStat, expected: FileVersion): boolean {
    if (current.size !== expected.size) return true;
    // Some servers (FTP without MDTM) report no times: compare sizes only then.
    return expected.mtime > 0 && current.mtime > 0 && current.mtime !== expected.mtime;
}

// File manager requests on the socket's file session (SFTP, FTP or S3). Each
// one is answered through its acknowledgement (see shared/files.ts).
export function registerFileHandlers(session: SocketSession): void {
    const { socket } = session;

    socket.on("files-session", (reply) => respond("files-session", reply, async (): Promise<FileSessionInfo> => {
        const fs = requireFs(session);
        return {
            protocol: fs.protocol,
            transport: fs.transport,
            secure: fs.transport !== "ftp" && fs.transport !== "http",
            home: await fs.home().catch(() => "/"),
            maxEditBytes: MAX_EDIT_BYTES
        };
    }));

    socket.on("files-list", (request, reply) => respond("files-list", reply, () => {
        const path = parsePath(body(request).path);
        return requireFs(session).list(path);
    }));

    socket.on("files-stat", (request, reply) => respond("files-stat", reply, async () => {
        const path = parsePath(body(request).path);
        return { path, stat: await requireFs(session).stat(path) };
    }));

    socket.on("files-read", (request, reply) => respond("files-read", reply, async () => {
        const fields = body(request);
        const path = parsePath(fields.path);
        const maxBytes = fields.maxBytes === undefined ? MAX_EDIT_BYTES : Math.min(parseCount(fields.maxBytes, "maxBytes"), MAX_EDIT_BYTES);
        const { data, stat } = await requireFs(session).readFile(path, maxBytes);
        return { path, data, stat };
    }));

    socket.on("files-write", (request, reply) => respond("files-write", reply, async () => {
        const fields = body(request);
        const path = parsePath(fields.path);
        const data = parseBytes(fields.data, MAX_WRITE_BYTES);
        const expected = parseVersion(fields.expected);
        const force = fields.force === true;
        const fs = requireFs(session);

        const current = await fs.stat(path);
        if (current?.isDir) throw new FsError("NOT_A_FILE", `${path} is a folder`);
        if (!force && expected === null && current) throw new FsError("EXISTS", `${path} already exists`, { current });
        if (!force && expected && (!current || changedSince(current, expected))) {
            throw new FsError("CONFLICT", `${path} changed on the server since it was opened`, { current });
        }
        if (!current) requireValidName(path, fs);

        // All the data is here, so writing in place (a file in a folder that
        // is not writable) cannot be cut short by a slow client.
        const sink = await fs.openWrite(path, { overwrite: current !== null || force, size: data.length, whole: true, inPlace: true });
        try {
            if (data.length) await sink.write(data);
            await sink.commit();
        } catch (err) {
            await sink.abort();
            throw err;
        }
        return { path, stat: await fs.stat(path).catch(() => null) };
    }));

    socket.on("files-mkdir", (request, reply) => respond("files-mkdir", reply, async () => {
        const path = parsePath(body(request).path);
        const fs = requireFs(session);
        requireValidName(path, fs);
        await fs.mkdir(path);
        return { path };
    }));

    socket.on("files-rename", (request, reply) => respond("files-rename", reply, async () => {
        const fields = body(request);
        const from = parsePath(fields.from, "from");
        const to = parsePath(fields.to, "to");
        if (from === "/" || to === "/") throw new FsError("INVALID", "The root folder cannot be renamed");
        if (from === to) throw new FsError("INVALID", "The new name is the same as the old one");
        const fs = requireFs(session);
        requireValidName(to, fs);
        await fs.rename(from, to, fields.isDir === true);
        return { from, to };
    }));

    socket.on("files-delete", (request, reply) => respond("files-delete", reply, () => {
        const items = parseItems(body(request).items);
        return requireFs(session).remove(items);
    }));

    socket.on("files-count", (request, reply) => respond("files-count", reply, () => {
        const items = parseItems(body(request).items);
        return requireFs(session).count(items, { maxEntries: COUNT_MAX_ENTRIES, deadline: Date.now() + COUNT_MAX_MS });
    }));
}
