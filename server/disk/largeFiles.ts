import {
    DEFAULT_LARGE_FILE_MB,
    LARGE_FILE_THRESHOLDS_MB,
    MAX_LARGE_FILES,
    type DiskMount,
    type LargeFile,
    type LargeFilesResult
} from "../../shared/disk";
import type { OpsCapabilities } from "../../shared/ops";
import { AppError } from "../errors";
import { POSIX_SECTION_FUNCTION, asNumber, asString, ensureArray, extractJson, isRecord, parseSections, psQuote, shellQuote } from "../ops/remote";
import type { SshLease } from "../ssh/pool";
import { largeFileScans } from "./cache";
import { TEMP_DIR, TEMP_DIR_CLEANUP, isElevated, isTimeoutCode, lowPriorityPrefix, runDiskScript, toInteger } from "./remote";
import { InvalidDiskInputError } from "./usage";

// The largest files of one filesystem: `find -xdev -size +N` (GNU find
// prints the details itself; busybox's goes through stat), the top
// MAX_LARGE_FILES by size. Windows walks the drive within the time budget.

export const LARGE_FILES_BUDGET_SECONDS = 90;
const MARGIN_MS = { linux: 20_000, windows: 40_000 } as const;

export function requireThreshold(value: unknown): number {
    if (value === undefined || value === null || value === "") return DEFAULT_LARGE_FILE_MB;
    const mb = typeof value === "number" ? value : Number(value);
    if (!(LARGE_FILE_THRESHOLDS_MB as readonly number[]).includes(mb)) {
        throw new InvalidDiskInputError(`The size threshold is one of ${LARGE_FILE_THRESHOLDS_MB.join(", ")} MB.`);
    }
    return mb;
}

export function linuxLargeFilesScript(mount: string, minMB: number, budgetSeconds = LARGE_FILES_BUDGET_SECONDS, limit = MAX_LARGE_FILES): string {
    // In KiB: busybox find knows no M suffix. Files above it, rounded up.
    const size = `+${minMB * 1024}k`;
    return [
        "LC_ALL=C",
        "export LC_ALL",
        POSIX_SECTION_FUNCTION,
        `p=${shellQuote(mount)}`,
        lowPriorityPrefix(budgetSeconds),
        TEMP_DIR,
        // A path with a newline in it would print over several lines: such
        // files are left out (find matches the newline itself).
        "nl=$(printf '\\nx')",
        "nl=${nl%x}",
        "m files",
        "if find / -maxdepth 0 -printf '' >/dev/null 2>&1; then",
        `  { $L find "$p" -xdev -type f -size ${size} ! -path "*$nl*" -printf '%s %T@ %u %p\\n' 2>"$e"; echo $? >"$d/rc"; } | sort -rn | head -n ${limit}`,
        "else",
        `  { $L find "$p" -xdev -type f -size ${size} ! -path "*$nl*" -exec stat -c '%s %Y %U %n' {} + 2>"$e"; echo $? >"$d/rc"; } | sort -rn | head -n ${limit}`,
        "fi",
        "m rc",
        "cat \"$d/rc\" 2>/dev/null",
        "m errors",
        "echo \"denied $(grep -ci 'permission denied' \"$e\" 2>/dev/null)\"",
        "m end",
        TEMP_DIR_CLEANUP,
        ""
    ].join("\n");
}

type Parsed = Pick<LargeFilesResult, "files" | "timedOut" | "denied">;

export function parseLinuxLargeFiles(output: string): Parsed {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new AppError("OPS_COMMAND_FAILED", "The file search was cut off before it finished.", 502);
    const files = (sections.get("files") ?? "").split("\n").flatMap((line): LargeFile[] => {
        const match = /^(\d+) ([\d.]+) (\S+) (\/.*)$/.exec(line);
        if (!match) return [];
        const seconds = Number.parseFloat(match[2]);
        return [{ path: match[4], bytes: Number(match[1]), modifiedAt: Number.isFinite(seconds) ? Math.round(seconds * 1000) : null, owner: match[3] }];
    });
    const rc = toInteger(sections.get("rc"));
    return { files, timedOut: isTimeoutCode(rc), denied: toInteger(/^denied (\d+)/m.exec(sections.get("errors") ?? "")?.[1]) ?? 0 };
}

export function windowsLargeFilesScript(mount: string, minMB: number, budgetSeconds = LARGE_FILES_BUDGET_SECONDS, limit = MAX_LARGE_FILES): string {
    return `
$ErrorActionPreference='SilentlyContinue'
$limit=${Math.round(budgetSeconds * 1000)}
$min=[long]${minMB * 1024 * 1024}
$clock=[Diagnostics.Stopwatch]::StartNew()
$reparse=[IO.FileAttributes]::ReparsePoint
$epoch=New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc)
$found=New-Object 'Collections.Generic.List[object]'
$denied=0
$stopped=$false
$stack=New-Object 'Collections.Generic.Stack[IO.DirectoryInfo]'
$stack.Push((New-Object IO.DirectoryInfo(${psQuote(mount)})))
while($stack.Count -gt 0){
if($clock.ElapsedMilliseconds -ge $limit){$stopped=$true;break}
$dir=$stack.Pop()
try{foreach($f in $dir.EnumerateFiles()){if($f.Length -gt $min){$found.Add(@{p=$f.FullName;b=[long]$f.Length;t=[long]($f.LastWriteTimeUtc-$epoch).TotalMilliseconds})}}}catch{$denied++}
try{foreach($s in $dir.EnumerateDirectories()){if(-not ($s.Attributes -band $reparse)){$stack.Push($s)}}}catch{$denied++}
}
@{files=@($found|Sort-Object @{Expression={$_.b}} -Descending|Select-Object -First ${limit});denied=$denied;timedOut=$stopped}|ConvertTo-Json -Compress -Depth 4
`;
}

export function parseWindowsLargeFiles(output: string): Parsed {
    const report = extractJson(output);
    if (!isRecord(report)) throw new AppError("OPS_COMMAND_FAILED", "The file search returned no data.", 502);
    const files = ensureArray(report.files).filter(isRecord).flatMap((item): LargeFile[] => {
        const path = asString(item.p);
        const bytes = asNumber(item.b);
        if (!path || bytes === null) return [];
        return [{ path, bytes, modifiedAt: asNumber(item.t), owner: null }];
    });
    return { files, timedOut: report.timedOut === true, denied: asNumber(report.denied) ?? 0 };
}

export type LargeFilesRequest = { mount: DiskMount; minMB: number; refresh?: boolean; budgetSeconds?: number; limit?: number };

export async function findLargeFiles(lease: SshLease, caps: OpsCapabilities, request: LargeFilesRequest): Promise<LargeFilesResult> {
    const { mount, minMB } = request;
    const budget = request.budgetSeconds ?? LARGE_FILES_BUDGET_SECONDS;
    const limit = request.limit ?? MAX_LARGE_FILES;
    const elevated = isElevated(caps);
    const key = `${lease.serverId}|${lease.target.version}|${elevated}|large|${mount.mount}|${minMB}|${limit}|${budget}`;
    const cached = request.refresh ? null : largeFileScans.get(key);
    if (cached) return { ...cached, cached: true };
    return largeFileScans.run(key, async () => {
        const started = Date.now();
        const windows = caps.platform === "windows";
        const script = windows ? windowsLargeFilesScript(mount.mount, minMB, budget, limit) : linuxLargeFilesScript(mount.mount, minMB, budget, limit);
        const result = await runDiskScript(lease, caps, script, { timeoutMs: budget * 1000 + MARGIN_MS[caps.platform] });
        const parsed = windows ? parseWindowsLargeFiles(result.stdout) : parseLinuxLargeFiles(result.stdout);
        return { mount: mount.mount, minMB, ...parsed, elevated, collectedAt: Date.now(), cached: false, durationMs: Date.now() - started };
    });
}
