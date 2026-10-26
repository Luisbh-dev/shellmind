import type { DiskAccess } from "../../shared/disk";
import type { OpsCapabilities } from "../../shared/ops";
import { AppError } from "../errors";
import { runPosixScript, runPowerShell, type RunOptions } from "../ops/remote";
import { exec, type ExecResult } from "../ssh/exec";
import type { SshLease } from "../ssh/pool";

// How the disk toolkit runs its commands. Reads run elevated when they can
// (root, or the whole script through `sudo -n sh -s`), so the explorer sees
// every folder; without that they run as the login user and report what they
// could not read. Cleanups and the release of deleted files need elevation:
// root or passwordless sudo on Linux, an administrator on Windows. Nothing
// ever asks for a password.

type Leased = Pick<SshLease, "client">;

export function isElevated(caps: OpsCapabilities): boolean {
    return caps.platform === "windows" ? caps.root === true : caps.root === true || caps.sudo;
}

export function diskAccess(caps: OpsCapabilities, user: string): DiskAccess {
    return { platform: caps.platform, user, root: caps.root, sudo: caps.sudo, elevated: isElevated(caps) };
}

// `sudo -n ` when the login user is not root but may use sudo without a
// password (what a command runs through, as the audit log shows it).
export function sudoPrefix(caps: OpsCapabilities): string {
    return caps.platform === "linux" && caps.root !== true && caps.sudo ? "sudo -n " : "";
}

export const NOT_ELEVATED_MESSAGE = {
    linux: "This needs root: log in as root, or as a user that may run sudo without a password (sudo -n). ShellMind never types a sudo password.",
    windows: "This needs an administrator: log in to the server's OpenSSH as a member of the Administrators group."
} as const;

export function requireElevated(caps: OpsCapabilities): void {
    if (!isElevated(caps)) throw new AppError("OPS_PERMISSION_DENIED", NOT_ELEVATED_MESSAGE[caps.platform], 403);
}

// A POSIX script as root when possible (as the login user otherwise); a
// PowerShell script in the login session (elevated for an administrator).
export function runDiskScript(lease: Leased, caps: OpsCapabilities, script: string, options: RunOptions): Promise<ExecResult> {
    if (caps.platform === "windows") return runPowerShell(lease, script, options);
    if (sudoPrefix(caps)) return exec(lease, "sudo -n sh -s", { ...options, stdin: script });
    return runPosixScript(lease, script, options);
}

// Exit codes of `timeout` when it stopped the command: 124 (coreutils),
// 143 (busybox, SIGTERM) and 137 (SIGKILL).
export function isTimeoutCode(code: number | null): boolean {
    return code === 124 || code === 137 || code === 143;
}

// Runs the rest of the line with a time limit and the lowest CPU and I/O
// priority, with whichever of timeout, nice and ionice the server has. The
// limit is enforced on the server: an SSH channel that closes does not stop
// a du or a find that is still running.
export function lowPriorityPrefix(seconds: number): string {
    return [
        "L=",
        `command -v timeout >/dev/null 2>&1 && L="timeout ${Math.max(1, Math.round(seconds))}"`,
        "command -v nice >/dev/null 2>&1 && L=\"$L nice -n 19\"",
        "ionice -c3 true >/dev/null 2>&1 && L=\"$L ionice -c3\""
    ].join("\n");
}

// A private folder for a script's side files ($d, and $e for the errors of
// its main command), removed with TEMP_DIR_CLEANUP. Scripts run as root: a
// predictable name in /tmp would let another user plant a link there and
// have root write through it, so without mktemp the folder is made with
// mkdir, which fails on anything that already exists.
export const TEMP_DIR = [
    "d=$(mktemp -d 2>/dev/null) || { d=/tmp/.shellmind.$$; mkdir -m 700 \"$d\" 2>/dev/null || { echo 'No private temporary folder could be made in /tmp.' >&2; exit 70; }; }",
    "e=\"$d/err\""
].join("\n");
export const TEMP_DIR_CLEANUP = "rm -rf \"$d\"";

const BINARY_UNITS: Record<string, number> = { "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4, p: 1024 ** 5, e: 1024 ** 6 };

// "1.2G", "512.0M", "48K", "0B", "3.5 GiB" (the binary units journalctl and
// du -h print) -> bytes.
export function parseBinarySize(value: string): number | null {
    const match = /^\s*([\d.]+)\s*([kmgtpe]?)(?:i?b)?\s*$/i.exec(value);
    if (!match) return null;
    const number = Number.parseFloat(match[1]);
    const unit = BINARY_UNITS[match[2].toLowerCase()];
    return Number.isFinite(number) && unit ? Math.round(number * unit) : null;
}

export function toInteger(value: string | undefined): number | null {
    const number = Number.parseInt((value ?? "").trim(), 10);
    return Number.isFinite(number) ? number : null;
}

// /proc/mounts escapes spaces, tabs, newlines and backslashes as octal (\040...).
export function decodeMountPath(value: string): string {
    return value.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}
