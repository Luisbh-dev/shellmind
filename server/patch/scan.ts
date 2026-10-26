import { isPatchServerType, PATCH_LIMITS, type PatchScan, type PatchScanError } from "../../shared/patch";
import type { ServerSummary } from "../../shared/types";
import { serversRepo } from "../db/serversRepo";
import { AppError } from "../errors";
import { fleetEndpoint } from "../fleet/repo";
import { createLogger } from "../logger";
import { cleanStderr, runPosixScript, runPowerShell } from "../ops/remote";
import { connectionError } from "../ssh/connectionErrors";
import { ExecAbortedError } from "../ssh/exec";
import { sshPool, type SshLease } from "../ssh/pool";
import { parseLinuxScan, parseWindowsScan } from "./parse";
import { LINUX_SCAN_SCRIPT, windowsScanScript } from "./scripts";

// Reading a server's updates (read-only, see scripts.ts) and keeping the
// latest reading of every server while the backend runs. A reading belongs to
// the server's connection as it was: editing its address, port, user, jump
// host or identity drops it.

const log = createLogger("patch");

export const SCAN_TIMEOUT_MS = {
    linux: 150_000,
    // A Windows Update search answered from the cache.
    windows: 120_000,
    // One that asks Windows Update (or WSUS) again.
    windowsOnline: 900_000
};

export type ScanOptions = {
    signal?: AbortSignal;
    // Windows: search online (the refresh of its "package lists").
    online?: boolean;
};

export type ScanDeps = {
    acquire: (serverId: number) => Promise<SshLease>;
    now: () => number;
};

const defaultDeps: ScanDeps = {
    acquire: (serverId) => sshPool.acquire(serverId),
    now: () => Date.now()
};

type Entry = { fingerprint: string; scan: PatchScan | null; error: PatchScanError | null };

const entries = new Map<number, Entry>();
// Scans running now, per server.
const running = new Map<number, number>();

export function isScanning(serverId: number): boolean {
    return (running.get(serverId) ?? 0) > 0;
}

// The connection a reading depends on, as the SSH pool makes it: the
// address (normalized), the SSH port (a Windows server's `port` is its RDP
// port), the jump host, the user and the identity.
export function connectionFingerprint(server: Pick<ServerSummary, "type" | "ip" | "port" | "ssh_port" | "username" | "jump_server_id" | "identity_id">): string {
    return [fleetEndpoint(server), server.username ?? "", server.identity_id ?? ""].join("|");
}

export function notPatchable(): AppError {
    return new AppError("PATCH_UNSUPPORTED", "The patch center only reads Linux and Windows servers (over SSH).", 400);
}

async function patchServer(serverId: number): Promise<ServerSummary> {
    const server = await serversRepo.getSummary(serverId);
    if (!server) throw new AppError("SERVER_NOT_FOUND", "Server not found", 404);
    if (!isPatchServerType(server.type)) throw notPatchable();
    return server;
}

export function scanError(err: unknown, at: number): PatchScanError {
    const { code, message } = connectionError(err, "PATCH_SCAN_FAILED");
    return { code, message: message.slice(0, 1000), at };
}

// The scan on a lease the caller holds.
async function scanOnLease(lease: SshLease, options: ScanOptions = {}, deps: Pick<ScanDeps, "now"> = defaultDeps): Promise<PatchScan> {
    const started = deps.now();
    const windows = lease.target.os === "windows";
    const timeoutMs = windows ? (options.online ? SCAN_TIMEOUT_MS.windowsOnline : SCAN_TIMEOUT_MS.windows) : SCAN_TIMEOUT_MS.linux;
    const result = windows
        ? await runPowerShell(lease, windowsScanScript(Boolean(options.online)), { timeoutMs, signal: options.signal })
        : await runPosixScript(lease, LINUX_SCAN_SCRIPT, { timeoutMs, signal: options.signal });
    const timing = { serverId: lease.serverId, scannedAt: deps.now(), durationMs: deps.now() - started };
    try {
        return windows ? parseWindowsScan(result.stdout, timing) : parseLinuxScan(result.stdout, timing);
    } catch (err) {
        const reason = cleanStderr(result.stderr) || (err as Error).message;
        throw new AppError("PATCH_SCAN_FAILED", `Could not read the server's updates: ${reason.slice(0, 500)}`, 502, { exitCode: result.code });
    }
}

// Scans a saved server and remembers the outcome (a failure too). Throws
// what made it fail.
export async function scanServer(serverId: number, options: ScanOptions = {}, deps: ScanDeps = defaultDeps): Promise<PatchScan> {
    const server = await patchServer(serverId);
    const fingerprint = connectionFingerprint(server);
    let lease: SshLease | null = null;
    running.set(serverId, (running.get(serverId) ?? 0) + 1);
    try {
        lease = await deps.acquire(serverId);
        const scan = await scanOnLease(lease, options, deps);
        entries.set(serverId, { fingerprint, scan, error: null });
        return scan;
    } catch (err) {
        if (!(err instanceof ExecAbortedError) && !options.signal?.aborted) {
            const previous = entries.get(serverId);
            const error = scanError(err, deps.now());
            entries.set(serverId, { fingerprint, scan: previous?.fingerprint === fingerprint ? previous.scan : null, error });
            log.debug(`Update check of server #${serverId} failed: ${error.message}`);
        }
        throw err;
    } finally {
        lease?.release();
        const left = (running.get(serverId) ?? 1) - 1;
        if (left > 0) running.set(serverId, left);
        else running.delete(serverId);
    }
}

// The latest reading of a server and its latest failure, while its
// connection is the same as when it was taken.
export function cachedScan(server: ServerSummary): { scan: PatchScan | null; error: PatchScanError | null } {
    const entry = entries.get(server.id);
    if (!entry) return { scan: null, error: null };
    if (entry.fingerprint !== connectionFingerprint(server)) {
        entries.delete(server.id);
        return { scan: null, error: null };
    }
    return { scan: entry.scan, error: entry.error };
}

// Readings of servers that no longer exist go.
export function forgetScansExcept(ids: ReadonlySet<number>): void {
    for (const id of entries.keys()) if (!ids.has(id)) entries.delete(id);
}

export type ScanEvent =
    | { type: "start"; serverId: number }
    | { type: "scan"; serverId: number; scan: PatchScan }
    | { type: "error"; serverId: number; error: PatchScanError };

// Scans several servers, a few at a time, reporting each as it goes. A
// server that cannot be read is reported and the others go on.
export async function scanMany(ids: number[], onEvent: (event: ScanEvent) => void, signal: AbortSignal, deps: ScanDeps = defaultDeps): Promise<void> {
    const queue = [...new Set(ids)];
    const worker = async () => {
        for (let serverId = queue.shift(); serverId !== undefined && !signal.aborted; serverId = queue.shift()) {
            onEvent({ type: "start", serverId });
            try {
                onEvent({ type: "scan", serverId, scan: await scanServer(serverId, { signal }, deps) });
            } catch (err) {
                if (signal.aborted) return;
                onEvent({ type: "error", serverId, error: scanError(err, deps.now()) });
            }
        }
    };
    await Promise.all(Array.from({ length: Math.min(PATCH_LIMITS.scanConcurrency, queue.length) }, worker));
}
