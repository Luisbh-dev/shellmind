import fs from "fs";
import path from "path";
import express, { type RequestHandler } from "express";
import { WEB_DIR } from "../config";
import { compressedFiles } from "./compression";

// The built web UI (`vite build` -> dist/) for self-hosting from the same
// origin as the API. Files are public; the UI asks for the access token.

// Tells the UI that the server which delivered the page is its backend (see
// getApiBase in src/lib/api.ts). A build opened any other way (vite preview,
// another static server) keeps calling the default local backend.
export const SAME_ORIGIN_MARKER = '<meta name="shellmind-api" content="same-origin">';

function findWebDir(): string | null {
    if (WEB_DIR) return path.resolve(WEB_DIR);
    // server/http under tsx, dist-server/server/http when compiled.
    let dir = __dirname;
    for (let depth = 0; depth < 4; depth++) {
        dir = path.dirname(dir);
        if (fs.existsSync(path.join(dir, "dist", "index.html"))) return path.join(dir, "dist");
    }
    return null;
}

export function withSameOriginMarker(html: string): string {
    if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, (end) => `${SAME_ORIGIN_MARKER}${end}`);
    // No <head>: right after the doctype, which must stay first.
    return html.replace(/^(\s*<!doctype[^>]*>)?/i, `$1${SAME_ORIGIN_MARKER}`);
}

export function serveWebUi(): RequestHandler {
    const webDir = findWebDir();
    if (!webDir || !fs.existsSync(path.join(webDir, "index.html"))) {
        throw new Error(`SERVE_WEB is set but no web build was found${webDir ? ` in ${webDir}` : ""}. Run \`npm run build\` or set WEB_DIR.`);
    }
    const indexFile = path.join(webDir, "index.html");

    // Vite fingerprints everything under assets/.
    const cacheControl = (filePath: string) =>
        path.relative(webDir, filePath).split(path.sep)[0] === "assets" ? "public, max-age=31536000, immutable" : "no-cache";
    const files = express.static(webDir, {
        index: false,
        dotfiles: "ignore",
        setHeaders: (res, filePath) => res.setHeader("Cache-Control", cacheControl(filePath))
    });
    // Text files go out compressed when the browser accepts it.
    const compressed = compressedFiles(webDir, cacheControl);
    const serveFile: RequestHandler = (req, res, next) => compressed(req, res, () => files(req, res, next));

    return (req, res, next) => {
        const isPage = req.path === "/" || req.path === "/index.html";
        if (!isPage || (req.method !== "GET" && req.method !== "HEAD")) return serveFile(req, res, next);
        // Read on every load: a rebuild is picked up, and index.html is tiny.
        fs.readFile(indexFile, "utf8", (error, html) => {
            if (error) return next(error);
            res.setHeader("Cache-Control", "no-cache");
            res.type("html").send(withSameOriginMarker(html));
        });
    };
}
