import type { StatusDisk, StatusInterface, StatusProcess, StatusSection, StatusSnapshot } from "../../shared/status";
import { asNumber, asString, ensureArray, extractJson, isRecord } from "../ops/remote";
import { aggregateStorage, clampPercent, percent, roundTo } from "./parse";
import { TOP_PROCESSES } from "./linux";

// Windows status: one PowerShell run returns a single JSON object. CPU,
// network and per-process CPU are measured over the same one-second sample:
// total CPU from the _Total processor counter, each process from the change
// of its TotalProcessorTime (the sampling PowerShell itself left out, as on
// Linux). Counter deltas are taken in PowerShell, where the 64-bit raw
// values are exact.

// The system ($os, $ver), its uptime in seconds ($up), memory in KB ($mem)
// and the fixed drives ($d) without WMI, which over an SSH logon Windows
// lets only administrators use (as it does listing the services, reading the
// event logs and the performance counters; a refused query takes seconds).
// The system comes from the registry, the uptime from the performance
// counter clock (as PowerShell 7's Get-Uptime reads it), memory from
// GlobalMemoryStatusEx (Microsoft.VisualBasic's ComputerInfo), the drives
// from DriveInfo; the paging files stay unknown.
export const WINDOWS_FALLBACK_FACTS = `
$k=Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion'
$os='Microsoft '+$k.ProductName;if([int]$k.CurrentBuild -ge 22000){$os=$os -replace 'Windows 10','Windows 11'}
$ver=[Environment]::OSVersion.Version.ToString(3)
$up=[Diagnostics.Stopwatch]::GetTimestamp()/[Diagnostics.Stopwatch]::Frequency
Add-Type -AssemblyName Microsoft.VisualBasic;$i=New-Object Microsoft.VisualBasic.Devices.ComputerInfo
$mem=@{t=$i.TotalPhysicalMemory/1KB;f=$i.AvailablePhysicalMemory/1KB}
$d=@([IO.DriveInfo]::GetDrives()|?{$_.DriveType -eq 'Fixed' -and $_.IsReady}|%{@{n=$_.Name.TrimEnd('\\');fs=$_.DriveFormat;s=$_.TotalSize;f=$_.TotalFreeSpace}})
`;

// The same facts from WMI (Win32_OperatingSystem, Win32_LogicalDisk) for an
// administrator, and whether WMI was used ($wmi): the fallback serves any
// other account, and a WMI that does not answer. The uptime is taken in UTC:
// local times an hour apart across a daylight saving change would make it an
// hour off.
export const WINDOWS_SYSTEM_FACTS = `
$wmi=([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(544)
if($wmi){$o=Get-CimInstance Win32_OperatingSystem;$wmi=$null -ne $o}
if($wmi){$os=$o.Caption;$ver=$o.Version;$up=([DateTime]::UtcNow-$o.LastBootUpTime.ToUniversalTime()).TotalSeconds
$mem=@{t=$o.TotalVisibleMemorySize;f=$o.FreePhysicalMemory;st=$o.SizeStoredInPagingFiles;sf=$o.FreeSpaceInPagingFiles}
$d=@(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{@{n=$_.DeviceID;fs=$_.FileSystem;s=$_.Size;f=$_.FreeSpace}})
}else{${WINDOWS_FALLBACK_FACTS}}
`;

// Without WMI there is no processor counter (the CPU stays unknown) and the
// traffic comes from the network interfaces' own statistics. The processes
// and the signed-in users are left out too: such an account may not read
// the processor time of another account's process (each refusal takes
// milliseconds, seconds for a whole list), and quser sees only its own.
export const WINDOWS_STATUS_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
${WINDOWS_SYSTEM_FACTS}
$q="Name='_Total'"
$N={$h=@{};if($wmi){Get-CimInstance Win32_PerfRawData_Tcpip_NetworkInterface|%{$h[$_.Name]=@([double]$_.BytesReceivedPersec,[double]$_.BytesSentPersec)}}else{[Net.NetworkInformation.NetworkInterface]::GetAllNetworkInterfaces()|?{$_.NetworkInterfaceType -ne 'Loopback' -and $_.OperationalStatus -eq 'Up'}|%{$s=$_.GetIPStatistics();$h[$_.Name]=@([double]$s.BytesReceived,[double]$s.BytesSent)}};$h}
$c1=if($wmi){Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter $q}
$n1=&$N
$p1=@{};if($wmi){Get-Process|%{if($_.Id -ne $PID){$p1[$_.Id]=$_.TotalProcessorTime.Ticks}}}
$w=[Diagnostics.Stopwatch]::StartNew()
Start-Sleep -Milliseconds 1000
$cpu=$null;if($c1){$c2=Get-CimInstance Win32_PerfRawData_PerfOS_Processor -Filter $q;if($c2){$cpu=@{i=[double]($c2.PercentProcessorTime-$c1.PercentProcessorTime);s=[double]($c2.Timestamp_Sys100NS-$c1.Timestamp_Sys100NS)}}}
$n2=&$N
$net=@($n2.Keys|%{$a=$n1[$_];if($a){@{n=$_;rx=$n2[$_][0]-$a[0];tx=$n2[$_][1]-$a[1]}}})
$pr=@(if($wmi){Get-Process|%{$t=$_.TotalProcessorTime.Ticks;if($_.Id -gt 0 -and $_.Id -ne $PID -and $null -ne $t -and $p1.ContainsKey($_.Id)){@{pid=$_.Id;name=$_.ProcessName;d=[double]($t-$p1[$_.Id]);ws=[double]$_.WorkingSet64}}}|Sort-Object {$_.d} -Descending|Select-Object -First ${TOP_PROCESSES}})
$el=[double]$w.Elapsed.Ticks
$u=$null;if($wmi -and (Get-Command quser -EA 0)){$u=@(quser 2>$null|Select-Object -Skip 1|%{($_.Trim().TrimStart('>') -split '\\s+')[0]}|Sort-Object -Unique).Count}
@{host=$env:COMPUTERNAME;os=$os;ver=$ver;up=$up;cores=[Environment]::ProcessorCount;mem=$mem;cpu=$cpu;el=$el;disks=$d;net=$net;procs=$pr;users=$u;wmi=$wmi}|ConvertTo-Json -Compress -Depth 4
`;

const TICKS_PER_SECOND = 10_000_000;
const BYTES_PER_GB = 1024 ** 3;

function windowsCpu(raw: unknown, cores: number | null): StatusSnapshot["cpu"] {
    if (!isRecord(raw)) return null;
    let idle = asNumber(raw.i);
    const span = asNumber(raw.s);
    if (idle === null || span === null || span <= 0) return null;
    // The _Total idle counter is an average; should a system report the sum
    // over all processors instead, scale it back.
    if (idle > span * 1.05 && cores) idle /= cores;
    return { usagePercent: clampPercent((1 - idle / span) * 100), cores, iowaitPercent: null };
}

function windowsMemory(raw: unknown): { memory: StatusSnapshot["memory"]; swap: StatusSnapshot["swap"] } {
    if (!isRecord(raw)) return { memory: null, swap: null };
    const totalKb = asNumber(raw.t);
    // FreePhysicalMemory is the "Available" figure of Task Manager.
    const freeKb = asNumber(raw.f);
    const swapTotalKb = asNumber(raw.st);
    const swapFreeKb = asNumber(raw.sf);
    const memory = totalKb && freeKb !== null
        ? {
            totalMB: roundTo(totalKb / 1024, 1),
            usedMB: roundTo(Math.max(0, totalKb - freeKb) / 1024, 1),
            availableMB: roundTo(Math.min(freeKb, totalKb) / 1024, 1),
            usagePercent: percent(totalKb - freeKb, totalKb)
        }
        : null;
    const swap = swapTotalKb !== null && swapFreeKb !== null
        ? {
            totalMB: roundTo(swapTotalKb / 1024, 1),
            usedMB: roundTo(Math.max(0, swapTotalKb - swapFreeKb) / 1024, 1),
            usagePercent: percent(swapTotalKb - swapFreeKb, swapTotalKb)
        }
        : null;
    return { memory, swap };
}

function windowsDisks(raw: unknown): StatusDisk[] {
    return ensureArray(raw).filter(isRecord).flatMap((disk) => {
        const size = asNumber(disk.s);
        const free = asNumber(disk.f);
        const name = asString(disk.n);
        if (!name || !size || free === null) return [];
        return [{
            name,
            mount: name,
            fsType: asString(disk.fs) || null,
            totalGB: roundTo(size / BYTES_PER_GB, 1),
            usedGB: roundTo((size - free) / BYTES_PER_GB, 1),
            freeGB: roundTo(free / BYTES_PER_GB, 1),
            usagePercent: percent(size - free, size)
        }];
    });
}

function windowsNetwork(raw: unknown, seconds: number): StatusSnapshot["network"] {
    const interfaces: StatusInterface[] = ensureArray(raw).filter(isRecord).flatMap((item) => {
        const rx = asNumber(item.rx);
        const tx = asNumber(item.tx);
        const name = asString(item.n);
        if (!name || rx === null || tx === null) return [];
        return [{ name, rxBytesPerSec: Math.round(Math.max(0, rx) / seconds), txBytesPerSec: Math.round(Math.max(0, tx) / seconds) }];
    });
    if (interfaces.length === 0) return null;
    return {
        rxBytesPerSec: interfaces.reduce((sum, item) => sum + item.rxBytesPerSec, 0),
        txBytesPerSec: interfaces.reduce((sum, item) => sum + item.txBytesPerSec, 0),
        interfaces: interfaces.sort((a, b) => (b.rxBytesPerSec + b.txBytesPerSec) - (a.rxBytesPerSec + a.txBytesPerSec)).slice(0, 6)
    };
}

function windowsProcesses(raw: unknown, elapsedTicks: number, totalKb: number | null): StatusProcess[] {
    return ensureArray(raw).filter(isRecord).flatMap((item) => {
        const pid = asNumber(item.pid);
        const ticks = asNumber(item.d);
        if (pid === null || ticks === null || elapsedTicks <= 0) return [];
        const workingSet = asNumber(item.ws);
        return [{
            pid,
            name: asString(item.name) || "?",
            // TotalProcessorTime counts every core: 100 = one core busy.
            cpuPercent: roundTo((Math.max(0, ticks) / elapsedTicks) * 100, 1),
            memoryMB: workingSet !== null ? roundTo(workingSet / 1024 / 1024, 1) : null,
            memoryPercent: workingSet !== null && totalKb ? percent(workingSet / 1024, totalKb) : null
        }];
    }).sort((a, b) => b.cpuPercent - a.cpuPercent);
}

export function parseWindowsStatus(output: string, collectedAt = Date.now()): StatusSnapshot {
    const report = extractJson(output);
    if (!isRecord(report)) throw new Error("The Windows status script returned no data.");
    const unavailable: StatusSection[] = [];
    const missing = <T>(section: StatusSection, value: T | null): T | null => {
        if (value === null) unavailable.push(section);
        return value;
    };

    const cores = asNumber(report.cores);
    const elapsedTicks = asNumber(report.el) ?? 0;
    const sampleSeconds = elapsedTicks > 0 ? roundTo(elapsedTicks / TICKS_PER_SECOND, 2) : 1;
    const { memory, swap } = windowsMemory(report.mem);
    const totalKb = isRecord(report.mem) ? asNumber(report.mem.t) : null;
    const disks = windowsDisks(report.disks);
    const processes = windowsProcesses(report.procs, elapsedTicks, totalKb);
    const uptime = asNumber(report.up);
    const users = asNumber(report.users);
    const os = [asString(report.os).trim(), asString(report.ver).trim()].filter(Boolean);

    return {
        platform: "windows",
        collectedAt,
        hostname: asString(report.host),
        os: os[0] || "Windows",
        kernel: os[1] ?? null,
        uptimeSeconds: uptime !== null ? Math.floor(uptime) : null,
        cpu: missing("cpu", windowsCpu(report.cpu, cores)),
        memory: missing("memory", memory),
        swap: missing("swap", swap),
        // Windows has no load average.
        load: null,
        storage: aggregateStorage(disks),
        disks: missing("disks", disks.length ? disks : null) ?? [],
        processes: missing("processes", processes.length ? processes : null) ?? [],
        network: missing("network", windowsNetwork(report.net, sampleSeconds)),
        failedUnits: null,
        loggedInUsers: missing("users", users),
        sampleSeconds,
        unavailable,
        ...(report.wmi === false ? { limited: true as const } : {})
    };
}
