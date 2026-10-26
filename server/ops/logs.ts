import {
    LOG_BACKLOG_LINES,
    isValidLogPath,
    normalizeUnitName,
    type ComposeLogSource,
    type LogSource,
    type LogStreamSource,
    type OpsCapabilities
} from "../../shared/ops";
import { parsePodLogSource } from "../k8s/validate";
import type { SshLease } from "../ssh/pool";
import { composeLogCommand } from "./compose";
import { engineCommand, requireContainerRef, requireEngine } from "./containers";
import { powershellStream, psQuote, shellQuote, windowsArgument } from "./remote";
import { InvalidOpsInputError, OpsUnsupportedError, privileged, requireServiceName } from "./services";

// Commands of the live log panel. They run until stopped, so on Linux each
// one sits behind a small watchdog: the command reads nothing from stdin, and
// a helper waits for stdin to close (the channel was closed) and then kills
// it. A `tail -F` of a quiet file would otherwise linger on the server until
// its next write. The script is a single line passed to `sh -c`, which every
// login shell (bash, zsh, fish, csh) hands over unchanged.

export function withWatchdog(command: string): string {
    const script = `exec 3<&0; ${command} </dev/null 2>&1 & p=$!; { read -r _ <&3; kill $p 2>/dev/null; } & w=$!; wait $p; r=$?; kill $w 2>/dev/null; exit $r`;
    return `sh -c ${shellQuote(script)}`;
}

// "~/x" is the login user's home (also under sudo -n, which keeps the caller's
// expansion); only the validated rest of the path is quoted.
function posixPathArgument(path: string): string {
    return path.startsWith("~/") ? `"$HOME"/${shellQuote(path.slice(2))}` : shellQuote(path);
}

function linuxLogCommand(caps: OpsCapabilities, source: LogSource): string {
    switch (source.kind) {
        case "journal": {
            if (!caps.journal) throw new OpsUnsupportedError("This server has no systemd journal.");
            const unit = source.unit ? ` -u ${shellQuote(requireServiceName("linux", source.unit))}` : "";
            return `${privileged(caps)}journalctl -f -n ${LOG_BACKLOG_LINES} --no-pager -o short-iso${unit}`;
        }
        case "file":
            if (!isValidLogPath("linux", source.path)) throw new InvalidOpsInputError("Enter an absolute file path (for example /var/log/syslog or ~/logs/app.log).");
            return `${privileged(caps)}tail -n ${LOG_BACKLOG_LINES} -F -- ${posixPathArgument(source.path)}`;
        case "container":
            return engineCommand(requireEngine(caps), ["logs", "-f", "--tail", String(LOG_BACKLOG_LINES), "--timestamps", requireContainerRef(source.container)]);
    }
}

// Windows has no `sh` for the watchdog, and the OpenSSH server may end only
// its direct child (cmd.exe) when the channel closes: the script watches its
// own stdin instead (the script itself arrives there, see powershellStream)
// and ends what it started once stdin closes. Errors go to stdout, as the
// -EncodedCommand fallback turns PowerShell's own stderr into CLIXML.
// [Console]::In would block (it is synchronous in .NET Framework), hence the
// raw stream's ReadAsync.
const WINDOWS_STDIN_WATCH = "$i=[Console]::OpenStandardInput();$e=$i.ReadAsync([byte[]]::new(64),0,64)";

// Get-Content -Wait runs in a second runspace; the main one stops it when
// stdin closes ([Environment]::Exit would deadlock on the running pipeline).
export function windowsFileLogScript(path: string): string {
    return `
$ProgressPreference='SilentlyContinue'
$r=[hashtable]::Synchronized(@{c=0})
$f={param($o,$r)
try{Get-Content -LiteralPath ${psQuote(path)} -Wait -Tail ${LOG_BACKLOG_LINES} -ErrorAction Stop|%{$o.WriteLine($_)}}catch{$o.WriteLine($_.Exception.Message);$r.c=1}}
$w=[PowerShell]::Create().AddScript($f).AddArgument([Console]::Out).AddArgument($r)
$h=$w.BeginInvoke()
${WINDOWS_STDIN_WATCH}
while(-not $h.IsCompleted -and -not $e.IsCompleted){[Threading.Thread]::Sleep(200)}
if(-not $h.IsCompleted){$w.Stop();exit 0}
exit $r.c
`;
}

// The engine runs as a child process writing straight to this channel (its
// stdin is a pipe of its own); it is killed when stdin closes.
export function windowsEngineLogScript(engine: string, args: string[]): string {
    return `
$ProgressPreference='SilentlyContinue'
try{$s=[Diagnostics.ProcessStartInfo]::new(@(Get-Command ${psQuote(engine)} -CommandType Application -ErrorAction Stop)[0].Source,${psQuote(args.map(windowsArgument).join(" "))})
$s.UseShellExecute=$false;$s.RedirectStandardInput=$true
$p=[Diagnostics.Process]::Start($s)}catch{[Console]::Out.WriteLine($_.Exception.Message);exit 1}
${WINDOWS_STDIN_WATCH}
while(-not $p.WaitForExit(200)){if($e.IsCompleted){try{$p.Kill()}catch{};exit 0}}
exit $p.ExitCode
`;
}

function windowsLogScript(caps: OpsCapabilities, source: LogSource): string {
    switch (source.kind) {
        case "journal":
            throw new OpsUnsupportedError("Windows servers have no systemd journal.");
        case "file":
            if (!isValidLogPath("windows", source.path)) throw new InvalidOpsInputError("Enter an absolute file path (for example C:\\logs\\app.log).");
            return windowsFileLogScript(source.path);
        case "container": {
            const { engine } = requireEngine(caps);
            return windowsEngineLogScript(engine, ["logs", "-f", "--tail", String(LOG_BACKLOG_LINES), "--timestamps", requireContainerRef(source.container)]);
        }
    }
}

export function parseLogSource(value: unknown): LogStreamSource {
    const source = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const text = (field: unknown) => (typeof field === "string" ? field.trim() : "");
    switch (source.kind) {
        case "journal":
            return text(source.unit) ? { kind: "journal", unit: normalizeUnitName(text(source.unit)) } : { kind: "journal" };
        case "file":
            return { kind: "file", path: text(source.path) };
        case "container":
            return { kind: "container", container: text(source.container) };
        case "compose":
            return { kind: "compose", project: text(source.project), ...(text(source.service) ? { service: text(source.service) } : {}) };
        // W8-T2: a Kubernetes pod's container (validated here: names only).
        case "pod":
            return parsePodLogSource(source);
        default:
            throw new InvalidOpsInputError("Unknown log source.");
    }
}

// W7-S3: `compose logs -f` of a project, with its files looked up on the
// server first (Linux only, like the Compose view).
export async function composeLogStream(lease: SshLease, caps: OpsCapabilities, source: ComposeLogSource, signal?: AbortSignal): Promise<string> {
    return withWatchdog(await composeLogCommand(lease, caps, source, signal));
}

export type LogStreamCommand = { command: string; input?: string };

// The remote command that follows `source` (validated; throws otherwise), and
// on Windows what it reads on stdin, which then stays open.
export function logStreamCommand(caps: OpsCapabilities, source: LogSource): LogStreamCommand {
    if (caps.platform === "windows") return powershellStream(windowsLogScript(caps, source));
    return { command: withWatchdog(linuxLogCommand(caps, source)) };
}
