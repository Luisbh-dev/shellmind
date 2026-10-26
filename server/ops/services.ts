import {
    LINUX_SERVICE_ACTIONS,
    WINDOWS_SERVICE_ACTIONS,
    isValidServiceName,
    type OpsCapabilities,
    type OpsPlatform,
    type ServiceAction,
    type ServiceDetail,
    type ServiceInfo,
    type ServicesList
} from "../../shared/ops";
import { AppError } from "../errors";
import type { SshLease } from "../ssh/pool";
import type { PreparedAction } from "./actions";
import {
    POSIX_SECTION_FUNCTION,
    asString,
    commandFailure,
    ensureArray,
    extractJson,
    isRecord,
    parseSections,
    psQuote,
    runPosixScript,
    runPowerShell,
    shellQuote
} from "./remote";

// systemd services (Linux) and Windows services. Unit names are validated
// before they reach a command; privileged commands go through `sudo -n` when
// the login user is not root but may use sudo without a password.

const LIST_TIMEOUT_MS = 20_000;
const DETAIL_TIMEOUT_MS = 15_000;
// Stopping or restarting a service can take a while (stop timeouts).
const ACTION_TIMEOUT_MS = 90_000;

const JOURNAL_MAX_LINES = 1000;

export class InvalidOpsInputError extends AppError {
    constructor(message: string) {
        super("OPS_INVALID_INPUT", message, 400);
        this.name = "InvalidOpsInputError";
    }
}

export class OpsUnsupportedError extends AppError {
    constructor(message: string) {
        super("OPS_UNSUPPORTED", message, 409);
        this.name = "OpsUnsupportedError";
    }
}

export function requireServiceName(platform: OpsPlatform, name: string): string {
    if (!isValidServiceName(platform, name)) throw new InvalidOpsInputError(`"${name.slice(0, 80)}" is not a valid service name.`);
    return name;
}

function requireSystemd(caps: OpsCapabilities): void {
    if (caps.platform === "linux" && !caps.systemd) throw new OpsUnsupportedError("This server does not run systemd.");
}

// `sudo -n ` for a non-root user with passwordless sudo, else nothing.
export function privileged(caps: OpsCapabilities): string {
    return caps.platform === "linux" && caps.root === false && caps.sudo ? "sudo -n " : "";
}

export const LIST_SERVICES_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    POSIX_SECTION_FUNCTION,
    "m units",
    "systemctl list-units --type=service --all --no-legend --no-pager --plain 2>&1",
    "m files",
    "systemctl list-unit-files --type=service --no-legend --no-pager 2>&1",
    "m end",
    ""
].join("\n");

// `systemctl list-units` rows (UNIT LOAD ACTIVE SUB DESCRIPTION) merged with
// the unit files, so services that are installed but not loaded (disabled
// and stopped) can be started too. Templates (foo@.service) cannot run as is.
export function parseSystemdServices(output: string): ServiceInfo[] {
    const sections = parseSections(output);
    const services = new Map<string, ServiceInfo>();
    for (const line of (sections.get("units") ?? "").split("\n")) {
        const match = /^[●*\s]*(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
        if (!match) continue;
        const [, name, load, active, sub, description] = match;
        services.set(name, { name, description: description.trim(), load, active, sub, startup: null });
    }
    for (const line of (sections.get("files") ?? "").split("\n")) {
        const match = /^(\S+\.service)\s+(\S+)/.exec(line.trim());
        if (!match) continue;
        const [, name, state] = match;
        const known = services.get(name);
        if (known) known.startup = state;
        else if (!name.endsWith("@.service")) services.set(name, { name, description: "", load: null, active: "inactive", sub: "dead", startup: state });
    }
    return [...services.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Over SSH Windows lets only administrators list the services ("Cannot open
// Service Control Manager"): another account asks for each service the
// registry names, and gets those it may query.
export const WINDOWS_LIST_SERVICES_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$e=$null;$s=@(Get-Service -ErrorVariable e);$l=$false
if(-not $s.Count -and $e){$l=$true;$s=@(Get-Service -Name @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Services'|?{($_.GetValue('Type') -band 0x30) -ne 0}|%{$_.PSChildName}))}
@{limited=$l;services=@($s|%{@{n=$_.Name;d=$_.DisplayName;s=[string]$_.Status;t=[string]$_.StartType}})}|ConvertTo-Json -Compress -Depth 3
`;

const WINDOWS_ACTIVE: Record<string, string> = {
    Running: "active",
    Stopped: "inactive",
    StartPending: "activating",
    StopPending: "deactivating",
    ContinuePending: "activating",
    PausePending: "deactivating",
    Paused: "inactive"
};

export function parseWindowsServices(output: string): ServicesList {
    const report = extractJson(output);
    const services = ensureArray(isRecord(report) ? report.services : null).filter(isRecord).flatMap((item) => {
        const name = asString(item.n);
        if (!name) return [];
        const status = asString(item.s);
        return [{
            name,
            description: asString(item.d),
            load: null,
            active: WINDOWS_ACTIVE[status] ?? status.toLowerCase(),
            sub: status,
            startup: asString(item.t) || null
        }];
    }).sort((a, b) => a.name.localeCompare(b.name));
    return isRecord(report) && report.limited === true ? { services, limited: true } : { services };
}

export async function listServices(lease: SshLease, caps: OpsCapabilities, signal?: AbortSignal): Promise<ServicesList> {
    const options = { timeoutMs: LIST_TIMEOUT_MS, signal };
    if (caps.platform === "windows") {
        const result = await runPowerShell(lease, WINDOWS_LIST_SERVICES_SCRIPT, options);
        if (result.code !== 0 && !result.stdout.trim()) throw commandFailure(result, "Get-Service failed");
        return parseWindowsServices(result.stdout);
    }
    requireSystemd(caps);
    const result = await runPosixScript(lease, LIST_SERVICES_SCRIPT, options);
    const services = parseSystemdServices(result.stdout);
    if (services.length === 0 && result.code !== 0) throw commandFailure(result, "systemctl failed");
    return { services };
}

const SHOWN_PROPERTIES = [
    "Id", "Description", "LoadState", "ActiveState", "SubState", "UnitFileState", "MainPID", "ExecMainStartTimestamp",
    "ActiveEnterTimestamp", "InactiveEnterTimestamp", "MemoryCurrent", "TasksCurrent", "NRestarts", "Restart", "User", "FragmentPath"
];

export function systemdDetailScript(unit: string): string {
    const quoted = shellQuote(unit);
    return [
        "LC_ALL=C",
        "export LC_ALL",
        POSIX_SECTION_FUNCTION,
        "m show",
        `systemctl show --no-pager ${SHOWN_PROPERTIES.map((name) => `-p ${name}`).join(" ")} -- ${quoted} 2>&1`,
        "m status",
        `systemctl status --no-pager --full -n 0 -- ${quoted} 2>&1`,
        "m end",
        ""
    ].join("\n");
}

export function parseSystemdDetail(name: string, output: string): ServiceDetail {
    const sections = parseSections(output);
    const properties: Record<string, string> = {};
    for (const line of (sections.get("show") ?? "").split("\n")) {
        const index = line.indexOf("=");
        if (index > 0) properties[line.slice(0, index)] = line.slice(index + 1);
    }
    return { name, properties, statusText: sections.get("status") || null };
}

// The service's registry key (readable by any account), as a PowerShell expression.
const serviceKey = (name: string) => `('HKLM:\\SYSTEM\\CurrentControlSet\\Services\\'+${psQuote(name)})`;

// Also lists the running services that depend on this one: stopping or
// restarting it stops them too. WMI (Win32_Service) is for administrators
// only over SSH (see WINDOWS_SYSTEM_FACTS): another account reads what the
// service manager tells it and the service's registry key, without the
// process id and the exit code. A service in the registry it may not
// query exits 5, one that does not exist exits 4.
export function windowsDetailScript(name: string): string {
    return `
$ErrorActionPreference='SilentlyContinue'
$s=$null;if(([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(544)){$s=Get-CimInstance Win32_Service -Filter ${psQuote(`Name='${name}'`)}}
$g=Get-Service -Name ${psQuote(name)}
$dep=@($g|%{$_.DependentServices}|?{$_.Status -eq 'Running'}|%{$_.Name})
if($s){@{Name=$s.Name;DisplayName=$s.DisplayName;State=$s.State;Status=$s.Status;StartMode=$s.StartMode;DelayedAutoStart=[string]$s.DelayedAutoStart;ProcessId=[string]$s.ProcessId;StartName=$s.StartName;PathName=$s.PathName;Description=$s.Description;ExitCode=[string]$s.ExitCode;Dependents=$dep}|ConvertTo-Json -Compress;exit 0}
$k=Get-ItemProperty ${serviceKey(name)}
if(-not $g){if($k){exit 5};[Console]::Error.WriteLine('Service not found');exit 4}
$m=@{0='Boot';1='System';2='Auto';3='Manual';4='Disabled'}[[int]$k.Start]
$t=[string]$k.Description;if($t.StartsWith('@')){$t=$null}
@{Name=$g.Name;DisplayName=$g.DisplayName;State=[string]$g.Status;StartMode=$m;DelayedAutoStart=[string]($k.DelayedAutostart -eq 1);StartName=$k.ObjectName;PathName=$k.ImagePath;Description=$t;Dependents=$dep}|ConvertTo-Json -Compress
`;
}

// Over SSH Windows lets an account that is not an administrator query only
// some services, and manage hardly any.
const SERVICE_DENIED = "Access is denied: over SSH Windows lets only administrators query or manage most services.";

export function parseWindowsDetail(name: string, output: string): ServiceDetail {
    const report = extractJson(output);
    const properties: Record<string, string> = {};
    let dependents: string[] = [];
    if (isRecord(report)) {
        for (const [key, value] of Object.entries(report)) {
            if (key === "Dependents") {
                dependents = ensureArray(value).map(asString).filter(Boolean);
                continue;
            }
            const text = asString(value);
            if (text) properties[key] = text;
        }
    }
    return { name, properties, statusText: null, dependents };
}

export async function serviceDetail(lease: SshLease, caps: OpsCapabilities, name: string, signal?: AbortSignal): Promise<ServiceDetail> {
    requireServiceName(caps.platform, name);
    const options = { timeoutMs: DETAIL_TIMEOUT_MS, signal };
    if (caps.platform === "windows") {
        const result = await runPowerShell(lease, windowsDetailScript(name), options);
        if (result.code === 4) throw new AppError("OPS_NOT_FOUND", `Service "${name}" does not exist.`, 404);
        if (result.code === 5) throw new AppError("OPS_PERMISSION_DENIED", SERVICE_DENIED, 403, { exitCode: 5 });
        if (result.code !== 0) throw commandFailure(result, "Get-CimInstance failed");
        return parseWindowsDetail(name, result.stdout);
    }
    requireSystemd(caps);
    const result = await runPosixScript(lease, systemdDetailScript(name), options);
    return parseSystemdDetail(name, result.stdout);
}

function isServiceAction(platform: OpsPlatform, action: string): action is ServiceAction {
    const allowed: readonly string[] = platform === "windows" ? WINDOWS_SERVICE_ACTIONS : LINUX_SERVICE_ACTIONS;
    return allowed.includes(action);
}

// -Force: without it a service that others depend on cannot be stopped or
// restarted at all (the UI names the dependents in its confirmation).
const WINDOWS_CMDLETS: Record<string, string> = { start: "Start-Service", stop: "Stop-Service -Force", restart: "Restart-Service -Force" };

// Runs `command` (a service cmdlet) and prints why it failed: the message
// with its innermost cause ("Access is denied"), and for a service the user
// may not even see, that it is denied, not missing.
export function windowsActionScript(name: string, command: string): string {
    return `
$ErrorActionPreference='Stop'
try{${command};exit 0}catch{$m=$_.Exception.Message;$i=$_.Exception;while($i.InnerException){$i=$i.InnerException};if(-not $m.Contains($i.Message)){$m+=' '+$i.Message}
if(-not (Get-Service -Name ${psQuote(name)} -EA 0) -and (Test-Path ${serviceKey(name)})){$m=${psQuote(SERVICE_DENIED)}}
[Console]::Error.WriteLine($m);exit 1}
`;
}

// The command an action runs (as the audit log shows it) and how to run it.
export function prepareServiceAction(caps: OpsCapabilities, name: string, action: string): PreparedAction {
    requireServiceName(caps.platform, name);
    if (!isServiceAction(caps.platform, action)) throw new InvalidOpsInputError(`"${action.slice(0, 40)}" is not a service action here.`);
    requireSystemd(caps);
    const meta = { kind: "service" as const, action, target: name };
    if (caps.platform === "windows") {
        const display = `${WINDOWS_CMDLETS[action]} -Name ${psQuote(name)}`;
        const script = windowsActionScript(name, display);
        return { display, meta, run: (lease, signal) => runPowerShell(lease, script, { timeoutMs: ACTION_TIMEOUT_MS, signal }) };
    }
    const display = `${privileged(caps)}systemctl --no-ask-password ${action} -- ${shellQuote(name)}`;
    return { display, meta, run: (lease, signal) => runPosixScript(lease, `${display}\n`, { timeoutMs: ACTION_TIMEOUT_MS, signal }) };
}

export function journalCommand(caps: OpsCapabilities, unit: string, lines: number): string {
    return `${privileged(caps)}journalctl -u ${shellQuote(unit)} -n ${lines} --no-pager -o short-iso 2>&1`;
}

export async function readJournal(lease: SshLease, caps: OpsCapabilities, unit: string, lines: number, signal?: AbortSignal): Promise<string> {
    if (caps.platform === "windows" || !caps.journal) throw new OpsUnsupportedError("This server has no systemd journal.");
    requireServiceName(caps.platform, unit);
    const count = Math.min(Math.max(Math.floor(lines) || 200, 1), JOURNAL_MAX_LINES);
    const result = await runPosixScript(lease, `${journalCommand(caps, unit, count)}\n`, { timeoutMs: LIST_TIMEOUT_MS, signal });
    if (result.code !== 0 && !result.stdout.trim()) throw commandFailure(result, "journalctl failed");
    return result.stdout;
}
