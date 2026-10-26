import type { Response } from "express";
import { ConnectionTargetError } from "../connections/target";
import { AppError } from "../errors";
import { createLogger } from "../logger";
import { sshFailure } from "../ssh/connectionErrors";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { errorBody, sendError } from "./respond";

// HTTP side of the routes that run commands on a saved server (status and
// operations panels). The domain modules (server/status, server/ops) stay
// free of Express: they throw, and these helpers turn that into answers.

const log = createLogger("http");

// Aborts when the client goes away before the answer is sent, so the remote
// command (and its channel) does not outlive the request.
export function abortOnClose(res: Response): { signal: AbortSignal; dispose: () => void } {
    const controller = new AbortController();
    const onClose = () => {
        if (!res.writableFinished) controller.abort();
    };
    res.on("close", onClose);
    return { signal: controller.signal, dispose: () => res.off("close", onClose) };
}

// Connection failures (refused, unreachable, rejected credentials) become 502
// SSH_FAILED with a readable message and, in details.connection, the code the
// client words like a terminal's (AUTH_FAILED, ECONNREFUSED...); expected
// failures keep their code and status (a missing server is 404
// SERVER_NOT_FOUND). A server of a type the feature does not support gets the
// feature's own explanation.
export function sendRemoteError(res: Response, err: unknown, context: string, unsupportedMessage: string): void {
    if (res.headersSent || res.writableEnded) return;
    if (err instanceof ConnectionTargetError && err.code === "UNSUPPORTED_PURPOSE") {
        res.status(400).json(errorBody(err.code, unsupportedMessage));
        return;
    }
    if (err instanceof AppError || err instanceof HostKeyMismatchError) {
        sendError(res, err, context);
        return;
    }
    const { message, connection } = sshFailure(err);
    const text = message || "The server could not be reached";
    log.warn(`${context}: ${text}`);
    res.status(502).json(errorBody("SSH_FAILED", text, connection ? { connection } : undefined));
}
