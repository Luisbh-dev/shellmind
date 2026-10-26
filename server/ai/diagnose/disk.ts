import type { ChatEvidenceSection } from "../../../shared/chat";
import type { CleanupPreview, DiskMount } from "../../../shared/disk";
import { cleanupOverview } from "../../disk/cleanups";
import { findDeletedOpenFiles } from "../../disk/deleted";
import { findLargeFiles } from "../../disk/largeFiles";
import { listMounts, requireMount } from "../../disk/mounts";
import { scanDirectory, scanTree } from "../../disk/usage";
import type { EvidenceContext } from "./context";
import { attempt, textSection } from "./sections";

// W8-T4: the evidence of "why is this disk full?" for one filesystem,
// gathered with the disk toolkit's own read-only scans (bounded on the
// server by their time budgets): the usage of every local filesystem, the
// largest directories two levels deep, the largest files, the deleted files
// still held open, and what the known cleanups would free.

const DIRS_BUDGET_SECONDS = 30;
const FILES_BUDGET_SECONDS = 30;
const DIRS_LIMIT = 40;
const FILES_LIMIT = 20;
const DELETED_LIMIT = 20;
const SECTION_CHARS = 5000;

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"];

export function bytesText(bytes: number | null): string {
    if (bytes === null || !Number.isFinite(bytes)) return "unknown size";
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${unit === 0 ? value : value.toFixed(1)} ${UNITS[unit]}`;
}

export function formatMounts(mounts: DiskMount[], target: DiskMount): string {
    return mounts.map((mount) => {
        const inodes = mount.inodes ? `, inodes ${mount.inodes.usagePercent}% used (${mount.inodes.free} free)` : "";
        const marker = mount.mount === target.mount ? " <- the filesystem asked about" : "";
        return `${mount.mount} (${mount.device}${mount.fsType ? `, ${mount.fsType}` : ""}${mount.readOnly ? ", read-only" : ""}): ${mount.usagePercent}% used, ${bytesText(mount.freeBytes)} free of ${bytesText(mount.totalBytes)}${inodes}${marker}`;
    }).join("\n");
}

export function formatCleanups(previews: CleanupPreview[], mount: string): string {
    if (!previews.length) return "(no known cleanup applies to this server)";
    return previews.map((preview) => {
        const where = preview.mounts.length ? ` (on ${preview.mounts.join(", ")}${preview.mounts.includes(mount) ? "" : ", another filesystem"})` : "";
        const size = preview.bytes ? ` ${bytesText(preview.bytes)}` : "";
        const state = preview.status === "ready" ? `would free about${size}${preview.count ? ` (${preview.count} items)` : ""}`
            : preview.status === "nothing" ? "nothing to free"
                : preview.status === "analyze" ? "needs an analysis first"
                    : `cannot run (${(preview.reason?.message ?? "unavailable").replace(/\.$/, "")})${size ? `; it would free about${size}` : ""}`;
        const usage = typeof preview.facts?.usage === "number" ? `; the journal takes ${bytesText(preview.facts.usage)}` : "";
        return `${preview.id}${where}: ${state}${usage}. Command: ${preview.command}`;
    }).join("\n");
}

export async function diskEvidence(ctx: EvidenceContext, mountName: string): Promise<ChatEvidenceSection[]> {
    const { lease, caps, signal } = ctx;
    const mounts = await listMounts(lease, caps, signal);
    const mount = requireMount(mounts, mountName);
    const linux = caps.platform === "linux";
    const source = linux ? "df -P -k; df -P -i" : "[IO.DriveInfo]::GetDrives()";
    const usage = textSection({ id: "disk", title: "Local filesystems", source }, formatMounts(mounts, mount), SECTION_CHARS);

    const dirsBase = {
        id: "disk-dirs" as const,
        title: `Largest directories of ${mount.mount}`,
        source: linux ? `du -x -k -d 2 ${mount.mount} | sort -rn | head -n ${DIRS_LIMIT}` : `folder sizes below ${mount.mount} (one level, ${DIRS_BUDGET_SECONDS} s budget)`
    };
    const filesBase = { id: "disk-files" as const, title: `Largest files of ${mount.mount} (over 100 MB)`, source: linux ? `find ${mount.mount} -xdev -type f -size +100M` : `files over 100 MB below ${mount.mount}` };
    const deletedBase = { id: "disk-deleted" as const, title: `Deleted files still held open on ${mount.mount}`, source: "lsof +L1 or /proc/<pid>/fd" };
    const consumersBase = { id: "disk-consumers" as const, title: "Known consumers of space and what their cleanup would free", source: "ShellMind cleanup previews (read-only)" };

    const sections = await Promise.all([
        attempt(dirsBase, signal, async () => {
            if (!linux) {
                const listing = await scanDirectory(lease, caps, mounts, { path: mount.mount, budgetSeconds: DIRS_BUDGET_SECONDS });
                const lines = listing.entries.slice(0, DIRS_LIMIT).map((entry) => `${bytesText(entry.bytes)}\t${entry.path}${entry.partial ? " (counted in part)" : ""}${entry.otherFs ? " (link, not followed)" : ""}`);
                return textSection(dirsBase, [...lines, ...(listing.timedOut ? ["(the scan stopped at its time budget: folders not listed were not measured)"] : [])].join("\n"), SECTION_CHARS);
            }
            const tree = await scanTree(lease, caps, mount.mount, DIRS_BUDGET_SECONDS, DIRS_LIMIT, signal);
            const lines = tree.dirs.map((dir) => `${bytesText(dir.bytes)}\t${dir.path}`);
            return textSection(dirsBase, [...lines, ...(tree.timedOut ? ["(the scan stopped at its time budget: directories it did not finish are missing)"] : [])].join("\n") || "(nothing measured)", SECTION_CHARS);
        }),
        attempt(filesBase, signal, async () => {
            const result = await findLargeFiles(lease, caps, { mount, minMB: 100, budgetSeconds: FILES_BUDGET_SECONDS, limit: FILES_LIMIT });
            const lines = result.files.map((file) => `${bytesText(file.bytes)}\t${file.path}${file.modifiedAt ? `\tmodified ${new Date(file.modifiedAt).toISOString().slice(0, 10)}` : ""}${file.owner ? `\towner ${file.owner}` : ""}`);
            const notes = [
                ...(result.timedOut ? ["(the search stopped at its time budget: there may be more)"] : []),
                ...(result.denied ? [`(${result.denied} directories could not be read)`] : [])
            ];
            return textSection(filesBase, [...(lines.length ? lines : ["(no file over 100 MB)"]), ...notes].join("\n"), SECTION_CHARS);
        }),
        ...(linux ? [attempt(deletedBase, signal, async () => {
            const result = await findDeletedOpenFiles(lease, caps, mount, signal);
            const lines = result.files.slice(0, DELETED_LIMIT).map((file) => {
                const owner = file.unit ? `, unit ${file.unit}` : file.container ? `, container ${file.container}` : "";
                return `${bytesText(file.bytes)}\t${file.path} (deleted), held by ${file.process} pid ${file.pid} fd ${file.fd}${file.user ? ` user ${file.user}` : ""}${owner}`;
            });
            const count = result.files.length;
            const total = count ? [`Total held: ${bytesText(result.totalBytes)} in ${count} file${count === 1 ? "" : "s"}`] : ["(none)"];
            return textSection(deletedBase, [...total, ...lines, ...(result.partial ? ["(processes of other users could not be checked)"] : [])].join("\n"), SECTION_CHARS);
        })] : []),
        attempt(consumersBase, signal, async () => textSection(consumersBase, formatCleanups(await cleanupOverview({ lease, caps, mounts, signal }), mount.mount), SECTION_CHARS))
    ]);
    return [usage, ...sections];
}
