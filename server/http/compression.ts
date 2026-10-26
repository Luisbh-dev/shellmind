import fs from "fs";
import path from "path";
import { promisify } from "util";
import zlib from "zlib";
import type { Request, RequestHandler, Response } from "express";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";

// Compressed text assets for the self-hosted web UI (`npm run serve`). The
// bundles are about three times smaller compressed, and the UI may be reached
// over a VPN or WAN without a compressing reverse proxy in front. Each file is
// compressed once per version (size + mtime) and kept in memory: the build is
// a fixed, small set of files. A precompressed sibling written by a build
// step (app.js.br / app.js.gz) is used as it is.

const log = createLogger("http");

export type Encoding = "br" | "gzip";

const COMPRESSIBLE = /\.(?:js|mjs|css|html|svg|json|map|txt|wasm|webmanifest)$/i;
// Below this the encoding overhead outweighs the saving.
export const MIN_COMPRESS_BYTES = 1024;
const MAX_COMPRESS_BYTES = 32 * 1024 * 1024;
const EXTENSION: Record<Encoding, string> = { br: ".br", gzip: ".gz" };

const brotli = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

// The encoding to answer with: Brotli when the client takes it, else gzip,
// else none. Honours q-values (q=0 refuses) and "*".
export function preferredEncoding(header: string | undefined): Encoding | null {
    if (!header) return null;
    const accepted = new Map<string, number>();
    for (const part of header.split(",")) {
        const [name, ...params] = part.trim().toLowerCase().split(";");
        const q = params.map((param) => /^\s*q=([\d.]+)\s*$/.exec(param)?.[1]).find((value) => value !== undefined);
        if (name) accepted.set(name, q === undefined ? 1 : Number(q));
    }
    const weight = (name: Encoding) => accepted.get(name) ?? accepted.get("*") ?? 0;
    if (weight("br") > 0 && weight("br") >= weight("gzip")) return "br";
    if (weight("gzip") > 0) return "gzip";
    return null;
}

function compress(data: Buffer, encoding: Encoding): Promise<Buffer> {
    return encoding === "br"
        ? brotli(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 9, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } })
        : gzip(data, { level: 9 });
}

type Version = { size: number; mtimeMs: number };
type Entry = Version & { encoded: Partial<Record<Encoding, Promise<Buffer>>> };

async function encodedFile(file: string, version: Version, encoding: Encoding): Promise<Buffer> {
    const sibling = `${file}${EXTENSION[encoding]}`;
    try {
        const info = await fs.promises.stat(sibling);
        if (info.isFile() && info.mtimeMs >= version.mtimeMs) return await fs.promises.readFile(sibling);
    } catch {
        // No precompressed copy.
    }
    return compress(await fs.promises.readFile(file), encoding);
}

// Serves the compressed form of the text files under `root` that the client
// accepts; anything else (or any failure) goes on to the next handler. Every
// answer for a text file, compressed or not, carries Vary: Accept-Encoding.
// `cacheControl` gives the Cache-Control of a file, as for the plain one.
export function compressedFiles(root: string, cacheControl: (file: string) => string): RequestHandler {
    const cache = new Map<string, Entry>();

    const lookup = async (file: string): Promise<Entry | null> => {
        let info: fs.Stats;
        try {
            info = await fs.promises.stat(file);
        } catch {
            return null;
        }
        if (!info.isFile() || info.size < MIN_COMPRESS_BYTES || info.size > MAX_COMPRESS_BYTES) return null;
        const known = cache.get(file);
        if (known && known.size === info.size && known.mtimeMs === info.mtimeMs) return known;
        const entry: Entry = { size: info.size, mtimeMs: info.mtimeMs, encoded: {} };
        cache.set(file, entry);
        return entry;
    };

    const answer = (req: Request, res: Response, file: string, entry: Entry, encoding: Encoding, body: Buffer) => {
        res.type(path.extname(file));
        res.setHeader("Content-Encoding", encoding);
        res.setHeader("Cache-Control", cacheControl(file));
        res.setHeader("ETag", `W/"${entry.size.toString(16)}-${Math.floor(entry.mtimeMs).toString(16)}-${encoding}"`);
        if (req.fresh) {
            res.status(304).end();
            return;
        }
        res.setHeader("Content-Length", String(body.length));
        if (req.method === "HEAD") res.end();
        else res.end(body);
    };

    return (req, res, next) => {
        if (req.method !== "GET" && req.method !== "HEAD") return next();
        if (!COMPRESSIBLE.test(req.path)) return next();
        // The plain answer of a text file depends on Accept-Encoding as much
        // as the compressed one: without Vary, a shared cache that first sees
        // a client sending none would hand the plain copy to every browser
        // (for a year, under assets/).
        res.vary("Accept-Encoding");
        const encoding = preferredEncoding(req.headers["accept-encoding"]);
        if (!encoding) return next();

        let relative: string;
        try {
            relative = decodeURIComponent(req.path);
        } catch {
            return next();
        }
        // Inside the build only, and never a dotfile (as express.static).
        const file = path.join(root, path.normalize(relative));
        const inside = path.relative(root, file);
        if (!inside || inside.startsWith("..") || path.isAbsolute(inside) || inside.split(path.sep).some((part) => part.startsWith("."))) {
            return next();
        }

        lookup(file)
            .then(async (entry) => {
                if (!entry) return next();
                const body = await (entry.encoded[encoding] ??= encodedFile(file, entry, encoding).catch((err: unknown) => {
                    delete entry.encoded[encoding];
                    throw err;
                }));
                if (cache.get(file) !== entry) return next();
                answer(req, res, file, entry, encoding, body);
            })
            .catch((err: unknown) => {
                log.warn(`Serving ${req.path} uncompressed: ${errorMessage(err)}`);
                if (!res.headersSent) next();
            });
    };
}
