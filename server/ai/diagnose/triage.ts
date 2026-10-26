import type { ChatEvidenceSection, ChatEvidenceSectionId } from "../../../shared/chat";
import type { OpsCapabilities } from "../../../shared/ops";
import { POSIX_SECTION_FUNCTION, SECTION_MARKER, cleanStderr, parseSections, runPosixScript, runPowerShell } from "../../ops/remote";
import { privileged } from "../../ops/services";
import { AppError } from "../../errors";
import { EVIDENCE_COMMAND_TIMEOUT_MS, EVIDENCE_OUTPUT_MAX_BYTES, type EvidenceContext } from "./context";
import { WINDOWS_FALLBACK_FACTS } from "../../status/windows";
import { JOURNAL_DENIED_REASON, WINDOWS_EVENTLOG_DENIED_REASON, WINDOWS_SERVICES_DENIED_REASON, failedSection, logSection, textSection } from "./sections";

// The triage pack: one read-only script that collects what an on-call admin
// looks at first. Linux: failed units, errors of the last hour in the journal
// (else syslog), kernel errors and OOM kills, disk space and inodes, memory,
// the busiest processes and the listening ports. Windows: errors of the last
// hour in the System and Application logs, automatic services that are not
// running, disks, memory, processes and listening ports. Privileged reads go
// through `sudo -n` when the user may use it without a password.

type Part = { id: ChatEvidenceSectionId; marker: string; title: string; source: string; maxChars: number; log?: boolean };

const LINUX_PARTS: Part[] = [
    { id: "system", marker: "system", title: "System", source: "hostname, /etc/os-release, uname -sr, uptime", maxChars: 1500 },
    { id: "failed-units", marker: "failed", title: "Failed systemd units", source: "systemctl list-units --state=failed", maxChars: 3000 },
    { id: "errors", marker: "errors", title: "Errors logged in the last hour", source: "journalctl -p err -S -1h -n 300 (else syslog)", maxChars: 10_000, log: true },
    { id: "kernel", marker: "kernel", title: "Kernel errors and OOM kills", source: "dmesg | grep -iE 'error|fail|oom|killed process|segfault|panic|hung task'", maxChars: 3000, log: true },
    { id: "disk", marker: "disk", title: "Disk space and inodes", source: "df -hP; df -iP", maxChars: 2500 },
    { id: "memory", marker: "memory", title: "Memory", source: "free -m", maxChars: 1200 },
    { id: "processes", marker: "processes", title: "Busiest processes", source: "ps -eo pid,user,pcpu,pmem,rss,etime,stat,comm --sort=-pcpu", maxChars: 3000 },
    { id: "ports", marker: "ports", title: "Listening ports", source: "ss -tulpn", maxChars: 4000 }
];

const WINDOWS_PARTS: Part[] = [
    { id: "system", marker: "system", title: "System", source: "Win32_OperatingSystem", maxChars: 1500 },
    { id: "errors", marker: "errors", title: "Errors logged in the last hour (System and Application), grouped by source, most frequent first", source: "Get-WinEvent -LogName System,Application -Level 1,2", maxChars: 10_000 },
    { id: "stopped-services", marker: "stopped", title: "Automatic services that are not running", source: "Get-CimInstance Win32_Service (StartMode Auto, not running)", maxChars: 3000 },
    { id: "disk", marker: "disk", title: "Disk space", source: "Win32_LogicalDisk", maxChars: 2000 },
    { id: "memory", marker: "memory", title: "Memory", source: "Win32_OperatingSystem", maxChars: 1000 },
    { id: "processes", marker: "processes", title: "Processes with the most CPU time", source: "Get-Process | Sort-Object CPU -Descending", maxChars: 3000 },
    { id: "ports", marker: "ports", title: "Listening ports", source: "Get-NetTCPConnection -State Listen", maxChars: 4000 }
];

// What WINDOWS_LIMITED_TRIAGE_SCRIPT reads instead.
const LIMITED_SOURCES: Partial<Record<ChatEvidenceSectionId, string>> = {
    system: "the registry, DriveInfo and GlobalMemoryStatusEx",
    "stopped-services": "Get-Service (StartType Automatic, not running)",
    disk: "DriveInfo",
    memory: "GlobalMemoryStatusEx",
    processes: "Get-Process | Sort-Object WorkingSet64 -Descending",
    ports: "netstat -ano"
};
const WINDOWS_LIMITED_PARTS: Part[] = WINDOWS_PARTS.map((part) => ({ ...part, source: LIMITED_SOURCES[part.id] ?? part.source }));

// `df -P<flag>` without pseudo filesystems or the files a container has
// bind-mounted (/etc/hosts...): rows of a device path or of "/", whose
// mount point (the rest of the line: it may hold spaces) is a directory.
const LOCAL_DF_FUNCTION = [
    "d() { df -P\"$1\" 2>/dev/null | { IFS= read -r h; printf '%s\\n' \"$h\"; while IFS= read -r l; do",
    "  p=$(printf '%s\\n' \"$l\" | awk '{ for (i = 6; i <= NF; i++) printf \"%s%s\", $i, (i < NF ? \" \" : \"\") }')",
    "  case \"$l\" in /*|*' /') [ -d \"$p\" ] && printf '%s\\n' \"$l\";; esac",
    "done; }; }"
].join("\n");
const PS_FIELDS = "pid,user,pcpu,pmem,rss,etime,stat,comm";

// Printed instead of a part the login user may not read, with why: "denied"
// (the journal), "none" (no journal and no readable syslog), "dmesg <its
// error>"; on Windows "eventlog" (neither the System nor the Application
// log) and "services" (the service manager's list).
const UNREADABLE = "!unreadable: ";

function unreadableReason(rest: string): string {
    if (rest === "denied") return `${JOURNAL_DENIED_REASON} No readable /var/log/syslog or /var/log/messages either.`;
    if (rest === "none") return "This server has no journal, and no readable /var/log/syslog or /var/log/messages.";
    if (rest === "eventlog") return WINDOWS_EVENTLOG_DENIED_REASON;
    if (rest === "services") return WINDOWS_SERVICES_DENIED_REASON;
    const error = rest.replace(/^dmesg\s*/, "").trim();
    return `The kernel log (dmesg) cannot be read: it needs root or passwordless sudo (kernel.dmesg_restrict), and inside a container the CAP_SYSLOG capability${error ? ` (${error})` : ""}.`;
}

export function linuxTriageScript(caps: OpsCapabilities): string {
    const sudo = privileged(caps);
    return [
        "LC_ALL=C",
        "export LC_ALL",
        POSIX_SECTION_FUNCTION,
        "m system",
        "echo \"Host: $(hostname 2>/dev/null || cat /proc/sys/kernel/hostname)\"",
        "grep '^PRETTY_NAME=' /etc/os-release 2>/dev/null | cut -d= -f2- | tr -d '\"'",
        "uname -sr",
        "uptime",
        "[ -f /var/run/reboot-required ] && echo 'A reboot is required (/var/run/reboot-required).'",
        "m failed",
        "if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then",
        "  f=$(systemctl list-units --state=failed --no-legend --plain --no-pager 2>&1 | head -n 50); [ -n \"$f\" ] && printf '%s\\n' \"$f\" || echo '(none)'",
        "else echo '(no systemd)'; fi",
        "m errors",
        // The journal, unless journalctl says it showed nothing of it (the
        // user may not read it): then syslog, said so. Neither: a marker.
        "r=",
        "if command -v journalctl >/dev/null 2>&1; then",
        `  j=$(${sudo}journalctl -p err -S -1h --no-pager -o short-iso -n 300 2>&1 | tail -n 300)`,
        "  case \"$j\" in *'insufficient permissions'*|*'not seeing messages from other users'*) r=denied;; *) printf '%s\\n' \"$j\"; r=ok;; esac",
        "fi",
        "if [ \"$r\" != ok ]; then",
        "  f=; for l in /var/log/syslog /var/log/messages; do [ -r \"$l\" ] && { f=$l; break; }; done",
        "  if [ -n \"$f\" ]; then",
        "    [ \"$r\" = denied ] && echo \"(The login user may not read the journal: the latest matching lines of $f instead, not only the last hour.)\"",
        "    tail -n 3000 \"$f\" | grep -iE 'error|fail|crit|panic|denied' | tail -n 150",
        `  else echo "${UNREADABLE}\${r:-none}"; fi`,
        "fi",
        "m kernel",
        `if k=$(${sudo}dmesg 2>&1); then printf '%s\\n' "$k" | grep -iE 'error|fail|oom|out of memory|killed process|segfault|i/o error|panic|hung task' | tail -n 60; else echo "${UNREADABLE}dmesg $(printf '%s' "$k" | head -n 1)"; fi`,
        "m disk",
        LOCAL_DF_FUNCTION,
        "d h",
        "echo",
        "d i",
        "m memory",
        "free -m 2>/dev/null || grep -E '^(MemTotal|MemAvailable|SwapTotal|SwapFree):' /proc/meminfo",
        "m processes",
        // Without this script's own session (the sampling pipeline). busybox
        // ps has no --sort: its top prints the same columns, and the session's
        // processes are found in /proc (the command name may hold spaces and
        // parentheses: the fields after its last ") " are state, ppid, pgrp, session).
        "S=$(cut -d ' ' -f 6 /proc/$$/stat 2>/dev/null)",
        `if ps -eo sid,${PS_FIELDS} --sort=-pcpu >/dev/null 2>&1; then ps -eo sid,${PS_FIELDS} --sort=-pcpu | awk -v s="$S" 'NR == 1 || $1 != s { $1 = ""; print substr($0, 2) }' | head -n 16`,
        "else",
        "  O=$(cat /proc/[0-9]*/stat 2>/dev/null | awk -v s=\"$S\" '{ r = $0; sub(/^.*\\) /, \"\", r); split(r, f, \" \"); if (f[4] == s) printf \" %s \", $1 }')",
        // The pipeline started after the list: its processes are children of this shell (PPID column).
        "  top -b -n 1 2>/dev/null | awk -v o=\"$O\" -v p=\"$$\" 'index(o, \" \" $1 \" \") == 0 && $2 != p' | head -n 24",
        "fi",
        "m ports",
        `if command -v ss >/dev/null 2>&1; then ${sudo}ss -tulpn 2>/dev/null | head -n 80; else ${sudo}netstat -tulpn 2>/dev/null | head -n 80; fi`,
        "m end",
        ""
    ].join("\n");
}

const marker = (name: string) => `'${SECTION_MARKER}${name}'`;

export const WINDOWS_TRIAGE_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
$o=Get-CimInstance Win32_OperatingSystem
${marker("system")}
"Host: $env:COMPUTERNAME"
"$($o.Caption) $($o.Version)"
"Last boot: $($o.LastBootUpTime.ToUniversalTime().ToString('s'))Z, up $([int]([DateTime]::UtcNow-$o.LastBootUpTime.ToUniversalTime()).TotalHours) h"
if(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'){'A reboot is required (Windows Update).'}
${marker("errors")}
$e=@(Get-WinEvent -FilterHashtable @{LogName='System','Application';Level=1,2;StartTime=(Get-Date).AddHours(-1)} -MaxEvents 500)
if(-not $e.Count){'(no errors in the System and Application logs in the last hour)'}
$e|Group-Object LogName,ProviderName,Id|Sort-Object Count -Descending|Select-Object -First 40|%{$l=$_.Group[0];$m=(($l.Message+'') -replace '\\s+',' ').Trim();if(-not $m){$m='(no message text)'};if($m.Length -gt 300){$m=$m.Substring(0,300)+'...'};'{0}x {1}/{2} id {3}, {4:HH:mm:ss}-{5:HH:mm:ss} UTC: {6}' -f $_.Count,$l.LogName,$l.ProviderName,$l.Id,$_.Group[-1].TimeCreated.ToUniversalTime(),$l.TimeCreated.ToUniversalTime(),$m}
${marker("stopped")}
$s=@(Get-CimInstance Win32_Service -Filter "StartMode='Auto' AND State<>'Running'")
if(-not $s.Count){'(every automatic service is running)'}
$s|Select-Object -First 60|%{'{0} ({1}): {2}, exit code {3}' -f $_.Name,$_.DisplayName,$_.State,$_.ExitCode}
${marker("disk")}
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3'|%{if($_.Size){'{0} {1:N1} GB free of {2:N1} GB ({3:N0}% used)' -f $_.DeviceID,($_.FreeSpace/1GB),($_.Size/1GB),(100-100*$_.FreeSpace/$_.Size)}}
${marker("memory")}
'Memory: {0:N0} MB available of {1:N0} MB' -f ($o.FreePhysicalMemory/1KB),($o.TotalVisibleMemorySize/1KB)
'Paging files: {0:N0} MB free of {1:N0} MB' -f ($o.FreeSpaceInPagingFiles/1KB),($o.SizeStoredInPagingFiles/1KB)
${marker("processes")}
Get-Process|Sort-Object CPU -Descending|Select-Object -First 15|%{'{0} (pid {1}): {2:N0} s of CPU time, {3:N0} MB' -f $_.ProcessName,$_.Id,$_.CPU,($_.WorkingSet64/1MB)}
${marker("ports")}
$p=@{};Get-Process|%{$p[$_.Id]=$_.ProcessName}
if(Get-Command Get-NetTCPConnection -EA 0){Get-NetTCPConnection -State Listen|Sort-Object LocalPort,LocalAddress|Select-Object -First 80|%{$a=$_.LocalAddress;if($a -like '*:*'){$a="[$a]"};'tcp {0}:{1} pid {2} {3}' -f $a,$_.LocalPort,$_.OwningProcess,$p[[int]$_.OwningProcess]}}else{netstat -ano -p tcp|Select-String LISTENING|Select-Object -First 80|%{$_.Line.Trim()}}
${marker("end")}
`;

// The pack of an account that is not an administrator, which over SSH may
// not use WMI, list the services, read the processor time of another
// account's process nor (unless it is a member of Event Log Readers) the
// event logs: the system facts come from WINDOWS_FALLBACK_FACTS, the logs and
// the services are reported unreadable when they are, the processes are
// sorted by memory, and the ports come from netstat (Get-NetTCPConnection is
// WMI), whose listening TCP lines have a foreign port of 0 in any language.
export const WINDOWS_LIMITED_TRIAGE_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$ProgressPreference='SilentlyContinue'
${WINDOWS_FALLBACK_FACTS}
${marker("system")}
"Host: $env:COMPUTERNAME"
"$os $ver"
"Last boot: $([DateTime]::UtcNow.AddSeconds(-$up).ToString('s'))Z, up $([int]($up/3600)) h"
if(Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'){'A reboot is required (Windows Update).'}
${marker("errors")}
$lg=@('System','Application'|?{try{$null=Get-WinEvent -LogName $_ -MaxEvents 1 -ErrorAction Stop;$true}catch [UnauthorizedAccessException]{$false}catch{$true}})
if(-not $lg.Count){'${UNREADABLE}eventlog'}else{if($lg.Count -lt 2){"(The login user may read the $($lg[0]) log only.)"}
$e=@(Get-WinEvent -FilterHashtable @{LogName=$lg;Level=1,2;StartTime=(Get-Date).AddHours(-1)} -MaxEvents 500)
if(-not $e.Count){"(no errors in the $($lg -join ' and ') logs in the last hour)"}
$e|Group-Object LogName,ProviderName,Id|Sort-Object Count -Descending|Select-Object -First 40|%{$l=$_.Group[0];$m=(($l.Message+'') -replace '\\s+',' ').Trim();if(-not $m){$m='(no message text)'};if($m.Length -gt 300){$m=$m.Substring(0,300)+'...'};'{0}x {1}/{2} id {3}, {4:HH:mm:ss}-{5:HH:mm:ss} UTC: {6}' -f $_.Count,$l.LogName,$l.ProviderName,$l.Id,$_.Group[-1].TimeCreated.ToUniversalTime(),$l.TimeCreated.ToUniversalTime(),$m}}
${marker("stopped")}
$x=$null;$s=@(Get-Service -ErrorVariable x)
if(-not $s.Count -and $x){'${UNREADABLE}services'}else{$s=@($s|?{$_.StartType -eq 'Automatic' -and $_.Status -ne 'Running'})
if(-not $s.Count){'(every automatic service is running)'}
$s|Select-Object -First 60|%{'{0} ({1}): {2}' -f $_.Name,$_.DisplayName,$_.Status}}
${marker("disk")}
$d|%{if($_.s){'{0} {1:N1} GB free of {2:N1} GB ({3:N0}% used)' -f $_.n,($_.f/1GB),($_.s/1GB),(100-100*$_.f/$_.s)}}
${marker("memory")}
'Memory: {0:N0} MB available of {1:N0} MB' -f ($mem.f/1KB),($mem.t/1KB)
${marker("processes")}
'(By memory: the processor time of other accounts is not readable.)'
Get-Process|Sort-Object WorkingSet64 -Descending|Select-Object -First 15|%{'{0} (pid {1}): {2:N0} MB' -f $_.ProcessName,$_.Id,($_.WorkingSet64/1MB)}
${marker("ports")}
$p=@{};Get-Process|%{$p[$_.Id]=$_.ProcessName}
netstat -ano|%{$f=$_.Trim() -split '\\s+';if($f[0] -eq 'TCP' -and $f[2] -match ':0$'){'tcp {0} pid {1} {2}' -f $f[1],$f[4],$p[[int]$f[4]]}}|Select-Object -First 80
${marker("end")}
`;

// `limited`: the output of WINDOWS_LIMITED_TRIAGE_SCRIPT.
export function parseTriage(platform: "linux" | "windows", output: string, limited = false): ChatEvidenceSection[] {
    const sections = parseSections(output);
    const parts = platform === "windows" ? (limited ? WINDOWS_LIMITED_PARTS : WINDOWS_PARTS) : LINUX_PARTS;
    return parts.map((part) => {
        const base = { id: part.id, title: part.title, source: part.source };
        const text = sections.get(part.marker);
        if (text === undefined) return { ...base, text: "(not reported: the script stopped before this part)", failed: true };
        if (text.startsWith(UNREADABLE)) return failedSection(base, new AppError("OPS_PERMISSION_DENIED", unreadableReason(text.slice(UNREADABLE.length).split("\n")[0].trim()), 403));
        const body = text.trim() || "(nothing found)";
        return part.log ? logSection(base, body, part.maxChars) : textSection(base, body, part.maxChars);
    });
}

export async function triageEvidence(ctx: EvidenceContext): Promise<ChatEvidenceSection[]> {
    const { lease, caps, signal } = ctx;
    const windows = caps.platform === "windows";
    const options = { timeoutMs: windows ? EVIDENCE_COMMAND_TIMEOUT_MS.windows : EVIDENCE_COMMAND_TIMEOUT_MS.linux, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES };
    // Windows: the capabilities tell whether the user is an administrator.
    const limited = windows && caps.root === false;
    const result = windows
        ? await runPowerShell(lease, limited ? WINDOWS_LIMITED_TRIAGE_SCRIPT : WINDOWS_TRIAGE_SCRIPT, options)
        : await runPosixScript(lease, linuxTriageScript(caps), options);
    if (!result.stdout.includes(SECTION_MARKER)) {
        const reason = cleanStderr(result.stderr) || result.stdout.trim() || "the script printed nothing";
        throw new AppError("OPS_COMMAND_FAILED", `The triage script did not run: ${reason.slice(0, 500)}`, 502, { exitCode: result.code });
    }
    return parseTriage(windows ? "windows" : "linux", result.stdout, limited);
}
