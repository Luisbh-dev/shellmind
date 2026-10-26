import type { CleanupId, CleanupParams, CleanupPreview, CleanupUnavailable } from "../../../shared/disk";
import { resolveCleanupParams } from "../../../shared/disk";
import { AppError } from "../../errors";
import { asNumber, asString, ensureArray, extractJson, isRecord, runPowerShell } from "../../ops/remote";
import { componentStoreAnalyses } from "../cache";
import { NOT_ELEVATED_MESSAGE, isElevated, parseBinarySize } from "../remote";
import { topItems, type CleanupContext, type CleanupProvider, type PreparedCleanup } from "./types";

// Windows cleanups: temporary folders, the Windows Update download cache,
// the recycle bins and the component store (WinSxS). Sizes are measured with
// the same walker as the explorer (reparse points not followed) within a
// time budget; DISM's analysis is slow, so it runs only for the preview of
// that cleanup (kept a few minutes per server), never before its run. Every
// run needs an administrator.

export const WINDOWS_CLEANUP_IDS = ["win-temp", "win-update-cache", "win-recycle-bin", "win-component-store"] as const;
type WindowsCleanupId = typeof WINDOWS_CLEANUP_IDS[number];

// Walking the folders (temporary files half of it, the rest a quarter each).
const MEASURE_BUDGET_MS = 24_000;
const PREVIEW_TIMEOUT_MS = 90_000;
// DISM is slow: its analysis alone took over ten minutes on a Windows Server
// 2025 test machine, and the cleanup can take much longer.
const DISM_TIMEOUT_MS = 30 * 60_000;
const DISM_RUN_TIMEOUT_MS = 90 * 60_000;
const RUN_TIMEOUT_MS = 30 * 60_000;
// The Windows Update download folder, renamed aside to be emptied with the
// services running again ("Download.shellmind-20261026103000").
const UPDATE_ASIDE = "Download.shellmind-";
const UPDATE_SERVICES = ["wuauserv", "bits"] as const;

// The walker, and the PowerShell date `days` ago ($null: every file).
const WALKER = `
$reparse=[IO.FileAttributes]::ReparsePoint
$epoch=New-Object DateTime 1970,1,1,0,0,0,([DateTimeKind]::Utc)
function Get-Files($paths,$cutoff,$limit){
$clock=[Diagnostics.Stopwatch]::StartNew()
$found=New-Object 'Collections.Generic.List[IO.FileInfo]'
$stopped=$false
$stack=New-Object 'Collections.Generic.Stack[IO.DirectoryInfo]'
foreach($p in $paths){$d=New-Object IO.DirectoryInfo($p);if($d.Exists){$stack.Push($d)}}
while($stack.Count -gt 0){
if($clock.ElapsedMilliseconds -ge $limit){$stopped=$true;break}
$dir=$stack.Pop()
try{foreach($f in $dir.EnumerateFiles()){if($null -eq $cutoff -or $f.LastWriteTimeUtc -lt $cutoff){$found.Add($f)}}}catch{}
try{foreach($s in $dir.EnumerateDirectories()){if(-not ($s.Attributes -band $reparse)){$stack.Push($s)}}}catch{}
}
@{files=$found;stopped=$stopped}
}
function Measure-Files($paths,$cutoff,$limit){
$r=Get-Files $paths $cutoff $limit
$sum=[long]0
foreach($f in $r.files){$sum+=$f.Length}
$top=@($r.files|Sort-Object Length -Descending|Select-Object -First 50|%{@{p=$_.FullName;b=[long]$_.Length;t=[long]($_.LastWriteTimeUtc-$epoch).TotalMilliseconds}})
@{b=$sum;c=$r.files.Count;stopped=$r.stopped;top=$top}
}
`;

const cutoffOf = (days: number) => (days > 0 ? `(Get-Date).ToUniversalTime().AddDays(-${days})` : "$null");

// The folders, as PowerShell expressions evaluated on the server.
const TEMP_PATHS = `$t=@();if($env:TEMP){$t+=$env:TEMP};$w=Join-Path $env:SystemRoot 'Temp';if($t -notcontains $w){$t+=$w}`;
const RECYCLE_PATHS = "$rb=@([IO.DriveInfo]::GetDrives()|Where-Object {$_.DriveType -eq 'Fixed' -and $_.IsReady}|ForEach-Object {Join-Path $_.Name '$Recycle.Bin'})";

export function windowsCleanupScript(tempDays: number): string {
    return `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
${WALKER}
${TEMP_PATHS}
${RECYCLE_PATHS}
$sd=Join-Path $env:SystemRoot 'SoftwareDistribution'
$dl=Join-Path $sd 'Download'
$up=@($dl)+@(Get-ChildItem -LiteralPath $sd -Directory -Force -Filter '${UPDATE_ASIDE}*'|ForEach-Object {$_.FullName})
$r=@{system=$env:SystemDrive;tempPaths=$t;updatePath=$dl;recyclePaths=$rb}
$r.temp=Measure-Files $t ${cutoffOf(tempDays)} ${MEASURE_BUDGET_MS / 2}
$r.update=Measure-Files $up $null ${MEASURE_BUDGET_MS / 4}
$r.recycle=Measure-Files $rb $null ${MEASURE_BUDGET_MS / 4}
$r|ConvertTo-Json -Compress -Depth 5
`;
}

export const DISM_ANALYZE_SCRIPT = `
$ErrorActionPreference='Continue'
$o=& Dism.exe /Online /Cleanup-Image /AnalyzeComponentStore /English 2>&1|Out-String
"exit=$LASTEXITCODE"
$o
`;

type Measured = { bytes: number; count: number; stopped: boolean; items: CleanupPreview["items"] };

function measured(value: unknown): Measured {
    const record = isRecord(value) ? value : {};
    const items = ensureArray(record.top).filter(isRecord).flatMap((item) => {
        const label = asString(item.p);
        return label ? [{ label, bytes: asNumber(item.b), modifiedAt: asNumber(item.t) }] : [];
    });
    return { bytes: asNumber(record.b) ?? 0, count: asNumber(record.c) ?? 0, stopped: record.stopped === true, items: topItems(items) };
}

// "C:\Users\x\AppData\Local\Temp" -> "C:\"
const driveOf = (path: string) => (/^[A-Za-z]:/.test(path) ? `${path.slice(0, 2).toUpperCase()}\\` : null);

function drives(paths: unknown, local: Set<string>): string[] {
    return [...new Set(ensureArray(paths).map(asString).flatMap((path) => {
        const drive = driveOf(path);
        return drive && local.has(drive) ? [drive] : [];
    }))];
}

export function windowsCommand(id: WindowsCleanupId, params: CleanupParams): string {
    switch (id) {
        case "win-temp":
            return `Get-ChildItem -LiteralPath $env:TEMP,"$env:SystemRoot\\Temp" -Recurse -File -Force${params.days ? ` | Where-Object LastWriteTime -lt (Get-Date).AddDays(-${params.days})` : ""} | Remove-Item -Force`;
        case "win-update-cache":
            return `Stop-Service wuauserv,bits -Force; Rename-Item "$env:SystemRoot\\SoftwareDistribution\\Download" ${UPDATE_ASIDE}<time>; Start-Service wuauserv,bits; Remove-Item "$env:SystemRoot\\SoftwareDistribution\\${UPDATE_ASIDE}*" -Recurse -Force`;
        case "win-recycle-bin":
            return "Remove-Item '<drive>:\\$Recycle.Bin\\*\\*' -Recurse -Force (every fixed drive)";
        case "win-component-store":
            return "Dism.exe /Online /Cleanup-Image /StartComponentCleanup";
    }
}

export function parseWindowsCleanups(output: string, admin: boolean, localMounts: string[], params: CleanupParams): CleanupPreview[] {
    const report = extractJson(output);
    if (!isRecord(report)) throw new AppError("OPS_COMMAND_FAILED", "The cleanup check returned no data.", 502);
    const local = new Set(localMounts);
    const reason: CleanupUnavailable | undefined = admin ? undefined : { code: "NOT_ELEVATED", message: NOT_ELEVATED_MESSAGE.windows };
    const system = driveOf(asString(report.system) || "C:");
    const systemMounts = system && local.has(system) ? [system] : [];
    const preview = (id: WindowsCleanupId, value: Measured, mounts: string[], extra: Partial<CleanupPreview> = {}): CleanupPreview => ({
        id,
        status: reason ? "unavailable" : value.count > 0 ? "ready" : "nothing",
        ...(reason ? { reason } : {}),
        bytes: value.bytes,
        // The walk stopped at its budget: at least what it counted.
        estimate: value.stopped ? "at-least" : "about",
        count: value.count,
        items: value.items,
        mounts,
        command: windowsCommand(id, id === "win-temp" ? params : {}),
        params: id === "win-temp" ? params : {},
        ...extra
    });
    return [
        preview("win-temp", measured(report.temp), drives(report.tempPaths, local)),
        preview("win-update-cache", measured(report.update), systemMounts),
        preview("win-recycle-bin", measured(report.recycle), drives(report.recyclePaths, local)),
        componentStorePreview(admin, systemMounts)
    ];
}

// The component store before DISM's analysis: nothing measured yet.
export function componentStorePreview(admin: boolean, systemMounts: string[]): CleanupPreview {
    const reason: CleanupUnavailable | undefined = admin ? undefined : { code: "NOT_ELEVATED", message: NOT_ELEVATED_MESSAGE.windows };
    return {
        id: "win-component-store",
        status: reason ? "unavailable" : "analyze",
        ...(reason ? { reason } : {}),
        bytes: null,
        estimate: "up-to",
        count: null,
        items: [],
        mounts: systemMounts,
        command: windowsCommand("win-component-store", {}),
        params: {}
    };
}

// DISM's report: "Backups and Disabled Features : 2.12 GB", "Component
// Store Cleanup Recommended : Yes"...
export function parseDismAnalysis(output: string): { exitCode: number | null; facts: Record<string, string | number>; bytes: number | null; recommended: boolean | null } {
    const exitCode = asNumber(/^exit=(-?\d+)/m.exec(output)?.[1]);
    const value = (label: string) => new RegExp(`^\\s*${label}\\s*:\\s*(.+?)\\s*$`, "mi").exec(output)?.[1] ?? null;
    // "7.66 GB", or "7,66 GB" where the locale writes a decimal comma.
    const size = (label: string) => {
        const text = value(label)?.replace(/\s+/g, "");
        if (!text) return null;
        return parseBinarySize(text.includes(".") ? text.replace(/,/g, "") : text.replace(",", "."));
    };
    const actual = size("Actual Size of Component Store");
    const backups = size("Backups and Disabled Features");
    const cache = size("Cache and Temporary Data");
    const packages = asNumber(value("Number of Reclaimable Packages"));
    const recommendedText = value("Component Store Cleanup Recommended");
    const facts: Record<string, string | number> = {};
    if (actual !== null) facts.size = actual;
    if (backups !== null) facts.backups = backups;
    if (cache !== null) facts.cache = cache;
    if (packages !== null) facts.packages = packages;
    const lastCleanup = value("Date of Last Cleanup");
    if (lastCleanup) facts.lastCleanup = lastCleanup;
    const recommended = recommendedText ? /^yes/i.test(recommendedText) : null;
    if (recommended !== null) facts.recommended = recommended ? "yes" : "no";
    const bytes = backups === null && cache === null ? null : (backups ?? 0) + (cache ?? 0);
    return { exitCode, facts, bytes, recommended };
}

// Deletes the files below the folders `$t` holds (set by `paths`, a line
// of PowerShell) last written before `days` ago; files in use are counted
// and left.
export function deleteOlderScript(paths: string, days: number): string {
    return `
$ErrorActionPreference='SilentlyContinue'
${WALKER}
${paths}
$r=Get-Files $t ${cutoffOf(days)} ${RUN_TIMEOUT_MS - 60_000}
$removed=0;$failed=0
foreach($f in $r.files){try{if($f.IsReadOnly){$f.IsReadOnly=$false};$f.Delete();$removed++}catch{$failed++}}
"$removed files removed, $failed in use or protected"
`;
}

const tempRunScript = (days: number) => deleteOlderScript(TEMP_PATHS, days);

// Empties the Windows Update download cache below `root` (a PowerShell
// expression: the SoftwareDistribution folder). The services are stopped
// only while the folder is renamed aside, a moment, and those that ran are
// started again before anything is deleted: a session that ends during the
// deletion (a lost connection) leaves them running, and the next run removes
// what was left aside. If the folder cannot be renamed, it is emptied in
// place with the services stopped.
export function updateCacheRunScript(root = "Join-Path $env:SystemRoot 'SoftwareDistribution'", services: readonly string[] = UPDATE_SERVICES): string {
    return `
$ErrorActionPreference='Stop'
$sd=${root}
$dl=Join-Path $sd 'Download'
$names=@(${services.map((name) => `'${name}'`).join(",")})
$active=@(Get-Service -Name $names -ErrorAction SilentlyContinue|Where-Object {$_.Status -ne 'Stopped'})
$running=@($active|Where-Object {$_.Status -eq 'Running'}|ForEach-Object {$_.Name})
$code=0;$script:failed=0
function Clear-Folder($path){foreach($i in @(Get-ChildItem -LiteralPath $path -Force -ErrorAction SilentlyContinue)){try{Remove-Item -LiteralPath $i.FullName -Recurse -Force -ErrorAction Stop}catch{$script:failed++}}}
try{
if($active.Count){$active|Stop-Service -Force -ErrorAction Stop}
if(Test-Path -LiteralPath $dl){
$aside='${UPDATE_ASIDE}'+(Get-Date -Format 'yyyyMMddHHmmss')
try{Rename-Item -LiteralPath $dl -NewName $aside -ErrorAction Stop}catch{Clear-Folder $dl}
}
}catch{[Console]::Error.WriteLine($_.Exception.Message);$code=1}
finally{foreach($n in $running){Start-Service -Name $n -ErrorAction SilentlyContinue}}
if($code -eq 0){
foreach($d in @(Get-ChildItem -LiteralPath $sd -Directory -Force -Filter '${UPDATE_ASIDE}*' -ErrorAction SilentlyContinue)){Clear-Folder $d.FullName;try{Remove-Item -LiteralPath $d.FullName -Recurse -Force -ErrorAction Stop}catch{}}
"The Windows Update download cache was emptied ($($script:failed) items could not be removed)."
}
exit $code
`;
}

const RECYCLE_RUN_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
${RECYCLE_PATHS}
$removed=0;$failed=0
foreach($b in $rb){Get-ChildItem -LiteralPath $b -Force -Directory|ForEach-Object{Get-ChildItem -LiteralPath $_.FullName -Force|Where-Object {$_.Name -ne 'desktop.ini'}|ForEach-Object{try{Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction Stop;$removed++}catch{$failed++}}}}
"$removed items removed from the recycle bins, $failed could not be removed"
`;

const DISM_RUN_SCRIPT = `
$ErrorActionPreference='Continue'
& Dism.exe /Online /Cleanup-Image /StartComponentCleanup /English 2>&1|Out-String
exit $LASTEXITCODE
`;

function requireWindowsId(id: CleanupId): WindowsCleanupId {
    if (!(WINDOWS_CLEANUP_IDS as readonly string[]).includes(id)) throw new AppError("OPS_UNSUPPORTED", `${id} is not a Windows cleanup.`, 409);
    return id as WindowsCleanupId;
}

async function measure(ctx: CleanupContext, params: CleanupParams): Promise<CleanupPreview[]> {
    const result = await runPowerShell(ctx.lease, windowsCleanupScript(params.days ?? 0), { timeoutMs: PREVIEW_TIMEOUT_MS, signal: ctx.signal });
    return parseWindowsCleanups(result.stdout, isElevated(ctx.caps), ctx.mounts.map((mount) => mount.mount), params);
}

async function analyzeComponentStore(ctx: CleanupContext, base: CleanupPreview): Promise<CleanupPreview> {
    if (base.status === "unavailable") return base;
    const result = await runPowerShell(ctx.lease, DISM_ANALYZE_SCRIPT, { timeoutMs: DISM_TIMEOUT_MS, signal: ctx.signal });
    const analysis = parseDismAnalysis(result.stdout);
    if (analysis.exitCode !== 0) {
        const message = result.stdout.replace(/^exit=.*$/m, "").trim().split("\n").filter((line) => /error/i.test(line)).join(" ").slice(0, 500);
        if (/740|elevat/i.test(message)) return { ...base, status: "unavailable", reason: { code: "NOT_ELEVATED", message: NOT_ELEVATED_MESSAGE.windows } };
        throw new AppError("OPS_COMMAND_FAILED", message || `DISM failed (exit code ${analysis.exitCode}).`, 502);
    }
    return {
        ...base,
        status: analysis.recommended === false && !(analysis.facts.packages as number) ? "nothing" : "ready",
        bytes: analysis.bytes,
        facts: analysis.facts
    };
}

// The system drive, for the component store (its run needs no measurement).
const SYSTEM_DRIVE_SCRIPT = "\"system=$env:SystemDrive\"";

async function componentStoreBase(ctx: CleanupContext): Promise<CleanupPreview> {
    const result = await runPowerShell(ctx.lease, SYSTEM_DRIVE_SCRIPT, { timeoutMs: PREVIEW_TIMEOUT_MS, signal: ctx.signal });
    const system = driveOf(/^system=(.*)$/m.exec(result.stdout)?.[1]?.trim() || "C:");
    const local = new Set(ctx.mounts.map((mount) => mount.mount));
    return componentStorePreview(isElevated(ctx.caps), system && local.has(system) ? [system] : []);
}

// DISM's analysis, kept per server for a while: reopening the cleanup (or
// the list) does not wait for it again. A run drops it (clearDiskScans).
const analysisKey = (ctx: CleanupContext) => `${ctx.lease.serverId}|${ctx.lease.target.version}|${isElevated(ctx.caps)}|component-store`;

async function componentStoreAnalysis(ctx: CleanupContext): Promise<CleanupPreview> {
    const cached = componentStoreAnalyses.get(analysisKey(ctx));
    if (cached) return cached;
    const analysis = await analyzeComponentStore(ctx, await componentStoreBase(ctx));
    if (analysis.status !== "unavailable") componentStoreAnalyses.set(analysisKey(ctx), analysis);
    return analysis;
}

export const windowsCleanups: CleanupProvider = {
    ids: WINDOWS_CLEANUP_IDS,
    overview: async (ctx) => {
        const previews = await measure(ctx, resolveCleanupParams("win-temp", {}) ?? {});
        const analysis = componentStoreAnalyses.get(analysisKey(ctx));
        return analysis ? previews.map((preview) => (preview.id === "win-component-store" && preview.status === "analyze" ? analysis : preview)) : previews;
    },
    preview: async (ctx, id, params) => {
        const cleanup = requireWindowsId(id);
        if (cleanup === "win-component-store") return componentStoreAnalysis(ctx);
        const all = await measure(ctx, cleanup === "win-temp" ? params : resolveCleanupParams("win-temp", {}) ?? {});
        return all.find((preview) => preview.id === cleanup)!;
    },
    prepare: async (ctx, id, params): Promise<PreparedCleanup> => {
        const cleanup = requireWindowsId(id);
        // The component store runs without the analysis again (minutes, and
        // the user has just seen it): only the rights are checked first.
        const preview = cleanup === "win-component-store" ? await componentStoreBase(ctx) : await windowsCleanups.preview(ctx, cleanup, params);
        const script = cleanup === "win-temp" ? tempRunScript(params.days ?? 0)
            : cleanup === "win-update-cache" ? updateCacheRunScript()
                : cleanup === "win-recycle-bin" ? RECYCLE_RUN_SCRIPT
                    : DISM_RUN_SCRIPT;
        return {
            preview,
            action: {
                display: preview.command,
                meta: { kind: "disk", action: `cleanup-${cleanup}`, target: preview.mounts.join(", ") || "C:\\" },
                run: (lease, signal) => runPowerShell(lease, script, { timeoutMs: cleanup === "win-component-store" ? DISM_RUN_TIMEOUT_MS : RUN_TIMEOUT_MS, signal })
            }
        };
    }
};
