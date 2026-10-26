import type { FleetMetrics, FleetUpdates, PackageManager } from "../../shared/fleet";
import type { StatusSnapshot } from "../../shared/status";
import { assessHealth, storageReading, type HealthIssue, type Tone } from "../../shared/thresholds";
import { AppError } from "../errors";
import { asNumber, cleanStderr, extractJson, isRecord, parseSections, runPosixScript, runPowerShell } from "../ops/remote";
import { ExecAbortedError } from "../ssh/exec";
import { sshPool, type SshLease } from "../ssh/pool";
import { roundTo } from "../status/parse";
import { LINUX_STATUS_SCRIPT, parseLinuxStatus } from "../status/linux";
import { WINDOWS_SYSTEM_FACTS, parseWindowsStatus } from "../status/windows";

// The fleet board's health check: a lighter version of the status
// dashboard's report, run as one read-only, unprivileged script over one
// channel of the server's pooled SSH connection. It takes no one-second CPU,
// network or process sample, reads the package cache without refreshing it,
// and adds what a fleet view needs: a pending reboot, pending updates and the
// last boot. The readings go through the status parsers, so both views agree.

// The whole check, connection included, is bounded by its caller; these
// bound the script (PowerShell cold starts are slow).
export const FLEET_PROBE_TIMEOUT_MS = { linux: 30_000, windows: 45_000 };

// The base sections of the status report (host, OS, kernel, load, memory,
// filesystems, failed units, users), without its sampling part.
const SAMPLING_START = "\nm up1\n";

function linuxBaseSections(): string {
    const end = LINUX_STATUS_SCRIPT.indexOf(SAMPLING_START);
    if (end === -1) throw new Error("The status script no longer has the sections the fleet check builds on");
    return LINUX_STATUS_SCRIPT.slice(0, end);
}

// `t <command>`: with a 10 s limit when the system has `timeout` (busybox
// before 1.30 spells it -t). Package managers can be slow on a cold cache;
// they must not make the whole check fail. The patch center (server/patch)
// builds on this and on LINUX_REBOOT.
export const LINUX_LIMIT_FUNCTION = [
    "if timeout 5 true >/dev/null 2>&1; then t() { timeout 10 \"$@\"; }",
    "elif timeout -t 5 true >/dev/null 2>&1; then t() { timeout -t 10 \"$@\"; }",
    "else t() { \"$@\"; }; fi"
].join("\n");

// A pending reboot: the Debian/Ubuntu flag file, needs-restarting on the RHEL
// family (exit 1: reboot needed), a running kernel whose modules were removed
// (Arch), or a newer installed kernel than the running one. Nothing printed:
// unknown.
export const LINUX_REBOOT = [
    "if [ -e /var/run/reboot-required ] || [ -e /run/reboot-required ]; then echo yes",
    "elif command -v needs-restarting >/dev/null 2>&1; then t needs-restarting -r >/dev/null 2>&1; r=$?; if [ $r -eq 1 ]; then echo yes; elif [ $r -eq 0 ]; then echo no; fi",
    "elif [ -n \"$(ls /lib/modules 2>/dev/null)\" ] && [ ! -d \"/lib/modules/$(uname -r)\" ]; then echo yes",
    "else k=$(ls -1 /boot 2>/dev/null | sed -n 's/^vmlinu[xz]-//p' | grep -v rescue | grep '^[0-9]' | sort -V 2>/dev/null | tail -n 1)",
    "if [ -n \"$k\" ]; then if [ \"$k\" = \"$(uname -r)\" ]; then echo no; else echo yes; fi; fi",
    "fi"
].join("\n");

// Pending updates from the package cache only, as "<manager> <count>
// <security or -> <cache mtime, epoch s>". Nothing printed: unknown (no
// manager, or a cache that was never filled).
const LINUX_UPDATES = [
    "if [ -x /usr/lib/update-notifier/apt-check ]; then",
    "c=$(t /usr/lib/update-notifier/apt-check 2>&1 >/dev/null | grep -E '^[0-9]+;[0-9]+$' | tail -n 1)",
    "[ -n \"$c\" ] && echo \"apt ${c%;*} ${c#*;} $(stat -c %Y /var/lib/apt/lists 2>/dev/null)\"",
    "elif command -v apt-get >/dev/null 2>&1; then",
    "if ls /var/lib/apt/lists/*_Packages* >/dev/null 2>&1; then",
    "u=$(t apt-get -s -o Debug::NoLocking=true dist-upgrade 2>/dev/null | grep '^Inst ')",
    "echo \"apt $(printf '%s\\n' \"$u\" | grep -c '^Inst ') $(printf '%s\\n' \"$u\" | grep -ci securi) $(stat -c %Y /var/lib/apt/lists 2>/dev/null)\"",
    "fi",
    "elif command -v dnf >/dev/null 2>&1 || command -v yum >/dev/null 2>&1; then",
    "p=yum; command -v dnf >/dev/null 2>&1 && p=dnf",
    "o=$(t $p -q -C check-update 2>/dev/null); r=$?",
    "if [ $r -eq 0 ] || [ $r -eq 100 ]; then",
    "n=$(printf '%s\\n' \"$o\" | awk '/^Obsoleting/ { exit } NF == 3 && $1 ~ /\\./ { c++ } END { print c + 0 }')",
    "s=-; si=$(t $p -q -C updateinfo list --security 2>/dev/null) && s=$(printf '%s\\n' \"$si\" | grep -c .)",
    "echo \"$p $n $s $(stat -c %Y /var/cache/$p 2>/dev/null)\"",
    "fi",
    "elif command -v zypper >/dev/null 2>&1; then",
    "o=$(t zypper -n --no-refresh -q list-updates 2>/dev/null) && echo \"zypper $(printf '%s\\n' \"$o\" | grep -c '^v ') - $(stat -c %Y /var/cache/zypp/raw 2>/dev/null)\"",
    "elif command -v apk >/dev/null 2>&1; then",
    "if ls /var/cache/apk/APKINDEX.* >/dev/null 2>&1; then",
    // apk-tools 3 downloads indexes older than four hours for a listing.
    "echo \"apk $(t apk --no-network version -l '<' 2>/dev/null | grep -c ' < ') - $(stat -c %Y /var/cache/apk 2>/dev/null)\"",
    "fi",
    "elif command -v pacman >/dev/null 2>&1; then",
    "echo \"pacman $(t pacman -Qu 2>/dev/null | grep -c .) - $(stat -c %Y /var/lib/pacman/sync 2>/dev/null)\"",
    "fi"
].join("\n");

let linuxScript: string | null = null;

// Built on first use from the status script, so a change there (a fix of the
// filesystem list, say) applies to both.
export function fleetLinuxScript(): string {
    linuxScript ??= [
        linuxBaseSections(),
        // parseLinuxStatus reads the uptime from up2 and the cores from cpu1.
        "m up1",
        "cat /proc/uptime",
        "m up2",
        "cat /proc/uptime",
        "m cpu1",
        "grep '^cpu' /proc/stat",
        LINUX_LIMIT_FUNCTION,
        "m reboot",
        LINUX_REBOOT,
        "m updates",
        LINUX_UPDATES,
        "m end",
        ""
    ].join("\n");
    return linuxScript;
}

// A pending reboot on Windows: the flag of component servicing or of Windows
// Update, as a PowerShell expression. The patch center's scan reads it too.
export const WINDOWS_REBOOT_PENDING = "(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Component Based Servicing\\RebootPending') -or (Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired')";

// Windows: the operating system, memory, fixed disks, the processor load and
// the pending-reboot flags of servicing and Windows Update, as the status
// report's JSON (parseWindowsStatus reads it) plus `load` and `reboot`. An
// account that may not use WMI (see WINDOWS_SYSTEM_FACTS) reports no load.
export const FLEET_WINDOWS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
${WINDOWS_SYSTEM_FACTS}
$l=$null;if($wmi){$l=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average}
$r=${WINDOWS_REBOOT_PENDING}
@{host=$env:COMPUTERNAME;os=$os;ver=$ver;up=$up;cores=[Environment]::ProcessorCount;mem=$mem;disks=$d;load=$l;reboot=$r;wmi=$wmi}|ConvertTo-Json -Compress -Depth 4
`;

type Extras = {
    cores: number | null;
    rebootRequired: boolean | null;
    updates: FleetUpdates | null;
};

const MANAGERS: readonly PackageManager[] = ["apt", "dnf", "yum", "zypper", "apk", "pacman"];
const MAX_REASONABLE_UPDATES = 100_000;

export function parseRebootLine(raw: string | undefined): boolean | null {
    const value = (raw ?? "").trim().split("\n").pop()?.trim();
    if (value === "yes") return true;
    if (value === "no") return false;
    return null;
}

export function parseUpdatesLine(raw: string | undefined): FleetUpdates | null {
    const line = (raw ?? "").trim().split("\n").pop()?.trim() ?? "";
    const [manager, count, security, cacheAt] = line.split(/\s+/);
    if (!MANAGERS.includes(manager as PackageManager) || !/^\d+$/.test(count ?? "")) return null;
    const total = Number(count);
    if (total > MAX_REASONABLE_UPDATES) return null;
    const securityCount = /^\d+$/.test(security ?? "") ? Math.min(Number(security), total) : null;
    const cacheSeconds = /^\d+$/.test(cacheAt ?? "") ? Number(cacheAt) : null;
    return {
        manager: manager as PackageManager,
        count: total,
        security: securityCount,
        cacheAt: cacheSeconds !== null && cacheSeconds > 0 ? cacheSeconds * 1000 : null
    };
}

export type FleetReading = {
    // The verdict of shared/thresholds.ts on the reading.
    tone: Tone | "unknown";
    issues: HealthIssue[];
    metrics: FleetMetrics;
};

export function toReading(snapshot: StatusSnapshot, extras: Extras): FleetReading {
    const cores = snapshot.cpu?.cores ?? extras.cores;
    const health = assessHealth(snapshot, { cores });
    const disk = storageReading(snapshot);
    return {
        tone: health.tone,
        issues: health.issues,
        metrics: {
            platform: snapshot.platform,
            hostname: snapshot.hostname,
            os: snapshot.os,
            kernel: snapshot.kernel,
            uptimeSeconds: snapshot.uptimeSeconds,
            bootedAt: snapshot.uptimeSeconds !== null ? snapshot.collectedAt - snapshot.uptimeSeconds * 1000 : null,
            cores,
            cpuPercent: snapshot.cpu?.usagePercent ?? null,
            load: snapshot.load,
            loadPerCore: snapshot.load ? roundTo(snapshot.load.one / Math.max(1, cores ?? 1), 2) : null,
            memory: snapshot.memory
                ? { usagePercent: snapshot.memory.usagePercent, totalMB: snapshot.memory.totalMB, availableMB: snapshot.memory.availableMB }
                : null,
            swapPercent: snapshot.swap && snapshot.swap.totalMB > 0 ? snapshot.swap.usagePercent : null,
            disk: disk ? { mount: disk.mount ?? "", usagePercent: disk.usagePercent, freeGB: disk.freeGB, totalGB: disk.totalGB } : null,
            diskCount: snapshot.disks.length,
            failedUnits: snapshot.failedUnits,
            loggedInUsers: snapshot.loggedInUsers,
            rebootRequired: extras.rebootRequired,
            updates: extras.updates
        }
    };
}

export function parseFleetLinux(output: string, collectedAt = Date.now()): FleetReading {
    const snapshot = parseLinuxStatus(output, collectedAt);
    const sections = parseSections(output);
    // Without a second CPU sample the status parser has no `cpu` to put the
    // core count in.
    const cores = (sections.get("cpu1") ?? "").split("\n").filter((line) => /^cpu\d+\s/.test(line)).length || null;
    return toReading(snapshot, {
        cores,
        rebootRequired: parseRebootLine(sections.get("reboot")),
        updates: parseUpdatesLine(sections.get("updates"))
    });
}

export function parseFleetWindows(output: string, collectedAt = Date.now()): FleetReading {
    const snapshot = parseWindowsStatus(output, collectedAt);
    const report = extractJson(output);
    const load = isRecord(report) ? asNumber(report.load) : null;
    const cpuPercent = load !== null && load >= 0 && load <= 100 ? roundTo(load, 1) : null;
    const reboot = isRecord(report) && typeof report.reboot === "boolean" ? report.reboot : null;
    const cores = isRecord(report) ? asNumber(report.cores) : null;
    // The status parser fills `cpu` from a sample this check does not take:
    // the processor load stands in for it.
    const withCpu: StatusSnapshot = cpuPercent !== null
        ? { ...snapshot, cpu: { usagePercent: cpuPercent, cores, iowaitPercent: null }, unavailable: snapshot.unavailable.filter((section) => section !== "cpu") }
        : snapshot;
    return toReading(withCpu, { cores, rebootRequired: reboot, updates: null });
}

// A failure of a check, and whether it happened before the server was
// reached (`connect`: the connection could not be made) or after (`run`).
// `hop`: the connection to that jump host of the route failed (its login,
// its host key...), not the one to the server.
export class ProbeError extends Error {
    constructor(readonly phase: "connect" | "run", readonly failure: unknown, readonly hop: number | null = null) {
        super(failure instanceof Error ? failure.message : String(failure));
        this.name = "ProbeError";
    }
}

export type ProbeResult = {
    reading: FleetReading;
    // Connect, handshake and authentication; null on a connection already open.
    handshakeMs: number | null;
};

export type ProbeDeps = {
    acquire: (serverId: number) => Promise<SshLease>;
    // Whether the server has a pooled connection open already.
    connected: (serverId: number) => boolean;
};

const defaultDeps: ProbeDeps = {
    acquire: (serverId) => sshPool.acquire(serverId),
    connected: (serverId) => sshPool.inspect(serverId).connections > 0
};

// A lease, unless `signal` ends the wait first: the connection then finishes
// on its own and its lease is handed back.
function leaseUnlessAborted(acquiring: Promise<SshLease>, signal: AbortSignal): Promise<SshLease> {
    return new Promise((resolve, reject) => {
        let aborted = false;
        const onAbort = () => {
            aborted = true;
            reject(new ExecAbortedError());
        };
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
        acquiring.then(
            (lease) => {
                signal.removeEventListener("abort", onAbort);
                if (aborted) lease.release();
                else resolve(lease);
            },
            (err: unknown) => {
                signal.removeEventListener("abort", onAbort);
                if (!aborted) reject(err);
            }
        );
    });
}

// Checks one saved Linux/Windows server. `route`: the jump hosts it is
// reached through, the one connected to first first. They are connected to
// one by one before the server (the server's own connection then goes
// through theirs), so a failure is known to be theirs or the server's.
// Throws a ProbeError.
export async function probeServer(serverId: number, signal: AbortSignal, route: number[] = [], deps: ProbeDeps = defaultDeps): Promise<ProbeResult> {
    const started = Date.now();
    const fresh = !deps.connected(serverId);
    const leases: SshLease[] = [];
    try {
        for (const hop of route) {
            try {
                leases.push(await leaseUnlessAborted(deps.acquire(hop), signal));
            } catch (err) {
                throw new ProbeError("connect", err, hop);
            }
        }
        let lease: SshLease;
        try {
            lease = await leaseUnlessAborted(deps.acquire(serverId), signal);
        } catch (err) {
            throw new ProbeError("connect", err);
        }
        leases.push(lease);
        const handshakeMs = fresh ? Date.now() - started : null;
        try {
            const windows = lease.target.os === "windows";
            const options = { timeoutMs: windows ? FLEET_PROBE_TIMEOUT_MS.windows : FLEET_PROBE_TIMEOUT_MS.linux, signal };
            const result = windows
                ? await runPowerShell(lease, FLEET_WINDOWS_SCRIPT, options)
                : await runPosixScript(lease, fleetLinuxScript(), options);
            try {
                return { reading: windows ? parseFleetWindows(result.stdout) : parseFleetLinux(result.stdout), handshakeMs };
            } catch (err) {
                const reason = cleanStderr(result.stderr) || (err as Error).message;
                throw new AppError("STATUS_UNAVAILABLE", `Could not read the server's health: ${reason.slice(0, 500)}`, 502, { exitCode: result.code });
            }
        } catch (err) {
            throw new ProbeError("run", err);
        }
    } finally {
        for (const lease of leases) lease.release();
    }
}
