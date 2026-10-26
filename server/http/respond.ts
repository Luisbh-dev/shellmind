import type { Request, Response } from "express";
import type { ApiErrorBody } from "../../shared/types";
import { AppError } from "../errors";
import { createLogger, redact } from "../logger";
import { HostKeyMismatchError } from "../ssh/hostKeys";

const log = createLogger("http");

// Every error answer of the API has the same shape (ApiErrorBody): a readable
// `error`, a stable `code` and, for some codes, `details`. Expected failures
// are AppErrors and keep their code and status; anything else is logged
// (redacted) and becomes a generic 500, because its message may quote a
// query, a path or a command line the client has no business seeing.
export function errorBody(code: string, message: string, details?: Record<string, unknown>): ApiErrorBody {
    return { error: message, code, ...(details ? { details } : {}) };
}

export function sendError(res: Response, err: unknown, context: string): void {
    if (res.headersSent) {
        // A stream already started: the status line is gone, all that is left is to end it.
        log.error(`${context} failed after the answer started`, redact(err));
        if (!res.writableEnded) res.end();
        return;
    }
    if (err instanceof AppError) {
        res.status(err.status).json(errorBody(err.code, err.message, err.details));
        return;
    }
    if (err instanceof HostKeyMismatchError) {
        res.status(409).json(errorBody(err.code, err.message, {
            host: err.host, port: err.port, keyType: err.keyType, expected: err.expected, actual: err.actual
        }));
        return;
    }
    log.error(`${context} failed`, redact(err));
    res.status(500).json(errorBody("INTERNAL", "Internal server error."));
}

// The 404 of a server id that does not exist (or is not an id at all).
export function serverNotFound(): AppError {
    return new AppError("SERVER_NOT_FOUND", "Server not found", 404);
}

// A positive integer route parameter, or null (answer 404 then).
export function routeId(value: unknown): number | null {
    const id = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// The JSON body as a plain object ({} when absent or not an object).
export function jsonBody(req: Request): Record<string, unknown> {
    const body: unknown = req.body;
    return body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
}
