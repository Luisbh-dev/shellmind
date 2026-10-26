import { findMount, type DiskInodes, type DiskMount } from "../../shared/disk";
import type { OpsCapabilities } from "../../shared/ops";
import { AppError } from "../errors";
import { POSIX_SECTION_FUNCTION, asNumber, asString, commandFailure, ensureArray, extractJson, isRecord, parseSections } from "../ops/remote";
import type { SshLease } from "../ssh/pool";
import { LOCAL_MOUNT } from "../status/linux";
import { decodeMountPath, runDiskScript } from "./remote";

// The local filesystems of a server with their space and inodes, in bytes
// (the status dashboard rounds to tenths of a GB; a cleanup's "space freed"
// needs the real figures). Linux: the same local filesystems as the
// dashboard, from /proc/mounts and `df -P`; Windows: the fixed drives.

const MOUNTS_TIMEOUT_MS = { linux: 20_000, windows: 40_000 } as const;

export const LINUX_MOUNTS_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    POSIX_SECTION_FUNCTION,
    "m mounts",
    `awk '${LOCAL_MOUNT} { print $1, $2, $3, $4 }' /proc/mounts 2>/dev/null`,
    // Directories only: containers bind-mount single files (/etc/hosts...).
    "set -f",
    "set --",
    `for p in $(awk '${LOCAL_MOUNT} { print $2 }' /proc/mounts 2>/dev/null | sort -u); do [ -d "$p" ] && set -- "$@" "$p"; done`,
    "set +f",
    "m df",
    "[ $# -gt 0 ] && df -P -k \"$@\" 2>/dev/null",
    "m inodes",
    "[ $# -gt 0 ] && df -P -i \"$@\" 2>/dev/null",
    "m end",
    ""
].join("\n");

// .NET's drive list, not WMI: Win32_LogicalDisk answers nothing to a user
// that is not an administrator over SSH (and takes seconds to start).
export const WINDOWS_MOUNTS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$d=@([IO.DriveInfo]::GetDrives()|Where-Object {$_.DriveType -eq 'Fixed' -and $_.IsReady}|ForEach-Object {@{n=$_.Name.TrimEnd('\\');fs=$_.DriveFormat;s=[double]$_.TotalSize;f=[double]$_.TotalFreeSpace}})
@{disks=$d}|ConvertTo-Json -Compress -Depth 3
`;

type DfRow = { device: string; total: number; used: number; free: number; mount: string };

// `df -P` rows (1024-blocks or inodes); the mount point is the rest of the
// line, it may hold spaces.
export function parseDfRows(raw: string): DfRow[] {
    return raw.split("\n").flatMap((line) => {
        const match = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(?:\d+%|-)\s+(.+)$/.exec(line.trim());
        if (!match) return [];
        return [{ device: match[1], total: Number(match[2]), used: Number(match[3]), free: Number(match[4]), mount: match[5] }];
    });
}

const percent = (used: number, free: number) => (used + free > 0 ? Math.round((used / (used + free)) * 1000) / 10 : 0);

type MountInfo = { type: string; readOnly: boolean };

function parseMountTable(raw: string): Map<string, MountInfo> {
    const table = new Map<string, MountInfo>();
    for (const line of raw.split("\n")) {
        const [, mount, type, options] = line.trim().split(/\s+/);
        if (mount && type) table.set(decodeMountPath(mount), { type, readOnly: (options ?? "").split(",").includes("ro") });
    }
    return table;
}

// Filesystems whose datasets or subvolumes share one pool: each mount stays
// (each is explored on its own), even with the same device and figures.
const POOLED = new Set(["btrfs", "zfs", "bcachefs"]);

export function parseLinuxMounts(output: string): DiskMount[] {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new AppError("OPS_COMMAND_FAILED", "The filesystem check was cut off before it finished.", 502);
    const table = parseMountTable(sections.get("mounts") ?? "");
    const inodes = new Map(parseDfRows(sections.get("inodes") ?? "").map((row) => [row.mount, row]));
    // Shortest mount points first: a bind mount of a filesystem seen
    // already (same device and figures) is left out.
    const rows = parseDfRows(sections.get("df") ?? "").sort((a, b) => a.mount.length - b.mount.length);
    const seen = new Set<string>();
    const mounts: DiskMount[] = [];
    for (const row of rows) {
        const info = table.get(row.mount);
        const key = `${row.device}:${row.total}:${row.used}:${row.free}`;
        if (seen.has(row.mount) || (seen.has(key) && !POOLED.has(info?.type ?? ""))) continue;
        seen.add(row.mount);
        seen.add(key);
        const inode = inodes.get(row.mount);
        const inodeUsage: DiskInodes | null = inode && inode.total > 0
            ? { total: inode.total, used: inode.used, free: inode.free, usagePercent: percent(inode.used, inode.free) }
            : null;
        mounts.push({
            mount: row.mount,
            device: row.device,
            fsType: info?.type ?? null,
            totalBytes: row.total * 1024,
            usedBytes: row.used * 1024,
            freeBytes: row.free * 1024,
            // Like df: used / (used + available), reserved blocks excluded.
            usagePercent: percent(row.used, row.free),
            inodes: inodeUsage,
            readOnly: info?.readOnly ?? false
        });
    }
    return mounts.sort((a, b) => a.mount.localeCompare(b.mount));
}

export function parseWindowsMounts(output: string): DiskMount[] {
    const report = extractJson(output);
    if (!isRecord(report)) throw new AppError("OPS_COMMAND_FAILED", "The drive check returned no data.", 502);
    return ensureArray(report.disks).filter(isRecord).flatMap((disk): DiskMount[] => {
        const name = asString(disk.n);
        const total = asNumber(disk.s);
        const free = asNumber(disk.f);
        if (!/^[A-Za-z]:$/.test(name) || total === null || free === null || total <= 0) return [];
        const used = Math.max(0, total - free);
        return [{
            mount: `${name.toUpperCase()}\\`,
            device: name.toUpperCase(),
            fsType: asString(disk.fs) || null,
            totalBytes: total,
            usedBytes: used,
            freeBytes: free,
            usagePercent: percent(used, free),
            inodes: null,
            readOnly: false
        }];
    }).sort((a, b) => a.mount.localeCompare(b.mount));
}

export async function listMounts(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<DiskMount[]> {
    const windows = caps.platform === "windows";
    const script = windows ? WINDOWS_MOUNTS_SCRIPT : LINUX_MOUNTS_SCRIPT;
    const result = await runDiskScript(lease, caps, script, { timeoutMs: MOUNTS_TIMEOUT_MS[caps.platform], signal });
    const mounts = windows ? parseWindowsMounts(result.stdout) : parseLinuxMounts(result.stdout);
    if (!mounts.length && result.code !== 0) throw commandFailure(result, "Reading the filesystems failed");
    return mounts;
}

// The mount a request names, as the server reports it now.
export function requireMount(mounts: DiskMount[], value: unknown): DiskMount {
    const name = typeof value === "string" ? value : "";
    // Drive letters in any case, with or without the backslash; Linux paths as they are.
    const found = findMount(mounts, name);
    if (!found) throw new AppError("DISK_UNKNOWN_MOUNT", `"${name.slice(0, 200)}" is not a local filesystem of this server.`, 404);
    return found;
}
