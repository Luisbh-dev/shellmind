import type { Server as HttpServer } from "http";
import type { AddressInfo } from "net";
import { createLogger, redact } from "./logger";

// Process-level behaviour of the backend: how it reports startup to a parent
// process, how it dies, and how it shuts down. The Electron shell forks the
// backend with an IPC channel and relies on these messages; under a plain
// `node`/`tsx` run they are simply not sent.

const log = createLogger("process");

export type ParentMessage =
    | { type: "ready"; port: number }
    | { type: "fatal"; message: string };

const FATAL_EXIT_GRACE_MS = 1000;
const SHUTDOWN_GRACE_MS = 3000;

function notifyParent(message: ParentMessage, done: () => void = () => {}) {
    if (!process.send || !process.connected) return done();
    process.send(message, undefined, undefined, () => done());
}

// Logs the reason, tells the parent and exits non-zero. The exit does not wait
// on the parent for more than a second.
export function exitFatally(message: string, error?: unknown): void {
    log.error(message, ...(error === undefined ? [] : [error]));
    setTimeout(() => process.exit(1), FATAL_EXIT_GRACE_MS).unref();
    notifyParent({ type: "fatal", message }, () => process.exit(1));
}

// An uncaught exception leaves per-connection state half-updated, so the
// process exits instead of limping on; the Electron shell restarts it.
// Unhandled rejections are logged only.
export function installCrashHandlers(): void {
    process.on("uncaughtException", (error) => {
        exitFatally(`Uncaught exception: ${error?.message ?? String(error)}`, error);
    });
    process.on("unhandledRejection", (reason) => {
        log.error("Unhandled promise rejection", redact(reason));
    });
}

// Listens and reports {type:"ready", port} to the parent, or exits fatally
// (EADDRINUSE and friends) instead of lingering without a listening socket.
export function listenAndReport(
    httpServer: HttpServer,
    options: { port: number; host: string },
    onListening: (port: number) => void
): void {
    httpServer.once("error", (error: NodeJS.ErrnoException) => {
        const where = `${options.host}:${options.port}`;
        exitFatally(error.code === "EADDRINUSE"
            ? `Port ${where} is already in use.`
            : `Could not listen on ${where}: ${error.message}`);
    });

    httpServer.listen(options.port, options.host, () => {
        const { port } = httpServer.address() as AddressInfo;
        onListening(port);
        notifyParent({ type: "ready", port });
    });
}

// With a parent process: close cleanly on {type:"shutdown"}, and exit when the
// parent goes away so a crashed shell never leaves an orphaned backend behind.
export function shutdownWithParent(close: () => Promise<void>): void {
    if (!process.send) return;

    let closing = false;
    const shutdown = () => {
        if (closing) return;
        closing = true;
        log.info("Shutting down");
        setTimeout(() => process.exit(0), SHUTDOWN_GRACE_MS).unref();
        close().catch((error) => log.error("Shutdown failed", error)).finally(() => process.exit(0));
    };

    process.on("message", (message: { type?: unknown } | null) => {
        if (message?.type === "shutdown") shutdown();
    });
    process.on("disconnect", shutdown);
    // The parent may already be gone (it quit while this process was loading).
    if (!process.connected) shutdown();
}
