import type { StatusDisk, StatusInterface, StatusProcess, StatusSection, StatusSnapshot } from "../../shared/status";
import { POSIX_SECTION_FUNCTION, parseSections } from "../ops/remote";
import { aggregateStorage, clampPercent, dedupeDisks, percent, roundTo } from "./parse";

// Linux status: one POSIX script (run by `sh -s`, so it works with any login
// shell and with busybox) prints every section; CPU, network and per-process
// CPU come from two samples one second apart. Only local filesystems are
// passed to df, so a hung network mount cannot block the report.

const LOCAL_FS = "ext[234]|xfs|btrfs|zfs|f2fs|jfs|reiserfs|vfat|exfat|ntfs|ntfs3|fuseblk|hfsplus|bcachefs|nilfs2|ufs";
// awk condition on /proc/mounts rows: local filesystems, plus "/" whatever it
// is (overlay in a container, simfs/ploop on some VPS).
export const LOCAL_MOUNT = `$2 == "/" || $3 ~ /^(${LOCAL_FS})$/`;

// Per-process CPU ticks between the two samples of /proc/<pid>/stat ("A" and
// "B" lines). The command name is between the first "(" and the last ")"; it
// may contain spaces and parentheses. Processes of this script's own session
// (the sampling pipeline) are left out. Prints "<pid> <ticks> <rss pages> <comm>".
const PROCESS_DELTA_AWK = [
    "{",
    "tag = $1; line = substr($0, 3); lp = index(line, \"(\"); rest = line; rp = 0",
    "while ((i = index(rest, \")\")) > 0) { rp = rp + i; rest = substr(rest, i + 1) }",
    "if (lp == 0 || rp <= lp) next",
    "pid = substr(line, 1, lp - 2); comm = substr(line, lp + 1, rp - lp - 1)",
    "n = split(substr(line, rp + 2), f, \" \")",
    "if (n < 22 || f[4] == self) next",
    "t = f[12] + f[13]",
    "if (tag == \"A\") { a[pid] = t; next }",
    "d = (pid in a) ? t - a[pid] : t",
    "if (d < 0) d = 0",
    "print pid, d, f[22], comm",
    "}"
].join("\n");

export const TOP_PROCESSES = 8;

export const LINUX_STATUS_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    POSIX_SECTION_FUNCTION,
    "m host",
    "hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null",
    "m os",
    "grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null || uname -s",
    "m kernel",
    "uname -r",
    "m loadavg",
    "cat /proc/loadavg 2>/dev/null",
    "m meminfo",
    "grep -E '^(MemTotal|MemFree|MemAvailable|Buffers|Cached|SReclaimable|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null",
    "m pagesize",
    "getconf PAGESIZE 2>/dev/null || echo 4096",
    "m virtualnet",
    "ls /sys/devices/virtual/net 2>/dev/null",
    "m mounts",
    `awk '${LOCAL_MOUNT} { print $1, $2, $3 }' /proc/mounts 2>/dev/null`,
    "m df",
    // Directories only: containers bind-mount single files (/etc/hosts...).
    "set -f",
    "set --",
    `for p in $(awk '${LOCAL_MOUNT} { print $2 }' /proc/mounts 2>/dev/null | sort -u); do [ -d "$p" ] && set -- "$@" "$p"; done`,
    "set +f",
    "[ $# -gt 0 ] && df -P -k \"$@\" 2>/dev/null",
    "m failed",
    "if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then systemctl list-units --state=failed --no-legend --plain --no-pager 2>/dev/null | grep -c .; fi",
    "m users",
    // Without a utmp file (musl systems such as Alpine) an empty `who` means
    // "unknown", not "nobody".
    "if command -v who >/dev/null 2>&1; then u=$(who 2>/dev/null | awk '{ print $1 }' | sort -u); if [ -n \"$u\" ] || [ -e /run/utmp ] || [ -e /var/run/utmp ]; then printf '%s\\n' \"$u\" | grep -c .; fi; fi",
    "m up1",
    "cat /proc/uptime",
    "m cpu1",
    "grep '^cpu' /proc/stat",
    "m net1",
    "cat /proc/net/dev 2>/dev/null",
    "S=$(cut -d ' ' -f 6 /proc/$$/stat 2>/dev/null)",
    "P=$(cat /proc/[0-9]*/stat 2>/dev/null)",
    "sleep 1",
    "m up2",
    "cat /proc/uptime",
    "m cpu2",
    "head -n 1 /proc/stat",
    "m net2",
    "cat /proc/net/dev 2>/dev/null",
    "m procs",
    `{ printf '%s\\n' "$P" | sed 's/^/A /'; cat /proc/[0-9]*/stat 2>/dev/null | sed 's/^/B /'; } | awk -v self="$S" '${PROCESS_DELTA_AWK}' | sort -k2,2nr -k3,3nr | head -n ${TOP_PROCESSES}`,
    "m end",
    ""
].join("\n");

type CpuTimes = { total: number; idle: number; iowait: number };

// The aggregate "cpu" line of /proc/stat. guest time is already part of user/nice.
export function parseCpuLine(line: string | undefined): CpuTimes | null {
    if (!line || !/^cpu\s/.test(line)) return null;
    const values = line.trim().split(/\s+/).slice(1, 9).map(Number);
    if (values.length < 4 || values.some((value) => !Number.isFinite(value))) return null;
    const [user, nice, system, idle, iowait = 0, irq = 0, softirq = 0, steal = 0] = values;
    return { total: user + nice + system + idle + iowait + irq + softirq + steal, idle: idle + iowait, iowait };
}

export function parseMeminfo(raw: string): Record<string, number> {
    const values: Record<string, number> = {};
    for (const line of raw.split("\n")) {
        const match = /^(\w+):\s+(\d+)/.exec(line.trim());
        if (match) values[match[1]] = Number(match[2]);
    }
    return values;
}

// /proc/net/dev: bytes per interface ("eth0: <rx bytes> ... <tx bytes> ...").
export function parseNetDev(raw: string): Map<string, { rx: number; tx: number }> {
    const counters = new Map<string, { rx: number; tx: number }>();
    for (const line of raw.split("\n")) {
        const colon = line.indexOf(":");
        if (colon === -1) continue;
        const name = line.slice(0, colon).trim();
        const fields = line.slice(colon + 1).trim().split(/\s+/).map(Number);
        if (!name || fields.length < 9 || !Number.isFinite(fields[0]) || !Number.isFinite(fields[8])) continue;
        counters.set(name, { rx: fields[0], tx: fields[8] });
    }
    return counters;
}

// `df -P -k` rows; the mount point is the rest of the line (it may contain
// spaces). Rows with exactly the same block counts as a shorter mount point
// are the same filesystem seen again (bind mounts, a container's overlay root
// on the host disk) and are left out; ZFS datasets are merged per pool later.
export function parseDf(raw: string, fsTypes: Map<string, string>): StatusDisk[] {
    const KB_PER_GB = 1024 * 1024;
    const rows = raw.split("\n").flatMap((line) => {
        const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)%\s+(.+)$/.exec(line.trim());
        return match ? [match] : [];
    }).sort((a, b) => a[6].length - b[6].length);

    const seen = new Set<string>();
    const disks: StatusDisk[] = [];
    for (const [, name, totalKb, usedKb, freeKb, , mount] of rows) {
        const fsType = fsTypes.get(mount) ?? null;
        const blocks = `${totalKb}:${usedKb}:${freeKb}`;
        if (fsType !== "zfs" && (seen.has(name) || seen.has(blocks))) continue;
        seen.add(name);
        seen.add(blocks);
        const totalGB = roundTo(Number(totalKb) / KB_PER_GB, 1);
        const usedGB = roundTo(Number(usedKb) / KB_PER_GB, 1);
        disks.push({
            name,
            mount,
            fsType,
            totalGB,
            usedGB,
            freeGB: roundTo(Number(freeKb) / KB_PER_GB, 1),
            // Like df: used / (used + available), reserved blocks excluded.
            usagePercent: percent(Number(usedKb), Number(usedKb) + Number(freeKb))
        });
    }
    return disks;
}

function parseMounts(raw: string): Map<string, string> {
    const types = new Map<string, string>();
    for (const line of raw.split("\n")) {
        const [, mount, type] = line.trim().split(/\s+/);
        // /proc/mounts escapes spaces as \040.
        if (mount && type) types.set(mount.replace(/\\040/g, " "), type);
    }
    return types;
}

function firstNumber(raw: string | undefined): number | null {
    const value = Number.parseFloat((raw ?? "").trim().split(/\s+/)[0] ?? "");
    return Number.isFinite(value) ? value : null;
}

function count(raw: string | undefined): number | null {
    if (raw === undefined || !/^\d+$/.test(raw.trim())) return null;
    return Number(raw.trim());
}

function interfaceRates(sections: Map<string, string>, seconds: number): StatusSnapshot["network"] {
    const before = parseNetDev(sections.get("net1") ?? "");
    const after = parseNetDev(sections.get("net2") ?? "");
    if (before.size === 0 || after.size === 0) return null;

    // Physical NICs carry what leaves the host; bridges, veths, bonds and
    // tunnels repeat that traffic. Containers only have virtual ones.
    const virtual = new Set((sections.get("virtualnet") ?? "").split(/\s+/).filter(Boolean));
    const names = [...after.keys()].filter((name) => name !== "lo" && before.has(name));
    const physical = names.filter((name) => !virtual.has(name));
    const counted = physical.length > 0 ? physical : names;

    const delta = (now: number, then: number) => (now >= then ? now - then : 0);
    const interfaces: StatusInterface[] = counted.map((name) => {
        const a = before.get(name)!;
        const b = after.get(name)!;
        return {
            name,
            rxBytesPerSec: Math.round(delta(b.rx, a.rx) / seconds),
            txBytesPerSec: Math.round(delta(b.tx, a.tx) / seconds)
        };
    });
    return {
        rxBytesPerSec: interfaces.reduce((sum, item) => sum + item.rxBytesPerSec, 0),
        txBytesPerSec: interfaces.reduce((sum, item) => sum + item.txBytesPerSec, 0),
        interfaces: interfaces
            .sort((a, b) => (b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec) || a.name.localeCompare(b.name))
            .slice(0, 6)
    };
}

function parseProcesses(raw: string, ticksPerCore: number, pageKb: number, memTotalKb: number | null): StatusProcess[] {
    const processes: StatusProcess[] = [];
    for (const line of raw.split("\n")) {
        const match = /^(\d+) (\d+) (\d+) (.*)$/.exec(line.trim());
        if (!match) continue;
        const rssKb = Number(match[3]) * pageKb;
        processes.push({
            pid: Number(match[1]),
            name: match[4] || "?",
            cpuPercent: ticksPerCore > 0 ? roundTo((Number(match[2]) / ticksPerCore) * 100, 1) : 0,
            memoryMB: roundTo(rssKb / 1024, 1),
            memoryPercent: memTotalKb ? percent(rssKb, memTotalKb) : null
        });
    }
    return processes;
}

export function parseLinuxStatus(output: string, collectedAt = Date.now()): StatusSnapshot {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new Error("The status report was cut off before it finished.");
    const unavailable: StatusSection[] = [];
    const missing = <T>(section: StatusSection, value: T | null): T | null => {
        if (value === null) unavailable.push(section);
        return value;
    };

    const hostname = (sections.get("host") ?? "").split("\n")[0].trim();
    const osLine = sections.get("os") ?? "";
    const prettyName = /^PRETTY_NAME=(.*)$/m.exec(osLine)?.[1]?.trim().replace(/^["']|["']$/g, "");
    const kernel = (sections.get("kernel") ?? "").trim() || null;

    const up1 = firstNumber(sections.get("up1"));
    const up2 = firstNumber(sections.get("up2"));
    const sampleSeconds = up1 !== null && up2 !== null && up2 > up1 ? roundTo(up2 - up1, 2) : 1;

    // CPU usage from the two samples of the aggregate line.
    const cpuLines = (sections.get("cpu1") ?? "").split("\n");
    const cores = cpuLines.filter((line) => /^cpu\d+\s/.test(line)).length || null;
    const cpuBefore = parseCpuLine(cpuLines[0]);
    const cpuAfter = parseCpuLine((sections.get("cpu2") ?? "").split("\n")[0]);
    const totalDelta = cpuBefore && cpuAfter ? cpuAfter.total - cpuBefore.total : 0;
    const cpu = cpuBefore && cpuAfter && totalDelta > 0
        ? {
            usagePercent: clampPercent((1 - (cpuAfter.idle - cpuBefore.idle) / totalDelta) * 100),
            cores,
            iowaitPercent: clampPercent(((cpuAfter.iowait - cpuBefore.iowait) / totalDelta) * 100)
        }
        : null;

    const meminfo = parseMeminfo(sections.get("meminfo") ?? "");
    const memTotalKb = meminfo.MemTotal ?? null;
    // MemAvailable (kernel 3.14+) estimates what can be allocated without
    // swapping; older kernels get the classic free + buffers + cache.
    const availableKb = meminfo.MemAvailable
        ?? (meminfo.MemFree !== undefined ? meminfo.MemFree + (meminfo.Buffers ?? 0) + (meminfo.Cached ?? 0) + (meminfo.SReclaimable ?? 0) : undefined);
    const memory = memTotalKb && availableKb !== undefined
        ? {
            totalMB: roundTo(memTotalKb / 1024, 1),
            usedMB: roundTo(Math.max(0, memTotalKb - availableKb) / 1024, 1),
            availableMB: roundTo(Math.min(availableKb, memTotalKb) / 1024, 1),
            usagePercent: percent(memTotalKb - availableKb, memTotalKb)
        }
        : null;
    const swap = meminfo.SwapTotal !== undefined && meminfo.SwapFree !== undefined
        ? {
            totalMB: roundTo(meminfo.SwapTotal / 1024, 1),
            usedMB: roundTo(Math.max(0, meminfo.SwapTotal - meminfo.SwapFree) / 1024, 1),
            usagePercent: percent(meminfo.SwapTotal - meminfo.SwapFree, meminfo.SwapTotal)
        }
        : null;

    const loadValues = (sections.get("loadavg") ?? "").trim().split(/\s+/).slice(0, 3).map(Number);
    const load = loadValues.length === 3 && loadValues.every(Number.isFinite)
        ? { one: roundTo(loadValues[0], 2), five: roundTo(loadValues[1], 2), fifteen: roundTo(loadValues[2], 2) }
        : null;

    const disks = dedupeDisks(parseDf(sections.get("df") ?? "", parseMounts(sections.get("mounts") ?? "")));
    const pageKb = (firstNumber(sections.get("pagesize")) ?? 4096) / 1024;
    const ticksPerCore = cores && totalDelta > 0 ? totalDelta / cores : 0;
    const processes = parseProcesses(sections.get("procs") ?? "", ticksPerCore, pageKb, memTotalKb);

    return {
        platform: "linux",
        collectedAt,
        hostname,
        os: prettyName || osLine.split("\n")[0].trim() || "Linux",
        kernel,
        uptimeSeconds: up2 !== null ? Math.floor(up2) : null,
        cpu: missing("cpu", cpu),
        memory: missing("memory", memory),
        swap: missing("swap", swap),
        load: missing("load", load),
        storage: aggregateStorage(disks),
        disks: missing("disks", disks.length ? disks : null) ?? [],
        processes: missing("processes", processes.length ? processes : null) ?? [],
        network: missing("network", interfaceRates(sections, sampleSeconds)),
        failedUnits: missing("failedUnits", count(sections.get("failed"))),
        loggedInUsers: missing("users", count(sections.get("users"))),
        sampleSeconds,
        unavailable
    };
}
