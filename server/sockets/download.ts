import { body, parsePath, respond } from "../files/requests";
import { requireFs } from "./files";
import type { SocketSession } from "./session";

// Streamed downloads: files-download-start answers with the transfer id, then
// the file arrives as files-download-chunk events the client acknowledges
// (files-download-ack) and ends with files-download-end or -error.
export function registerDownloadHandlers(session: SocketSession): void {
    const { socket } = session;

    socket.on("files-download-start", (request, reply) => respond("files-download-start", reply, async () => {
        const path = parsePath(body(request).path);
        session.transfers.canDownload();
        const source = await requireFs(session).openRead(path);
        const transfer = session.transfers.addDownload(source, {
            chunk: (chunk) => socket.emit("files-download-chunk", chunk),
            end: (end) => socket.emit("files-download-end", end),
            error: (failure) => socket.emit("files-download-error", failure)
        });
        // Data starts flowing after the reply, which carries the id the
        // client needs to recognize the chunks.
        setImmediate(() => transfer.start());
        return { transferId: transfer.id, size: transfer.size, window: transfer.window };
    }));

    socket.on("files-download-ack", (ack) => {
        const fields = body(ack);
        if (typeof fields.seq === "number") session.transfers.download(fields.transferId)?.ack(fields.seq);
    });

    socket.on("files-download-cancel", (request) => {
        session.transfers.download(body(request).transferId)?.cancel();
    });
}
