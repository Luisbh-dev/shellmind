import type { ChatEvidenceSection } from "../../../shared/chat";
import type { FleetMetrics, FleetSnapshot } from "../../../shared/fleet";
import { serversRepo } from "../../db/serversRepo";
import { fleetEndpoint, fleetRepo } from "../../fleet/repo";
import { textSection } from "./sections";

// What the fleet board last stored about a server that cannot be reached now
// (health_snapshots, server/fleet): its latest reading, dated, so a diagnosis
// of a server that is down still sees what it looked like before. The model
// is told how old it is; it is not current evidence.

const MINUTE = 60_000;

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

export function describeAge(ms: number): string {
    const minutes = Math.max(0, Math.round(ms / MINUTE));
    if (minutes < 1) return "less than a minute";
    if (minutes < 60) return `${minutes} min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours} h ${minutes % 60} min`;
    return `${Math.floor(hours / 24)} days`;
}

const percent = (value: number) => `${Math.round(value)}%`;
const gb = (value: number) => `${value.toFixed(1)} GB`;

function metricLines(metrics: FleetMetrics): string[] {
    const lines = [`Host: ${[metrics.hostname, metrics.os, metrics.kernel ? `kernel ${metrics.kernel}` : ""].filter(Boolean).join(", ")}`];
    if (metrics.uptimeSeconds !== null) {
        lines.push(`Uptime: ${describeAge(metrics.uptimeSeconds * 1000)}${metrics.bootedAt ? ` (booted ${iso(metrics.bootedAt)})` : ""}`);
    }
    const cpu = [
        metrics.load ? `load ${metrics.load.one} ${metrics.load.five} ${metrics.load.fifteen}` : "",
        metrics.loadPerCore !== null ? `${metrics.loadPerCore.toFixed(2)} per core` : "",
        metrics.cores !== null ? `${metrics.cores} cores` : "",
        metrics.cpuPercent !== null ? `processor ${percent(metrics.cpuPercent)}` : ""
    ].filter(Boolean);
    if (cpu.length) lines.push(`CPU: ${cpu.join(", ")}`);
    if (metrics.memory) {
        lines.push(`Memory: ${percent(metrics.memory.usagePercent)} used, ${metrics.memory.availableMB} MB available of ${metrics.memory.totalMB} MB`);
    }
    if (metrics.swapPercent !== null) lines.push(`Swap: ${percent(metrics.swapPercent)} used`);
    if (metrics.disk) {
        lines.push(`Fullest disk: ${metrics.disk.mount} ${percent(metrics.disk.usagePercent)} used, ${gb(metrics.disk.freeGB)} free of ${gb(metrics.disk.totalGB)}`);
    }
    if (metrics.failedUnits !== null) lines.push(`Failed systemd units: ${metrics.failedUnits}`);
    if (metrics.rebootRequired !== null) lines.push(`Reboot required: ${metrics.rebootRequired ? "yes" : "no"}`);
    if (metrics.updates) {
        const security = metrics.updates.security !== null ? ` (${metrics.updates.security} security)` : "";
        lines.push(`Pending updates (${metrics.updates.manager}, from its package cache): ${metrics.updates.count}${security}`);
    }
    return lines;
}

function issueLine(snapshot: Pick<FleetSnapshot, "issues">): string | null {
    if (!snapshot.issues.length) return null;
    const issues = snapshot.issues.map((issue) => `${issue.metric}${issue.mount ? ` ${issue.mount}` : ""} ${issue.tone} (${issue.value})`);
    return `What the board flagged: ${issues.join(", ")}`;
}

// The section, or null when the board never read the server nor saw it answer.
export function fleetSection(snapshot: Omit<FleetSnapshot, "monitored" | "checking" | "nextCheckAt" | "blocked">, now: number): ChatEvidenceSection | null {
    const readAt = snapshot.metrics ? snapshot.readAt ?? snapshot.lastSeenAt : null;
    if (readAt === null && snapshot.lastSeenAt === null) return null;
    const lines = [
        "The fleet board's latest stored reading of this server, from before this failed connection. It is not current: weigh it by its age."
    ];
    if (readAt !== null && snapshot.metrics) {
        lines.push(`Read at: ${iso(readAt)} (${describeAge(now - readAt)} before this evidence)`, ...metricLines(snapshot.metrics));
        const issues = issueLine(snapshot);
        if (issues) lines.push(issues);
    } else {
        lines.push("The board never read its metrics (health checks that sign in are off or never succeeded).");
    }
    if (snapshot.lastSeenAt !== null) {
        // Only the Remote Desktop port of a Windows server may have answered.
        const rdpOnly = snapshot.reachedVia === "rdp";
        lines.push(`Last answered the board: ${iso(snapshot.lastSeenAt)} (${describeAge(now - snapshot.lastSeenAt)} before this evidence)${rdpOnly ? " (Remote Desktop port only; SSH did not answer)" : ""}`);
        if (rdpOnly) {
            lines.push(snapshot.sshSeenAt !== null
                ? `SSH last answered the board: ${iso(snapshot.sshSeenAt)} (${describeAge(now - snapshot.sshSeenAt)} before this evidence)`
                : "SSH never answered the board.");
        }
    }
    if (snapshot.checkedAt !== null) {
        const outcome = snapshot.error ? `failed: ${snapshot.error.code}: ${snapshot.error.message}` : `state ${snapshot.state}`;
        lines.push(`Latest board check: ${iso(snapshot.checkedAt)}, ${outcome}`);
    }
    const dated = readAt ?? snapshot.lastSeenAt!;
    return {
        ...textSection({ id: "fleet", title: `Last fleet health reading (${iso(dated)})`, source: `fleet health check of ${iso(dated)}` }, lines.join("\n"), 4000),
        readAt: dated
    };
}

export async function fleetEvidence(serverId: number, now: number): Promise<ChatEvidenceSection | null> {
    const [stored, server] = await Promise.all([fleetRepo.get(serverId), serversRepo.getSummary(serverId)]);
    if (!stored || !server) return null;
    // Read where the server was before it was moved (another address, port,
    // type or jump host): not this server's past.
    if (stored.endpoint !== null && stored.endpoint !== fleetEndpoint(server)) return null;
    return fleetSection(stored.snapshot, now);
}
