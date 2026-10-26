import type { StatusSnapshot } from "../../shared/status";
import { loadConnectionTarget } from "../connections/target";
import { AppError } from "../errors";
import { cleanStderr, runPosixScript, runPowerShell } from "../ops/remote";
import { sshPool } from "../ssh/pool";
import { LINUX_STATUS_SCRIPT, parseLinuxStatus } from "./linux";
import { WINDOWS_STATUS_SCRIPT, parseWindowsStatus } from "./windows";

// One status report = one channel on the pooled connection, bounded by a
// timeout that kills the remote script. Concurrent requests for the same
// server (two windows, a poll racing a manual refresh) share one collection,
// which is cancelled only when every requester has gone away.

// PowerShell cold starts are slow.
export const STATUS_TIMEOUT_MS = { linux: 15_000, windows: 30_000 };

type Collection = {
    promise: Promise<StatusSnapshot>;
    controller: AbortController;
    waiters: number;
};

const inFlight = new Map<number, Collection>();

async function collect(serverId: number, signal: AbortSignal): Promise<StatusSnapshot> {
    const target = await loadConnectionTarget(serverId, "status");
    const lease = await sshPool.acquire(target.serverId);
    try {
        const windows = target.os === "windows";
        const options = { timeoutMs: windows ? STATUS_TIMEOUT_MS.windows : STATUS_TIMEOUT_MS.linux, signal };
        const result = windows
            ? await runPowerShell(lease, WINDOWS_STATUS_SCRIPT, options)
            : await runPosixScript(lease, LINUX_STATUS_SCRIPT, options);
        try {
            return windows ? parseWindowsStatus(result.stdout) : parseLinuxStatus(result.stdout);
        } catch (err) {
            const reason = cleanStderr(result.stderr) || (err as Error).message;
            throw new AppError("STATUS_UNAVAILABLE", `Could not read the server status: ${reason.slice(0, 500)}`, 502, { exitCode: result.code });
        }
    } finally {
        lease.release();
    }
}

export function collectStatus(serverId: number, signal?: AbortSignal): Promise<StatusSnapshot> {
    let entry = inFlight.get(serverId);
    if (!entry) {
        const controller = new AbortController();
        const created: Collection = { controller, waiters: 0, promise: collect(serverId, controller.signal) };
        // The requesters observe the outcome; this only clears the entry.
        created.promise.catch(() => undefined).finally(() => {
            if (inFlight.get(serverId) === created) inFlight.delete(serverId);
        });
        inFlight.set(serverId, created);
        entry = created;
    }
    const shared = entry;
    shared.waiters += 1;

    return new Promise<StatusSnapshot>((resolve, reject) => {
        let done = false;
        const leave = () => {
            if (done) return;
            done = true;
            signal?.removeEventListener("abort", onAbort);
            shared.waiters -= 1;
        };
        const onAbort = () => {
            leave();
            if (shared.waiters === 0) {
                if (inFlight.get(serverId) === shared) inFlight.delete(serverId);
                shared.controller.abort();
            }
            reject(signal?.reason ?? new Error("aborted"));
        };
        if (signal?.aborted) {
            onAbort();
            return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        shared.promise.then(
            (snapshot) => {
                if (done) return;
                leave();
                resolve(snapshot);
            },
            (err) => {
                if (done) return;
                leave();
                reject(err);
            }
        );
    });
}
