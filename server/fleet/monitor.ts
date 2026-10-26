import { createHash } from "crypto";
import { EventEmitter } from "events";
import {
    DEFAULT_FLEET_SETTINGS,
    FLEET_LIMITS,
    isFleetServerType,
    reachIntervalMinutes,
    type FleetAlert,
    type FleetBlock,
    type FleetBoard,
    type FleetHealthEvent,
    type FleetRefreshResult,
    type FleetSettings,
    type FleetSnapshot,
    type FleetState
} from "../../shared/fleet";
import { MAX_JUMP_HOPS, normalizeHost } from "../../shared/hostRoutes";
import { effectivePort } from "../../shared/ports";
import type { AuditInput, ServerSummary } from "../../shared/types";
import { recordAudit } from "../db/auditRepo";
import { knownHostsRepo } from "../db/knownHostsRepo";
import { serversRepo } from "../db/serversRepo";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import {
    awaitsConfirmation, classifyFailure, FLEET_TIMING, jittered, LOGIN_BREAKER_FAILURES, observeState, retryDelay,
    type AlertTrack, type FailureOutcome
} from "./policy";
import { ProbeError, probeServer, type ProbeResult } from "./probe";
import { reachServer, reachTcp, type ReachEndpoint, type ReachResult } from "./reach";
import { credentialMarkers, fleetEndpoint, fleetRepo, loadFleetSettings, saveFleetSettings, type HoldContext, type StoredHealth } from "./repo";

// The fleet scheduler: checks every saved Linux/Windows server in the
// background, a few at a time, each at its own jittered interval, and keeps
// the latest snapshot of each in memory and in the database. With health
// checks on, it logs in and reads the server; otherwise it only checks that
// the servers reached directly answer (no login). Failing servers back off;
// failures only someone can fix (rejected credentials, a changed host key)
// are never retried by themselves, and neither are the servers behind a jump
// host on hold, or other servers of a login rejected on several servers in a
// row. "Check now" runs a health check of whatever it names at once, on or
// off. Listeners get what changed in batches (the "fleet-health" socket event).

const log = createLogger("fleet");

export type FleetMonitorDeps = {
    probe: (serverId: number, signal: AbortSignal, route: number[]) => Promise<ProbeResult>;
    reach: (endpoint: ReachEndpoint, signal: AbortSignal) => Promise<ReachResult>;
    // A TCP connection to a Windows server's Remote Desktop port: the time it took.
    reachRdp: (endpoint: { host: string; port: number }, signal: AbortSignal) => Promise<number>;
    listServers: () => Promise<ServerSummary[]>;
    // Per server, a marker of its saved credentials (see repo.ts).
    credentialMarkers: (servers: ServerSummary[]) => Promise<Map<number, string>>;
    repo: {
        list: () => Promise<StoredHealth[]>;
        save: (health: StoredHealth) => Promise<void>;
        remove: (serverId: number) => Promise<void>;
    };
    loadSettings: () => Promise<FleetSettings>;
    saveSettings: (settings: FleetSettings) => Promise<void>;
    findHostKey: (host: string, port: number, via: string) => Promise<{ fingerprint: string } | null>;
    audit: (entry: AuditInput) => Promise<unknown>;
    now: () => number;
    random: () => number;
};

export type FleetMonitorOptions = {
    concurrency?: number;
    // How long changes are collected before listeners get them.
    flushMs?: number;
};

const defaultDeps: FleetMonitorDeps = {
    probe: (serverId, signal, route) => probeServer(serverId, signal, route),
    reach: (endpoint, signal) => reachServer(endpoint, signal),
    reachRdp: (endpoint, signal) => reachTcp(endpoint, signal),
    listServers: () => serversRepo.listSummaries(),
    credentialMarkers,
    repo: fleetRepo,
    loadSettings: loadFleetSettings,
    saveSettings: saveFleetSettings,
    findHostKey: (host, port, via) => knownHostsRepo.find(host, port, via),
    audit: recordAudit,
    now: () => Date.now(),
    random: () => Math.random()
};

// health: logs in and reads the server; reach: connects to its SSH port only
// (or, for a Windows server whose SSH port does not answer, its RDP port).
type CheckMode = "health" | "reach";

type Entry = {
    serverId: number;
    // The connection of the server and its jump chain, as last read: a
    // change lifts a hold.
    version: string;
    health: StoredHealth;
    track: AlertTrack;
    // When the next automatic check is due (Infinity: none).
    due: number;
    // Waiting for a check slot: asked for ("Check now", "Check all") or
    // automatic, and whether the server was named.
    queued: { requested: boolean; named: boolean } | null;
    running: { controller: AbortController; mode: CheckMode } | null;
    // The block last pushed to listeners (as JSON), to push its changes.
    shownBlock: string;
};

type LoginPause = Extract<FleetBlock, { kind: "login" }>;
// A login rejected on `rejected` servers since it last worked anywhere.
type LoginState = { rejected: number; pause: LoginPause | null };
const NO_LOGINS: ReadonlyMap<string, LoginState> = new Map();

export type FleetSettingsUpdate = Partial<FleetSettings>;

// What a server connects with (not its name, notes, tags...): a change of
// any of it lifts a hold and gets the server checked soon. `marker` changes
// whenever its saved secrets or its key file do.
function connectionStamp(server: ServerSummary, marker: string | undefined): string {
    const fields = [
        server.type,
        normalizeHost(server.ip ?? ""),
        effectivePort(server, "terminal"),
        server.username?.trim() || "root",
        server.jump_server_id ?? null,
        server.private_key_path ?? null,
        server.identity_id ?? null,
        marker ?? ""
    ];
    return createHash("sha256").update(JSON.stringify(fields)).digest("base64url").slice(0, 16);
}

// The connection of the server and of its jump hosts, as saved now.
function chainVersion(server: ServerSummary, byId: Map<number, ServerSummary>, markers: Map<number, string>): string {
    const parts: string[] = [];
    let current: ServerSummary | undefined = server;
    const seen = new Set<number>();
    while (current && !seen.has(current.id) && parts.length <= MAX_JUMP_HOPS) {
        seen.add(current.id);
        parts.push(`${current.id}:${connectionStamp(current, markers.get(current.id))}`);
        current = current.jump_server_id ? byId.get(current.jump_server_id) : undefined;
    }
    return parts.join(">");
}

const loginUser = (server: ServerSummary) => server.username?.trim() || "root";

// Servers that log in with the same account: the same saved identity, or
// else the same user name (a directory account is the same on every host).
function loginKey(server: ServerSummary): string {
    return server.identity_id ? `identity:${server.identity_id}` : `user:${loginUser(server).toLowerCase()}`;
}

function blankHealth(serverId: number): StoredHealth {
    return {
        snapshot: {
            serverId,
            state: "unknown",
            issues: [],
            metrics: null,
            checkedAt: null,
            lastSeenAt: null,
            reachedVia: null,
            sshSeenAt: null,
            readAt: null,
            error: null,
            handshakeMs: null,
            durationMs: null,
            failures: 0,
            hold: null
        },
        streak: 0,
        alerted: null,
        holdContext: null,
        endpoint: null
    };
}

// States a health check decided, which a reachability check leaves as they
// are (it says nothing about them).
const HEALTH_VERDICTS = new Set<FleetState>(["ok", "warn", "critical", "error"]);

const sameIds = (a: number[], b: number[]) => a.length === b.length && a.every((id, index) => id === b[index]);

export class FleetMonitor {
    private readonly deps: FleetMonitorDeps;
    private readonly concurrency: number;
    private readonly flushMs: number;
    private readonly events = new EventEmitter();
    private readonly entries = new Map<number, Entry>();
    // Every saved server by id (any type), as of the latest sync.
    private servers = new Map<number, ServerSummary>();
    private stored = new Map<number, StoredHealth>();
    private settings: FleetSettings = DEFAULT_FLEET_SETTINGS;
    private loaded = false;
    private loading: Promise<void> | null = null;
    private syncing: Promise<void> | null = null;
    private lastSync = 0;
    private timer: NodeJS.Timeout | null = null;
    private lastTick = 0;
    private active = 0;
    // Server ids waiting for a check slot: asked for (health checks), automatic.
    private readonly requestedQueue: number[] = [];
    private readonly queue: number[] = [];
    private pending: { snapshots: Set<number>; removed: Set<number>; alerts: FleetAlert[]; settings: boolean } = this.emptyPending();
    // Servers in planned maintenance (a patch run reboots them): until when.
    private readonly maintenance = new Map<number, number>();
    private flushTimer: NodeJS.Timeout | null = null;

    constructor(deps: Partial<FleetMonitorDeps> = {}, options: FleetMonitorOptions = {}) {
        this.deps = { ...defaultDeps, ...deps };
        this.concurrency = Math.max(1, options.concurrency ?? FLEET_LIMITS.concurrency);
        this.flushMs = options.flushMs ?? 150;
        this.events.setMaxListeners(0);
    }

    // Starts the automatic checks (they run while their settings are on).
    start(): void {
        if (this.timer) return;
        this.lastTick = 0;
        this.timer = setInterval(() => this.tick(), FLEET_TIMING.tickMs);
        this.timer.unref?.();
        this.tick();
    }

    // Stops the automatic checks and cancels the running ones.
    stop(): void {
        if (this.timer) clearInterval(this.timer);
        this.timer = null;
        if (this.flushTimer) clearTimeout(this.flushTimer);
        this.flushTimer = null;
        this.requestedQueue.length = 0;
        this.queue.length = 0;
        for (const entry of this.entries.values()) {
            entry.queued = null;
            entry.running?.controller.abort();
        }
    }

    // Changes, batched. Returns the function that stops listening.
    onChange(listener: (event: FleetHealthEvent) => void): () => void {
        this.events.on("change", listener);
        return () => this.events.off("change", listener);
    }

    // Reads the saved servers again first: one added a moment ago is on it.
    async board(): Promise<FleetBoard> {
        await this.ensureLoaded();
        await this.sync(true);
        const logins = this.loginStates();
        return {
            settings: this.settings,
            snapshots: [...this.entries.values()].sort((a, b) => a.serverId - b.serverId).map((entry) => this.snapshotOf(entry, logins))
        };
    }

    async getSettings(): Promise<FleetSettings> {
        await this.ensureLoaded();
        return this.settings;
    }

    async updateSettings(update: FleetSettingsUpdate): Promise<FleetSettings> {
        await this.ensureLoaded();
        // Only servers on the board can be left out (a deleted one, a typo...).
        if (update.excludedServerIds) await this.sync(true);
        const previous = this.settings;
        const next: FleetSettings = {
            enabled: update.enabled ?? previous.enabled,
            reachability: update.reachability ?? previous.reachability,
            intervalMinutes: update.intervalMinutes ?? previous.intervalMinutes,
            notifications: update.notifications ?? previous.notifications,
            excludedServerIds: update.excludedServerIds
                ? [...new Set(update.excludedServerIds)].filter((id) => this.entries.has(id)).sort((a, b) => a - b).slice(0, FLEET_LIMITS.maxIds)
                : previous.excludedServerIds
        };
        await this.deps.saveSettings(next);
        this.settings = next;

        const now = this.deps.now();
        const healthOn = next.enabled && !previous.enabled;
        const reachOn = !next.enabled && next.reachability && (previous.enabled || !previous.reachability);
        for (const entry of this.entries.values()) {
            entry.due = this.plan(entry, now);
            // Health checks turned on read every server soon (unless it was
            // read within the interval); reachability checks turned on catch
            // up on servers not checked lately. Both spread a little.
            const unread = (entry.health.snapshot.readAt ?? 0) < now - this.intervalMs();
            if ((healthOn && unread) || (reachOn && entry.due < now + FLEET_TIMING.catchUpMs)) entry.due = Math.min(entry.due, now + this.spread());
            this.changed(entry);
        }
        this.pending.settings = true;
        this.scheduleFlush();
        this.auditSettings(previous, next);
        this.dispatchDue(now);
        return next;
    }

    // "Check now": a health check of the named servers (or of every
    // monitored one neither on hold nor blocked), at once, ahead of the
    // automatic checks. Naming a server lifts its hold: the user asked for
    // that attempt. A server behind a jump host on hold is not checked: that
    // would retry the jump host's login (it can be named itself).
    async refresh(ids?: number[]): Promise<FleetRefreshResult> {
        await this.ensureLoaded();
        await this.sync(true);
        const result: FleetRefreshResult = { queued: [], skipped: [] };
        const targets: Entry[] = [];
        if (ids === undefined) {
            const logins = this.loginStates();
            for (const entry of this.entries.values()) {
                if (this.isMonitored(entry) && !entry.health.snapshot.hold && !this.blockOf(entry, logins)) targets.push(entry);
            }
        } else {
            for (const id of new Set(ids)) {
                const entry = this.entries.get(id);
                if (!entry) result.skipped.push({ serverId: id, reason: this.servers.has(id) ? "unsupported" : "not-found" });
                else if (this.jumpBlock(entry)) result.skipped.push({ serverId: id, reason: "jump-host" });
                else targets.push(entry);
            }
        }
        for (const entry of targets.sort((a, b) => a.serverId - b.serverId)) {
            if (entry.health.snapshot.hold) {
                this.releaseHold(entry);
                this.changed(entry);
            }
            this.enqueue(entry, ids === undefined ? "all" : "named");
            result.queued.push(entry.serverId);
        }
        this.pump();
        if (result.queued.length) {
            this.audit({
                serverId: result.queued.length === 1 ? result.queued[0] : null,
                source: "fleet",
                command: "fleet health check",
                meta: { servers: result.queued.length, ...(result.queued.length > 1 ? { serverIds: result.queued.slice(0, 50) } : {}) }
            });
        }
        return result;
    }

    // --- planned maintenance -----------------------------------------------------

    // A planned interruption of servers (a patch run reboots them), until
    // `untilMs` at the latest: no automatic check starts on them meanwhile,
    // and one that fails then (already running, or "Check now") raises no
    // alert and puts no login on hold: a server shutting down refuses logins
    // (pam_nologin), and a reboot of a minute or more would otherwise be
    // confirmed as unreachable and notified.
    beginMaintenance(serverIds: number[], untilMs: number): void {
        for (const id of serverIds) this.maintenance.set(id, Math.max(untilMs, this.maintenance.get(id) ?? 0));
    }

    // The maintenance is over: the servers are checked again at once, the way
    // the automatic checks run now (health or reachability).
    endMaintenance(serverIds: number[]): void {
        const now = this.deps.now();
        for (const id of serverIds) {
            this.maintenance.delete(id);
            const entry = this.entries.get(id);
            if (!entry || entry.running || entry.health.snapshot.hold) continue;
            entry.due = now;
            this.changed(entry);
        }
        this.dispatchDue(now);
    }

    private inMaintenance(serverId: number): boolean {
        const until = this.maintenance.get(serverId);
        if (until === undefined) return false;
        if (until > this.deps.now()) return true;
        this.maintenance.delete(serverId);
        return false;
    }

    // --- loading and syncing ---------------------------------------------------

    private async ensureLoaded(): Promise<void> {
        if (this.loaded) return;
        this.loading ??= (async () => {
            this.settings = await this.deps.loadSettings();
            this.stored = new Map((await this.deps.repo.list()).map((health) => [health.snapshot.serverId, health]));
            this.loaded = true;
            await this.sync(true);
        })().finally(() => {
            this.loading = null;
        });
        await this.loading;
    }

    // Reads the saved servers again: new SSH servers join the board, deleted
    // ones (or ones that are no longer SSH servers) leave it, ones whose
    // connection changed are checked soon and lose their hold.
    private sync(force: boolean): Promise<void> {
        if (!force && this.deps.now() - this.lastSync < FLEET_TIMING.syncMs) return this.syncing ?? Promise.resolve();
        this.syncing ??= this.readServers().finally(() => {
            this.syncing = null;
        });
        return this.syncing;
    }

    private async readServers(): Promise<void> {
        const all = await this.deps.listServers();
        const markers = await this.deps.credentialMarkers(all.filter((server) => isFleetServerType(server.type)));
        const now = this.deps.now();
        this.servers = new Map(all.map((server) => [server.id, server]));
        const present = new Set<number>();
        for (const server of all) {
            if (!isFleetServerType(server.type)) continue;
            present.add(server.id);
            const version = chainVersion(server, this.servers, markers);
            const endpoint = fleetEndpoint(server);
            const entry = this.entries.get(server.id);
            if (!entry) {
                this.entries.set(server.id, this.createEntry(server.id, version, endpoint, now));
                this.changed(this.entries.get(server.id)!);
            } else if (entry.version !== version) {
                entry.version = version;
                if (entry.health.endpoint !== endpoint) this.moved(entry, endpoint);
                else if (entry.health.snapshot.hold) this.releaseHold(entry);
                // A new address, credentials or jump host is checked soon.
                else if (!entry.running) entry.due = Math.min(entry.due, now + Math.round(this.deps.random() * 5000));
                this.changed(entry);
            }
        }
        for (const [serverId, entry] of [...this.entries]) {
            if (present.has(serverId)) continue;
            entry.running?.controller.abort();
            this.entries.delete(serverId);
            this.pending.snapshots.delete(serverId);
            this.pending.removed.add(serverId);
            this.scheduleFlush();
            this.forget(serverId);
        }
        // Rows read at startup of servers that are no longer SSH servers.
        for (const serverId of [...this.stored.keys()]) {
            this.stored.delete(serverId);
            this.forget(serverId);
        }
        this.pruneExcluded(present);
        await this.checkHostKeyHolds();
        this.lastSync = now;
    }

    private createEntry(serverId: number, version: string, endpoint: string, now: number): Entry {
        let health = this.stored.get(serverId) ?? blankHealth(serverId);
        this.stored.delete(serverId);
        // Saved while the server was elsewhere (it was moved while the
        // backend was not running): of no use now.
        const moved = health.endpoint !== null && health.endpoint !== endpoint;
        health = { ...(moved ? blankHealth(serverId) : health), endpoint };
        const { snapshot } = health;
        const entry: Entry = {
            serverId,
            version,
            health,
            track: { state: snapshot.checkedAt !== null ? snapshot.state : null, streak: health.streak, before: null, alerted: health.alerted },
            due: Infinity,
            queued: null,
            running: null,
            shownBlock: "null"
        };
        // A hold saved before the connection was changed no longer applies.
        if (snapshot.hold && health.holdContext?.version !== version) this.releaseHold(entry);
        entry.due = this.plan(entry, now);
        if (moved) this.persist(entry);
        return entry;
    }

    // The server was moved (another type, address, SSH port or jump host):
    // what the board read or saw of it, and a check still running, are of
    // where it was. It starts afresh, checked soon; a hold goes too (it was
    // about the old connection).
    private moved(entry: Entry, endpoint: string): void {
        entry.running?.controller.abort();
        entry.health = { ...blankHealth(entry.serverId), endpoint };
        entry.track = { state: null, streak: 0, before: null, alerted: null };
        entry.due = this.deps.now() + Math.round(this.deps.random() * 5000);
        this.persist(entry);
    }

    // The snapshot of a server that left the board. A deleted server took
    // its row along already; one whose type changed must not get it back.
    private forget(serverId: number): void {
        this.deps.repo.remove(serverId).catch((err: unknown) => {
            log.warn(`Could not remove the health snapshot of server #${serverId}: ${errorMessage(err)}`);
        });
    }

    // Servers no longer on the board leave the list of excluded ones too.
    private pruneExcluded(present: Set<number>): void {
        const kept = this.settings.excludedServerIds.filter((id) => present.has(id));
        if (kept.length === this.settings.excludedServerIds.length) return;
        this.settings = { ...this.settings, excludedServerIds: kept };
        this.deps.saveSettings(this.settings).catch((err: unknown) => log.warn(`Could not save the fleet settings: ${errorMessage(err)}`));
        this.pending.settings = true;
        this.scheduleFlush();
    }

    // A changed host key the user has trusted since (or whose pin was
    // removed, so the next connection pins the key it finds).
    private async checkHostKeyHolds(): Promise<void> {
        for (const entry of this.entries.values()) {
            const key = entry.health.snapshot.hold === "host-key" ? entry.health.holdContext?.hostKey : undefined;
            if (!key) continue;
            try {
                const pinned = await this.deps.findHostKey(key.host, key.port, key.via);
                if (!pinned || pinned.fingerprint === key.actual) {
                    this.releaseHold(entry);
                    this.changed(entry);
                }
            } catch (err) {
                log.warn(`Could not read the pinned host key of ${key.host}:${key.port}: ${errorMessage(err)}`);
            }
        }
    }

    private releaseHold(entry: Entry): void {
        entry.health = { ...entry.health, snapshot: { ...entry.health.snapshot, hold: null }, holdContext: null };
        entry.due = this.deps.now() + Math.round(this.deps.random() * 5000);
    }

    // --- routes, holds and blocks ----------------------------------------------

    // The jump hosts of a server, the one connected to first first.
    private route(serverId: number): number[] {
        const hops: number[] = [];
        const seen = new Set([serverId]);
        let jumpId = this.servers.get(serverId)?.jump_server_id ?? null;
        while (jumpId !== null && !seen.has(jumpId) && hops.length < MAX_JUMP_HOPS) {
            seen.add(jumpId);
            hops.unshift(jumpId);
            jumpId = this.servers.get(jumpId)?.jump_server_id ?? null;
        }
        return hops;
    }

    // The first jump host of the route that is on hold (its own).
    private jumpBlock(entry: Entry): FleetBlock | null {
        for (const hop of this.route(entry.serverId)) {
            const hold = this.entries.get(hop)?.health.snapshot.hold;
            if (hold) return { kind: "jump-host", serverId: hop, hold };
        }
        return null;
    }

    // Why the health checks of a server that is not on hold itself wait.
    private blockOf(entry: Entry, logins: ReadonlyMap<string, LoginState>): FleetBlock | null {
        if (entry.health.snapshot.hold) return null;
        const jump = this.jumpBlock(entry);
        if (jump) return jump;
        const server = this.servers.get(entry.serverId);
        return (server && logins.get(loginKey(server))?.pause) || null;
    }

    // The logins rejected since they last worked on any server (a server
    // read since counts as worked), and the ones that are paused.
    private loginStates(): Map<string, LoginState> {
        const logins = new Map<string, { lastRead: number; rejectedAt: number[]; user: string; identity: boolean }>();
        for (const entry of this.entries.values()) {
            const server = this.servers.get(entry.serverId);
            if (!server) continue;
            const key = loginKey(server);
            let login = logins.get(key);
            if (!login) {
                login = { lastRead: 0, rejectedAt: [], user: loginUser(server), identity: Boolean(server.identity_id) };
                logins.set(key, login);
            }
            const { snapshot } = entry.health;
            login.lastRead = Math.max(login.lastRead, snapshot.readAt ?? 0);
            if (snapshot.hold === "auth" && snapshot.error?.code === "AUTH_FAILED" && snapshot.checkedAt !== null) login.rejectedAt.push(snapshot.checkedAt);
        }
        const states = new Map<string, LoginState>();
        for (const [key, login] of logins) {
            const rejected = login.rejectedAt.filter((at) => at > login.lastRead).length;
            if (rejected === 0) continue;
            const pause: LoginPause | null = rejected >= LOGIN_BREAKER_FAILURES
                ? { kind: "login", user: login.user, identity: login.identity, servers: rejected }
                : null;
            states.set(key, { rejected, pause });
        }
        return states;
    }

    // A login rejected since it last worked is tried on one server at a time.
    private loginBusy(entry: Entry, logins: ReadonlyMap<string, LoginState>): boolean {
        const server = this.servers.get(entry.serverId);
        if (!server) return false;
        const key = loginKey(server);
        if (!logins.has(key)) return false;
        for (const other of this.entries.values()) {
            if (other === entry || other.running?.mode !== "health") continue;
            const otherServer = this.servers.get(other.serverId);
            if (otherServer && loginKey(otherServer) === key) return true;
        }
        return false;
    }

    // A check of the server is waiting or running.
    private isBusy(serverId: number): boolean {
        const entry = this.entries.get(serverId);
        return Boolean(entry && (entry.queued || entry.running));
    }

    // --- scheduling ---------------------------------------------------------------

    private isMonitored(entry: Entry): boolean {
        return !this.settings.excludedServerIds.includes(entry.serverId);
    }

    private intervalMs(): number {
        return this.settings.intervalMinutes * 60_000;
    }

    private spread(): number {
        return Math.round(this.deps.random() * FLEET_TIMING.catchUpMs);
    }

    // The automatic check a server gets now, if any: a health check while
    // they are on, else a reachability check of a server reached directly.
    private automaticMode(entry: Entry): CheckMode | null {
        if (!this.isMonitored(entry) || entry.health.snapshot.hold) return null;
        if (this.settings.enabled) return "health";
        if (this.settings.reachability && !this.servers.get(entry.serverId)?.jump_server_id) return "reach";
        return null;
    }

    // When the next automatic check of `entry` is due, counted from its
    // latest check. Overdue ones are spread over the next few seconds.
    private plan(entry: Entry, now: number): number {
        const { snapshot } = entry.health;
        if (snapshot.hold) return Infinity;
        if (snapshot.checkedAt === null) return now + this.spread();
        const reach = this.automaticMode(entry) === "reach";
        const interval = reach ? reachIntervalMinutes(this.settings) * 60_000 : this.intervalMs();
        // A reachability check confirms only that a server stopped answering.
        const confirming = awaitsConfirmation(entry.track) && (!reach || entry.track.state === "unreachable");
        const delay = snapshot.failures > 0
            ? retryDelay(interval, snapshot.failures)
            : confirming ? Math.min(interval, FLEET_TIMING.confirmMs) : interval;
        const due = snapshot.checkedAt + jittered(delay, this.deps.random);
        return due > now ? due : now + this.spread();
    }

    private tick(): void {
        const now = this.deps.now();
        // Asleep (a suspended laptop) or blocked for a while: everything came
        // due at once, so it is spread instead of run in one burst.
        if (this.lastTick && now - this.lastTick > FLEET_TIMING.tickMs * 3 + 60_000) {
            for (const entry of this.entries.values()) {
                if (entry.due < now + FLEET_TIMING.catchUpMs) entry.due = now + this.spread();
            }
        }
        this.lastTick = now;
        this.ensureLoaded()
            .then(() => this.sync(false))
            .then(() => this.dispatchDue(this.deps.now()))
            .catch((err: unknown) => log.warn(`The fleet health checks could not run: ${errorMessage(err)}`));
    }

    private dispatchDue(now: number): void {
        if (!this.timer) return;
        let logins: Map<string, LoginState> | null = null;
        for (const entry of this.entries.values()) {
            if (entry.running || entry.queued || entry.due > now || this.inMaintenance(entry.serverId)) continue;
            const mode = this.automaticMode(entry);
            if (!mode) continue;
            if (mode === "health" && this.blockOf(entry, logins ??= this.loginStates())) {
                // Checked within the catch-up spread once the block lifts.
                entry.due = now + this.spread();
                continue;
            }
            this.enqueue(entry, "automatic");
        }
        this.pump();
    }

    // Asked-for checks go ahead of the automatic ones, each kind in the
    // order it was queued. A health check asked for while a reachability
    // check runs follows it.
    private enqueue(entry: Entry, kind: "automatic" | "all" | "named"): void {
        const requested = kind !== "automatic";
        if (entry.running && (!requested || entry.running.mode === "health")) return;
        if (entry.queued) {
            if (kind === "named") entry.queued.named = true;
            if (!requested || entry.queued.requested) return;
            this.queue.splice(this.queue.indexOf(entry.serverId), 1);
        }
        entry.queued = { requested, named: kind === "named" };
        (requested ? this.requestedQueue : this.queue).push(entry.serverId);
        this.changed(entry);
    }

    private pump(): void {
        while (this.active < this.concurrency) {
            const next = this.takeRunnable();
            if (!next) return;
            void this.run(next.entry, next.mode);
        }
    }

    // The next queued check that can run now. A server waits while a check of
    // a jump host of its route is waiting or running (its outcome decides
    // whether the server can be checked at all), and while another server of
    // its login, rejected lately, is being checked. A server that became
    // blocked meanwhile leaves the queue unchecked.
    private takeRunnable(): { entry: Entry; mode: CheckMode } | null {
        // Dropping a server can free one that waited for it: scan again.
        for (let dropped = true; dropped;) {
            dropped = false;
            const logins = this.loginStates();
            scan: for (const queue of [this.requestedQueue, this.queue]) {
                for (let index = 0; index < queue.length; index += 1) {
                    const entry = this.entries.get(queue[index]);
                    const queued = entry?.queued;
                    if (!entry || !queued) {
                        queue.splice(index, 1);
                        dropped = true;
                        break scan;
                    }
                    if (entry.running) continue;
                    const mode = queued.requested ? "health" : this.automaticMode(entry);
                    if (mode === "health" && this.route(entry.serverId).some((hop) => this.isBusy(hop))) continue;
                    if (mode === "health" && !queued.named && this.loginBusy(entry, logins)) continue;
                    queue.splice(index, 1);
                    if (mode === null || (mode === "health" && this.blockOf(entry, queued.named ? NO_LOGINS : logins))) {
                        entry.queued = null;
                        this.changed(entry);
                        dropped = true;
                        break scan;
                    }
                    return { entry, mode };
                }
            }
        }
        return null;
    }

    private endpoint(serverId: number): ReachEndpoint {
        const server = this.servers.get(serverId);
        if (!server) throw Object.assign(new Error(`Server #${serverId} does not exist (it may have been deleted).`), { code: "SERVER_NOT_FOUND" });
        const rdpPort = server.type === "windows" ? effectivePort(server, "rdp") ?? undefined : undefined;
        return { host: normalizeHost(server.ip ?? ""), port: effectivePort(server, "terminal") ?? 22, ...(rdpPort ? { rdpPort } : {}) };
    }

    private async run(entry: Entry, mode: CheckMode): Promise<void> {
        entry.queued = null;
        const running = { controller: new AbortController(), mode };
        const { controller } = running;
        entry.running = running;
        this.active += 1;
        this.changed(entry);
        const started = this.deps.now();
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, FLEET_TIMING.checkTimeoutMs);
        timer.unref?.();
        try {
            let outcome: { result: ProbeResult | ReachResult } | { error: unknown };
            try {
                outcome = {
                    result: mode === "health"
                        ? await this.deps.probe(entry.serverId, controller.signal, this.route(entry.serverId))
                        : await this.deps.reach(this.endpoint(entry.serverId), controller.signal)
                };
            } catch (err) {
                outcome = { error: err };
            }
            // Stopped, or the server is gone: nothing to record.
            if ((controller.signal.aborted && !timedOut) || this.entries.get(entry.serverId) !== entry) return;
            let recorded = true;
            if ("result" in outcome) {
                if (mode === "health") this.recordSuccess(entry, outcome.result as ProbeResult, started);
                else this.recordReach(entry, outcome.result as ReachResult, started);
            } else if (timedOut) {
                const phase = outcome.error instanceof ProbeError ? outcome.error.phase : "connect";
                const late = Object.assign(new Error(`The health check did not finish within ${FLEET_TIMING.checkTimeoutMs / 1000}s`), { code: "CHECK_TIMEOUT" });
                this.recordFailure(entry, new ProbeError(phase, late), started);
            } else {
                const failure = mode === "reach" ? new ProbeError("connect", outcome.error) : outcome.error;
                const rdpMs = mode === "health" ? await this.rdpAnswers(entry, failure, controller.signal) : null;
                if ((controller.signal.aborted && !timedOut) || this.entries.get(entry.serverId) !== entry) return;
                if (rdpMs !== null) this.recordReach(entry, { ms: rdpMs, greeting: "", service: "rdp" }, started);
                else recorded = this.recordFailure(entry, failure, started);
            }
            if (recorded) this.persist(entry);
        } catch (err) {
            log.error(`The health check of server #${entry.serverId} could not be recorded: ${errorMessage(err)}`);
        } finally {
            clearTimeout(timer);
            if (entry.running === running) entry.running = null;
            this.active -= 1;
            if (this.entries.get(entry.serverId) === entry) this.changed(entry);
            this.pump();
        }
    }

    // A Windows server reached over Remote Desktop only: a health check
    // that could not connect to its SSH port (refused, unreachable, no
    // answer; not a rejected login or a changed key) tries its RDP port, as
    // a reachability check does. The time it answered in, or null.
    private async rdpAnswers(entry: Entry, err: unknown, signal: AbortSignal): Promise<number | null> {
        if (!(err instanceof ProbeError) || err.phase !== "connect" || err.hop !== null) return null;
        const outcome = classifyFailure(err);
        const server = this.servers.get(entry.serverId);
        if (outcome.state !== "unreachable" || outcome.hold || !server || server.jump_server_id) return null;
        const { host, port, rdpPort } = this.endpoint(entry.serverId);
        if (rdpPort === undefined || rdpPort === port) return null;
        try {
            return await this.deps.reachRdp({ host, port: rdpPort }, signal);
        } catch {
            return null;
        }
    }

    private recordSuccess(entry: Entry, result: ProbeResult, started: number): void {
        const now = this.deps.now();
        const { reading } = result;
        const state: FleetState = reading.tone;
        const previous = entry.health.snapshot;
        entry.health = {
            ...entry.health,
            snapshot: {
                ...previous,
                state,
                issues: reading.issues,
                metrics: reading.metrics,
                checkedAt: now,
                lastSeenAt: now,
                reachedVia: "ssh",
                sshSeenAt: now,
                readAt: now,
                error: null,
                // A check over a connection that was already open measures no handshake.
                handshakeMs: result.handshakeMs ?? previous.handshakeMs,
                durationMs: now - started,
                failures: 0,
                hold: null
            },
            streak: 0,
            alerted: null,
            holdContext: null
        };
        this.observe(entry, state, now);
    }

    // The server answered: its SSH server, or only its Remote Desktop port
    // (reachServer). A health verdict stays its state (it ages, and a second
    // health check still has to confirm a critical one); otherwise it is "up".
    private recordReach(entry: Entry, result: ReachResult, started: number): void {
        const now = this.deps.now();
        const previous = entry.health.snapshot;
        const keeps = HEALTH_VERDICTS.has(previous.state);
        const reachedVia = result.service === "rdp" ? "rdp" : "ssh";
        entry.health = {
            ...entry.health,
            snapshot: {
                ...previous,
                state: keeps ? previous.state : "up",
                checkedAt: now,
                lastSeenAt: now,
                reachedVia,
                sshSeenAt: reachedVia === "ssh" ? now : previous.sshSeenAt,
                error: keeps ? previous.error : null,
                durationMs: now - started,
                failures: 0
            }
        };
        if (keeps) entry.due = this.plan(entry, now);
        else this.observe(entry, "up", now);
    }

    // Records a failed check. A jump host of the route that rejected its
    // login (or showed a changed key, or cannot be used as saved) failed
    // itself: that is recorded on the jump host, which goes on hold, and
    // the server waits for it (false: nothing recorded on the server).
    private recordFailure(entry: Entry, err: unknown, started: number): boolean {
        const outcome = classifyFailure(err);
        const hopId = err instanceof ProbeError ? err.hop : null;
        const hop = hopId !== null ? this.entries.get(hopId) : undefined;
        if (hop && outcome.hold) {
            // A health check of the jump host itself reports the same failure.
            if (hop.running?.mode !== "health") {
                this.applyFailure(hop, outcome, started);
                this.persist(hop);
                this.changed(hop);
            }
            return false;
        }
        this.applyFailure(entry, hopId !== null ? { ...outcome, error: { ...outcome.error, jumpServerId: hopId } } : outcome, started);
        return true;
    }

    private applyFailure(entry: Entry, failure: FailureOutcome, started: number): void {
        const now = this.deps.now();
        // A login refused while the server reboots for a planned maintenance
        // is the shutdown, not a wrong password.
        const outcome: FailureOutcome = failure.hold === "auth" && this.inMaintenance(entry.serverId) ? { ...failure, state: "unreachable", hold: null } : failure;
        const previous = entry.health.snapshot;
        const holdContext: HoldContext | null = outcome.hold ? { version: entry.version, ...(outcome.hostKey ? { hostKey: outcome.hostKey } : {}) } : null;
        entry.health = {
            ...entry.health,
            snapshot: {
                ...previous,
                state: outcome.state,
                // The reading stays (as of readAt); its verdict does not.
                issues: [],
                checkedAt: now,
                error: outcome.error,
                durationMs: now - started,
                failures: previous.failures + 1,
                hold: outcome.hold
            },
            streak: 0,
            alerted: null,
            holdContext
        };
        if (outcome.hold) log.warn(`Automatic health checks of server #${entry.serverId} are on hold until it is fixed: ${outcome.error.message}`);
        else log.debug(`Check of server #${entry.serverId} failed (${outcome.error.code}): ${outcome.error.message}`);
        this.observe(entry, outcome.state, now);
    }

    // Alert bookkeeping and the next check. During a planned maintenance
    // nothing is tracked: the check after it says how the server is.
    private observe(entry: Entry, state: FleetState, now: number): void {
        if (this.inMaintenance(entry.serverId)) {
            entry.health = { ...entry.health, streak: entry.track.streak, alerted: entry.track.alerted };
            entry.due = this.plan(entry, now);
            return;
        }
        const { track, alert } = observeState(entry.track, state);
        entry.track = track;
        entry.health = { ...entry.health, streak: track.streak, alerted: track.alerted };
        if (alert) {
            this.pending.alerts.push({ serverId: entry.serverId, state: alert.state, previous: alert.previous, at: now });
            log.info(`Server #${entry.serverId} is ${alert.state} (was ${alert.previous ?? "unknown"})`);
        }
        entry.due = this.plan(entry, now);
    }

    private persist(entry: Entry): void {
        this.deps.repo.save(entry.health).catch((err: unknown) => {
            log.warn(`Could not save the health snapshot of server #${entry.serverId}: ${errorMessage(err)}`);
        });
    }

    private audit(entry: AuditInput): void {
        this.deps.audit(entry).catch((err: unknown) => log.warn(`Could not record a fleet action in the audit log: ${errorMessage(err)}`));
    }

    // One audit entry per settings change that changes what is checked.
    private auditSettings(previous: FleetSettings, next: FleetSettings): void {
        const parts: string[] = [];
        if (next.enabled !== previous.enabled || (next.enabled && next.intervalMinutes !== previous.intervalMinutes)) {
            parts.push(next.enabled ? `fleet health checks on, every ${next.intervalMinutes} min` : "fleet health checks off");
        }
        const reachEvery = (settings: FleetSettings) => (!settings.enabled && settings.reachability ? reachIntervalMinutes(settings) : null);
        if (next.reachability !== previous.reachability || (reachEvery(next) !== null && reachEvery(next) !== reachEvery(previous))) {
            parts.push(next.reachability ? `fleet reachability checks on, every ${reachIntervalMinutes(next)} min` : "fleet reachability checks off");
        }
        if (!sameIds(next.excludedServerIds, previous.excludedServerIds)) {
            parts.push(`${next.excludedServerIds.length} server(s) left out of automatic checks`);
        }
        if (!parts.length) return;
        this.audit({
            source: "fleet",
            command: parts.join("; "),
            meta: { enabled: next.enabled, reachability: next.reachability, intervalMinutes: next.intervalMinutes, excludedServers: next.excludedServerIds.length }
        });
    }

    // --- changes ---------------------------------------------------------------

    private snapshotOf(entry: Entry, logins: ReadonlyMap<string, LoginState>): FleetSnapshot {
        const monitored = this.isMonitored(entry);
        const blocked = this.blockOf(entry, logins);
        const mode = this.automaticMode(entry);
        const planned = mode !== null && !(mode === "health" && blocked) && Number.isFinite(entry.due);
        return {
            ...entry.health.snapshot,
            blocked,
            monitored,
            checking: entry.queued !== null || entry.running !== null,
            nextCheckAt: planned ? entry.due : null
        };
    }

    private emptyPending() {
        return { snapshots: new Set<number>(), removed: new Set<number>(), alerts: [] as FleetAlert[], settings: false };
    }

    private changed(entry: Entry): void {
        this.pending.snapshots.add(entry.serverId);
        this.scheduleFlush();
    }

    private scheduleFlush(): void {
        if (this.flushTimer) return;
        this.flushTimer = setTimeout(() => this.flush(), this.flushMs);
        this.flushTimer.unref?.();
    }

    private flush(): void {
        this.flushTimer = null;
        const { snapshots, removed, alerts, settings } = this.pending;
        this.pending = this.emptyPending();
        // A hold or a rejected login elsewhere blocks (or frees) other servers.
        const logins = this.loginStates();
        for (const entry of this.entries.values()) {
            const shown = JSON.stringify(this.blockOf(entry, logins));
            if (shown === entry.shownBlock) continue;
            entry.shownBlock = shown;
            snapshots.add(entry.serverId);
        }
        const event: FleetHealthEvent = {};
        const changed = [...snapshots].map((id) => this.entries.get(id)).filter((entry): entry is Entry => entry !== undefined);
        if (changed.length) event.snapshots = changed.map((entry) => this.snapshotOf(entry, logins));
        if (removed.size) event.removed = [...removed];
        if (alerts.length) event.alerts = alerts;
        if (settings) event.settings = this.settings;
        if (Object.keys(event).length === 0) return;
        try {
            this.events.emit("change", event);
        } catch (err) {
            log.warn(`A fleet listener failed: ${errorMessage(err)}`);
        }
    }
}

// The backend's one scheduler (started by server/main.ts).
export const fleetMonitor = new FleetMonitor();
