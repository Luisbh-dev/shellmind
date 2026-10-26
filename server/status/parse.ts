import type { StatusDisk, StatusSnapshot } from "../../shared/status";

// Helpers shared by the Linux and Windows status parsers.

export function roundTo(value: number, digits = 1): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

export function percent(part: number, total: number): number {
    if (!Number.isFinite(part) || !Number.isFinite(total) || total <= 0) return 0;
    return roundTo(Math.min(100, Math.max(0, (part / total) * 100)), 1);
}

export function clampPercent(value: number): number {
    return roundTo(Math.min(100, Math.max(0, value)), 1);
}

// Mount points of container runtimes, snaps and the like: they repeat the
// host's filesystems (one overlay per container) and would inflate totals.
const IGNORED_MOUNT_PREFIXES = [
    "/var/lib/docker/",
    "/var/lib/containers/",
    "/var/lib/kubelet/",
    "/var/lib/lxd/",
    "/var/snap/",
    "/snap/",
    "/run/",
    "/proc/",
    "/sys/",
    "/dev/"
];

const MAX_LISTED_DISKS = 20;

// One entry per filesystem: bind mounts and btrfs subvolumes of a device
// report the same numbers, so only the shortest mount point is kept. ZFS
// datasets share their pool's free space, so a pool counts its datasets'
// used space plus the free space once.
export function dedupeDisks(disks: StatusDisk[]): StatusDisk[] {
    const groups = new Map<string, StatusDisk[]>();
    for (const disk of disks) {
        if (disk.totalGB <= 0 && disk.usedGB <= 0) continue;
        if (IGNORED_MOUNT_PREFIXES.some((prefix) => disk.mount.startsWith(prefix))) continue;
        const key = disk.fsType === "zfs" ? `zfs:${disk.name.split("/")[0]}` : disk.name;
        const group = groups.get(key);
        if (group) group.push(disk);
        else groups.set(key, [disk]);
    }

    const result: StatusDisk[] = [];
    for (const group of groups.values()) {
        const primary = [...group].sort((a, b) => a.mount.length - b.mount.length || a.mount.localeCompare(b.mount))[0];
        if (primary.fsType !== "zfs" || group.length === 1) {
            result.push(primary);
            continue;
        }
        const usedGB = roundTo(group.reduce((sum, disk) => sum + disk.usedGB, 0), 1);
        const freeGB = Math.max(...group.map((disk) => disk.freeGB));
        const totalGB = roundTo(usedGB + freeGB, 1);
        result.push({ ...primary, name: primary.name.split("/")[0], totalGB, usedGB, freeGB, usagePercent: percent(usedGB, totalGB) });
    }
    return result.sort((a, b) => a.mount.localeCompare(b.mount)).slice(0, MAX_LISTED_DISKS);
}

export function aggregateStorage(disks: StatusDisk[]): StatusSnapshot["storage"] {
    if (disks.length === 0) return null;
    const totals = disks.reduce((acc, disk) => {
        acc.totalGB += disk.totalGB;
        acc.usedGB += disk.usedGB;
        acc.freeGB += disk.freeGB;
        return acc;
    }, { totalGB: 0, usedGB: 0, freeGB: 0 });

    return {
        totalGB: roundTo(totals.totalGB, 1),
        usedGB: roundTo(totals.usedGB, 1),
        freeGB: roundTo(totals.freeGB, 1),
        // Like df: blocks reserved for root count as neither used nor free.
        usagePercent: percent(totals.usedGB, totals.usedGB + totals.freeGB)
    };
}
