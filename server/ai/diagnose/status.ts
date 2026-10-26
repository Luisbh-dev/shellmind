import type { ChatEvidenceSection } from "../../../shared/chat";
import type { StatusSnapshot } from "../../../shared/status";
import { assessHealth, THRESHOLDS, type HealthIssue } from "../../../shared/thresholds";
import { AppError } from "../../errors";
import { runPosixScript, runPowerShell } from "../../ops/remote";
import { collectStatus } from "../../status/collect";
import { EVIDENCE_COMMAND_TIMEOUT_MS, EVIDENCE_OUTPUT_MAX_BYTES, type EvidenceContext } from "./context";
import { WINDOWS_SERVICES_DENIED_REASON, attempt, textSection } from "./sections";

// The status evidence: the dashboard's snapshot as a short report, graded
// with the same thresholds as the dashboard (shared/thresholds.ts), plus the
// units that failed (Linux) or the automatic services that are not running
// (Windows), which the snapshot only counts.

const SNAPSHOT_CHARS = 6000;
const LIST_CHARS = 4000;

const fixed = (value: number, digits = 1) => (Math.round(value * 10 ** digits) / 10 ** digits).toString();

function uptime(seconds: number): string {
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return days ? `${days} d ${hours} h` : hours ? `${hours} h ${minutes} min` : `${minutes} min`;
}

function rate(bytesPerSecond: number): string {
    if (bytesPerSecond >= 1024 * 1024) return `${fixed(bytesPerSecond / (1024 * 1024))} MB/s`;
    if (bytesPerSecond >= 1024) return `${fixed(bytesPerSecond / 1024)} KB/s`;
    return `${Math.round(bytesPerSecond)} B/s`;
}

function issueText(issue: HealthIssue): string {
    switch (issue.metric) {
        case "cpu": return `CPU ${fixed(issue.value)}%`;
        case "memory": return `memory ${fixed(issue.value)}%`;
        case "load": return `load ${fixed(issue.value, 2)} per core`;
        case "disk": return `disk ${issue.mount ?? "total"} ${fixed(issue.value)}%`;
        case "failedUnits": return `${issue.value} failed unit${issue.value === 1 ? "" : "s"}`;
    }
}

export function formatSnapshot(snapshot: StatusSnapshot): string {
    const health = assessHealth(snapshot);
    const verdict = health.tone === "unknown"
        ? "unknown (no metric was reported)"
        : health.issues.length
            ? `${health.tone}: ${health.issues.map((issue) => `${issueText(issue)} (${issue.tone})`).join(", ")}`
            : "ok";
    const lines = [
        `Host: ${snapshot.hostname} (${snapshot.os}${snapshot.kernel ? `, ${snapshot.platform === "windows" ? "version" : "kernel"} ${snapshot.kernel}` : ""})`,
        `Collected: ${new Date(snapshot.collectedAt).toISOString()}${snapshot.uptimeSeconds !== null ? `, up ${uptime(snapshot.uptimeSeconds)}` : ""}`,
        `Health: ${verdict}`,
        `Thresholds (warn/critical): CPU ${THRESHOLDS.cpu.warn}/${THRESHOLDS.cpu.critical}%, memory ${THRESHOLDS.memory.warn}/${THRESHOLDS.memory.critical}%, disk ${THRESHOLDS.disk.warn}/${THRESHOLDS.disk.critical}%, load per core ${THRESHOLDS.loadPerCore.warn}/${THRESHOLDS.loadPerCore.critical}`
    ];
    if (snapshot.cpu) {
        lines.push(`CPU: ${fixed(snapshot.cpu.usagePercent)}% over ${fixed(snapshot.sampleSeconds)} s${snapshot.cpu.cores ? ` of ${snapshot.cpu.cores} cores` : ""}${snapshot.cpu.iowaitPercent !== null ? `, iowait ${fixed(snapshot.cpu.iowaitPercent)}%` : ""}`);
    }
    if (snapshot.load) lines.push(`Load average: ${fixed(snapshot.load.one, 2)} ${fixed(snapshot.load.five, 2)} ${fixed(snapshot.load.fifteen, 2)}`);
    if (snapshot.memory) {
        lines.push(`Memory: ${fixed(snapshot.memory.usedMB / 1024)} of ${fixed(snapshot.memory.totalMB / 1024)} GB used (${fixed(snapshot.memory.usagePercent)}%), ${fixed(snapshot.memory.availableMB / 1024)} GB available`);
    }
    if (snapshot.swap) lines.push(`Swap: ${fixed(snapshot.swap.usedMB / 1024)} of ${fixed(snapshot.swap.totalMB / 1024)} GB used (${fixed(snapshot.swap.usagePercent)}%)`);
    if (snapshot.disks.length) {
        lines.push("Filesystems:");
        for (const disk of snapshot.disks) {
            lines.push(`  ${disk.mount} (${disk.name}${disk.fsType ? `, ${disk.fsType}` : ""}): ${fixed(disk.usagePercent)}% used, ${fixed(disk.freeGB)} of ${fixed(disk.totalGB)} GB free`);
        }
    }
    if (snapshot.network) lines.push(`Network: in ${rate(snapshot.network.rxBytesPerSec)}, out ${rate(snapshot.network.txBytesPerSec)}`);
    if (snapshot.failedUnits !== null) lines.push(`Failed systemd units: ${snapshot.failedUnits}`);
    if (snapshot.loggedInUsers !== null) lines.push(`Users logged in: ${snapshot.loggedInUsers}`);
    if (snapshot.processes.length) {
        lines.push(`Busiest processes (CPU over the ${fixed(snapshot.sampleSeconds)} s sample, 100% = one core):`);
        for (const process of snapshot.processes) {
            const memory = process.memoryMB !== null ? `, ${fixed(process.memoryMB, 0)} MB` : "";
            lines.push(`  pid ${process.pid} ${process.name}: CPU ${fixed(process.cpuPercent)}%${memory}`);
        }
    }
    if (snapshot.unavailable.length) lines.push(`Not reported by the host: ${snapshot.unavailable.join(", ")}`);
    return lines.join("\n");
}

export const FAILED_UNITS_SCRIPT = "systemctl list-units --state=failed --no-legend --plain --no-pager 2>&1 | head -n 60\n";

// Automatic services that are not running. Trigger-start and delayed
// services may be stopped on purpose; the exit code tells them apart.
export const WINDOWS_STOPPED_SERVICES_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$s=@(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'")
if(-not $s.Count){'(every automatic service is running)';exit 0}
$s|Select-Object -First 60|%{'{0} ({1}): {2}, exit code {3}' -f $_.Name,$_.DisplayName,$_.State,$_.ExitCode}
`;

// The same for an account that is not an administrator, which may not use
// WMI over SSH: from the service manager's list (no exit codes), exit 5 when
// it may not list the services either.
export const WINDOWS_LIMITED_STOPPED_SERVICES_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$x=$null;$s=@(Get-Service -ErrorVariable x)
if(-not $s.Count -and $x){exit 5}
$s=@($s|?{$_.StartType -eq 'Automatic' -and $_.Status -ne 'Running'})
if(-not $s.Count){'(every automatic service is running)';exit 0}
$s|Select-Object -First 60|%{'{0} ({1}): {2}' -f $_.Name,$_.DisplayName,$_.Status}
`;

export async function failedUnitsSection(ctx: EvidenceContext): Promise<ChatEvidenceSection | null> {
    const { lease, caps, signal } = ctx;
    if (caps.platform === "windows") {
        const limited = caps.root === false;
        const base = { id: "stopped-services" as const, title: "Automatic services that are not running", source: limited ? "Get-Service (StartType Automatic, not running)" : "Get-CimInstance Win32_Service (StartMode Auto, not running)" };
        return attempt(base, signal, async () => {
            const result = await runPowerShell(lease, limited ? WINDOWS_LIMITED_STOPPED_SERVICES_SCRIPT : WINDOWS_STOPPED_SERVICES_SCRIPT, { timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS.windows, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
            if (limited && result.code === 5) throw new AppError("OPS_PERMISSION_DENIED", WINDOWS_SERVICES_DENIED_REASON, 403);
            return textSection(base, result.stdout, LIST_CHARS);
        });
    }
    if (!caps.systemd) return null;
    const base = { id: "failed-units" as const, title: "Failed systemd units", source: "systemctl list-units --state=failed" };
    return attempt(base, signal, async () => {
        const result = await runPosixScript(lease, FAILED_UNITS_SCRIPT, { timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS.linux, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
        return textSection(base, result.stdout.trim() || "(none)", LIST_CHARS);
    });
}

export async function statusEvidence(ctx: EvidenceContext): Promise<ChatEvidenceSection[]> {
    const base = { id: "snapshot" as const, title: "Status snapshot", source: "ShellMind status collection (one-second sample)" };
    const [snapshot, failed] = await Promise.all([
        attempt(base, ctx.signal, async () => textSection(base, formatSnapshot(await collectStatus(ctx.serverId, ctx.signal)), SNAPSHOT_CHARS)),
        failedUnitsSection(ctx)
    ]);
    return failed ? [snapshot, failed] : [snapshot];
}
