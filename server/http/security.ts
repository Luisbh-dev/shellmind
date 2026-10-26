import express, { type ErrorRequestHandler, type RequestHandler } from "express";
import { bearerToken, tokensMatch } from "../auth";
import { createLogger, redact } from "../logger";
import { errorBody } from "./respond";

const log = createLogger("http");

export function securityHeaders(): RequestHandler {
    return (req, res, next) => {
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Frame-Options", "DENY");
        // API answers carry hosts, settings and terminal-adjacent data.
        if (req.path.startsWith("/api/")) res.setHeader("Cache-Control", "no-store");
        next();
    };
}

// Every route mounted after this middleware needs the session token.
export function requireAuth(token: string): RequestHandler {
    return (req, res, next) => {
        if (tokensMatch(token, bearerToken(req.headers.authorization))) return next();
        res.setHeader("WWW-Authenticate", 'Bearer realm="ShellMind"');
        res.status(401).json(errorBody("UNAUTHORIZED", "Authentication required"));
    };
}

const MB = 1024 * 1024;

// The chat sends the conversation history and terminal context, and the
// history route stores whole conversations; a configuration export carries
// every server's notes and every snippet. Everything else is small.
export const DEFAULT_JSON_LIMIT = 1 * MB;
export const CHAT_JSON_LIMIT = 8 * MB;
export const IMPORT_JSON_LIMIT = 8 * MB;

const isChatRoute = (path: string) => path === "/api/chat" || path.startsWith("/api/chat/history/");
const isImportRoute = (path: string) => path === "/api/import" || path === "/api/import/preview";

export function jsonBodyParser(): RequestHandler {
    const chatParser = express.json({ limit: CHAT_JSON_LIMIT });
    const importParser = express.json({ limit: IMPORT_JSON_LIMIT });
    const defaultParser = express.json({ limit: DEFAULT_JSON_LIMIT });
    return (req, res, next) =>
        (isChatRoute(req.path) ? chatParser : isImportRoute(req.path) ? importParser : defaultParser)(req, res, next);
}

export const notFound: RequestHandler = (req, res) => {
    res.status(404).json(errorBody("NOT_FOUND", `Not found: ${req.method} ${req.path}`));
};

type HttpError = Error & { status?: number; statusCode?: number; type?: string; limit?: number; expose?: boolean };

const formatSize = (bytes: number) => (bytes >= MB ? `${Math.round(bytes / MB)} MB` : `${Math.round(bytes / 1024)} kB`);

// Final handler: always the error envelope, never a stack trace. Body-parser errors keep
// their status (413, 400, 415); anything else is a logged 500.
export const errorHandler: ErrorRequestHandler = (err: HttpError, req, res, next) => {
    if (res.headersSent) return next(err);

    const status = Number(err?.status ?? err?.statusCode);
    if (err?.type === "entity.too.large" || status === 413) {
        const limit = typeof err.limit === "number" ? ` (limit ${formatSize(err.limit)})` : "";
        res.status(413).json(errorBody("PAYLOAD_TOO_LARGE", `Request body is too large${limit}.`));
        return;
    }
    if (err?.type === "entity.parse.failed") {
        res.status(400).json(errorBody("MALFORMED_JSON", "Malformed JSON in request body."));
        return;
    }
    if (status >= 400 && status < 500) {
        res.status(status).json(errorBody("BAD_REQUEST", err.expose && err.message ? err.message : "Bad request."));
        return;
    }

    log.error(`Unhandled error in ${req.method} ${req.path}`, redact(err));
    res.status(500).json(errorBody("INTERNAL", "Internal server error."));
};
