import net from "net";
import { ExecAbortedError } from "../ssh/exec";

// The fleet board's reachability check: it opens a TCP connection to a
// server's SSH port and waits for the SSH server's greeting, then hangs up
// without sending anything. No login, no credentials: the server logs at
// most a "connection closed" line. Servers reached through a jump host are
// not checked this way (reaching them needs the jump host's login).

// Connecting and the greeting together.
export const REACH_TIMEOUT_MS = 8000;
// RFC 4253 allows other lines before the identification string; a server
// that sends this much without one is not an SSH server.
const MAX_GREETING_BYTES = 8192;

// rdpPort: a Windows server's Remote Desktop port (see reachServer).
export type ReachEndpoint = { host: string; port: number; rdpPort?: number };

export type ReachResult = {
    // Connected and greeted, in milliseconds.
    ms: number;
    // The identification line (e.g. "SSH-2.0-OpenSSH_9.6"), cut to 255 characters.
    greeting: string;
    // "rdp": the SSH port did not answer, the Remote Desktop port did.
    service?: "rdp";
};

function coded(code: string, message: string): Error {
    return Object.assign(new Error(message), { code });
}

// Resolves once the SSH server greeted; rejects with a coded error
// (ECONNREFUSED, EHOSTUNREACH, ENOTFOUND, ETIMEDOUT, HANDSHAKE_TIMEOUT,
// CONNECTION_CLOSED, NOT_SSH) or an ExecAbortedError when `signal` ends it.
export function reachSsh(endpoint: ReachEndpoint, signal: AbortSignal, timeoutMs = REACH_TIMEOUT_MS): Promise<ReachResult> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        const where = `${endpoint.host}:${endpoint.port}`;
        let connected = false;
        let received = "";
        let settled = false;
        const socket = new net.Socket();

        const finish = (err: Error | null, result?: ReachResult) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            socket.removeAllListeners("data");
            socket.removeAllListeners("close");
            // Errors after the outcome (a reset while closing) are of no interest.
            socket.on("error", () => undefined);
            socket.destroy();
            if (err) reject(err);
            else resolve(result!);
        };
        const onAbort = () => finish(new ExecAbortedError());
        const timer = setTimeout(() => finish(connected
            ? coded("HANDSHAKE_TIMEOUT", `${where} accepted the connection but sent no SSH greeting within ${timeoutMs / 1000}s`)
            : coded("ETIMEDOUT", `Connecting to ${where} timed out after ${timeoutMs / 1000}s`)), timeoutMs);

        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });

        socket.on("connect", () => {
            connected = true;
        });
        socket.on("data", (chunk: Buffer) => {
            received += chunk.toString("latin1");
            const lines = received.split("\n");
            // The last piece may be a line still arriving.
            for (const line of lines.slice(0, -1)) {
                if (line.startsWith("SSH-")) {
                    finish(null, { ms: Date.now() - started, greeting: line.replace(/\r$/, "").slice(0, 255) });
                    return;
                }
            }
            if (received.length > MAX_GREETING_BYTES) finish(coded("NOT_SSH", `Something answers on ${where}, but not an SSH server`));
        });
        socket.on("error", (err) => finish(err));
        socket.on("close", () => finish(coded("CONNECTION_CLOSED", `${where} closed the connection before the SSH server greeted`)));
        socket.connect({ host: endpoint.host, port: endpoint.port });
    });
}

// Resolves with the time it took once something accepts a TCP connection on
// the endpoint, then hangs up without sending anything.
export function reachTcp(endpoint: { host: string; port: number }, signal: AbortSignal, timeoutMs = REACH_TIMEOUT_MS): Promise<number> {
    return new Promise((resolve, reject) => {
        const started = Date.now();
        let settled = false;
        const socket = new net.Socket();
        const finish = (err: Error | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            socket.on("error", () => undefined);
            socket.destroy();
            if (err) reject(err);
            else resolve(Date.now() - started);
        };
        const onAbort = () => finish(new ExecAbortedError());
        const timer = setTimeout(() => finish(coded("ETIMEDOUT", `Connecting to ${endpoint.host}:${endpoint.port} timed out after ${timeoutMs / 1000}s`)), timeoutMs);
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        socket.once("connect", () => finish(null));
        socket.on("error", (err) => finish(err));
        socket.connect({ host: endpoint.host, port: endpoint.port });
    });
}

// W7 integration: a Windows server is often reached over Remote Desktop
// only (no OpenSSH, ShellMind's embedded RDP). When its SSH port does not
// answer, its RDP port accepting a connection still says it is up (the board
// records and shows that only Remote Desktop answered: the terminal, Status
// and health checks need SSH); the SSH failure is reported only when neither
// answers.
export async function reachServer(endpoint: ReachEndpoint, signal: AbortSignal): Promise<ReachResult> {
    try {
        return await reachSsh(endpoint, signal);
    } catch (err) {
        const rdpPort = endpoint.rdpPort;
        if (rdpPort === undefined || rdpPort === endpoint.port || signal.aborted || err instanceof ExecAbortedError) throw err;
        try {
            return { ms: await reachTcp({ host: endpoint.host, port: rdpPort }, signal), greeting: "", service: "rdp" };
        } catch {
            throw err;
        }
    }
}
