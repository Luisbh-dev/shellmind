import type { KnownHost } from "../../shared/types";
import { dbAll, dbGet, dbRun } from "./sqlite";

type PinEntry = Omit<KnownHost, "id" | "created_at">;

// Pinned SSH host keys (trust on first use), one per host, port and `via`:
// the jump hosts the host is reached through ("" for a direct connection,
// see server/ssh/hostKeys.ts routeVia).
export const knownHostsRepo = {
    async find(host: string, port: number, via = ""): Promise<KnownHost | null> {
        return (await dbGet<KnownHost>("SELECT * FROM known_hosts WHERE host = ? AND port = ? AND via = ?", [host, port, via])) ?? null;
    },

    // Pins a key unless one is already pinned for host:port on that route,
    // and returns the pinned entry (which differs from `entry` if another
    // connection won the race).
    async pin(entry: PinEntry): Promise<KnownHost> {
        const via = entry.via ?? "";
        await dbRun(
            `INSERT INTO known_hosts (host, port, via, key_type, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(host, port, via) DO NOTHING`,
            [entry.host, entry.port, via, entry.key_type, entry.fingerprint, Date.now()]
        );
        const pinned = await knownHostsRepo.find(entry.host, entry.port, via);
        if (!pinned) throw new Error(`Could not pin the host key of ${entry.host}:${entry.port}`);
        return pinned;
    },

    async list(): Promise<KnownHost[]> {
        return dbAll<KnownHost>("SELECT * FROM known_hosts ORDER BY host, port, via");
    },

    async remove(id: number): Promise<boolean> {
        const { changes } = await dbRun("DELETE FROM known_hosts WHERE id = ?", [id]);
        return changes > 0;
    },

    // Replaces the pinned key of host:port on the entry's route with `entry`,
    // but only while the pinned one is still `expected` (in one statement, so
    // no other connection can pin a key in between). Pins `entry` if nothing
    // is pinned. Returns the key pinned afterwards, whichever it is.
    async replace(entry: PinEntry, expected: string): Promise<KnownHost> {
        const via = entry.via ?? "";
        const { changes } = await dbRun(
            "UPDATE known_hosts SET key_type = ?, fingerprint = ?, created_at = ? WHERE host = ? AND port = ? AND via = ? AND fingerprint = ?",
            [entry.key_type, entry.fingerprint, Date.now(), entry.host, entry.port, via, expected]
        );
        if (changes > 0) {
            const pinned = await knownHostsRepo.find(entry.host, entry.port, via);
            if (pinned) return pinned;
        }
        return knownHostsRepo.pin(entry);
    }
};
