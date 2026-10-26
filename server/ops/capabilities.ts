import type { OpsCapabilities, OpsPlatform } from "../../shared/ops";
import type { SshLease } from "../ssh/pool";
import { POSIX_SECTION_FUNCTION, asString, extractJson, isRecord, parseSections, runPosixScript, runPowerShell } from "./remote";

// What a server offers to the operations panels: systemd and the journal,
// a container engine (Docker, else Podman) and whether privileged commands
// can run through passwordless sudo. Detected with one script and cached per
// connection settings for a few minutes.

const CAPABILITIES_TTL_MS = 5 * 60_000;
const DETECT_TIMEOUT_MS = 20_000;

const DOCKER_VERSION = "version --format '{{.Server.Version}}'";

export const LINUX_CAPABILITIES_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    POSIX_SECTION_FUNCTION,
    "u=$(id -u 2>/dev/null)",
    "s=",
    "if [ \"$u\" != 0 ] && command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then s=yes; fi",
    "m uid",
    "echo \"$u\"",
    "m sudo",
    "echo \"$s\"",
    "m systemd",
    "if [ -d /run/systemd/system ] && command -v systemctl >/dev/null 2>&1; then echo yes; fi",
    "m journal",
    "if command -v journalctl >/dev/null 2>&1; then echo yes; fi",
    "D=",
    "m docker",
    // A failed sudo attempt must not replace Docker's own error in $v.
    "if command -v docker >/dev/null 2>&1; then",
    `  if v=$(docker ${DOCKER_VERSION} 2>&1); then D=docker; echo "ok $v"`,
    `  elif [ -n "$s" ] && sv=$(sudo -n docker ${DOCKER_VERSION} 2>/dev/null); then D="sudo -n docker"; echo "sudo $sv"`,
    "  else echo \"error $v\" | head -n 2; fi",
    "fi",
    "m podman",
    "if [ -z \"$D\" ] && command -v podman >/dev/null 2>&1; then",
    "  if v=$(podman version --format '{{.Version}}' 2>&1); then D=podman; echo \"ok $v\"; else echo \"error $v\" | head -n 2; fi",
    "fi",
    "m compose",
    "if [ -n \"$D\" ] && [ \"$D\" != podman ] && $D compose version >/dev/null 2>&1; then echo yes; fi",
    "m end",
    ""
].join("\n");

export const WINDOWS_CAPABILITIES_SCRIPT = `
$ErrorActionPreference='SilentlyContinue'
$r=@{admin=$null;docker=$null;compose=$false}
try{$id=[Security.Principal.WindowsIdentity]::GetCurrent();$r.admin=(New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)}catch{}
if(Get-Command docker -EA 0){$v=(docker ${DOCKER_VERSION} 2>&1|Out-String).Trim();if($LASTEXITCODE -eq 0){$r.docker="ok $v";docker compose version 2>$null|Out-Null;$r.compose=($LASTEXITCODE -eq 0)}else{$r.docker="error $v"}}
$r|ConvertTo-Json -Compress
`;

function engineState(raw: string | undefined): { ok: boolean; sudo: boolean; version: string | null; problem: string | null } | null {
    const line = (raw ?? "").trim();
    if (!line) return null;
    const match = /^(ok|sudo|error)\s?([\s\S]*)$/.exec(line);
    if (!match) return null;
    const detail = match[2].trim();
    if (match[1] === "error") return { ok: false, sudo: false, version: null, problem: detail || "The engine did not answer." };
    return { ok: true, sudo: match[1] === "sudo", version: detail || null, problem: null };
}

export function parseLinuxCapabilities(output: string, detectedAt = Date.now()): OpsCapabilities {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new Error("The capability check was cut off before it finished.");
    const yes = (name: string) => sections.get(name)?.trim() === "yes";
    const docker = engineState(sections.get("docker"));
    const podman = engineState(sections.get("podman"));
    const engine = docker?.ok ? "docker" : podman?.ok ? "podman" : null;
    const chosen = engine === "docker" ? docker : engine === "podman" ? podman : null;
    const problem = chosen ? null : docker?.problem ?? podman?.problem ?? "Neither Docker nor Podman is installed.";

    return {
        platform: "linux",
        root: sections.get("uid")?.trim() === "0",
        sudo: yes("sudo"),
        systemd: yes("systemd"),
        journal: yes("journal"),
        containers: {
            engine,
            version: chosen?.version ?? null,
            sudo: chosen?.sudo ?? false,
            compose: engine === "docker" && yes("compose"),
            problem
        },
        detectedAt
    };
}

export function parseWindowsCapabilities(output: string, detectedAt = Date.now()): OpsCapabilities {
    const report = extractJson(output);
    if (!isRecord(report)) throw new Error("The Windows capability check returned no data.");
    const docker = engineState(asString(report.docker));
    return {
        platform: "windows",
        root: typeof report.admin === "boolean" ? report.admin : null,
        sudo: false,
        systemd: false,
        journal: false,
        containers: {
            engine: docker?.ok ? "docker" : null,
            version: docker?.ok ? docker.version : null,
            sudo: false,
            compose: Boolean(docker?.ok && report.compose === true),
            problem: docker?.ok ? null : docker?.problem ?? "Docker is not installed."
        },
        detectedAt
    };
}

type CacheEntry = { version: string; value: OpsCapabilities };
const cache = new Map<number, CacheEntry>();

export async function detectCapabilities(lease: SshLease, platform: OpsPlatform, signal?: AbortSignal): Promise<OpsCapabilities> {
    const options = { timeoutMs: DETECT_TIMEOUT_MS, signal };
    if (platform === "windows") {
        const result = await runPowerShell(lease, WINDOWS_CAPABILITIES_SCRIPT, options);
        return parseWindowsCapabilities(result.stdout);
    }
    const result = await runPosixScript(lease, LINUX_CAPABILITIES_SCRIPT, options);
    return parseLinuxCapabilities(result.stdout);
}

// Cached per server and connection settings (an edited server is detected again).
export async function getCapabilities(
    lease: SshLease,
    platform: OpsPlatform,
    options: { refresh?: boolean; signal?: AbortSignal } = {}
): Promise<OpsCapabilities> {
    const cached = cache.get(lease.serverId);
    const fresh = cached && cached.version === lease.target.version && Date.now() - cached.value.detectedAt < CAPABILITIES_TTL_MS;
    if (cached && fresh && !options.refresh) return cached.value;
    const value = await detectCapabilities(lease, platform, options.signal);
    cache.set(lease.serverId, { version: lease.target.version, value });
    return value;
}
