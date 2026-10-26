import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FLEET_SETTINGS, type FleetHealthEvent, type FleetSettings, type FleetSnapshot } from "../../shared/fleet";
import type { AuditInput, ServerSummary } from "../../shared/types";
import { HostKeyMismatchError } from "../ssh/hostKeys";
import { FleetMonitor, type FleetMonitorDeps } from "./monitor";
import { FLEET_TIMING, LOGIN_BREAKER_FAILURES } from "./policy";
import { ProbeError, type FleetReading, type ProbeResult } from "./probe";
import type { ReachEndpoint, ReachResult } from "./reach";
import { fleetEndpoint, type StoredHealth } from "./repo";

// The scheduler with every dependency faked: servers, checks, storage and
// the clock (vitest fake timers, which Date.now follows).

const reading = (tone: FleetReading["tone"] = "ok"): ProbeResult => ({
    handshakeMs: 42,
    reading: {
        tone,
        issues: tone === "critical" ? [{ metric: "disk", tone: "critical", value: 95, mount: "/" }] : [],
        metrics: {
            platform: "linux", hostname: "h", os: "Linux", kernel: null, uptimeSeconds: 10, bootedAt: 0, cores: 2, cpuPercent: null,
            load: null, loadPerCore: null, memory: null, swapPercent: null, disk: null, diskCount: 0, failedUnits: 0,
            loggedInUsers: null, rebootRequired: false, updates: null
        }
    }
});

const refused = () => Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });
const unreachable = () => new ProbeError("connect", refused());
const rejectedLogin = () => Object.assign(new Error("All configured authentication methods failed"), { level: "client-authentication" });
const authFailure = () => new ProbeError("connect", rejectedLogin());

const linux = (id: number, extra: Partial<ServerSummary> = {}): ServerSummary => ({ id, name: `s${id}`, ip: `10.0.0.${id}`, type: "linux", updated_at: 1, ...extra });

type Behaviour = (serverId: number, route: number[]) => Promise<ProbeResult>;
type ReachBehaviour = (endpoint: ReachEndpoint) => Promise<ReachResult>;

function setup(options: {
    servers?: ServerSummary[];
    settings?: Partial<FleetSettings>;
    stored?: StoredHealth[];
    concurrency?: number;
    random?: () => number;
} = {}) {
    let servers: ServerSummary[] = options.servers ?? [
        { id: 1, name: "web", ip: "10.0.0.1", type: "linux", updated_at: 1 },
        { id: 2, name: "win", ip: "10.0.0.2", type: "windows", updated_at: 1 },
        { id: 3, name: "bucket", ip: "", type: "s3", updated_at: 1 }
    ];
    let behaviour: Behaviour = async () => reading();
    let reachBehaviour: ReachBehaviour = async () => ({ ms: 3, greeting: "SSH-2.0-OpenSSH_9.6" });
    // The Remote Desktop port of the Windows servers: closed unless told.
    let rdpBehaviour: (endpoint: { host: string; port: number }) => Promise<number> = async () => { throw refused(); };
    const probes: number[] = [];
    const reaches: string[] = [];
    const rdpReaches: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const saved: StoredHealth[] = [];
    const removed: number[] = [];
    const audits: AuditInput[] = [];
    let settings: FleetSettings = { ...DEFAULT_FLEET_SETTINGS, ...options.settings };
    const hostKeys = new Map<string, string>();
    const markers = new Map<number, string>();
    const deps: Partial<FleetMonitorDeps> = {
        probe: async (serverId, _signal, route) => {
            probes.push(serverId);
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            try {
                return await behaviour(serverId, route);
            } finally {
                inFlight -= 1;
            }
        },
        reach: async (endpoint) => {
            // A Windows server's RDP port is the fallback (reachServer).
            reaches.push(`${endpoint.host}:${endpoint.port}${endpoint.rdpPort ? `+rdp:${endpoint.rdpPort}` : ""}`);
            return reachBehaviour(endpoint);
        },
        reachRdp: async (endpoint) => {
            rdpReaches.push(`${endpoint.host}:${endpoint.port}`);
            return rdpBehaviour(endpoint);
        },
        listServers: async () => servers,
        credentialMarkers: async () => new Map(markers),
        repo: {
            list: async () => options.stored ?? [],
            save: async (health) => { saved.push(structuredClone(health)); },
            remove: async (serverId) => { removed.push(serverId); }
        },
        loadSettings: async () => settings,
        saveSettings: async (next) => { settings = next; },
        findHostKey: async (host, port, via) => {
            const fingerprint = hostKeys.get(`${host}:${port}:${via}`);
            return fingerprint ? { fingerprint } : null;
        },
        audit: async (entry) => { audits.push(entry); },
        random: options.random ?? (() => 0.5)
    };
    const monitor = new FleetMonitor(deps, { concurrency: options.concurrency ?? 6, flushMs: 10 });
    const events: FleetHealthEvent[] = [];
    monitor.onChange((event) => events.push(event));
    return {
        monitor,
        probes,
        reaches,
        rdpReaches,
        saved,
        removed,
        audits,
        events,
        hostKeys,
        markers,
        savedSettings: () => settings,
        maxInFlight: () => maxInFlight,
        setServers: (next: ServerSummary[]) => { servers = next; },
        behave: (next: Behaviour) => { behaviour = next; },
        reachBehave: (next: ReachBehaviour) => { reachBehaviour = next; },
        rdpBehave: (next: (endpoint: { host: string; port: number }) => Promise<number>) => { rdpBehaviour = next; },
        snapshot: async (id: number): Promise<FleetSnapshot> => (await monitor.board()).snapshots.find((item) => item.serverId === id)!,
        alerts: () => events.flatMap((event) => event.alerts ?? [])
    };
}

// A fake SSH network for `behave`: logins of the servers in `rejected` fail.
// Like the pool, a connection being opened is shared by whoever asks for it
// meanwhile, an open one is kept, and a failed one is not.
function network(rejected: Set<number>) {
    const attempts = new Map<number, number>();
    const connections = new Map<number, Promise<void>>();
    const connect = (id: number) => {
        let connection = connections.get(id);
        if (!connection) {
            attempts.set(id, (attempts.get(id) ?? 0) + 1);
            connection = new Promise<void>((resolve, reject) => setTimeout(() => (rejected.has(id) ? reject(rejectedLogin()) : resolve()), 200));
            connections.set(id, connection);
            connection.catch(() => connections.delete(id));
        }
        return connection;
    };
    const probe: Behaviour = async (serverId, route) => {
        for (const hop of route) {
            try {
                await connect(hop);
            } catch (err) {
                throw new ProbeError("connect", err, hop);
            }
        }
        try {
            await connect(serverId);
        } catch (err) {
            throw new ProbeError("connect", err);
        }
        return reading();
    };
    return { attempts: (id: number) => attempts.get(id) ?? 0, probe };
}

// A sequence of "random" numbers, over and over: spread due times.
const cycle = (values: number[]) => {
    let index = 0;
    return () => values[index++ % values.length];
};

// Lets pending promises and the change batches run.
const settle = async (ms = 50) => {
    await vi.advanceTimersByTimeAsync(ms);
};

beforeEach(() => {
    vi.useFakeTimers({ now: new Date("2026-10-24T10:00:00Z") });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("fleet board", () => {
    it("lists every Linux and Windows server, never checked yet", async () => {
        const { monitor } = setup();
        const board = await monitor.board();
        expect(board.settings).toEqual(DEFAULT_FLEET_SETTINGS);
        expect(board.snapshots.map((item) => [item.serverId, item.state, item.monitored, item.checkedAt, item.blocked])).toEqual([
            [1, "unknown", true, null, null],
            [2, "unknown", true, null, null]
        ]);
    });

    it("checks named servers at once, saves the result and reports the change", async () => {
        const fleet = setup({ settings: { reachability: false } });
        fleet.behave(() => new Promise((resolve) => setTimeout(() => resolve(reading()), 100)));
        const started = Date.now();
        const result = await fleet.monitor.refresh([1, 3, 99]);
        expect(result).toEqual({ queued: [1], skipped: [{ serverId: 3, reason: "unsupported" }, { serverId: 99, reason: "not-found" }] });
        await settle(500);
        expect(fleet.probes).toEqual([1]);
        const snapshot = await fleet.snapshot(1);
        expect(snapshot).toMatchObject({
            state: "ok", checking: false, failures: 0, handshakeMs: 42, error: null,
            checkedAt: started + 100, lastSeenAt: started + 100, readAt: started + 100, durationMs: 100
        });
        // Automatic checks are off: none is planned.
        expect(snapshot.nextCheckAt).toBeNull();
        expect(fleet.saved.at(-1)?.snapshot).toMatchObject({ serverId: 1, state: "ok" });
        const changes = fleet.events.flatMap((event) => event.snapshots ?? []).filter((item) => item.serverId === 1);
        expect(changes.some((item) => item.checking)).toBe(true);
        expect(changes.at(-1)).toMatchObject({ state: "ok", checking: false });
        expect(fleet.audits).toEqual([{ serverId: 1, source: "fleet", command: "fleet health check", meta: { servers: 1 } }]);
    });

    it("runs at most `concurrency` checks at a time", async () => {
        const servers = Array.from({ length: 10 }, (_, index) => linux(index + 1));
        const fleet = setup({ servers, concurrency: 3 });
        fleet.behave(() => new Promise((resolve) => setTimeout(() => resolve(reading()), 100)));
        await fleet.monitor.refresh();
        await settle(1000);
        expect(fleet.probes).toHaveLength(10);
        expect(fleet.maxInFlight()).toBe(3);
    });

    it("runs asked-for checks in the order they were asked", async () => {
        const servers = [1, 2, 3, 4].map((id) => linux(id));
        const fleet = setup({ servers, concurrency: 1 });
        fleet.behave(() => new Promise((resolve) => setTimeout(() => resolve(reading()), 100)));
        await fleet.monitor.refresh([3]);
        await fleet.monitor.refresh([1, 4]);
        await fleet.monitor.refresh([4]);
        await settle(1000);
        expect(fleet.probes).toEqual([3, 1, 4]);
    });

    it("leaves excluded servers out of automatic checks and of 'check all', not of a named check", async () => {
        const fleet = setup({ settings: { excludedServerIds: [2] } });
        expect((await fleet.monitor.refresh()).queued).toEqual([1]);
        await settle();
        expect((await fleet.snapshot(2)).monitored).toBe(false);
        expect((await fleet.monitor.refresh([2])).queued).toEqual([2]);
        await settle();
        expect(fleet.probes).toEqual([1, 2]);
    });

    it("drops a server that was deleted", async () => {
        const fleet = setup();
        await fleet.monitor.board();
        fleet.setServers([{ id: 2, name: "win", ip: "10.0.0.2", type: "windows", updated_at: 1 }]);
        await fleet.monitor.refresh([2]);
        await settle();
        expect(fleet.events.some((event) => event.removed?.includes(1))).toBe(true);
        expect((await fleet.monitor.board()).snapshots.map((item) => item.serverId)).toEqual([2]);
    });

    it("forgets the stored snapshot of a server that is no longer an SSH server", async () => {
        const old: StoredHealth = {
            snapshot: {
                serverId: 3, state: "critical", issues: [], metrics: null, checkedAt: Date.now() - 1000, lastSeenAt: Date.now() - 1000,
                reachedVia: "ssh", sshSeenAt: Date.now() - 1000, readAt: Date.now() - 1000, error: null, handshakeMs: null, durationMs: 10, failures: 0, hold: null
            },
            streak: 1,
            alerted: null,
            holdContext: null,
            endpoint: null
        };
        // Server 3 became an S3 bucket while the backend was not running.
        const fleet = setup({ stored: [old], servers: [linux(1), { id: 3, name: "bucket", ip: "", type: "s3", updated_at: 1 }] });
        await fleet.monitor.board();
        expect(fleet.removed).toEqual([3]);

        // Server 1 becomes an FTP server, then a Linux one again: it starts over.
        await fleet.monitor.refresh([1]);
        await settle();
        expect((await fleet.snapshot(1)).checkedAt).not.toBeNull();
        fleet.setServers([{ id: 1, name: "web", ip: "10.0.0.1", type: "ftp", updated_at: 2 }]);
        await fleet.monitor.board();
        await settle();
        expect(fleet.removed).toEqual([3, 1]);
        expect(fleet.events.at(-1)?.removed).toEqual([1]);
        fleet.setServers([linux(1, { updated_at: 3 })]);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "unknown", checkedAt: null });
    });

    it("starts afresh when a server is moved: what it read was of the old address", async () => {
        const fleet = setup({ servers: [linux(1)] });
        await fleet.monitor.refresh([1]);
        await settle();
        expect(await fleet.snapshot(1)).toMatchObject({ state: "ok", metrics: { hostname: "h" } });
        expect(fleet.saved.at(-1)?.endpoint).toBe(fleetEndpoint(linux(1)));

        // A new name keeps the reading; a new port does not.
        fleet.setServers([linux(1, { name: "renamed", updated_at: 2 })]);
        await settle(FLEET_TIMING.syncMs + 1000);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "ok", metrics: { hostname: "h" } });
        fleet.reachBehave(async () => { throw refused(); });
        fleet.setServers([linux(1, { port: 2, updated_at: 3 })]);
        await fleet.monitor.board();
        expect(await fleet.snapshot(1)).toMatchObject({ state: "unknown", metrics: null, readAt: null, lastSeenAt: null, checkedAt: null, issues: [] });
        expect(fleet.saved.at(-1)).toMatchObject({ endpoint: fleetEndpoint(linux(1, { port: 2 })), snapshot: { metrics: null, lastSeenAt: null } });
        fleet.monitor.start();
        await settle(10_000);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "unreachable", metrics: null, lastSeenAt: null });
        fleet.monitor.stop();
    });

    it("drops a stored reading of where a server was before it was moved, and keeps one saved before endpoints were recorded", async () => {
        const stored = (serverId: number, endpoint: string | null): StoredHealth => ({
            snapshot: {
                serverId, state: "ok", issues: [], metrics: reading().reading.metrics, checkedAt: Date.now() - 1000, lastSeenAt: Date.now() - 1000,
                reachedVia: "ssh", sshSeenAt: Date.now() - 1000, readAt: Date.now() - 1000, error: null, handshakeMs: 20, durationMs: 10, failures: 0, hold: null
            },
            streak: 1,
            alerted: null,
            holdContext: null,
            endpoint
        });
        // Server 1 was moved to port 2222 while the backend was not running.
        const fleet = setup({ stored: [stored(1, fleetEndpoint(linux(1))), stored(2, null)], servers: [linux(1, { port: 2222 }), linux(2)] });
        const board = await fleet.monitor.board();
        expect(board.snapshots.find((item) => item.serverId === 1)).toMatchObject({ state: "unknown", metrics: null, checkedAt: null });
        expect(board.snapshots.find((item) => item.serverId === 2)).toMatchObject({ state: "ok", metrics: { hostname: "h" } });
        expect(fleet.saved.map((health) => [health.snapshot.serverId, health.endpoint, health.snapshot.metrics])).toEqual([[1, fleetEndpoint(linux(1, { port: 2222 })), null]]);
    });
});

describe("automatic checks", () => {
    it("run only while enabled, every interval with jitter", async () => {
        const fleet = setup({ settings: { reachability: false } });
        fleet.monitor.start();
        await settle(60_000);
        expect(fleet.probes).toEqual([]);
        expect(fleet.reaches).toEqual([]);

        await fleet.monitor.updateSettings({ enabled: true, intervalMinutes: 5 });
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes.sort()).toEqual([1, 2]);
        const first = await fleet.snapshot(1);
        // random() is 0.5: exactly the interval.
        expect(first.nextCheckAt).toBe(first.checkedAt! + 5 * 60_000);

        await settle(5 * 60_000 + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes.filter((id) => id === 1)).toHaveLength(2);
        fleet.monitor.stop();
    });

    it("back off on a server that keeps failing and alert once it is confirmed unreachable", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5 }, servers: [linux(1)] });
        fleet.behave(async () => { throw unreachable(); });
        fleet.monitor.start();
        const times: number[] = [];
        const start = Date.now();
        for (let minute = 0; minute < 40; minute += 1) {
            const before = fleet.probes.length;
            await settle(60_000);
            if (fleet.probes.length > before) times.push(Math.round((Date.now() - start) / 60_000));
        }
        // Spread at startup (≤30 s), then 1 min (confirmation), 5, 10, 20 min.
        expect(times).toEqual([1, 2, 7, 17, 37]);
        const snapshot = await fleet.snapshot(1);
        expect(snapshot).toMatchObject({ state: "unreachable", failures: 5, hold: null, error: { code: "ECONNREFUSED" } });
        expect(fleet.alerts()).toEqual([{ serverId: 1, state: "unreachable", previous: null, at: expect.any(Number) }]);
        fleet.monitor.stop();
    });

    it("confirm a critical reading within a minute before alerting", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 15 }, servers: [linux(1)] });
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toHaveLength(1);
        fleet.behave(async () => reading("critical"));
        await settle(15 * 60_000 + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toHaveLength(2);
        expect(fleet.alerts()).toEqual([]);
        await settle(60_000 + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toHaveLength(3);
        expect(fleet.alerts()).toEqual([{ serverId: 1, state: "critical", previous: "ok", at: expect.any(Number) }]);
        fleet.monitor.stop();
    });
});

describe("reachability checks", () => {
    it("are on by default for the servers reached directly, without logging in", async () => {
        const fleet = setup({ servers: [linux(1), { id: 2, name: "win", ip: "10.0.0.2", type: "windows", ssh_port: 2222, updated_at: 1 }, linux(3, { jump_server_id: 1 })] });
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toEqual([]);
        expect(fleet.reaches.sort()).toEqual(["10.0.0.1:22", "10.0.0.2:2222+rdp:3389"]);
        const snapshot = await fleet.snapshot(1);
        expect(snapshot).toMatchObject({ state: "up", readAt: null, metrics: null, error: null });
        expect(snapshot.lastSeenAt).toBe(snapshot.checkedAt);
        // Behind a jump host: only a health check reaches it.
        expect(await fleet.snapshot(3)).toMatchObject({ state: "unknown", checkedAt: null, nextCheckAt: null });
        fleet.monitor.stop();
    });

    it("run every 5 minutes at most often, and alert once a server stops answering", async () => {
        const fleet = setup({ settings: { intervalMinutes: 1 }, servers: [linux(1)] });
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.reaches).toHaveLength(1);
        const first = await fleet.snapshot(1);
        expect(first.nextCheckAt! - first.checkedAt!).toBe(5 * 60_000);
        await settle(4 * 60_000);
        expect(fleet.reaches).toHaveLength(1);

        fleet.reachBehave(async () => { throw refused(); });
        await settle(60_000 + FLEET_TIMING.tickMs * 2);
        expect(fleet.reaches).toHaveLength(2);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "unreachable", error: { code: "ECONNREFUSED" } });
        expect(fleet.alerts()).toEqual([]);
        // Confirmed a minute later.
        await settle(60_000 + FLEET_TIMING.tickMs * 2);
        expect(fleet.reaches).toHaveLength(3);
        expect(fleet.alerts()).toEqual([{ serverId: 1, state: "unreachable", previous: "up", at: expect.any(Number) }]);

        fleet.reachBehave(async () => ({ ms: 2, greeting: "SSH-2.0-OpenSSH" }));
        await settle(10 * 60_000);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "up", failures: 0, error: null });
        fleet.monitor.stop();
    });

    it("record whether only the Remote Desktop port of a Windows server answered, and when SSH last did", async () => {
        const win: ServerSummary = { id: 2, name: "win", ip: "10.0.0.2", type: "windows", updated_at: 1 };
        const fleet = setup({ servers: [win] });
        fleet.reachBehave(async () => ({ ms: 3, greeting: "", service: "rdp" }));
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        const rdpOnly = await fleet.snapshot(2);
        expect(rdpOnly).toMatchObject({ state: "up", reachedVia: "rdp", sshSeenAt: null });
        expect(rdpOnly.lastSeenAt).toBe(rdpOnly.checkedAt);
        expect(fleet.saved.at(-1)?.snapshot).toMatchObject({ reachedVia: "rdp", sshSeenAt: null });

        fleet.reachBehave(async () => ({ ms: 3, greeting: "SSH-2.0-OpenSSH_for_Windows_9.5" }));
        await settle(5 * 60_000 + FLEET_TIMING.tickMs * 2);
        const ssh = await fleet.snapshot(2);
        expect(ssh).toMatchObject({ state: "up", reachedVia: "ssh", sshSeenAt: ssh.checkedAt });

        // OpenSSH stopped: Remote Desktop still answers, SSH did before.
        fleet.reachBehave(async () => ({ ms: 3, greeting: "", service: "rdp" }));
        await settle(5 * 60_000 + FLEET_TIMING.tickMs * 2);
        expect(await fleet.snapshot(2)).toMatchObject({ state: "up", reachedVia: "rdp", sshSeenAt: ssh.checkedAt });

        // A health check signs in over SSH.
        await fleet.monitor.refresh([2]);
        await settle();
        const read = await fleet.snapshot(2);
        expect(read).toMatchObject({ state: "ok", reachedVia: "ssh", sshSeenAt: read.readAt });
        fleet.monitor.stop();
    });

    it("leave a health verdict as it is, and do not confirm a critical one", async () => {
        const fleet = setup({ servers: [linux(1)] });
        fleet.behave(async () => reading("critical"));
        await fleet.monitor.refresh([1]);
        await settle();
        fleet.monitor.start();
        await settle(30 * 60_000);
        expect(fleet.probes).toEqual([1]);
        expect(fleet.reaches.length).toBeGreaterThanOrEqual(5);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "critical", issues: [{ metric: "disk" }] });
        expect(fleet.alerts()).toEqual([]);
        fleet.monitor.stop();
    });

    it("give way to health checks once those are turned on", async () => {
        const fleet = setup({ servers: [linux(1)] });
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.reaches).toHaveLength(1);
        await fleet.monitor.updateSettings({ enabled: true });
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toEqual([1]);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "ok", readAt: expect.any(Number) });
        await settle(20 * 60_000);
        expect(fleet.reaches).toHaveLength(1);
        fleet.monitor.stop();
    });
});

// UX-03: with health checks on, a Windows server reached over Remote
// Desktop only was "unreachable", alerted and listed as needing attention.
describe("health checks of a Windows server that only answers on Remote Desktop", () => {
    const win: ServerSummary = { id: 2, name: "win", ip: "10.0.0.2", type: "windows", ssh_port: 22, port: 3389, updated_at: 1 };

    it("find it up through its RDP port, automatic or asked for, with no alert", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 1 }, servers: [win] });
        fleet.behave(async () => { throw unreachable(); });
        fleet.rdpBehave(async () => 4);
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toEqual([2]);
        expect(fleet.rdpReaches).toEqual(["10.0.0.2:3389"]);
        expect(await fleet.snapshot(2)).toMatchObject({ state: "up", reachedVia: "rdp", error: null, failures: 0, hold: null });
        // Still so after the confirming checks.
        await settle(3 * 60_000);
        expect(fleet.probes.length).toBeGreaterThan(1);
        expect(await fleet.snapshot(2)).toMatchObject({ state: "up", reachedVia: "rdp" });
        await fleet.monitor.refresh([2]);
        await settle();
        expect(await fleet.snapshot(2)).toMatchObject({ state: "up", reachedVia: "rdp" });
        expect(fleet.alerts()).toEqual([]);
        fleet.monitor.stop();
    });

    it("is unreachable when neither answers, and not tried over RDP after a rejected login or behind a jump host", async () => {
        const fleet = setup({ settings: { enabled: true }, servers: [win, linux(5), { ...win, id: 6, name: "win-behind", jump_server_id: 5 }] });
        fleet.behave(async (serverId) => {
            if (serverId === 2) throw unreachable();
            if (serverId === 6) throw unreachable();
            return reading();
        });
        await fleet.monitor.refresh([2, 6]);
        await settle();
        expect(await fleet.snapshot(2)).toMatchObject({ state: "unreachable", error: { code: "ECONNREFUSED" } });
        expect(await fleet.snapshot(6)).toMatchObject({ state: "unreachable" });
        expect(fleet.rdpReaches).toEqual(["10.0.0.2:3389"]);

        fleet.behave(async () => { throw authFailure(); });
        fleet.rdpBehave(async () => 4);
        await fleet.monitor.refresh([2]);
        await settle();
        expect(await fleet.snapshot(2)).toMatchObject({ state: "error", hold: "auth" });
        expect(fleet.rdpReaches).toEqual(["10.0.0.2:3389"]);
    });
});

// CR-04: a patch run's reboot is planned: the board raises no alert for it
// and takes a login refused while the server shuts down for what it is.
describe("planned maintenance", () => {
    it("starts no automatic check, alerts nothing and holds no login meanwhile, then checks at once", async () => {
        const servers = [linux(1), linux(2), linux(3), linux(4)];
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 1 }, servers });
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect([...new Set(fleet.probes)].sort()).toEqual([1, 2, 3, 4]);

        fleet.monitor.beginMaintenance([1, 2, 3], Date.now() + 10 * 60_000);
        const before = fleet.probes.length;
        fleet.behave(async (serverId) => {
            if (serverId === 4) return reading();
            // pam_nologin while it shuts down, then nothing answers.
            throw Date.now() % 2 ? authFailure() : unreachable();
        });
        await settle(5 * 60_000);
        expect(fleet.probes.slice(before).filter((id) => id !== 4)).toEqual([]);
        // Asked for: it runs, and a refused login puts nothing on hold.
        await fleet.monitor.refresh([1, 2, 3]);
        fleet.behave(async (serverId) => {
            if (serverId === 4) return reading();
            throw authFailure();
        });
        await settle();
        for (const id of [1, 2, 3]) expect(await fleet.snapshot(id)).toMatchObject({ state: "unreachable", hold: null, blocked: null });
        await settle(3 * 60_000);
        expect(fleet.alerts()).toEqual([]);

        fleet.behave(async () => reading());
        const ended = fleet.probes.length;
        fleet.monitor.endMaintenance([1, 2, 3]);
        await settle();
        expect(fleet.probes.slice(ended).sort()).toEqual([1, 2, 3]);
        for (const id of [1, 2, 3]) expect(await fleet.snapshot(id)).toMatchObject({ state: "ok", failures: 0 });
        expect(fleet.alerts()).toEqual([]);
        fleet.monitor.stop();
    });

    it("checks a server again when the maintenance ends, with reachability checks too", async () => {
        const fleet = setup({ servers: [linux(1)] });
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.reaches).toHaveLength(1);
        fleet.monitor.beginMaintenance([1], Date.now() + 60 * 60_000);
        fleet.reachBehave(async () => { throw refused(); });
        await settle(10 * 60_000);
        expect(fleet.reaches).toHaveLength(1);
        fleet.reachBehave(async () => ({ ms: 2, greeting: "SSH-2.0-OpenSSH" }));
        fleet.monitor.endMaintenance([1]);
        await settle();
        expect(fleet.reaches).toHaveLength(2);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "up" });
        expect(fleet.alerts()).toEqual([]);
        fleet.monitor.stop();
    });
});

describe("holds", () => {
    it("never retry rejected credentials by themselves; a new password or 'Check now' does", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 1 }, servers: [linux(1)] });
        fleet.markers.set(1, "iv-1");
        fleet.behave(async () => { throw authFailure(); });
        fleet.monitor.start();
        await settle(10 * 60_000);
        expect(fleet.probes).toEqual([1]);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "error", hold: "auth", nextCheckAt: null, error: { code: "AUTH_FAILED" } });
        const heldVersion = fleet.saved.at(-1)?.holdContext?.version;
        expect(heldVersion).toMatch(/^1:/);

        // "Check all" leaves it alone too.
        expect((await fleet.monitor.refresh()).queued).toEqual([]);

        // The password was saved again: its marker changed.
        fleet.behave(async () => reading());
        fleet.markers.set(1, "iv-2");
        await settle(FLEET_TIMING.syncMs + 10_000);
        expect(fleet.probes).toEqual([1, 1]);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "ok", hold: null });

        fleet.behave(async () => { throw authFailure(); });
        await settle(2 * 60_000);
        expect(fleet.probes).toEqual([1, 1, 1]);
        expect((await fleet.monitor.refresh([1])).queued).toEqual([1]);
        await settle();
        expect(fleet.probes).toEqual([1, 1, 1, 1]);
        fleet.monitor.stop();
    });

    it("are not lifted by edits that do not change the connection", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 1 }, servers: [linux(1)] });
        fleet.behave(async () => { throw authFailure(); });
        fleet.monitor.start();
        await settle(2 * 60_000);
        expect(fleet.probes).toEqual([1]);

        // Notes, tags, group, colour, name: the row's updated_at changes, the connection does not.
        fleet.setServers([linux(1, { name: "web (prod)", notes: "see wiki", tags: ["prod"], group_name: "Web", color: "red", updated_at: 99 })]);
        await settle(10 * 60_000);
        expect(fleet.probes).toEqual([1]);
        expect((await fleet.snapshot(1)).hold).toBe("auth");

        // Another user is a new connection.
        fleet.setServers([linux(1, { username: "deploy", updated_at: 100 })]);
        await settle(FLEET_TIMING.syncMs + 10_000);
        expect(fleet.probes).toEqual([1, 1]);
        fleet.monitor.stop();
    });

    it("lift a changed host key's hold once the new key is trusted", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 1 }, servers: [linux(1)] });
        fleet.hostKeys.set("10.0.0.1:22:", "SHA256:old");
        fleet.behave(async () => { throw new ProbeError("connect", new HostKeyMismatchError("10.0.0.1", 22, "ssh-ed25519", "SHA256:old", "SHA256:new")); });
        fleet.monitor.start();
        await settle(5 * 60_000);
        expect(fleet.probes).toEqual([1]);
        expect((await fleet.snapshot(1)).hold).toBe("host-key");

        fleet.hostKeys.set("10.0.0.1:22:", "SHA256:new");
        fleet.behave(async () => reading());
        await settle(FLEET_TIMING.syncMs + 10_000);
        expect(fleet.probes).toEqual([1, 1]);
        expect((await fleet.snapshot(1)).state).toBe("ok");
        fleet.monitor.stop();
    });

    it("survive a restart, unless the connection was changed meanwhile", async () => {
        const first = setup({ settings: { enabled: true }, servers: [linux(1)] });
        first.behave(async () => { throw authFailure(); });
        await first.monitor.refresh([1]);
        await settle();
        const held = first.saved.at(-1)!;
        expect(held.snapshot.hold).toBe("auth");

        const kept = setup({ stored: [held], settings: { enabled: true }, servers: [linux(1, { notes: "edited", updated_at: 7 })] });
        kept.monitor.start();
        await settle(10 * 60_000);
        expect(kept.probes).toEqual([]);
        expect(await kept.snapshot(1)).toMatchObject({ state: "error", hold: "auth" });
        kept.monitor.stop();

        const edited = setup({ stored: [held], settings: { enabled: true }, servers: [linux(1, { ip: "10.0.0.11", updated_at: 7 })] });
        edited.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(edited.probes).toEqual([1]);
        edited.monitor.stop();
    });
});

describe("jump hosts", () => {
    const bastion = linux(1, { name: "bastion" });
    const behind = (id: number, jump = 1) => linux(id, { ip: `192.168.0.${id}`, jump_server_id: jump });

    it("a rejected jump host login is tried once for the whole route, however many servers are behind it", async () => {
        const servers = [bastion, ...[2, 3, 4, 5, 6].map((id) => behind(id))];
        // Due times spread over the catch-up window, the jump host's last.
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 1 }, servers, random: cycle([0.9, 0.1, 0.3, 0.5, 0.7, 0.2]) });
        const net = network(new Set([1]));
        fleet.behave(net.probe);
        fleet.monitor.start();
        await settle(10 * 60_000);
        expect(net.attempts(1)).toBe(1);
        // The first server behind it found out; nothing was recorded on it.
        expect(fleet.probes).toHaveLength(1);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "error", hold: "auth", error: { code: "AUTH_FAILED" } });
        for (const id of [2, 3, 4, 5, 6]) {
            expect(await fleet.snapshot(id)).toMatchObject({
                state: "unknown", hold: null, error: null, nextCheckAt: null,
                blocked: { kind: "jump-host", serverId: 1, hold: "auth" }
            });
        }

        // Neither "Check all" nor naming a server behind it tries again.
        expect((await fleet.monitor.refresh()).queued).toEqual([]);
        expect(await fleet.monitor.refresh([4])).toEqual({ queued: [], skipped: [{ serverId: 4, reason: "jump-host" }] });
        await settle(60_000);
        expect(net.attempts(1)).toBe(1);
        fleet.monitor.stop();
    });

    it("checks the jump host first when both are due, and the servers behind it once it works", async () => {
        const servers = [bastion, behind(2), behind(3)];
        const rejected = new Set([1]);
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5 }, servers });
        const net = network(rejected);
        fleet.behave(net.probe);
        fleet.monitor.start();
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        // All three were due at once: only the jump host was checked.
        expect(fleet.probes).toEqual([1]);
        expect(net.attempts(1)).toBe(1);

        // Its password is fixed: it is checked again, then the servers behind it.
        rejected.clear();
        fleet.markers.set(1, "new password");
        await settle(FLEET_TIMING.syncMs + FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        expect(fleet.probes).toEqual([1, 1, 2, 3]);
        expect(net.attempts(1)).toBe(2);
        for (const id of [2, 3]) expect(await fleet.snapshot(id)).toMatchObject({ state: "ok", blocked: null });
        fleet.monitor.stop();
    });

    it("blames the hop that failed in a longer route", async () => {
        // 3 behind 2 behind 1: 1 rejects the login.
        const servers = [bastion, behind(2), behind(3, 2)];
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5, excludedServerIds: [1, 2] }, servers });
        const net = network(new Set([1]));
        fleet.behave(net.probe);
        fleet.monitor.start();
        await settle(10 * 60_000);
        expect(fleet.probes).toEqual([3]);
        expect(net.attempts(1)).toBe(1);
        expect(net.attempts(2)).toBe(0);
        expect(await fleet.snapshot(1)).toMatchObject({ hold: "auth", monitored: false });
        expect(await fleet.snapshot(2)).toMatchObject({ hold: null, blocked: { kind: "jump-host", serverId: 1 } });
        expect(await fleet.snapshot(3)).toMatchObject({ hold: null, state: "unknown", blocked: { kind: "jump-host", serverId: 1 } });
        fleet.monitor.stop();
    });

    it("records the jump host's rejected login while only its reachability is being checked", async () => {
        const fleet = setup({ servers: [bastion, behind(2)] });
        // The check of the server behind it is under way (its jump host's
        // login is slow to be refused) when the jump host's reachability
        // check comes due (+15 s) and starts.
        fleet.behave(() => new Promise((_resolve, reject) => setTimeout(() => reject(new ProbeError("connect", rejectedLogin(), 1)), 3000)));
        fleet.reachBehave(() => new Promise((resolve) => setTimeout(() => resolve({ ms: 1, greeting: "SSH-2.0-x" }), 5000)));
        fleet.monitor.start();
        await settle(14_500);
        await fleet.monitor.refresh([2]);
        await settle(2000);
        expect(fleet.reaches).toEqual(["10.0.0.1:22"]);
        await settle(1500);
        expect(await fleet.snapshot(1)).toMatchObject({ hold: "auth", error: { code: "AUTH_FAILED" } });
        // The reachability check ends: the hold stays.
        await settle(10_000);
        expect(await fleet.snapshot(1)).toMatchObject({ state: "error", hold: "auth", nextCheckAt: null });
        expect(await fleet.snapshot(2)).toMatchObject({ state: "unknown", blocked: { kind: "jump-host", serverId: 1, hold: "auth" } });
        expect(fleet.probes).toEqual([2]);
        fleet.monitor.stop();
    });

    it("says which jump host could not be reached", async () => {
        const fleet = setup({ settings: { reachability: false }, servers: [bastion, behind(2)] });
        fleet.behave(async (serverId, route) => {
            if (route.includes(1)) throw new ProbeError("connect", refused(), 1);
            return reading();
        });
        await fleet.monitor.refresh([2]);
        await settle();
        // Unreachable through it: not a hold, so it is retried.
        expect(await fleet.snapshot(2)).toMatchObject({ state: "unreachable", hold: null, error: { code: "ECONNREFUSED", jumpServerId: 1 } });
        expect(await fleet.snapshot(1)).toMatchObject({ state: "unknown" });
    });
});

describe("logins rejected on several servers", () => {
    const sameUser = (count: number) => Array.from({ length: count }, (_, index) => linux(index + 1, { username: "ops" }));

    it(`pause the automatic checks of the other servers of that login after ${LOGIN_BREAKER_FAILURES} in a row`, async () => {
        const spread = cycle([0.05, 0.6, 0.3, 0.9, 0.15, 0.45, 0.75, 0.2, 0.5, 0.85]);
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5 }, servers: sameUser(10), concurrency: 6, random: spread });
        const net = network(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
        fleet.behave(net.probe);
        fleet.monitor.start();
        await settle(30 * 60_000);
        // The first rejection makes the login suspect (one server at a
        // time); the third pauses it.
        expect(fleet.probes).toHaveLength(LOGIN_BREAKER_FAILURES);
        const board = await fleet.monitor.board();
        const held = board.snapshots.filter((item) => item.hold === "auth");
        const paused = board.snapshots.filter((item) => item.blocked?.kind === "login");
        expect(held.length + paused.length).toBe(10);
        expect(paused[0].blocked).toEqual({ kind: "login", user: "ops", identity: false, servers: held.length });
        expect(paused.every((item) => item.nextCheckAt === null && item.state === "unknown")).toBe(true);

        // "Check all" leaves them alone; naming one tries it.
        expect((await fleet.monitor.refresh()).queued).toEqual([]);
        const one = paused[0].serverId;
        expect((await fleet.monitor.refresh([one])).queued).toEqual([one]);
        await settle();
        expect(fleet.probes.at(-1)).toBe(one);
        fleet.monitor.stop();
    });

    it("count the checks that were already running when the first rejection came", async () => {
        // All ten due at the same moment: six start at once, before any answer.
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5 }, servers: sameUser(10), concurrency: 6 });
        fleet.behave(network(new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])).probe);
        fleet.monitor.start();
        await settle(30 * 60_000);
        expect(fleet.probes).toHaveLength(6);
        expect((await fleet.monitor.board()).snapshots.filter((item) => item.blocked?.kind === "login")).toHaveLength(4);
        fleet.monitor.stop();
    });

    it("work again everywhere once that login works on one of them", async () => {
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5 }, servers: sameUser(6), concurrency: 1 });
        const rejected = new Set([1, 2, 3, 4, 5, 6]);
        const net = network(rejected);
        fleet.behave(net.probe);
        fleet.monitor.start();
        await settle(10 * 60_000);
        expect(fleet.probes).toHaveLength(LOGIN_BREAKER_FAILURES);
        const pausedIds = (await fleet.monitor.board()).snapshots.filter((item) => item.blocked).map((item) => item.serverId);
        expect(pausedIds).toHaveLength(6 - LOGIN_BREAKER_FAILURES);

        // The account works again (its password was reset back).
        rejected.clear();
        await fleet.monitor.refresh([pausedIds[0]]);
        await settle(FLEET_TIMING.catchUpMs + FLEET_TIMING.tickMs * 2);
        for (const id of pausedIds) expect(await fleet.snapshot(id)).toMatchObject({ state: "ok", blocked: null });
        fleet.monitor.stop();
    });

    it("keep apart servers that log in as other users", async () => {
        const servers = [...sameUser(3), linux(4, { username: "deploy" }), linux(5)];
        const fleet = setup({ settings: { enabled: true, intervalMinutes: 5 }, servers });
        const net = network(new Set([1, 2, 3]));
        fleet.behave(net.probe);
        fleet.monitor.start();
        await settle(10 * 60_000);
        expect(await fleet.snapshot(4)).toMatchObject({ state: "ok", blocked: null });
        expect(await fleet.snapshot(5)).toMatchObject({ state: "ok", blocked: null });
        fleet.monitor.stop();
    });
});

describe("settings", () => {
    it("are saved, pushed to listeners and recorded in the audit log", async () => {
        const fleet = setup();
        const next = await fleet.monitor.updateSettings({ enabled: true, intervalMinutes: 15, excludedServerIds: [2, 2, 1] });
        expect(next).toEqual({ enabled: true, reachability: true, intervalMinutes: 15, notifications: true, excludedServerIds: [1, 2] });
        expect(await fleet.monitor.getSettings()).toEqual(next);
        await settle();
        expect(fleet.events.some((event) => event.settings?.intervalMinutes === 15)).toBe(true);
        expect(fleet.audits).toEqual([{
            source: "fleet",
            command: "fleet health checks on, every 15 min; 2 server(s) left out of automatic checks",
            meta: { enabled: true, reachability: true, intervalMinutes: 15, excludedServers: 2 }
        }]);
        await fleet.monitor.updateSettings({ notifications: false });
        expect(fleet.audits).toHaveLength(1);
        await fleet.monitor.updateSettings({ enabled: false, reachability: false });
        expect(fleet.audits.at(-1)?.command).toBe("fleet health checks off; fleet reachability checks off");
    });

    it("keep only servers on the board out of the checks", async () => {
        const fleet = setup();
        expect((await fleet.monitor.updateSettings({ excludedServerIds: [1, 3, 999_999] })).excludedServerIds).toEqual([1]);
        await fleet.monitor.updateSettings({ excludedServerIds: [1, 2] });

        // Server 2 is deleted: it leaves the setting, which is saved and pushed.
        fleet.setServers([linux(1)]);
        await fleet.monitor.board();
        await settle();
        expect(fleet.savedSettings().excludedServerIds).toEqual([1]);
        expect(fleet.events.at(-1)?.settings?.excludedServerIds).toEqual([1]);
    });
});
