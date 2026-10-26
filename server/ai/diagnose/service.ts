import type { ChatEvidenceSection } from "../../../shared/chat";
import { normalizeUnitName, type ServiceDetail } from "../../../shared/ops";
import { AppError } from "../../errors";
import { commandFailure, psQuote, runPowerShell } from "../../ops/remote";
import { readJournal, requireServiceName, serviceDetail } from "../../ops/services";
import { EVIDENCE_COMMAND_TIMEOUT_MS, EVIDENCE_OUTPUT_MAX_BYTES, EVIDENCE_LOG_LINES, type EvidenceContext } from "./context";
import { WINDOWS_EVENTLOG_DENIED_REASON, attempt, logSection, readableJournal, textSection } from "./sections";

// A service's evidence: its state as the init system reports it, and what it
// logged. Linux: `systemctl status` and its properties, plus the last lines
// of its journal. Windows: the Win32_Service record, plus the Service Control
// Manager events about it (start failures, unexpected stops).

const STATUS_CHARS = 6000;
const JOURNAL_CHARS = 14_000;
const EVENTS_CHARS = 8000;
const MAX_EVENTS = 40;

function linuxStatusText(detail: ServiceDetail): string {
    const properties = Object.entries(detail.properties)
        .filter(([, value]) => value !== "" && value !== "[not set]")
        .map(([key, value]) => `${key}=${value}`);
    return [detail.statusText ?? "", properties.length ? `Properties:\n${properties.join("\n")}` : ""].filter(Boolean).join("\n\n");
}

function windowsStatusText(detail: ServiceDetail): string {
    const lines = Object.entries(detail.properties).map(([key, value]) => `${key}: ${value}`);
    if (detail.dependents?.length) lines.push(`Running services that depend on it: ${detail.dependents.join(", ")}`);
    return lines.join("\n");
}

// Service Control Manager events of the last week that name the service (by
// its name or its display name, which is what the messages use), oldest
// first, one line each. The display name comes from the server: both names
// are quoted (psQuote), and the display name kept to one line.
export function windowsServiceEventsScript(name: string, displayName: string): string {
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    const display = displayName.replace(/[\0-\x1f\x7f]+/g, " ").trim().slice(0, 256) || name;
    return `
$ErrorActionPreference='SilentlyContinue'
$n=${psQuote(name)};$d=${psQuote(display)}
try{$null=Get-WinEvent -LogName System -MaxEvents 1 -ErrorAction Stop}catch [UnauthorizedAccessException]{exit 5}catch{}
$ev=@(Get-WinEvent -FilterHashtable @{LogName='System';ProviderName='Service Control Manager';StartTime=(Get-Date).AddDays(-7)} -MaxEvents 3000|?{$_.Message -and ($_.Message.Contains($d) -or $_.Message.Contains($n))}|Select-Object -First ${MAX_EVENTS})
if(-not $ev.Count){'(no Service Control Manager events about this service in the last 7 days)';exit 0}
[array]::Reverse($ev)
$ev|%{$m=($_.Message -replace '\\s+',' ').Trim();if($m.Length -gt 300){$m=$m.Substring(0,300)+'...'};'{0:yyyy-MM-ddTHH:mm:ssZ} id {1} {2}: {3}' -f $_.TimeCreated.ToUniversalTime(),$_.Id,$_.LevelDisplayName,$m}
`;
}

export async function serviceEvidence(ctx: EvidenceContext, name: string): Promise<ChatEvidenceSection[]> {
    const { lease, caps, signal } = ctx;
    const windows = caps.platform === "windows";
    const unit = requireServiceName(caps.platform, windows ? name : normalizeUnitName(name));

    let displayName = unit;
    // An account that is not an administrator reads Get-Service and the registry instead (see windowsDetailScript).
    const windowsSource = caps.root === false ? `Get-Service ${unit} and its registry key` : `Get-CimInstance Win32_Service (${unit})`;
    const statusBase = { id: "service" as const, title: "Service status", source: windows ? windowsSource : `systemctl status ${unit}` };
    const status = await attempt(statusBase, signal, async () => {
        const detail = await serviceDetail(lease, caps, unit, signal);
        displayName = detail.properties.DisplayName || unit;
        return textSection(statusBase, windows ? windowsStatusText(detail) : linuxStatusText(detail), STATUS_CHARS);
    });

    if (windows) {
        const base = { id: "events" as const, title: "Service Control Manager events (last 7 days)", source: "Get-WinEvent -LogName System -ProviderName 'Service Control Manager'" };
        const events = await attempt(base, signal, async () => {
            const result = await runPowerShell(lease, windowsServiceEventsScript(unit, displayName), { timeoutMs: EVIDENCE_COMMAND_TIMEOUT_MS.windows, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
            if (result.code === 5) throw new AppError("OPS_PERMISSION_DENIED", WINDOWS_EVENTLOG_DENIED_REASON, 403);
            if (result.code !== 0 && !result.stdout.trim()) throw commandFailure(result, "Get-WinEvent failed");
            return logSection(base, result.stdout, EVENTS_CHARS);
        });
        return [status, events];
    }

    if (!caps.journal) return [status];
    const base = { id: "journal" as const, title: `Journal of ${unit} (last ${EVIDENCE_LOG_LINES} lines)`, source: `journalctl -u ${unit} -n ${EVIDENCE_LOG_LINES}` };
    const journal = await attempt(base, signal, async () => logSection(base, readableJournal(await readJournal(lease, caps, unit, EVIDENCE_LOG_LINES, signal)), JOURNAL_CHARS));
    return [status, journal];
}
