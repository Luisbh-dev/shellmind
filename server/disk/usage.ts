import {
    DEFAULT_DISK_SCAN_BUDGET,
    DISK_SCAN_BUDGETS,
    MAX_DISK_ENTRIES,
    mountOf,
    normalizeDiskPath,
    type DirectoryListing,
    type DiskEntry,
    type DiskMount
} from "../../shared/disk";
import type { OpsCapabilities, OpsPlatform } from "../../shared/ops";
import { AppError } from "../errors";
import { POSIX_SECTION_FUNCTION, asNumber, asString, ensureArray, extractJson, isRecord, parseSections, psQuote, shellQuote } from "../ops/remote";
import type { SshLease } from "../ssh/pool";
import { usageScans } from "./cache";
import { TEMP_DIR, TEMP_DIR_CLEANUP, decodeMountPath, isElevated, isTimeoutCode, lowPriorityPrefix, runDiskScript, toInteger } from "./remote";

// The directory usage explorer: the size of everything one level below a
// directory, largest first. Linux: `du -x -k -a -d 1` (sizes on disk, the
// scan stays on the directory's filesystem), at the lowest CPU and I/O
// priority and stopped by `timeout` on the server at the time budget; what
// it finished by then is listed. Windows: the sizes of the files below each
// folder, walked with .NET enumerators (reparse points, such as junctions and
// mounted volumes, are not followed) until the budget runs out.

// Beyond the budget: the time to start, sort and send the result.
const SCAN_MARGIN_MS = { linux: 20_000, windows: 40_000 } as const;
// A folder with this many direct entries prints them all: the output cap.
const SCAN_OUTPUT_BYTES = 8 * 1024 * 1024;

export class InvalidDiskInputError extends AppError {
    constructor(message: string) {
        super("OPS_INVALID_INPUT", message, 400);
        this.name = "InvalidDiskInputError";
    }
}

export function requirePath(platform: OpsPlatform, value: unknown): string {
    const path = typeof value === "string" ? normalizeDiskPath(platform, value) : null;
    if (!path) {
        throw new InvalidDiskInputError(platform === "windows"
            ? "Name an absolute folder on a drive, such as C:\\Users."
            : "Name an absolute directory, such as /var/log.");
    }
    return path;
}

export function requireBudget(value: unknown): number {
    if (value === undefined || value === null || value === "") return DEFAULT_DISK_SCAN_BUDGET;
    const seconds = typeof value === "number" ? value : Number(value);
    if (!(DISK_SCAN_BUDGETS as readonly number[]).includes(seconds)) throw new InvalidDiskInputError(`The time budget is one of ${DISK_SCAN_BUDGETS.join(", ")} seconds.`);
    return seconds;
}

// Prints the `<kb>\t<path>` lines (not the rest of a name broken over
// several lines), and `@@REST <count> <kb>` for those beyond `cap`.
const CAP_AWK = (cap: number) => `awk -v cap=${cap} '!/^[0-9]+\\t/ { next } { n++ } n <= cap { print; next } { c++; s += $1 } END { if (c) print "@@REST " c " " s }'`;

// `mount` is the filesystem `path` is meant to be on: the scan is refused
// when it is not (/proc, /sys, /dev/shm or a network mount below "/", or a
// symbolic link to another filesystem), checked by device number.
export function linuxUsageScript(path: string, budgetSeconds: number, mount = "/", cap = MAX_DISK_ENTRIES + 1): string {
    return [
        "LC_ALL=C",
        "export LC_ALL",
        POSIX_SECTION_FUNCTION,
        `p=${shellQuote(path)}`,
        `mp=${shellQuote(mount)}`,
        "if [ ! -d \"$p\" ]; then c=missing",
        "elif [ ! -r \"$p\" ] || [ ! -x \"$p\" ]; then c=denied",
        "elif [ \"$(stat -L -c %d -- \"$p\" 2>/dev/null)\" != \"$(stat -L -c %d -- \"$mp\" 2>/dev/null)\" ]; then c=otherfs",
        "else c=ok; fi",
        "m check",
        "echo \"$c\"",
        lowPriorityPrefix(budgetSeconds),
        TEMP_DIR,
        "m du",
        // The exit status of du (a timeout) is kept apart: a pipeline only reports its last command's.
        `if [ "$c" = ok ]; then { $L du -x -k -a -d 1 -- "$p" 2>"$e"; echo $? >"$d/rc"; } | sort -rn | ${CAP_AWK(cap)}; fi`,
        "m rc",
        "cat \"$d/rc\" 2>/dev/null",
        "m errors",
        "echo \"denied $(grep -ci 'permission denied' \"$e\" 2>/dev/null)\"",
        "grep -vi 'permission denied' \"$e\" 2>/dev/null | head -n 3",
        "m dirs",
        "[ \"$c\" = ok ] && find \"$p\" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | head -n 20000",
        "m links",
        "[ \"$c\" = ok ] && find \"$p\" -mindepth 1 -maxdepth 1 -type l 2>/dev/null | head -n 20000",
        // Names with a newline in them, NUL-separated by find, their
        // newlines turned into \x01: du prints such a name over several lines.
        "m odd",
        "nl=$(printf '\\nx')",
        "nl=${nl%x}",
        "[ \"$c\" = ok ] && find \"$p\" -mindepth 1 -maxdepth 1 -name \"*$nl*\" -print0 2>/dev/null | tr '\\n\\000' '\\001\\n' | head -n 1000",
        "m mounts",
        "awk '{ print $2 }' /proc/mounts 2>/dev/null",
        "m end",
        TEMP_DIR_CLEANUP,
        ""
    ].join("\n");
}

const childName = (parent: string, path: string, separator: string) => {
    const prefix = parent.endsWith(separator) ? parent : `${parent}${separator}`;
    return path.startsWith(prefix) ? path.slice(prefix.length) : null;
};

type ScanParse = Omit<DirectoryListing, "mount" | "budgetSeconds" | "elevated" | "collectedAt" | "cached" | "durationMs">;

export function parseLinuxUsage(path: string, output: string, mount = "/"): ScanParse {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new AppError("OPS_COMMAND_FAILED", "The directory scan was cut off before it finished.", 502);
    const check = sections.get("check")?.trim();
    if (check === "missing") throw new AppError("OPS_NOT_FOUND", `${path} is not a directory on this server (anymore).`, 404);
    if (check === "denied") throw new AppError("OPS_PERMISSION_DENIED", `The login user may not read ${path}. Log in as root, or as a user that may run sudo without a password.`, 403);
    if (check === "otherfs") {
        throw new AppError("DISK_UNKNOWN_MOUNT", `${path} is not on ${mount}: it is on another filesystem (virtual and network filesystems are not explored).`, 404);
    }

    // A name with a newline: du's first line of it looks like an entry
    // ("<kb>\t<dir>/<first part>"), and a later part may too. Both are left out.
    const odd = (sections.get("odd") ?? "").split("\n").filter(Boolean).map((record) => record.split("\x01"));
    const oddPaths = new Set(odd.map((parts) => parts[0]));
    const oddLines = new Set(odd.flatMap((parts) => parts.slice(1)));
    const dirs = new Set((sections.get("dirs") ?? "").split("\n").filter(Boolean));
    const links = new Set((sections.get("links") ?? "").split("\n").filter(Boolean));
    const mountPoints = new Set((sections.get("mounts") ?? "").split("\n").filter(Boolean).map(decodeMountPath));
    const rc = toInteger(sections.get("rc"));
    const errors = sections.get("errors") ?? "";
    const denied = toInteger(/^denied (\d+)/m.exec(errors)?.[1]) ?? 0;

    let totalBytes: number | null = null;
    let omitted: DirectoryListing["omitted"] = null;
    const entries: DiskEntry[] = [];
    for (const line of (sections.get("du") ?? "").split("\n")) {
        const rest = /^@@REST (\d+) (\d+)$/.exec(line.trim());
        if (rest) {
            omitted = { count: Number(rest[1]), bytes: Number(rest[2]) * 1024 };
            continue;
        }
        const match = /^(\d+)\t(.+)$/.exec(line);
        if (!match || oddLines.has(line)) continue;
        const bytes = Number(match[1]) * 1024;
        const entryPath = match[2];
        if (entryPath === path) {
            totalBytes = bytes;
            continue;
        }
        const name = childName(path, entryPath, "/");
        if (!name || name.includes("/") || oddPaths.has(entryPath)) continue;
        const entry: DiskEntry = { name, path: entryPath, bytes, kind: dirs.has(entryPath) ? "dir" : links.has(entryPath) ? "other" : "file" };
        if (mountPoints.has(entryPath)) entry.otherFs = true;
        entries.push(entry);
    }
    // Largest first (sort ran on the server; a missing sort must not reorder the view).
    entries.sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0));
    if (entries.length > MAX_DISK_ENTRIES) {
        const extra = entries.splice(MAX_DISK_ENTRIES);
        omitted = { count: (omitted?.count ?? 0) + extra.length, bytes: (omitted?.bytes ?? 0) + extra.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0) };
    }
    const timedOut = isTimeoutCode(rc);
    if (rc !== null && rc !== 0 && !timedOut && !entries.length && totalBytes === null) {
        const reason = errors.split("\n").filter((line) => line && !line.startsWith("denied ")).join(" ").trim();
        throw new AppError("OPS_COMMAND_FAILED", reason || `du failed (exit code ${rc}).`, 502);
    }
    return { path, totalBytes: timedOut ? null : totalBytes, entries, omitted, denied, timedOut };
}

export function windowsUsageScript(path: string, budgetSeconds: number, cap = MAX_DISK_ENTRIES): string {
    return `
$ErrorActionPreference='SilentlyContinue'
$root=${psQuote(path)}
$limit=${Math.round(budgetSeconds * 1000)}
$clock=[Diagnostics.Stopwatch]::StartNew()
$script:denied=0
$script:stopped=$false
$reparse=[IO.FileAttributes]::ReparsePoint
function Get-FolderSize([IO.DirectoryInfo]$top){
$total=[long]0
$stack=New-Object 'Collections.Generic.Stack[IO.DirectoryInfo]'
$stack.Push($top)
while($stack.Count -gt 0){
if($clock.ElapsedMilliseconds -ge $limit){$script:stopped=$true;return @{b=$total;p=$true}}
$dir=$stack.Pop()
try{foreach($f in $dir.EnumerateFiles()){$total+=$f.Length}}catch{$script:denied++}
try{foreach($s in $dir.EnumerateDirectories()){if(-not ($s.Attributes -band $reparse)){$stack.Push($s)}}}catch{$script:denied++}
}
return @{b=$total;p=$false}
}
$base=New-Object IO.DirectoryInfo($root)
if(-not $base.Exists){@{missing=$true}|ConvertTo-Json -Compress;exit 0}
$items=@()
try{$items=@($base.EnumerateFileSystemInfos())}catch{@{denied=$true}|ConvertTo-Json -Compress;exit 0}
$rows=New-Object 'Collections.Generic.List[object]'
foreach($i in $items){if($i -isnot [IO.DirectoryInfo]){$rows.Add(@{n=$i.Name;b=[long]$i.Length;k='f'})}}
foreach($i in $items){
if($i -isnot [IO.DirectoryInfo]){continue}
if($i.Attributes -band $reparse){$rows.Add(@{n=$i.Name;b=[long]0;k='d';o=$true});continue}
if($clock.ElapsedMilliseconds -ge $limit){$script:stopped=$true;$rows.Add(@{n=$i.Name;b=$null;k='d'});continue}
$r=Get-FolderSize $i
$rows.Add(@{n=$i.Name;b=$r.b;k='d';p=$r.p})
}
$sorted=@($rows|Sort-Object @{Expression={if($null -eq $_.b){-1}else{$_.b}}} -Descending)
$rest=@($sorted|Select-Object -Skip ${cap})
$sum=[long]0
foreach($r in $rows){if($null -ne $r.b){$sum+=$r.b}}
$restBytes=[long]0
foreach($r in $rest){if($null -ne $r.b){$restBytes+=$r.b}}
@{entries=@($sorted|Select-Object -First ${cap});total=$sum;restCount=$rest.Count;restBytes=$restBytes;denied=$script:denied;timedOut=$script:stopped}|ConvertTo-Json -Compress -Depth 4
`;
}

const KINDS: Record<string, DiskEntry["kind"]> = { d: "dir", f: "file" };

export function parseWindowsUsage(path: string, output: string): ScanParse {
    const report = extractJson(output);
    if (!isRecord(report)) throw new AppError("OPS_COMMAND_FAILED", "The folder scan returned no data.", 502);
    if (report.missing === true) throw new AppError("OPS_NOT_FOUND", `${path} is not a folder on this server (anymore).`, 404);
    if (report.denied === true) throw new AppError("OPS_PERMISSION_DENIED", `The login user may not read ${path}.`, 403);
    const timedOut = report.timedOut === true;
    const entries = ensureArray(report.entries).filter(isRecord).flatMap((item): DiskEntry[] => {
        const name = asString(item.n);
        if (!name || /[\\/]/.test(name)) return [];
        const bytes = item.b === null ? null : asNumber(item.b);
        const entry: DiskEntry = { name, path: path.endsWith("\\") ? `${path}${name}` : `${path}\\${name}`, bytes, kind: KINDS[asString(item.k)] ?? "other" };
        if (item.p === true) entry.partial = true;
        if (item.o === true) entry.otherFs = true;
        return [entry];
    });
    const restCount = asNumber(report.restCount) ?? 0;
    return {
        path,
        totalBytes: timedOut ? null : asNumber(report.total),
        entries,
        omitted: restCount > 0 ? { count: restCount, bytes: asNumber(report.restBytes) ?? 0 } : null,
        denied: asNumber(report.denied) ?? 0,
        timedOut
    };
}

// The largest directories two levels deep (the AI's "why is it full?"
// evidence): "<KiB>\t<path>" lines, largest first.
export function linuxTreeScript(path: string, budgetSeconds: number, limit: number): string {
    return [
        "LC_ALL=C",
        "export LC_ALL",
        lowPriorityPrefix(budgetSeconds),
        `$L du -x -k -d 2 -- ${shellQuote(path)} 2>/dev/null | sort -rn | head -n ${limit}`,
        ""
    ].join("\n");
}

export function parseTree(output: string): Array<{ path: string; bytes: number }> {
    return output.split("\n").flatMap((line) => {
        const match = /^(\d+)\t(.+)$/.exec(line);
        return match ? [{ path: match[2], bytes: Number(match[1]) * 1024 }] : [];
    });
}

export async function scanTree(lease: SshLease, caps: OpsCapabilities, path: string, budgetSeconds: number, limit: number, signal?: AbortSignal): Promise<{ dirs: Array<{ path: string; bytes: number }>; timedOut: boolean }> {
    const result = await runDiskScript(lease, caps, linuxTreeScript(path, budgetSeconds, limit), { timeoutMs: budgetSeconds * 1000 + SCAN_MARGIN_MS.linux, signal });
    const dirs = parseTree(result.stdout);
    // sort and head end the pipeline: a scan stopped by its budget shows as
    // a list without its root (printed last by du).
    return { dirs, timedOut: !dirs.some((dir) => dir.path === path) };
}

export type ScanRequest = { path: string; budgetSeconds: number; refresh?: boolean };

// One level of `path`. A cached scan is reused unless it stopped at a
// shorter budget than the one asked for now.
export async function scanDirectory(lease: SshLease, caps: OpsCapabilities, mounts: DiskMount[], request: ScanRequest): Promise<DirectoryListing> {
    const { path, budgetSeconds } = request;
    const mount = mountOf(caps.platform, path, mounts);
    if (!mount) throw new AppError("DISK_UNKNOWN_MOUNT", `${path} is not on a local filesystem of this server.`, 404);
    const elevated = isElevated(caps);
    const key = `${lease.serverId}|${lease.target.version}|${elevated}|usage|${path}`;
    const cached = request.refresh ? null : usageScans.get(key);
    if (cached && (!cached.timedOut || cached.budgetSeconds >= budgetSeconds)) return { ...cached, cached: true };
    return usageScans.run(key, async () => {
        const started = Date.now();
        const windows = caps.platform === "windows";
        const script = windows ? windowsUsageScript(path, budgetSeconds) : linuxUsageScript(path, budgetSeconds, mount.mount);
        // Not tied to the request: the scan is bounded on the server and its
        // result is kept for the next request (another view, a step back).
        const result = await runDiskScript(lease, caps, script, {
            timeoutMs: budgetSeconds * 1000 + SCAN_MARGIN_MS[caps.platform],
            maxOutputBytes: SCAN_OUTPUT_BYTES
        });
        const parsed = windows ? parseWindowsUsage(path, result.stdout) : parseLinuxUsage(path, result.stdout, mount.mount);
        return { ...parsed, mount: mount.mount, budgetSeconds, elevated, collectedAt: Date.now(), cached: false, durationMs: Date.now() - started };
    }, `${key}|${budgetSeconds}`);
}
