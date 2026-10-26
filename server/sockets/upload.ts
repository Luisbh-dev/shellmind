import { FILE_CHUNK_BYTES, UPLOAD_WINDOW } from "../../shared/files";
import { baseName, pathNameProblem } from "../files/paths";
import { FsError } from "../files/remoteFs";
import type { UploadTransfer } from "../files/transfers";
import { body, parseBytes, parseCount, parsePath, respond } from "../files/requests";
import { requireFs } from "./files";
import type { SocketSession } from "./session";

// Chunked uploads: start -> chunk* -> end (or cancel). The client keeps up to
// UPLOAD_WINDOW chunks in flight; each is acknowledged once written, so a
// failed write is reported for the chunk that hit it, never as a success.
export function registerUploadHandlers(session: SocketSession): void {
    const { socket } = session;

    socket.on("files-upload-start", (request, reply) => respond("files-upload-start", reply, async () => {
        const fields = body(request);
        const path = parsePath(fields.path);
        const size = parseCount(fields.size, "size");
        session.transfers.canUpload();
        const fs = requireFs(session);
        if (pathNameProblem(path, fs.protocol)) throw new FsError("INVALID", `"${baseName(path)}" is not a valid file name`);
        const sink = await fs.openWrite(path, { overwrite: fields.overwrite === true, size, inPlace: fields.inPlace === true });
        let transfer: UploadTransfer;
        try {
            // The connection may have been replaced, or other starts may have
            // taken the last slot, while this one was opening.
            if (session.fs !== fs) throw new FsError("NOT_CONNECTED", "The file session was closed");
            transfer = session.transfers.addUpload(path, size, sink);
        } catch (err) {
            await sink.abort();
            throw err;
        }
        return { transferId: transfer.id, chunkSize: FILE_CHUNK_BYTES, window: UPLOAD_WINDOW };
    }));

    socket.on("files-upload-chunk", (request, reply) => respond("files-upload-chunk", reply, async () => {
        const fields = body(request);
        const transfer = session.transfers.upload(fields.transferId);
        try {
            return await transfer.chunk(parseCount(fields.seq, "seq"), parseBytes(fields.data, FILE_CHUNK_BYTES));
        } catch (err) {
            // A failed upload is over: drop its partial data right away.
            if (session.transfers.takeUpload(transfer.id)) await transfer.abort();
            throw err;
        }
    }));

    socket.on("files-upload-end", (request, reply) => respond("files-upload-end", reply, async () => {
        const transfer = session.transfers.takeUpload(body(request).transferId);
        if (!transfer) throw new FsError("NOT_FOUND", "No such upload (it was cancelled or failed)");
        return transfer.end();
    }));

    socket.on("files-upload-cancel", (request, reply) => respond("files-upload-cancel", reply, async () => {
        const transferId = body(request).transferId;
        await session.transfers.takeUpload(transferId)?.abort();
        return { transferId: typeof transferId === "string" ? transferId : "" };
    }));
}
