// Patch center (W8-T3): the pending updates of every SSH server, which of
// them fix security problems, whether a reboot is pending, and patching one
// server or the whole fleet. The backend reads a server with one read-only
// script, from the package cache as it is (the package lists are refreshed
// only when asked to), and installs updates as a multi-exec job: batches, a
// canary, a failure limit, pause and cancel, and the job history. A job can
// end each server with a reboot when one is required, waiting for SSH to come
// back. Windows servers are listed (Windows Update), not patched.
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

import type { FleetState, PackageManager } from "./fleet";
import type { MultiExecJobInfo, MultiExecStrategy, MultiExecTarget } from "./multiexec";
import type { ServerType } from "./types";

export type PatchManager = PackageManager | "windows-update";

export const PATCH_MANAGERS: readonly PatchManager[] = ["apt", "dnf", "yum", "zypper", "apk", "pacman", "windows-update"];

// The managers whose repositories say which updates fix security problems.
export const SECURITY_MANAGERS: readonly PatchManager[] = ["apt", "dnf", "yum", "zypper", "windows-update"];

// The managers ShellMind installs updates with (Windows Update is listed only).
export const APPLY_MANAGERS: readonly PatchManager[] = ["apt", "dnf", "yum", "zypper", "apk", "pacman"];

export const PATCH_SERVER_TYPES: readonly ServerType[] = ["linux", "windows"];

export function isPatchServerType(type: ServerType | string | undefined): boolean {
    return (PATCH_SERVER_TYPES as readonly string[]).includes(type ?? "");
}

export const canTellSecurity = (manager: PatchManager | null): boolean => manager !== null && SECURITY_MANAGERS.includes(manager);
export const canApply = (manager: PatchManager | null): boolean => manager !== null && APPLY_MANAGERS.includes(manager);

// How the login user can install packages. Linux: as root, through sudo
// without a password (`sudo -n`), or not at all: sudo asks for a password
// ("sudo-password": not supported in 1.0) or there is no sudo ("none").
// Windows: a member of Administrators or not.
export type PatchPrivilege = "root" | "sudo" | "sudo-password" | "none" | "admin" | "user";

export const canInstall = (privilege: PatchPrivilege | null): boolean => privilege === "root" || privilege === "sudo";

export type PendingUpdate = {
    // The package (Windows: the update's title).
    name: string;
    arch: string | null;
    // The version installed now (null: a package the update installs, such
    // as a new kernel; Windows: always null).
    current: string | null;
    // The version it installs (Windows: its KB articles).
    available: string;
    // apt: the archives it comes from ("bookworm-security"); dnf/yum/zypper:
    // the repository; Windows: the classification ("Security Updates").
    repository: string | null;
    // null: the manager does not say (apk, pacman; zypper per package, see
    // PatchScan.patches).
    security: boolean | null;
    // The advisory's severity where there is one (dnf: Important, Moderate...;
    // Windows: the MSRC severity).
    severity: string | null;
};

// Updates the manager leaves out of an upgrade: apt keeps back those that
// would remove packages ("kept-back": they need a full upgrade, done by hand)
// and defers phased ones on Ubuntu ("phased").
export type HeldUpdate = { name: string; reason: "kept-back" | "phased" };

// zypper: a patch that is needed (its packages are not up to date).
export type PatchAdvisory = {
    name: string;
    category: string;
    severity: string | null;
    repository: string | null;
    summary: string;
};

export type PatchNoticeCode =
    // The package lists were never downloaded: refresh them first.
    | "metadata-missing"
    // Another package manager runs now (detail: its processes); installing
    // waits for it.
    | "manager-busy"
    // The manager tells security updates apart, but the repositories carry
    // no security information (dnf without updateinfo, say).
    | "security-unknown"
    // Listing the updates failed (detail: the manager's message).
    | "listing-failed"
    // More updates than PATCH_LIMITS.maxListed: the list stops there.
    | "truncated"
    // Windows: Windows Update could not be searched (detail: its message).
    | "search-failed"
    // Windows: the user is not an administrator, and over SSH Windows Update
    // lets only administrators search it (detail: its message).
    | "search-denied";

export type PatchNotice = { code: PatchNoticeCode; detail?: string };

// What a scan read from a server.
export type PatchScan = {
    serverId: number;
    platform: "linux" | "windows";
    // null: no supported package manager.
    manager: PatchManager | null;
    privilege: PatchPrivilege;
    updates: PendingUpdate[];
    // Pending updates (the list may stop before: see the "truncated" notice).
    total: number;
    // Of those, security updates (zypper: needed security patches); null when
    // the manager cannot tell.
    security: number | null;
    held: HeldUpdate[];
    patches: PatchAdvisory[];
    // A reboot is pending (new kernel or libraries, Windows servicing); null
    // when the server gives no way to tell.
    rebootRequired: boolean | null;
    // Debian/Ubuntu: the packages that asked for it.
    rebootPackages: string[];
    // Services running outdated libraries (needrestart / needs-restarting),
    // when the server says.
    restartServices: string[];
    // The latest time updates were installed (epoch ms), if known: apt's
    // history, the newest rpm install time, apk's database, pacman's log,
    // Windows Update's last installation.
    lastUpdateAt: number | null;
    // When the package lists were last refreshed (Windows: the last online
    // search), if known.
    metadataAt: number | null;
    notices: PatchNotice[];
    scannedAt: number;
    durationMs: number;
};

// A scan without its lists (the fleet table).
export type PatchScanSummary = Omit<PatchScan, "updates" | "held" | "patches"> & { held: number; patches: number };

export function summarizeScan(scan: PatchScan): PatchScanSummary {
    const { updates: _updates, held, patches, ...rest } = scan;
    return { ...rest, held: held.length, patches: patches.length };
}

// Why a scan failed.
export type PatchScanError = {
    // AUTH_FAILED, HOST_KEY_MISMATCH, ECONNREFUSED, EXEC_TIMEOUT, PATCH_SCAN_FAILED...
    code: string;
    message: string;
    at: number;
};

// GET /api/patch/fleet: one row per saved Linux/Windows server.
export type PatchFleetRow = {
    serverId: number;
    // The latest scan since the backend started (null: none).
    scan: PatchScanSummary | null;
    // The latest scan failed (a scan before it may still be there).
    scanError: PatchScanError | null;
    // The fleet board's latest health check, which counts updates from the
    // package cache too (null: never checked).
    fleet: {
        state: FleetState;
        updates: { manager: PackageManager; count: number; security: number | null; cacheAt: number | null } | null;
        rebootRequired: boolean | null;
        readAt: number | null;
    } | null;
    // The saved servers reached through this one: a jump host is never
    // rebooted automatically (that would cut their connections).
    jumpHostFor: number[];
    // A patch job runs on it now.
    jobId: string | null;
    // A scan of it is running (one asked for, or the one after a run).
    scanning: boolean;
};

export type PatchFleet = { rows: PatchFleetRow[] };

// GET /api/servers/:id/patch: the latest scan of one server, with its lists.
export type PatchServerState = {
    scan: PatchScan | null;
    error: PatchScanError | null;
    jobId: string | null;
    scanning: boolean;
};

// POST /api/patch/scan streams one of these per event (Server-Sent Events).
export type PatchScanEvent =
    | { type: "start"; serverId: number }
    | { type: "scan"; serverId: number; scan: PatchScan }
    | { type: "error"; serverId: number; error: PatchScanError }
    | { type: "end" }
    | { type: "ping" };

// What a patch run does: install security updates, all updates, or only
// refresh the package lists; whether it refreshes them first; and whether
// each server reboots afterwards when a reboot is required.
export const PATCH_MODES = ["security", "all", "refresh"] as const;
export type PatchMode = typeof PATCH_MODES[number];

export type PatchOptions = {
    mode: PatchMode;
    // Refresh the package lists before installing (always, for "refresh").
    refresh: boolean;
    // Reboot when a reboot is required once the updates are in, and wait for
    // SSH to come back. Never for "refresh".
    reboot: boolean;
};

export const PATCH_LIMITS = {
    maxServers: 200,
    // Scans running at the same time.
    scanConcurrency: 4,
    // Updates listed per server.
    maxListed: 2000,
    // A server's whole run (updates, reboot and the wait for SSH), seconds.
    defaultTimeoutSec: 3600,
    minTimeoutSec: 300,
    // How long a rebooted server may take to answer SSH again, seconds.
    defaultRebootWaitSec: 600,
    minRebootWaitSec: 60,
    maxRebootWaitSec: 1800,
    // A run that reboots gives each server at least the wait for SSH plus
    // this (for its updates and the reboot itself), seconds.
    rebootMarginSec: 300
} as const;

// The shortest time per server a run allows (seconds).
export function minPatchTimeoutSec(options: Pick<PatchOptions, "reboot">, rebootWaitSec: number): number {
    return options.reboot ? Math.max(PATCH_LIMITS.minTimeoutSec, rebootWaitSec + PATCH_LIMITS.rebootMarginSec) : PATCH_LIMITS.minTimeoutSec;
}

export type PatchSkipReason =
    | "not-found"
    | "unsupported"         // not a Linux/Windows server
    | "windows"             // Windows updates are listed, not installed
    | "not-scanned"         // no scan yet: scan it first
    | "scan-failed"
    | "no-manager"          // no supported package manager
    | "privilege"           // neither root nor sudo
    | "sudo-password"       // sudo asks for a password (not supported in 1.0)
    | "no-security"         // the manager cannot tell security updates (apk, pacman)
    | "up-to-date"          // nothing to install, nothing to reboot
    | "busy";               // a patch job runs on it already

// How a server's run ends: with a reboot if one is required, never (the
// option is off), or never because it is a jump host.
export type PatchRebootPlan = "if-required" | "off" | "jump-host";

export type PatchPreviewServer = MultiExecTarget & {
    manager: PatchManager | null;
    privilege: PatchPrivilege | null;
    skip: PatchSkipReason | null;
    // What the latest scan counts for this mode (null: unknown).
    pending: number | null;
    security: number | null;
    rebootRequired: boolean | null;
    reboot: PatchRebootPlan;
    jumpHostFor: number[];
    scannedAt: number | null;
    metadataAt: number | null;
};

// The commands a run gives each package manager, as shown in the preview.
export type PatchCommandPlan = { manager: PatchManager; commands: string[] };

// POST /api/patch/preview: what a run with these options would do.
export type PatchPreview = {
    options: PatchOptions;
    servers: PatchPreviewServer[];
    // Servers that would run (skip === null).
    eligible: number;
    totals: { pending: number; security: number };
    // Eligible servers that reboot if required.
    rebootable: number;
    commands: PatchCommandPlan[];
    // The script every server runs.
    script: string;
};

export type PatchPreviewRequest = PatchOptions & { serverIds: number[] };

// POST /api/patch/apply.
export type PatchApplyRequest = PatchPreviewRequest & {
    strategy?: Partial<MultiExecStrategy> | null;
    timeoutSec?: number;
    rebootWaitSec?: number;
    // The number of servers the run starts on, as the user confirmed it (typed
    // for a fleet run): a preview that changed meanwhile is refused.
    confirm: number;
};

export type PatchApplyResponse = {
    job: MultiExecJobInfo;
    targets: MultiExecTarget[];
    skipped: PatchPreviewServer[];
};

// The first line of the command a patch job records, so the job history
// (and the patch center) can tell patch jobs from other multi-exec jobs.
export const PATCH_JOB_HEADER = "# ShellMind patch center:";

export const isPatchJob = (job: Pick<MultiExecJobInfo, "command">): boolean => job.command.startsWith(PATCH_JOB_HEADER);

// What a patch job installs (its script sets `mode=`), null for other jobs.
export function patchJobMode(job: Pick<MultiExecJobInfo, "command">): PatchMode | null {
    if (!isPatchJob(job)) return null;
    const mode = /^mode=([a-z]+)$/m.exec(job.command)?.[1];
    return mode && (PATCH_MODES as readonly string[]).includes(mode) ? mode as PatchMode : null;
}

// The lines ShellMind itself writes into a patch run's output (its scripts
// and the reboot step), and the reasons a server's run failed, are
// machine-readable so the client words them in its language:
// "[shellmind] <event>=<value> [<name>=<value>...] [| <detail>]", e.g.
// "[shellmind] reboot=back after=42 up=9 state=running failed=0". The detail
// is free text (a server's own error message), shown as it is.
export const PATCH_MARK = "[shellmind]";

export type PatchMarker = {
    event: string;
    value: string;
    params: Record<string, string>;
    detail: string | null;
};

const MARKER_LINE = /^\[shellmind\] ([a-z][a-z-]*)=([\w.:-]+)((?: [a-z][a-z-]*=[\w.:-]+)*)(?: \| (.*))?$/;

export function parsePatchMarker(line: string): PatchMarker | null {
    const match = MARKER_LINE.exec(line.replace(/\r$/, ""));
    if (!match) return null;
    const params: Record<string, string> = {};
    for (const pair of match[3].trim().split(" ").filter(Boolean)) {
        const index = pair.indexOf("=");
        params[pair.slice(0, index)] = pair.slice(index + 1);
    }
    return { event: match[1], value: match[2], params, detail: match[4]?.trim() || null };
}

// The marker line for an event (values are numbers or plain words; the
// detail is kept on one line).
export function patchMarker(event: string, value: string | number, params: Record<string, string | number | null | undefined> = {}, detail?: string | null): string {
    const pairs = Object.entries(params).filter(([, item]) => item !== null && item !== undefined && String(item) !== "").map(([name, item]) => ` ${name}=${String(item).replace(/[^\w.:-]/g, "_")}`);
    const text = detail?.replace(/\s+/g, " ").trim();
    return `${PATCH_MARK} ${event}=${String(value).replace(/[^\w.:-]/g, "_")}${pairs.join("")}${text ? ` | ${text}` : ""}`;
}

// What a run installs, by mode (security: the security updates the scan
// counts, or all of them when it cannot tell).
export function pendingFor(scan: Pick<PatchScan, "total" | "security">, mode: PatchMode): number {
    if (mode === "security") return scan.security ?? 0;
    return mode === "all" ? scan.total : 0;
}
