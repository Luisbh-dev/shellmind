// Fleet board (W7-S1): the health of every saved SSH server on one screen.
// The backend checks each Linux/Windows server in one of two ways: a health
// check (a short read-only script over its pooled SSH connection, which logs
// in) or a reachability check (it connects to the SSH port and reads the
// server's greeting, without logging in). It keeps the latest snapshot per
// server. GET /api/fleet lists them and the "fleet-health" socket event
// pushes what changed. It is triage, not a monitoring system: it keeps the
// latest reading only, and checks only while the backend runs.
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

import type { StatusPlatform } from "./status";
import type { HealthIssue } from "./thresholds";
import type { ServerType } from "./types";

// Server types the fleet board checks (reached over SSH).
export const FLEET_SERVER_TYPES: readonly ServerType[] = ["linux", "windows"];

export function isFleetServerType(type: ServerType | string | undefined): boolean {
    return (FLEET_SERVER_TYPES as readonly string[]).includes(type ?? "");
}

// ok / warn / critical: the verdict of shared/thresholds.ts on the reading;
// unknown: never checked, or the host reported none of the metrics;
// up: it answers a reachability check (its SSH server, or only the Remote
// Desktop port of a Windows server: see FleetSnapshot.reachedVia), but no
// current health reading says how it is doing; unreachable: no SSH
// connection could be made; error: the server was reached but the check
// failed (rejected credentials, a changed host key, a script that did not
// finish...).
export type FleetState = "ok" | "warn" | "critical" | "unreachable" | "error" | "unknown" | "up";

// How a server answered: its SSH server, or only the Remote Desktop port of
// a Windows server whose SSH port did not answer (the terminal, Status,
// multi-exec and health checks cannot reach it then).
export type FleetReachedVia = "ssh" | "rdp";

// Most urgent first: the order of "Needs attention".
export const FLEET_STATES: readonly FleetState[] = ["critical", "unreachable", "error", "warn", "unknown", "up", "ok"];

export function fleetStateRank(state: FleetState): number {
    const rank = FLEET_STATES.indexOf(state);
    return rank === -1 ? FLEET_STATES.length : rank;
}

export function needsAttention(state: FleetState): boolean {
    return state === "critical" || state === "unreachable" || state === "error" || state === "warn";
}

// A server entering one of these states (confirmed by a second check) raises
// an alert: a desktop notification when they are on.
export const FLEET_ALERT_STATES = ["critical", "unreachable"] as const;
export type FleetAlertState = typeof FLEET_ALERT_STATES[number];

export function isAlertState(state: FleetState): state is FleetAlertState {
    return (FLEET_ALERT_STATES as readonly string[]).includes(state);
}

// Why automatic checks of a server stopped until someone acts (they never
// retry by themselves, so a wrong password cannot lock an account or trip
// fail2ban): its credentials were rejected ("auth"), its host key changed
// ("host-key"), or its saved configuration cannot be used ("config": a key
// file that cannot be read, a secret saved with another data key...). A
// change of its connection (address, port, user, credentials, key file, jump
// host), trusting the new host key or "Check now" lift it; other edits
// (name, notes, tags...) do not.
export type FleetHold = "auth" | "host-key" | "config";

// The connection failures of each hold (codes of server/ssh/connectionErrors.ts
// and server/connections/target.ts). The status dashboard stops polling on
// them too: trying again by itself would only repeat them. W7 integration:
// the SSH agent and identity failures of S2 are holds as well.
const AUTH_HOLD_CODES: readonly string[] = ["AUTH_FAILED", "PRIVATE_KEY_INVALID", "AGENT_FAILED"];
const CONFIG_HOLD_CODES: readonly string[] = [
    "SECRET_UNREADABLE", "PRIVATE_KEY_FILE", "JUMP_HOST", "UNSUPPORTED_PURPOSE", "SERVER_NOT_FOUND", "INVALID_SERVER_ID", "AGENT_UNAVAILABLE", "IDENTITY"
];

export function holdForCode(code: string | null | undefined): FleetHold | null {
    if (!code) return null;
    if (code === "HOST_KEY_MISMATCH") return "host-key";
    if (AUTH_HOLD_CODES.includes(code)) return "auth";
    return CONFIG_HOLD_CODES.includes(code) ? "config" : null;
}

// Why the health checks of a server wait although it is not on hold itself,
// worked out from the other servers (never stored):
//   jump-host  a jump host of its route is on hold: checking the server would
//              log in to that jump host again (or knock on its changed key).
//              It lasts until that hold is lifted.
//   login      the same login (its user name, or its saved identity) was just
//              rejected on `servers` servers in a row: the password may have
//              changed everywhere, and more attempts could lock the account.
//              Automatic checks and "Check all" leave the server alone until
//              that login works again somewhere (checking it by name tries).
export type FleetBlock =
    | { kind: "jump-host"; serverId: number; hold: FleetHold }
    | { kind: "login"; user: string; identity: boolean; servers: number };

export type PackageManager = "apt" | "dnf" | "yum" | "zypper" | "apk" | "pacman";

export type FleetUpdates = {
    manager: PackageManager;
    // Pending upgrades as the package cache knows them: the check never
    // refreshes it (no apt update / dnf makecache).
    count: number;
    // Of those, security updates; null when the manager cannot tell.
    security: number | null;
    // When the package cache was last refreshed (epoch ms), if known.
    cacheAt: number | null;
};

// What a check read from the server.
export type FleetMetrics = {
    platform: StatusPlatform;
    hostname: string;
    os: string;
    kernel: string | null;
    uptimeSeconds: number | null;
    // Epoch ms of the last boot (the check's time minus the uptime).
    bootedAt: number | null;
    cores: number | null;
    // Windows: processor load at the time of the check (%). Linux hosts
    // report the load average instead: the check takes no one-second sample.
    cpuPercent: number | null;
    load: { one: number; five: number; fifteen: number } | null;
    // The one-minute load average per core (null without a load average).
    loadPerCore: number | null;
    memory: { usagePercent: number; totalMB: number; availableMB: number } | null;
    swapPercent: number | null;
    // The fullest local filesystem: the one that fills up, and the one the
    // health counts.
    disk: { mount: string; usagePercent: number; freeGB: number; totalGB: number } | null;
    diskCount: number;
    // systemd units in the failed state (null without systemd, e.g. Windows).
    failedUnits: number | null;
    loggedInUsers: number | null;
    // A reboot is pending (new kernel or libraries, Windows servicing);
    // null when the host gives no way to tell.
    rebootRequired: boolean | null;
    updates: FleetUpdates | null;
};

export type FleetError = {
    // AUTH_FAILED, HOST_KEY_MISMATCH, ECONNREFUSED, EXEC_TIMEOUT... (the
    // codes of server/ssh/connectionErrors.ts and server/errors.ts).
    code: string;
    // The backend's English text.
    message: string;
    // What the client fills its own wording with (host, port, target...).
    details?: Record<string, string | number>;
    // The failure happened on the way, at this jump host of the route.
    jumpServerId?: number;
};

export type FleetSnapshot = {
    serverId: number;
    state: FleetState;
    // What made the verdict (worst first), as shared/thresholds.ts grades it.
    issues: HealthIssue[];
    // The latest successful reading. It stays when a later check fails, and
    // is then as old as `lastSeenAt`.
    metrics: FleetMetrics | null;
    // The latest check, whatever its kind and outcome (epoch ms).
    checkedAt: number | null;
    // The latest time the server answered (a health check that read it, or
    // a reachability check), and how (null: it never answered).
    lastSeenAt: number | null;
    reachedVia: FleetReachedVia | null;
    // The latest time its SSH server answered: when only the Remote Desktop
    // port answers now, whether SSH ever did.
    sshSeenAt: number | null;
    // The latest health check that read the server: when `metrics` are from.
    readAt: number | null;
    // Why the latest check failed (null when it succeeded).
    error: FleetError | null;
    // SSH connect, handshake and authentication, as last measured (a check
    // that reuses a connection that is already open measures none).
    handshakeMs: number | null;
    // The latest check from start to end.
    durationMs: number | null;
    // Failed checks in a row; automatic retries back off with it.
    failures: number;
    hold: FleetHold | null;
    // Its health checks wait for another server (see FleetBlock).
    blocked: FleetBlock | null;
    // false: left out of automatic checks (Settings: excludedServerIds).
    monitored: boolean;
    // A check is running now.
    checking: boolean;
    // When the next automatic check is due (null: none is planned).
    nextCheckAt: number | null;
};

// Minutes between two automatic checks of a server.
export const FLEET_INTERVALS = [1, 5, 10, 15, 30, 60] as const;
export type FleetIntervalMinutes = typeof FLEET_INTERVALS[number];

export function isFleetInterval(value: unknown): value is FleetIntervalMinutes {
    return typeof value === "number" && (FLEET_INTERVALS as readonly number[]).includes(value);
}

// Reachability checks run at most this often, whatever the interval: each
// leaves a "connection closed" line in the server's log, which fail2ban's
// aggressive mode counts (5 in 10 minutes, by default).
export const FLEET_REACH_MIN_MINUTES = 5;

export type FleetSettings = {
    // Automatic health checks in the background. Off by default: they log in
    // and show up in the servers' auth logs, so they are something to opt into.
    enabled: boolean;
    // While health checks are off: automatic reachability checks of the
    // servers reached directly (no jump host). They do not log in, so they are
    // on by default.
    reachability: boolean;
    intervalMinutes: FleetIntervalMinutes;
    // Desktop notifications when a server turns critical or unreachable.
    notifications: boolean;
    // Servers left out of automatic checks ("Check now" still works).
    excludedServerIds: number[];
};

export const DEFAULT_FLEET_SETTINGS: FleetSettings = {
    enabled: false,
    reachability: true,
    intervalMinutes: 5,
    notifications: true,
    excludedServerIds: []
};

export const FLEET_LIMITS = {
    // Checks running at the same time.
    concurrency: 6,
    // Server ids in one refresh request, and excluded servers kept.
    maxIds: 1000
} as const;

// Minutes between two automatic reachability checks of a server.
export function reachIntervalMinutes(settings: Pick<FleetSettings, "intervalMinutes">): number {
    return Math.max(settings.intervalMinutes, FLEET_REACH_MIN_MINUTES);
}

// GET /api/fleet, and the answer to "fleet-subscribe".
export type FleetBoard = {
    settings: FleetSettings;
    // One per saved Linux/Windows server, by id.
    snapshots: FleetSnapshot[];
};

// A server entered an alert state, confirmed by a second check in a row.
export type FleetAlert = {
    serverId: number;
    state: FleetAlertState;
    // The state before (null when it had none).
    previous: FleetState | null;
    at: number;
};

// "fleet-health": what changed since the last event (or the board).
export type FleetHealthEvent = {
    snapshots?: FleetSnapshot[];
    // Servers that are no longer on the board (deleted, or no SSH server any more).
    removed?: number[];
    alerts?: FleetAlert[];
    settings?: FleetSettings;
};

// Body of POST /api/fleet/refresh: health checks, at once. Without `ids`:
// every monitored server whose checks are neither on hold nor blocked.
export type FleetRefreshRequest = { ids?: number[] };

export type FleetRefreshSkipReason =
    | "not-found"     // no saved server with that id
    | "unsupported"   // not a Linux/Windows (SSH) server
    | "jump-host";    // a jump host of its route is on hold: check that one first

export type FleetRefreshResult = {
    // Checks started or queued.
    queued: number[];
    skipped: Array<{ serverId: number; reason: FleetRefreshSkipReason }>;
};
