import type { InstallStatus, RemoveStatus } from "../../shared/identities";
import { AppError } from "../errors";
import { commandFailure, psQuote, runPosixScript, runPowerShell, shellQuote, type RunOptions } from "../ops/remote";
import type { SshLease } from "../ssh/pool";
import type { PublicKeyInfo } from "./keys";

// "Install public key on servers": appends an identity's public key to the
// authorized_keys of the user a server signs in as, through the server's
// pooled connection (its current credentials). Idempotent: a key already in
// the file (same type and key data, whatever its options or comment) is left
// alone; a commented-out copy does not count, so the key is added again. The
// script is assembled here from a validated key only, and the key
// is quoted even so (it carries no quotes: keys.ts safeComment).
//
// POSIX: ~/.ssh (0700) and ~/.ssh/authorized_keys (0600), SELinux labels
// restored when restorecon exists, and a warning when the home directory is
// writable by others (sshd's StrictModes then ignores the keys).
// Windows (OpenSSH): administrators sign in with
// %ProgramData%\ssh\administrators_authorized_keys (the default sshd_config),
// which must only be accessible to Administrators and SYSTEM; other users
// with %USERPROFILE%\.ssh\authorized_keys.

export const INSTALL_MARKER = "@@SHELLMIND_KEY:";

export type InstallOutcome = { status: Exclude<InstallStatus, "failed">; file: string | null; warnings: string[] };

export function posixInstallScript(key: PublicKeyInfo): string {
    const [type, data] = key.blob.split(" ");
    return [
        `key=${shellQuote(key.publicKey)}`,
        `type=${shellQuote(type)}`,
        `data=${shellQuote(data)}`,
        `if [ -z "\${HOME:-}" ] || [ ! -d "$HOME" ]; then echo "The home directory of $(id -un 2>/dev/null) does not exist" >&2; exit 3; fi`,
        `dir="$HOME/.ssh"`,
        `file="$dir/authorized_keys"`,
        "umask 077",
        `mkdir -p "$dir" || exit 4`,
        `chmod 700 "$dir" || exit 4`,
        // A commented-out line (an administrator disabled the key) does not count.
        `if [ -f "$file" ] && awk -v t="$type" -v k="$data" '/^[[:space:]]*#/ { next } { for (i = 1; i < NF; i++) if ($i == t && $(i + 1) == k) { found = 1; exit } } END { exit found ? 0 : 1 }' "$file"; then`,
        "  state=present",
        "else",
        `  if [ -s "$file" ] && [ -n "$(tail -c 1 "$file")" ]; then printf '\\n' >> "$file" || exit 5; fi`,
        `  printf '%s\\n' "$key" >> "$file" || exit 5`,
        "  state=installed",
        "fi",
        `chmod 600 "$file" || exit 6`,
        `if command -v restorecon >/dev/null 2>&1; then restorecon -R "$dir" >/dev/null 2>&1 || true; fi`,
        `if [ -n "$(find "$HOME" -maxdepth 0 \\( -perm -020 -o -perm -002 \\) 2>/dev/null)" ]; then echo "${INSTALL_MARKER}warning:home-writable"; fi`,
        `echo "${INSTALL_MARKER}file:$file"`,
        `echo "${INSTALL_MARKER}$state"`,
        ""
    ].join("\n");
}

// Where sshd looks for the keys of the signed-in user ($admin, $dir, $file):
// administrators %ProgramData%\ssh\administrators_authorized_keys (the
// default sshd_config), everyone else %USERPROFILE%\.ssh\authorized_keys.
const WINDOWS_KEY_FILE = [
    "$me = [Security.Principal.WindowsIdentity]::GetCurrent()",
    "$adminSid = New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')",
    "$admin = $false",
    // Membership, not elevation: sshd's "Match Group administrators" goes by the group.
    "try { $admin = [bool](Get-LocalGroupMember -SID 'S-1-5-32-544' -ErrorAction Stop | Where-Object { $_.SID -eq $me.User }) } catch { }",
    "if (-not $admin) { $admin = (New-Object Security.Principal.WindowsPrincipal($me)).IsInRole($adminSid) }",
    "if ($admin) { $dir = Join-Path $env:ProgramData 'ssh'; $file = Join-Path $dir 'administrators_authorized_keys' }",
    "else { $dir = Join-Path $env:USERPROFILE '.ssh'; $file = Join-Path $dir 'authorized_keys' }"
];

// Only Administrators and SYSTEM (by SID: the group names are localized).
const RESTRICT_ADMIN_FILE = "if ($admin) { & icacls.exe $file /inheritance:r /grant '*S-1-5-32-544:F' /grant '*S-1-5-18:F' | Out-Null; if ($LASTEXITCODE -ne 0) { throw \"icacls could not restrict $file (exit code $LASTEXITCODE)\" } }";

export function windowsInstallScript(key: PublicKeyInfo): string {
    const [type, data] = key.blob.split(" ");
    return [
        "$ErrorActionPreference = 'Stop'",
        `$key = ${psQuote(key.publicKey)}`,
        `$type = ${psQuote(type)}`,
        `$data = ${psQuote(data)}`,
        ...WINDOWS_KEY_FILE,
        "if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }",
        "$present = $false",
        "if (Test-Path -LiteralPath $file) {",
        "foreach ($line in [IO.File]::ReadAllLines($file)) {",
        "if ($line.TrimStart().StartsWith('#')) { continue }",
        "$parts = @($line.Trim() -split '\\s+')",
        "for ($i = 0; $i -lt $parts.Count - 1; $i++) { if ($parts[$i] -ceq $type -and $parts[$i + 1] -ceq $data) { $present = $true } }",
        "}",
        "}",
        "if (-not $present) {",
        "$prefix = ''",
        "if (Test-Path -LiteralPath $file) { $existing = [IO.File]::ReadAllText($file); if ($existing.Length -gt 0 -and -not $existing.EndsWith([string][char]10)) { $prefix = [string][char]13 + [char]10 } }",
        "[IO.File]::AppendAllText($file, $prefix + $key + [char]13 + [char]10, (New-Object Text.UTF8Encoding $false))",
        "}",
        RESTRICT_ADMIN_FILE,
        `Write-Output "${INSTALL_MARKER}file:$file"`,
        `if ($present) { Write-Output '${INSTALL_MARKER}present' } else { Write-Output '${INSTALL_MARKER}installed' }`
    ].join("\n");
}

// The outcome the script printed, or null when it did not finish.
export function parseInstallOutput(stdout: string): InstallOutcome | null {
    let status: InstallOutcome["status"] | null = null;
    let file: string | null = null;
    const warnings: string[] = [];
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith(INSTALL_MARKER)) continue;
        const value = line.slice(INSTALL_MARKER.length);
        if (value === "installed" || value === "present") status = value;
        else if (value.startsWith("file:")) file = value.slice("file:".length) || null;
        else if (value.startsWith("warning:")) warnings.push(value.slice("warning:".length));
    }
    return status ? { status, file, warnings } : null;
}

// Runs the install script for the lease's server (POSIX or PowerShell by OS).
export async function installOnLease(lease: SshLease, key: PublicKeyInfo, options: RunOptions): Promise<InstallOutcome> {
    const result = lease.target.os === "windows"
        ? await runPowerShell(lease, windowsInstallScript(key), options)
        : await runPosixScript(lease, posixInstallScript(key), options);
    const outcome = parseInstallOutput(result.stdout);
    if (result.code !== 0 || !outcome) throw commandFailure(result, "The key could not be added to authorized_keys.");
    return outcome;
}

// Taking a key out of authorized_keys again (a rotated identity's previous
// key, so that a copy of it stops signing in): every line that holds it goes,
// whatever its options or comment; a commented-out copy stays (it signs
// nothing in). The file is rewritten only when a line goes: POSIX through a
// new file moved into place (0600, SELinux label restored; written through
// when it is a symbolic link), Windows in place, which keeps its ACL.
export type RemoveOutcome = { status: Exclude<RemoveStatus, "failed">; removed: number; file: string | null };

export function posixRemoveScript(key: PublicKeyInfo): string {
    const [type, data] = key.blob.split(" ");
    return [
        `type=${shellQuote(type)}`,
        `data=${shellQuote(data)}`,
        `file="\${HOME:-}/.ssh/authorized_keys"`,
        `if [ -z "\${HOME:-}" ] || [ ! -f "$file" ]; then echo "${INSTALL_MARKER}file:$file"; echo "${INSTALL_MARKER}absent"; exit 0; fi`,
        "umask 077",
        `tmp="$file.shellmind-$$"`,
        `: > "$tmp" || exit 5`,
        // Lines as sshd reads them: blank-separated fields, the key's type
        // followed by its data (a trailing CR from a Windows editor too).
        `n=$(awk -v t="$type" -v k="$data" -v out="$tmp" '/^[[:space:]]*#/ { print > out; next } { drop = 0; for (i = 1; i < NF; i++) if ($i == t && ($(i + 1) == k || $(i + 1) == k "\\r")) drop = 1; if (drop) n++; else print > out } END { close(out); print n + 0 }' "$file") || { rm -f "$tmp"; exit 5; }`,
        `if [ "$n" -gt 0 ]; then`,
        `  if [ -L "$file" ]; then cat "$tmp" > "$file" || { rm -f "$tmp"; exit 6; }; rm -f "$tmp"; else chmod 600 "$tmp" && mv -f "$tmp" "$file" || { rm -f "$tmp"; exit 6; }; fi`,
        `  if command -v restorecon >/dev/null 2>&1; then restorecon "$file" >/dev/null 2>&1 || true; fi`,
        `  echo "${INSTALL_MARKER}removed:$n"`,
        "else",
        `  rm -f "$tmp"`,
        `  echo "${INSTALL_MARKER}absent"`,
        "fi",
        `echo "${INSTALL_MARKER}file:$file"`,
        ""
    ].join("\n");
}

export function windowsRemoveScript(key: PublicKeyInfo): string {
    const [type, data] = key.blob.split(" ");
    return [
        "$ErrorActionPreference = 'Stop'",
        `$type = ${psQuote(type)}`,
        `$data = ${psQuote(data)}`,
        ...WINDOWS_KEY_FILE,
        `if (-not (Test-Path -LiteralPath $file)) { Write-Output "${INSTALL_MARKER}file:$file"; Write-Output '${INSTALL_MARKER}absent'; return }`,
        "$kept = New-Object System.Collections.Generic.List[string]",
        "$n = 0",
        "foreach ($line in [IO.File]::ReadAllLines($file)) {",
        "$drop = $false",
        "if (-not $line.TrimStart().StartsWith('#')) { $parts = @($line.Trim() -split '\\s+'); for ($i = 0; $i -lt $parts.Count - 1; $i++) { if ($parts[$i] -ceq $type -and $parts[$i + 1] -ceq $data) { $drop = $true } } }",
        "if ($drop) { $n++ } else { $kept.Add($line) }",
        "}",
        "if ($n -gt 0) {",
        "$eol = [string][char]13 + [char]10",
        "$text = $kept -join $eol",
        "if ($kept.Count -gt 0) { $text += $eol }",
        // Writing over an existing file keeps its security descriptor.
        "[IO.File]::WriteAllText($file, $text, (New-Object Text.UTF8Encoding $false))",
        RESTRICT_ADMIN_FILE,
        `Write-Output "${INSTALL_MARKER}removed:$n"`,
        `} else { Write-Output '${INSTALL_MARKER}absent' }`,
        `Write-Output "${INSTALL_MARKER}file:$file"`
    ].join("\n");
}

// The outcome the removal script printed, or null when it did not finish.
export function parseRemoveOutput(stdout: string): RemoveOutcome | null {
    let outcome: Omit<RemoveOutcome, "file"> | null = null;
    let file: string | null = null;
    for (const raw of stdout.split(/\r?\n/)) {
        const line = raw.trim();
        if (!line.startsWith(INSTALL_MARKER)) continue;
        const value = line.slice(INSTALL_MARKER.length);
        const removed = /^removed:(\d+)$/.exec(value);
        if (removed) outcome = { status: "removed", removed: Number(removed[1]) };
        else if (value === "absent") outcome = { status: "absent", removed: 0 };
        else if (value.startsWith("file:")) file = value.slice("file:".length) || null;
    }
    return outcome ? { ...outcome, file } : null;
}

// Runs the removal script for the lease's server (POSIX or PowerShell by OS).
export async function removeOnLease(lease: SshLease, key: PublicKeyInfo, options: RunOptions): Promise<RemoveOutcome> {
    const result = lease.target.os === "windows"
        ? await runPowerShell(lease, windowsRemoveScript(key), options)
        : await runPosixScript(lease, posixRemoveScript(key), options);
    const outcome = parseRemoveOutput(result.stdout);
    if (result.code !== 0 || !outcome) throw commandFailure(result, "The previous key could not be taken out of authorized_keys.");
    return outcome;
}

export class IdentityKeyMissingError extends AppError {
    constructor(message: string) {
        super("IDENTITY_NO_KEY", message, 409);
        this.name = "IdentityKeyMissingError";
    }
}
