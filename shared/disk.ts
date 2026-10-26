// W8-T4 disk-full toolkit: the payloads of /api/servers/:id/disk/* and the
// path and parameter rules shared by the backend (which builds every remote
// command from them) and the disk view (which checks input before sending).
// Requests name a path, a mount, a cleanup or a process; never shell text.
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

import type { OpsActionResult, OpsPlatform } from "./ops";

// Who the disk commands run as. `elevated`: as root (or through `sudo -n`) on
// Linux, as an administrator on Windows. Without it the explorer reads only
// what the login user may read (denied folders are counted) and no cleanup
// can run.
export type DiskAccess = {
    platform: OpsPlatform;
    user: string;
    root: boolean | null;
    sudo: boolean;
    elevated: boolean;
};

export type DiskInodes = { total: number; used: number; free: number; usagePercent: number };

// A local filesystem: a mount point on Linux, a drive ("C:\") on Windows.
export type DiskMount = {
    mount: string;
    // Device (/dev/sda1) or drive letter (C:).
    device: string;
    fsType: string | null;
    totalBytes: number;
    usedBytes: number;
    // Available to unprivileged users (like df).
    freeBytes: number;
    usagePercent: number;
    // Null where the filesystem has no fixed inode table (btrfs, Windows).
    inodes: DiskInodes | null;
    readOnly: boolean;
};

// GET /api/servers/:id/disk
export type DiskOverview = {
    access: DiskAccess;
    mounts: DiskMount[];
    collectedAt: number;
};

// --- directory usage explorer ---

export type DiskEntryKind = "dir" | "file" | "other";

export type DiskEntry = {
    name: string;
    path: string;
    // Null: not measured (the time budget ran out before it was reached).
    bytes: number | null;
    kind: DiskEntryKind;
    // Measured only in part (Windows: the time budget ran out inside it).
    partial?: boolean;
    // Another filesystem is mounted there: its space is not counted here.
    otherFs?: boolean;
};

// GET /api/servers/:id/disk/usage?path=&budget=&rescan=1: one level of a
// directory, largest first, sizes on disk (du -x -k: the scan stays on the
// directory's own filesystem).
export type DirectoryListing = {
    path: string;
    // The filesystem the directory is on.
    mount: string;
    // The directory itself, everything included (null when the scan stopped
    // before it finished).
    totalBytes: number | null;
    entries: DiskEntry[];
    // What did not fit in the list (its entries are the smallest).
    omitted: { count: number; bytes: number } | null;
    // Folders the scan could not read: their sizes (and the total) are low.
    denied: number;
    // The scan stopped at its time budget: listed entries are complete (Linux)
    // or partial (Windows), the rest is missing.
    timedOut: boolean;
    budgetSeconds: number;
    elevated: boolean;
    collectedAt: number;
    // Served from the backend's cache (`rescan=1` scans again).
    cached: boolean;
    durationMs: number;
};

// Time budgets a scan may ask for (seconds).
export const DISK_SCAN_BUDGETS = [30, 60, 180] as const;
export const DEFAULT_DISK_SCAN_BUDGET = 60;
// Entries a listing returns at most (the rest is summed in `omitted`).
export const MAX_DISK_ENTRIES = 300;

// --- largest files ---

export type LargeFile = {
    path: string;
    bytes: number;
    // Epoch ms.
    modifiedAt: number | null;
    owner: string | null;
};

// GET /api/servers/:id/disk/large-files?mount=&minMB=&rescan=1
export type LargeFilesResult = {
    mount: string;
    minMB: number;
    // Largest first, at most MAX_LARGE_FILES.
    files: LargeFile[];
    timedOut: boolean;
    denied: number;
    elevated: boolean;
    collectedAt: number;
    cached: boolean;
    durationMs: number;
};

export const LARGE_FILE_THRESHOLDS_MB = [50, 100, 500, 1024] as const;
export const DEFAULT_LARGE_FILE_MB = 100;
export const MAX_LARGE_FILES = 50;

// --- deleted files still held open (Linux) ---

export type DeletedOpenFile = {
    pid: number;
    fd: number;
    // The process name (/proc/<pid>/comm).
    process: string;
    user: string | null;
    // The path the file had, without " (deleted)".
    path: string;
    bytes: number;
    // The file's inode number and the process's start time (clock ticks
    // after boot), as decimal digits: a release checks that the descriptor
    // still holds this file and that the pid is still this process.
    inode: string | null;
    started: string | null;
    // What runs the process, when known: a systemd unit to restart, or a
    // container (its short id) of the server's engine.
    unit: string | null;
    container: string | null;
};

// GET /api/servers/:id/disk/deleted?mount=
export type DeletedOpenResult = {
    mount: string;
    files: DeletedOpenFile[];
    totalBytes: number;
    // How they were found: lsof +L1, or a scan of /proc/<pid>/fd.
    source: "lsof" | "proc";
    // Processes of other users could not be read (not elevated).
    partial: boolean;
    elevated: boolean;
    collectedAt: number;
};

// truncate           empty the file through /proc/<pid>/fd/<fd> (the
//                    process keeps running; the data is gone)
// restart-service    restart the systemd unit that runs the process
// restart-container  restart the container the process runs in
// terminate          SIGTERM to the process
export const DELETED_RELEASE_ACTIONS = ["truncate", "restart-service", "restart-container", "terminate"] as const;
export type DeletedReleaseAction = typeof DELETED_RELEASE_ACTIONS[number];

// POST /api/servers/:id/disk/deleted/release. `process` (and `started`,
// when given) must still be those of `pid` when the action runs (a reused
// pid is refused); for truncate, `inode` that of the file `fd` holds.
export type DeletedReleaseRequest = {
    action: DeletedReleaseAction;
    mount: string;
    pid: number;
    fd?: number;
    process: string;
    started?: string;
    inode?: string;
    unit?: string;
    container?: string;
};

// --- cleanups ---

// journal             journalctl --vacuum-size / --vacuum-time
// package-cache       apt-get clean, dnf clean all, yum clean all, apk cache clean, zypper clean
// rotated-logs        rotated logs in /var/log (*.gz, *.1, *-YYYYMMDD...) older than N days
// tmp                 files in /tmp and /var/tmp untouched for N days
// core-dumps          systemd-coredump, apport and /var/crash dumps
// docker-*            the container engine's prunes (images, build cache, stopped containers)
// win-temp            the user's %TEMP% and C:\Windows\Temp, files older than N days
// win-update-cache    C:\Windows\SoftwareDistribution\Download (Windows Update stopped meanwhile)
// win-recycle-bin     the recycle bins of every drive
// win-component-store DISM /AnalyzeComponentStore, then /StartComponentCleanup
export const LINUX_CLEANUPS = [
    "journal", "package-cache", "rotated-logs", "tmp", "core-dumps",
    "docker-dangling", "docker-unused", "docker-build-cache", "docker-containers"
] as const;
export const WINDOWS_CLEANUPS = ["win-temp", "win-update-cache", "win-recycle-bin", "win-component-store"] as const;
export type CleanupId = typeof LINUX_CLEANUPS[number] | typeof WINDOWS_CLEANUPS[number];

export const CLEANUP_IDS: readonly CleanupId[] = [...LINUX_CLEANUPS, ...WINDOWS_CLEANUPS];

export function isCleanupId(value: string): value is CleanupId {
    return (CLEANUP_IDS as readonly string[]).includes(value);
}

export type CleanupParams = {
    // Only what was last changed this many days ago (logs, temporary files, dumps).
    days?: number;
    // journal: keep at most this much (MB) / nothing older than this (days).
    keepMB?: number;
    keepDays?: number;
};

// The parameters each cleanup takes, their choices and defaults.
export type CleanupParamRule = { choices: readonly number[]; default: number };
export const CLEANUP_PARAM_RULES: Partial<Record<CleanupId, Partial<Record<keyof CleanupParams, CleanupParamRule>>>> = {
    journal: { keepMB: { choices: [50, 100, 200, 500, 1000, 2000], default: 200 }, keepDays: { choices: [0, 1, 7, 14, 30, 90], default: 0 } },
    "rotated-logs": { days: { choices: [1, 3, 7, 14, 30, 90], default: 7 } },
    tmp: { days: { choices: [1, 3, 7, 10, 30], default: 10 } },
    "core-dumps": { days: { choices: [0, 1, 7, 30], default: 0 } },
    "win-temp": { days: { choices: [0, 1, 7, 30], default: 7 } }
};

// The parameters of a cleanup with its defaults filled in, or null when one
// is not among its choices (or belongs to no parameter of that cleanup).
export function resolveCleanupParams(id: CleanupId, input: Record<string, unknown>): CleanupParams | null {
    const rules = CLEANUP_PARAM_RULES[id] ?? {};
    const params: CleanupParams = {};
    for (const [name, value] of Object.entries(input)) {
        if (value === undefined || value === null || value === "") continue;
        if (!(name in rules)) return null;
        const rule = rules[name as keyof CleanupParams]!;
        const number = typeof value === "number" ? value : typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
        if (!rule.choices.includes(number)) return null;
        params[name as keyof CleanupParams] = number;
    }
    for (const [name, rule] of Object.entries(rules) as Array<[keyof CleanupParams, CleanupParamRule]>) {
        if (params[name] === undefined) params[name] = rule.default;
    }
    return params;
}

// ready        something to clean (bytes is the estimate)
// nothing      nothing to clean right now
// unavailable  cannot run here (`reason` says why)
// analyze      the estimate needs a slow analysis first (DISM): the preview of
//              the cleanup alone runs it
export type CleanupStatus = "ready" | "nothing" | "unavailable" | "analyze";

// NOT_ELEVATED  needs root / passwordless sudo / an administrator
// NOT_FOUND     the tool or the folder is not on this server
// NO_ENGINE     no container engine (or not the one it needs)
export type CleanupUnavailable = { code: "NOT_ELEVATED" | "NOT_FOUND" | "NO_ENGINE"; message: string };

export type CleanupItem = { label: string; bytes: number | null; modifiedAt?: number | null };

// exact     as the tool reports it
// about     the size of what goes, as measured now
// up-to     at most this much (shared data may stay)
// at-least  at least this much
export type CleanupEstimate = "exact" | "about" | "up-to" | "at-least";

export type CleanupPreview = {
    id: CleanupId;
    status: CleanupStatus;
    reason?: CleanupUnavailable;
    bytes: number | null;
    estimate: CleanupEstimate;
    // Files, packages, images... that go (null: not counted).
    count: number | null;
    // The largest of them, at most MAX_CLEANUP_ITEMS.
    items: CleanupItem[];
    // The filesystems it frees space on.
    mounts: string[];
    // What runs, as the audit log records it.
    command: string;
    params: CleanupParams;
    // Facts worth showing with it ("usage": the journal's size in bytes,
    // "manager": the package manager, "recommended": DISM's verdict...).
    facts?: Record<string, string | number>;
};

export const MAX_CLEANUP_ITEMS = 50;

// GET /api/servers/:id/disk/cleanups
export type CleanupOverview = { cleanups: CleanupPreview[] };

// Free space of one filesystem before and after an action (bytes).
export type MountDelta = { mount: string; freeBefore: number; freeAfter: number };

// POST /api/servers/:id/disk/cleanups/:id (body: CleanupParams) and the
// release of a deleted file: what ran and the space it freed, measured as
// the change of the free space (df) of the filesystems it acts on.
export type DiskActionResult = OpsActionResult & {
    freedBytes: number | null;
    // What the tool itself reported (journalctl "freed", "Total reclaimed space").
    reportedBytes: number | null;
    mounts: MountDelta[];
};

// --- paths ---

// eslint-disable-next-line no-control-regex -- control characters are what it rejects
const CONTROL = /[\0-\x1f\x7f]/;
export const MAX_DISK_PATH_CHARS = 4096;

// An absolute POSIX path without "." or ".." segments, its slashes
// collapsed and no trailing slash ("/" stays "/"); null when not one.
export function normalizePosixPath(value: string): string | null {
    if (!value.startsWith("/") || value.length > MAX_DISK_PATH_CHARS || CONTROL.test(value)) return null;
    const segments = value.split("/").filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === "..")) return null;
    return `/${segments.join("/")}`;
}

// An absolute path on a drive ("C:\Users", "d:\"): backslashes (a forward
// slash counts as one), none of the characters Windows forbids in names, no
// "." or ".." segments; the drive letter upper-cased, no trailing backslash
// except the drive's own ("C:\").
export function normalizeWindowsPath(value: string): string | null {
    if (value.length > MAX_DISK_PATH_CHARS || CONTROL.test(value)) return null;
    const match = /^([A-Za-z]):[\\/](.*)$/.exec(value);
    if (!match) return null;
    const segments = match[2].split(/[\\/]+/).filter(Boolean);
    if (segments.some((segment) => segment === "." || segment === ".." || /[<>:"|?*]/.test(segment) || /[. ]$/.test(segment))) return null;
    return `${match[1].toUpperCase()}:\\${segments.join("\\")}`;
}

export function normalizeDiskPath(platform: OpsPlatform, value: string): string | null {
    return platform === "windows" ? normalizeWindowsPath(value) : normalizePosixPath(value);
}

// `path` is `mount` or inside it (both normalized).
export function isWithinMount(platform: OpsPlatform, path: string, mount: string): boolean {
    if (platform === "windows") {
        const a = path.toLowerCase();
        const b = mount.toLowerCase();
        return a === b || a.startsWith(b.endsWith("\\") ? b : `${b}\\`);
    }
    return path === mount || path.startsWith(mount === "/" ? "/" : `${mount}/`);
}

// The filesystem a name refers to: a mount point as listed, or a drive in
// any case, with or without its backslash ("d:", "D:\"; the Status page
// names Windows drives "D:").
export function findMount<T extends { mount: string }>(mounts: readonly T[], name: string): T | null {
    const exact = mounts.find((mount) => mount.mount === name);
    if (exact) return exact;
    const drive = /^([A-Za-z]):\\?$/.exec(name);
    if (!drive) return null;
    const wanted = `${drive[1].toUpperCase()}:\\`;
    return mounts.find((mount) => mount.mount.toUpperCase() === wanted) ?? null;
}

// The filesystem a path is on: the longest mount point containing it.
export function mountOf<T extends { mount: string }>(platform: OpsPlatform, path: string, mounts: readonly T[]): T | null {
    let best: T | null = null;
    for (const mount of mounts) {
        if (isWithinMount(platform, path, mount.mount) && (!best || mount.mount.length > best.mount.length)) best = mount;
    }
    return best;
}

// The directory above `path` within `mount` (null at the mount itself).
export function parentPath(platform: OpsPlatform, path: string, mount: string): string | null {
    if (platform === "windows" ? path.toLowerCase() === mount.toLowerCase() : path === mount) return null;
    const separator = platform === "windows" ? "\\" : "/";
    const index = path.lastIndexOf(separator);
    if (index < 0) return null;
    const parent = path.slice(0, index) || "/";
    const resolved = platform === "windows" && /^[A-Z]:$/i.test(parent) ? `${parent}\\` : parent;
    return isWithinMount(platform, resolved, mount) ? resolved : mount;
}

// The directories from `mount` down to `path`, for a breadcrumb.
export function pathTrail(platform: OpsPlatform, path: string, mount: string): Array<{ name: string; path: string }> {
    const trail: Array<{ name: string; path: string }> = [];
    let current: string | null = path;
    while (current) {
        const parent = parentPath(platform, current, mount);
        const separator = platform === "windows" ? "\\" : "/";
        trail.unshift({ name: parent === null ? mount : current.slice(current.lastIndexOf(separator) + 1), path: current });
        current = parent;
    }
    return trail;
}

// A process id and a file descriptor number as the kernel allows them.
export function isValidPid(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value <= 4_194_304;
}

export function isValidFd(value: unknown): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1_048_576;
}

// An inode number or a process start time as the kernel prints them (up to 2^64).
export function isValidDecimal(value: unknown): value is string {
    return typeof value === "string" && /^\d{1,20}$/.test(value);
}

// A process name as /proc/<pid>/comm prints it (up to 15 bytes, any byte but NUL and newline).
export function isValidProcessName(value: unknown): value is string {
    return typeof value === "string" && value.length > 0 && value.length <= 64 && !CONTROL.test(value);
}
