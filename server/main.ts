import { createServer } from "http";
import { getSessionToken } from "./auth";
import { SERVE_WEB } from "./config";
import { startAuditRetention } from "./db/auditRetention";
import { initDatabase } from "./db/init";
import { errorMessage } from "./errors";
import { createApp } from "./http/app";
import { exitFatally, installCrashHandlers, listenAndReport, shutdownWithParent } from "./lifecycle";
import { createLogger } from "./logger";
import { stopMultiExecJobs } from "./multiexec/jobs";
import { createSocketServer } from "./sockets/io";
import { sshCryptoBindingAvailable, sshCryptoNotice } from "./ssh/cryptoBinding";
// --- W7-S6 embedded RDP ---
import { attachRdpGateway } from "./rdp/gateway";
import { tunnelManager } from "./tunnels/manager";
// --- W7-S1 fleet board ---
import { fleetMonitor } from "./fleet/monitor";

const log = createLogger("server");

// Builds the Express app, the HTTP server and the socket.io server without
// listening, so tests can boot the backend on a port of their choice.
// initDatabase() must have completed first.
export function createShellMindServer(options: { authToken?: string } = {}) {
    const authToken = options.authToken ?? getSessionToken().value;
    const app = createApp({ authToken });
    const httpServer = createServer(app);
    const io = createSocketServer(httpServer, { authToken });
    // --- W7-S6: the embedded Remote Desktop client's WebSocket gateway ---
    attachRdpGateway(httpServer);
    return { app, httpServer, io };
}

export type ShellMindServer = ReturnType<typeof createShellMindServer>;

const isLoopbackAddress = (host: string) => host === "localhost" || host === "::1" || /^127\./.test(host);

// Opens and migrates the database before listening, so the "ready" message
// never reaches the parent while the schema is still being created. Every
// startup failure (the database, a missing web build, the session token...)
// is fatal: the parent gets {type:"fatal"} and the process exits 1.
export async function start(options: { port: number; host?: string }): Promise<ShellMindServer | null> {
    installCrashHandlers();

    try {
        await initDatabase();
    } catch (err) {
        exitFatally(`Could not open the database: ${errorMessage(err)}`, err);
        return null;
    }

    try {
        return launch(options.port, options.host ?? "127.0.0.1");
    } catch (err) {
        exitFatally(`Could not start: ${errorMessage(err)}`, err);
        return null;
    }
}

function launch(port: number, host: string): ShellMindServer {
    const session = getSessionToken();
    const server = createShellMindServer({ authToken: session.value });
    let stopAuditRetention = () => {};

    shutdownWithParent(async () => {
        stopAuditRetention();
        // --- W7-S1 fleet board ---
        fleetMonitor.stop();
        // W7-S4: running multi-exec jobs are recorded as interrupted first.
        await stopMultiExecJobs();
        await Promise.all([new Promise<void>((resolve) => server.io.close(() => resolve())), tunnelManager.stopAll()]);
    });

    listenAndReport(server.httpServer, { port, host }, (listeningPort) => {
        void tunnelManager.startAutoStart();
        stopAuditRetention = startAuditRetention();
        // --- W7-S1 fleet board ---
        fleetMonitor.start();
        const url = `http://${host.includes(":") ? `[${host}]` : host}:${listeningPort}`;
        log.info(`Backend ready on ${url}${SERVE_WEB ? " (serving the web UI)" : ""}`);
        const cryptoNotice = sshCryptoNotice(sshCryptoBindingAvailable());
        if (cryptoNotice) log.warn(cryptoNotice);
        if (!isLoopbackAddress(host)) {
            log.warn(`Listening on ${host}, not loopback: put a TLS reverse proxy in front and list its name in ALLOWED_HOSTS / ALLOWED_ORIGINS.`);
        }
        if (session.generated) {
            // Printed on purpose regardless of LOG_LEVEL: it is the only way in.
            // eslint-disable-next-line no-console
            console.log(`Access token: ${session.value}`);
        } else if (session.value.length < 16) {
            log.warn("SHELLMIND_AUTH_TOKEN is short; use at least 32 random characters.");
        }
    });

    return server;
}
