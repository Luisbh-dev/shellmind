import { describe, expect, it, vi } from "vitest";
import type { FileProtocol, FileResult } from "../../shared/files";
import type { RemoteFs, UploadSink } from "../files/remoteFs";
import { registerFileHandlers } from "./files";
import { createSession, type ShellMindSocket } from "./session";
import { registerUploadHandlers } from "./upload";

type Handler = (...args: unknown[]) => void;

// The files-* handlers of one session over a stand-in file system, called
// the way socket.io calls them (payload, then the acknowledgement).
function harness(protocol: FileProtocol) {
    const handlers = new Map<string, Handler>();
    const socket = { on: (event: string, handler: Handler) => handlers.set(event, handler) };
    const session = createSession(socket as unknown as ShellMindSocket);
    const sink: UploadSink = { write: async () => undefined, commit: async () => undefined, abort: async () => undefined };
    const fs = {
        protocol,
        transport: protocol === "s3" ? "https" : protocol === "ftp" ? "ftp" : "ssh",
        stat: vi.fn(async () => null),
        mkdir: vi.fn(async () => undefined),
        rename: vi.fn(async () => undefined),
        openWrite: vi.fn(async () => sink),
        close: () => undefined
    };
    session.fs = fs as unknown as RemoteFs;
    registerFileHandlers(session);
    registerUploadHandlers(session);
    const call = (event: string, payload: unknown) => new Promise<FileResult<unknown>>((resolve) => {
        const handler = handlers.get(event);
        if (!handler) throw new Error(`no handler for ${event}`);
        handler(payload, resolve);
    });
    return { fs, call };
}

describe("names of new files and folders", () => {
    // 200 accented letters: 400 bytes, beyond NAME_MAX but a fine S3 key.
    const accented = "é".repeat(200);
    const cjk = "文".repeat(100);

    it("refuses names beyond NAME_MAX on SFTP and FTP servers", async () => {
        for (const protocol of ["sftp", "ftp"] as const) {
            const { fs, call } = harness(protocol);
            expect(await call("files-upload-start", { path: `/srv/${accented}`, size: 1, overwrite: false }), protocol)
                .toMatchObject({ ok: false, error: { code: "INVALID" } });
            expect(await call("files-mkdir", { path: `/srv/${cjk}` })).toMatchObject({ ok: false, error: { code: "INVALID" } });
            expect(await call("files-rename", { from: "/srv/a", to: `/srv/${cjk}` })).toMatchObject({ ok: false, error: { code: "INVALID" } });
            expect(await call("files-write", { path: `/srv/${accented}`, data: Buffer.from("x"), expected: null })).toMatchObject({ ok: false, error: { code: "INVALID" } });
            expect(fs.openWrite).not.toHaveBeenCalled();
            expect(fs.mkdir).not.toHaveBeenCalled();
            expect(fs.rename).not.toHaveBeenCalled();
        }
    });

    // S3 limits only the whole key (1024 bytes): the byte rule of SFTP used
    // to refuse these names although the bucket takes them.
    it("takes them on S3, up to the key's limit", async () => {
        const { fs, call } = harness("s3");
        expect(await call("files-upload-start", { path: `/photos/${accented}`, size: 1, overwrite: false })).toMatchObject({ ok: true });
        expect(await call("files-mkdir", { path: `/photos/${cjk}` })).toMatchObject({ ok: true });
        expect(await call("files-rename", { from: "/photos/a", to: `/photos/${cjk}.jpg` })).toMatchObject({ ok: true });
        expect(await call("files-write", { path: `/photos/${accented}.txt`, data: Buffer.from("x"), expected: null })).toMatchObject({ ok: true });
        expect(fs.openWrite).toHaveBeenCalledTimes(2);
        expect(fs.mkdir).toHaveBeenCalledWith(`/photos/${cjk}`);

        expect(await call("files-upload-start", { path: `/photos/${"x".repeat(1100)}`, size: 1, overwrite: false }))
            .toMatchObject({ ok: false, error: { code: "INVALID" } });
        expect(await call("files-mkdir", { path: `/${"d".repeat(500)}/${"x".repeat(600)}` })).toMatchObject({ ok: false, error: { code: "INVALID" } });
        expect(fs.openWrite).toHaveBeenCalledTimes(2);
        expect(fs.mkdir).toHaveBeenCalledTimes(1);
    });
});
