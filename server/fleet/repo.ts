import fs from "fs/promises";
import {
    DEFAULT_FLEET_SETTINGS,
    FLEET_LIMITS,
    FLEET_STATES,
    isAlertState,
    isFleetInterval,
    type FleetAlertState,
    type FleetError,
    type FleetHold,
    type FleetMetrics,
    type FleetReachedVia,
    type FleetSettings,
    type FleetSnapshot,
    type FleetState
} from "../../shared/fleet";
import type { HealthIssue } from "../../shared/thresholds";
import { normalizeHost } from "../../shared/hostRoutes";
import { effectivePort } from "../../shared/ports";
import type { ServerSummary } from "../../shared/types";
import { expandHome } from "../connections/target";
import { settingsRepo } from "../db/settingsRepo";
import { dbAll, dbGet, dbRun } from "../db/sqlite";
import { createLogger } from "../logger";

// The latest health check of each server (table health_snapshots, migration
// 12) and the fleet settings (one JSON setting). Only the backend writes
// either, so what is read back is trusted to be of its own making, but a row
// that does not parse is dropped rather than trusted.

const log = createLogger("fleet");

export const FLEET_SETTINGS_KEY = "FLEET_SETTINGS";

// What lifts a hold (see FleetHold): the connection of the server (and of its
// jump chain) as it was when the check failed, and for a changed host key,
// the key that was refused, which the user may trust since.
export type HoldContext = {
    version: string;
    hostKey?: { host: string; port: number; via: string; actual: string };
};

// The part of a snapshot that is kept between runs of the backend, and what
// the alerting needs to carry over a restart.
export type StoredHealth = {
    snapshot: Omit<FleetSnapshot, "monitored" | "checking" | "nextCheckAt" | "blocked">;
    // Checks in a row that ended in snapshot.state.
    streak: number;
    // The alert state last raised for the server (cleared once it leaves it).
    alerted: FleetAlertState | null;
    holdContext: HoldContext | null;
    // Where the snapshot's readings were made (fleetEndpoint). null in rows
    // saved before it was recorded, taken to be of the current endpoint.
    endpoint: string | null;
};

// Where a server is checked: its type, address, SSH port and jump host. What
// the board read or saw of a server is of that endpoint: once the server is
// moved elsewhere, it says nothing about it.
export function fleetEndpoint(server: Pick<ServerSummary, "type" | "ip" | "port" | "ssh_port" | "jump_server_id">): string {
    return JSON.stringify([server.type, normalizeHost(server.ip ?? "").toLowerCase(), effectivePort(server, "terminal"), server.jump_server_id ?? null]);
}

type Row = { server_id: number; collected_at: number; state: string; data: string; error_code: string | null };

const HOLDS: readonly FleetHold[] = ["auth", "host-key", "config"];
const REACHED_VIA: readonly FleetReachedVia[] = ["ssh", "rdp"];

const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

function parseError(value: unknown): FleetError | null {
    if (!isRecord(value) || typeof value.code !== "string" || typeof value.message !== "string") return null;
    const details = isRecord(value.details)
        ? Object.fromEntries(Object.entries(value.details).filter((entry): entry is [string, string | number] => typeof entry[1] === "string" || typeof entry[1] === "number"))
        : {};
    const jump = numberOrNull(value.jumpServerId);
    return {
        code: value.code,
        message: value.message,
        ...(Object.keys(details).length ? { details } : {}),
        ...(jump !== null && Number.isSafeInteger(jump) && jump > 0 ? { jumpServerId: jump } : {})
    };
}

function parseHoldContext(value: unknown): HoldContext | null {
    if (!isRecord(value) || typeof value.version !== "string") return null;
    const key = value.hostKey;
    if (isRecord(key) && typeof key.host === "string" && typeof key.port === "number" && typeof key.via === "string" && typeof key.actual === "string") {
        return { version: value.version, hostKey: { host: key.host, port: key.port, via: key.via, actual: key.actual } };
    }
    return { version: value.version };
}

function parseRow(row: Row): StoredHealth | null {
    const state = row.state as FleetState;
    if (!FLEET_STATES.includes(state)) return null;
    let data: unknown;
    try {
        data = JSON.parse(row.data);
    } catch {
        return null;
    }
    if (!isRecord(data)) return null;
    const hold = HOLDS.includes(data.hold as FleetHold) ? data.hold as FleetHold : null;
    const alerted = typeof data.alerted === "string" && isAlertState(data.alerted as FleetState) ? data.alerted as FleetAlertState : null;
    const metrics = isRecord(data.metrics) ? data.metrics as FleetMetrics : null;
    const lastSeenAt = numberOrNull(data.lastSeenAt);
    // Rows saved before reachability checks: the reading was the last sighting.
    const readAt = numberOrNull(data.readAt) ?? (metrics ? lastSeenAt : null);
    return {
        snapshot: {
            serverId: row.server_id,
            state,
            issues: Array.isArray(data.issues) ? data.issues.filter(isRecord) as HealthIssue[] : [],
            metrics,
            checkedAt: numberOrNull(row.collected_at),
            lastSeenAt,
            // Rows saved before it was recorded: unknown until the next check
            // (SSH answered at least when the server was read).
            reachedVia: lastSeenAt !== null && REACHED_VIA.includes(data.reachedVia as FleetReachedVia) ? data.reachedVia as FleetReachedVia : null,
            sshSeenAt: numberOrNull(data.sshSeenAt) ?? readAt,
            readAt,
            error: parseError(data.error),
            handshakeMs: numberOrNull(data.handshakeMs),
            durationMs: numberOrNull(data.durationMs),
            failures: Math.max(0, Math.floor(numberOrNull(data.failures) ?? 0)),
            hold
        },
        streak: Math.max(0, Math.floor(numberOrNull(data.streak) ?? 0)),
        alerted,
        holdContext: hold ? parseHoldContext(data.holdContext) : null,
        endpoint: typeof data.endpoint === "string" ? data.endpoint : null
    };
}

export const fleetRepo = {
    async list(): Promise<StoredHealth[]> {
        const rows = await dbAll<Row>("SELECT server_id, collected_at, state, data, error_code FROM health_snapshots");
        const parsed: StoredHealth[] = [];
        for (const row of rows) {
            const health = parseRow(row);
            if (health) parsed.push(health);
            else log.warn(`Ignoring the unreadable health snapshot of server #${row.server_id}`);
        }
        return parsed;
    },

    // One server's (the AI diagnosis of a server it cannot reach reads it).
    async get(serverId: number): Promise<StoredHealth | null> {
        const row = await dbGet<Row>("SELECT server_id, collected_at, state, data, error_code FROM health_snapshots WHERE server_id = ?", [serverId]);
        return row ? parseRow(row) : null;
    },

    async save(health: StoredHealth): Promise<void> {
        const { snapshot } = health;
        const data = JSON.stringify({
            issues: snapshot.issues,
            metrics: snapshot.metrics,
            lastSeenAt: snapshot.lastSeenAt,
            reachedVia: snapshot.reachedVia,
            sshSeenAt: snapshot.sshSeenAt,
            readAt: snapshot.readAt,
            error: snapshot.error,
            handshakeMs: snapshot.handshakeMs,
            durationMs: snapshot.durationMs,
            failures: snapshot.failures,
            hold: snapshot.hold,
            streak: health.streak,
            alerted: health.alerted,
            holdContext: health.holdContext,
            endpoint: health.endpoint
        });
        // A server deleted while its check ran has no row to refer to: the
        // foreign key turns the insert into a no-op instead of an orphan.
        await dbRun(
            `INSERT INTO health_snapshots (server_id, collected_at, state, data, error_code)
             SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM servers WHERE id = ?)
             ON CONFLICT(server_id) DO UPDATE SET collected_at = excluded.collected_at, state = excluded.state,
                data = excluded.data, error_code = excluded.error_code`,
            [snapshot.serverId, snapshot.checkedAt ?? 0, snapshot.state, data, snapshot.error?.code ?? null, snapshot.serverId]
        );
    },

    // The snapshot of a server that left the board without being deleted
    // (its type changed): it must not come back if the type is changed back.
    async remove(serverId: number): Promise<void> {
        await dbRun("DELETE FROM health_snapshots WHERE server_id = ?", [serverId]);
    }
};

// A saved secret's marker: the random IV it was last encrypted with, which
// changes whenever the secret is written again (the secret itself is never
// read here). Blank when there is none. Plaintext cannot be left after the
// startup migration; it would read as "?".
const secretMarker = (column: string) =>
    `CASE WHEN ${column} IS NULL OR ${column} = '' THEN '' WHEN substr(${column}, 1, 7) = 'enc:v1:' THEN substr(${column}, 8, 16) ELSE '?' END`;

async function keyFileMarker(file: string): Promise<string> {
    try {
        const info = await fs.stat(expandHome(file));
        return `${info.size}:${Math.round(info.mtimeMs)}`;
    } catch {
        return "missing";
    }
}

// Per Linux/Windows server, a marker that changes whenever its credentials
// change: a saved password, key or passphrase written again, or its private
// key file replaced, its own or those of the identity it signs in with (S2:
// the identity's user name and agent setting too). Part of the connection
// version that lifts holds.
export async function credentialMarkers(servers: ServerSummary[]): Promise<Map<number, string>> {
    const rows = await dbAll<{ id: number; password: string; private_key: string; passphrase: string; identity: string | null; identity_key_path: string | null }>(
        `SELECT s.id, ${secretMarker("s.password")} AS password, ${secretMarker("s.privateKey")} AS private_key, ${secretMarker("s.passphrase")} AS passphrase,
            CASE WHEN i.id IS NULL THEN NULL ELSE ${secretMarker("i.password")} || '|' || ${secretMarker("i.privateKey")} || '|' || ${secretMarker("i.passphrase")}
                || '|' || i.use_agent || '|' || COALESCE(i.username, '') END AS identity,
            i.private_key_path AS identity_key_path
         FROM servers s LEFT JOIN identities i ON i.id = s.identity_id WHERE s.type IN ('linux', 'windows')`
    );
    const markers = new Map(rows.map((row) => [row.id, `${row.password}|${row.private_key}|${row.passphrase}${row.identity === null ? "" : `|identity:${row.identity}`}`]));
    const identityKeyFiles = new Map(rows.filter((row) => row.identity_key_path).map((row) => [row.id, row.identity_key_path as string]));
    await Promise.all(servers.map(async (server) => {
        let marker = markers.get(server.id);
        if (marker === undefined) return;
        if (server.private_key_path) marker = `${marker}|${await keyFileMarker(server.private_key_path)}`;
        const identityKey = identityKeyFiles.get(server.id);
        if (identityKey) marker = `${marker}|identity-key:${await keyFileMarker(identityKey)}`;
        markers.set(server.id, marker);
    }));
    return markers;
}

// Saved settings, each field checked on its own: a value that does not fit
// (an older or hand-edited one) falls back to its default.
export function parseFleetSettings(raw: string | null): FleetSettings {
    let value: unknown = null;
    try {
        value = raw ? JSON.parse(raw) : null;
    } catch {
        value = null;
    }
    const stored = isRecord(value) ? value : {};
    const excluded = Array.isArray(stored.excludedServerIds) ? stored.excludedServerIds : [];
    return {
        enabled: typeof stored.enabled === "boolean" ? stored.enabled : DEFAULT_FLEET_SETTINGS.enabled,
        reachability: typeof stored.reachability === "boolean" ? stored.reachability : DEFAULT_FLEET_SETTINGS.reachability,
        intervalMinutes: isFleetInterval(stored.intervalMinutes) ? stored.intervalMinutes : DEFAULT_FLEET_SETTINGS.intervalMinutes,
        notifications: typeof stored.notifications === "boolean" ? stored.notifications : DEFAULT_FLEET_SETTINGS.notifications,
        excludedServerIds: [...new Set(excluded.filter((id): id is number => Number.isSafeInteger(id) && id > 0))].slice(0, FLEET_LIMITS.maxIds)
    };
}

export async function loadFleetSettings(): Promise<FleetSettings> {
    return parseFleetSettings(await settingsRepo.get(FLEET_SETTINGS_KEY));
}

export async function saveFleetSettings(settings: FleetSettings): Promise<void> {
    await settingsRepo.set(FLEET_SETTINGS_KEY, JSON.stringify(settings));
}
