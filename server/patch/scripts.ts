import type { PatchManager, PatchMode, PatchOptions } from "../../shared/patch";
import { PATCH_JOB_HEADER, PATCH_MARK } from "../../shared/patch";
import { LINUX_LIMIT_FUNCTION, LINUX_REBOOT, WINDOWS_REBOOT_PENDING } from "../fleet/probe";
import { POSIX_SECTION_FUNCTION } from "../ops/remote";

// The remote side of the patch center. Every script is built here from fixed
// text and validated options (a mode from PATCH_MODES, two booleans): nothing
// a client sends reaches a server as shell text.
//
// The scan reads, under LC_ALL=C and without changing anything: who may
// install (root, passwordless sudo, or neither), the package manager, its
// pending updates as its cache knows them (apt-get simulates, dnf/yum/zypper
// run cache-only, apk and pacman read their local indexes), the security ones
// where the repositories say, held updates, a pending reboot (the fleet
// probe's detection, plus needrestart's kernel check), the last update and
// the age of the package lists. Refreshing the lists is a separate, explicit
// action (the "refresh" mode, or the refresh option of a run): a run never
// refreshes them on its own either, so it installs what the preview counted.
//
// What the scripts say themselves are marker lines (shared/patch.ts,
// "[shellmind] key=value"), which the backend follows and the client words
// in its language.

// `tl <command>`: like the fleet probe's `t`, with room for package managers
// that load large caches (dnf on a cold system takes tens of seconds).
const LISTING_LIMIT_FUNCTION = [
    "if timeout 5 true >/dev/null 2>&1; then tl() { timeout 90 \"$@\"; }",
    "elif timeout -t 5 true >/dev/null 2>&1; then tl() { timeout -t 90 \"$@\"; }",
    "else tl() { \"$@\"; }; fi"
].join("\n");

// The manager, in the fleet probe's order of preference.
const DETECT_MANAGER = [
    "if command -v apt-get >/dev/null 2>&1; then p=apt",
    "elif command -v dnf >/dev/null 2>&1; then p=dnf",
    "elif command -v yum >/dev/null 2>&1; then p=yum",
    "elif command -v zypper >/dev/null 2>&1; then p=zypper",
    "elif command -v apk >/dev/null 2>&1; then p=apk",
    "elif command -v pacman >/dev/null 2>&1; then p=pacman",
    "else p=; fi"
].join("\n");

// The package processes that hold (or wait for) the manager's lock. Read
// from /proc, so it works with busybox too. PackageKit idles in the
// background on many systems and is left out, and so are listings that take
// no lock (simulations, cache-only queries: another scan, say).
const BUSY_PROCESSES = "unattended-upgr|apt|apt-get|aptitude|dpkg|dnf|dnf5|yum|rpm|zypper|apk|pacman";
const LOCKLESS_COMMANDS = "*\" -s \"*|*NoLocking*|*\" -C \"*|*check-update*|*updateinfo*|*\" list\"*|*\" version\"*|*\" -Q\"*";

const RPM_INSTALLED = "rpm -qa --qf '%{NAME}.%{ARCH} %|EPOCH?{%{EPOCH}:}:{}|%{VERSION}-%{RELEASE}\\n' 2>/dev/null";

// A package name apt prints (and the only words passed back to apt).
const APT_NAME = "'^[A-Za-z0-9][A-Za-z0-9+.:~_-]*$'";

// apt: of the packages an upgrade simulation installs (read on stdin), those
// with a version newer than the installed one in a security archive, as
// "<name> <that version> <archive>". The candidate itself may come from
// elsewhere: a point release ships the security fix again with a higher
// version (Debian's glibc, systemd), and the candidate supersedes it, which
// is what unattended-upgrades counts too. `apt-cache policy` lists a
// package's versions newest first, the installed one marked "***".
export const APT_SECURITY_VERSIONS_FUNCTION = [
    `apt_security_versions() { n=$(awk '/^Inst / { print $2 }' | grep -E ${APT_NAME} | head -n 3000); [ -n "$n" ] || return 0; apt-cache policy $n 2>/dev/null | awk '`,
    "/^[^ ]/ { p = $1; sub(/:$/, \"\", p); a = 1; v = \"\"; next }",
    "$1 == \"***\" { a = 0; next }",
    "NF == 2 && $2 ~ /^-?[0-9]+$/ { v = $1; next }",
    "$1 ~ /^-?[0-9]+$/ && a && v != \"\" && !(p in s) && ($0 ~ /-security\\// || $0 ~ /security\\.debian\\.org/) { s[p] = 1; x = $3; sub(/\\/.*$/, \"\", x); print p, v, x }",
    "'; }"
].join("\n");

export const LINUX_SCAN_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    POSIX_SECTION_FUNCTION,
    LINUX_LIMIT_FUNCTION,
    LISTING_LIMIT_FUNCTION,
    APT_SECURITY_VERSIONS_FUNCTION,
    "u=$(id -u 2>/dev/null)",
    DETECT_MANAGER,
    "m uid",
    "echo \"$u\"",
    "m sudo",
    "if [ \"$u\" != 0 ]; then if ! command -v sudo >/dev/null 2>&1; then echo none; elif sudo -n true >/dev/null 2>&1; then echo yes; else echo password; fi; fi",
    "m manager",
    "echo \"$p\"",
    "m busy",
    `for d in /proc/[0-9]*; do c=$(cat "$d/comm" 2>/dev/null) || continue; case $c in ${BUSY_PROCESSES}) a=$(tr '\\0' ' ' < "$d/cmdline" 2>/dev/null); case " $a" in ${LOCKLESS_COMMANDS}) ;; *) echo "$c";; esac;; esac; done | sort -u`,
    "newest() { ls -t \"$@\" 2>/dev/null | head -n 1; }",
    "m metadata",
    "case $p in",
    "apt) f=; ls /var/lib/apt/lists/*_Packages* >/dev/null 2>&1 && f=/var/lib/apt/lists ;;",
    "dnf|yum) f=$(newest /var/cache/dnf/*/repodata/repomd.xml /var/cache/libdnf5/*/repodata/repomd.xml /var/cache/yum/*/*/*/repomd.xml) ;;",
    "zypper) f=$(newest /var/cache/zypp/raw/*/repodata/repomd.xml) ;;",
    "apk) f=$(newest /var/cache/apk/APKINDEX.*) ;;",
    "pacman) f=; ls /var/lib/pacman/sync/*.db >/dev/null 2>&1 && f=/var/lib/pacman/sync ;;",
    "*) f= ;;",
    "esac",
    "[ -n \"$f\" ] && stat -c %Y \"$f\" 2>/dev/null",
    "m last",
    "case $p in",
    "apt) for f in /var/log/apt/history.log /var/log/apt/history.log.1.gz; do case $f in *.gz) c=zcat;; *) c=cat;; esac; d=$($c \"$f\" 2>/dev/null | awk '/^Start-Date:/ { d = $2 \" \" $3 } /^Upgrade:/ { u = d } END { print u }'); [ -n \"$d\" ] && break; done; [ -n \"$d\" ] && date -d \"$d\" +%s 2>/dev/null ;;",
    "dnf|yum|zypper) rpm -qa --qf '%{INSTALLTIME}\\n' 2>/dev/null | sort -n | tail -n 1 ;;",
    "apk) stat -c %Y /lib/apk/db/installed 2>/dev/null ;;",
    "pacman) stat -c %Y /var/lib/pacman/local 2>/dev/null ;;",
    "esac",
    "m reboot",
    LINUX_REBOOT,
    "m rebootpkgs",
    "cat /var/run/reboot-required.pkgs /run/reboot-required.pkgs 2>/dev/null | sort -u | head -n 100",
    // Kernel status and services with outdated libraries; list mode only
    // (-r l), so it never restarts anything. As a non-root user it sees the
    // kernel and that user's own processes.
    "m needrestart",
    "if command -v needrestart >/dev/null 2>&1; then t needrestart -b -r l 2>/dev/null | head -n 200; fi",
    "m restarting",
    "if [ \"$u\" = 0 ] && command -v needs-restarting >/dev/null 2>&1; then t needs-restarting -s 2>/dev/null | head -n 200; fi",
    "m updates",
    "case $p in",
    "apt) o=$(tl apt-get -s -o Debug::NoLocking=true --with-new-pkgs upgrade 2>&1); r=$?; printf '%s\\n' \"$o\"; echo \"@@rc $r\" ;;",
    "dnf|yum) tl $p -q -C check-update 2>&1; echo \"@@rc $?\" ;;",
    "zypper) tl zypper -n --no-refresh -q list-updates 2>&1; echo \"@@rc $?\" ;;",
    // apk-tools 3 (Alpine 3.23+) downloads missing or old indexes for a
    // listing, and as root keeps them: a scan reads the cached ones only.
    "apk) tl apk --no-network list -u 2>&1 || tl apk --no-network version -l '<' 2>&1; echo \"@@rc $?\" ;;",
    "pacman) tl pacman -Qu 2>&1; echo \"@@rc $?\" ;;",
    "esac",
    "m security",
    "case $p in",
    "dnf) tl dnf -q -C updateinfo list --security 2>&1; echo \"@@rc $?\" ;;",
    "yum) tl yum -q -C updateinfo list security 2>&1; echo \"@@rc $?\" ;;",
    "zypper) tl zypper -n --no-refresh -q list-patches --category security 2>&1; echo \"@@rc $?\" ;;",
    "esac",
    "m aptsecurity",
    "if [ \"$p\" = apt ]; then printf '%s\\n' \"$o\" | apt_security_versions; fi",
    "m installed",
    "case $p in",
    `dnf|yum) ${RPM_INSTALLED} ;;`,
    "esac",
    "m end",
    ""
].join("\n");

// Windows: Windows Update through its COM API, searching only (nothing is
// downloaded or installed). Offline, the search answers from what the last
// online search learned (the "package lists"); online it asks Windows Update
// or WSUS again, which is the Windows side of a refresh. Classifications are
// reported by id as well: their names follow the system's language. Plain
// PowerShell on purpose: no encoding tricks, nothing that looks like
// obfuscation.
export function windowsScanScript(online: boolean): string {
    return `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function IsoDate($value) {
    if ($value -is [DateTime] -and $value.Year -ge 2000) { return $value.ToUniversalTime().ToString('o') }
    return $null
}
$report = @{ admin = $null; reboot = $false; updates = @(); error = $null; lastInstall = $null; lastSearch = $null }
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $report.admin = (New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
} catch {}
$report.reboot = ${WINDOWS_REBOOT_PENDING}
try {
    $auto = New-Object -ComObject Microsoft.Update.AutoUpdate
    $report.lastInstall = IsoDate $auto.Results.LastInstallationSuccessDate
    $report.lastSearch = IsoDate $auto.Results.LastSearchSuccessDate
} catch {}
try {
    $session = New-Object -ComObject Microsoft.Update.Session
    $searcher = $session.CreateUpdateSearcher()
    $searcher.Online = $${online ? "true" : "false"}
    $found = $searcher.Search('IsInstalled=0 and IsHidden=0')
    foreach ($update in $found.Updates) {
        $classes = @($update.Categories | Where-Object { $_.Type -eq 'UpdateClassification' } | ForEach-Object { @{ id = $_.CategoryID; name = $_.Name } })
        $report.updates += @{
            title = $update.Title
            kb = @($update.KBArticleIDs)
            severity = $update.MsrcSeverity
            classes = $classes
            reboot = [int]$update.InstallationBehavior.RebootBehavior
        }
    }
} catch {
    $report.error = $_.Exception.Message
}
$report | ConvertTo-Json -Compress -Depth 5
`;
}

const MODE_TEXT: Record<PatchMode, string> = {
    security: "install security updates",
    all: "install all updates",
    refresh: "refresh the package lists"
};

// What a run does, in a few words (the job's first line and the audit log).
export function describeRun(options: PatchOptions): string {
    const parts = [MODE_TEXT[options.mode]];
    if (options.mode !== "refresh" && options.refresh) parts.push("refresh the package lists first");
    if (options.mode !== "refresh" && options.reboot) parts.push("then reboot where a reboot is required");
    return parts.join(", ");
}

// apt: never a question (debconf, changed configuration files, needrestart),
// and up to five minutes for a lock held by unattended-upgrades.
const APT_ENV = "env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l APT_LISTCHANGES_FRONTEND=none";
const APT_OPTIONS = "-y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o DPkg::Lock::Timeout=300";
// dnf/yum: the metadata as it is. Their per-repository metadata_expire (6 h
// in the RHEL family's .repo files) wins over the global option, so it is
// set for every repository; after a refresh it keeps a failed one from being
// retried behind the user's back. Quoted: the * is not a file pattern.
const RPM_NO_REFRESH = "'--setopt=*.metadata_expire=never'";
// apk: the indexes as they are (apk fetches them again when they are older
// than four hours).
const APK_NO_REFRESH = "--cache-max-age 5256000";

// The commands each manager runs for these options, as the preview lists
// them ($S: "sudo -n" for a non-root user).
export function planCommands(options: PatchOptions): Record<Exclude<PatchManager, "windows-update">, string[]> {
    const { mode } = options;
    const refresh = mode === "refresh" || options.refresh;
    const unquoted = RPM_NO_REFRESH.replace(/'/g, "");
    const rpm = (manager: "dnf" | "yum") => {
        const commands = refresh ? [`${manager} -y makecache`] : [];
        if (mode === "all") commands.push(`${manager} -y ${unquoted} upgrade`);
        if (mode === "security") commands.push(`${manager} -y ${unquoted} upgrade --security`);
        return commands;
    };
    const apt = refresh ? ["apt-get -q update"] : [];
    if (mode === "all") apt.push(`apt-get ${APT_OPTIONS} --with-new-pkgs upgrade`);
    if (mode === "security") {
        apt.push(`apt-get ${APT_OPTIONS} --no-remove install --only-upgrade <the pending security updates>`);
        apt.push("apt-mark auto <those of them that were installed as dependencies>");
    }
    const zypper = refresh ? ["zypper -n refresh"] : [];
    if (mode === "all") zypper.push("zypper -n --no-refresh update --auto-agree-with-licenses");
    if (mode === "security") zypper.push("zypper -n --no-refresh patch --category security --auto-agree-with-licenses");
    const apk = refresh ? ["apk update"] : [];
    if (mode === "all") apk.push(`apk ${APK_NO_REFRESH} upgrade`);
    const pacman = mode === "refresh" ? ["pacman -Sy --noconfirm"] : mode === "all" ? [refresh ? "pacman -Syu --noconfirm" : "pacman -Su --noconfirm"] : [];
    return { apt, dnf: rpm("dnf"), yum: rpm("yum"), zypper, apk, pacman };
}

// apt: the packages a security run installs, taken again right before it
// from the same simulation the scan reads: those whose candidate comes from
// a security archive, and those with a newer version there than the one
// installed (see APT_SECURITY_VERSIONS_FUNCTION).
const APT_SECURITY_PACKAGES_FUNCTION = [
    "apt_security_packages() {",
    "  o=$(apt-get -s -o Debug::NoLocking=true --with-new-pkgs upgrade 2>/dev/null)",
    "  { printf '%s\\n' \"$o\" | awk '/^Inst / { s = $0; sub(/^[^(]*\\(/, \"\", s); sub(/\\).*$/, \"\", s); if (s ~ /-[Ss]ecurity/) print $2 }'",
    "    printf '%s\\n' \"$o\" | apt_security_versions | cut -d' ' -f1",
    `  } | grep -E ${APT_NAME} | sort -u`,
    "}"
].join("\n");

// The script a patch run executes on each server (read it in the preview).
// Exit codes: the manager's own, or 77 (no privilege), 78 (no supported
// manager), 79 (security updates asked of a manager that cannot tell them).
// Whether a reboot is required once it is done is its last line. Nothing it
// starts reads its input (the script itself, on `sh -s`).
export function buildApplyScript(options: PatchOptions): string {
    const mode = options.mode;
    const refresh = mode === "refresh" || options.refresh ? 1 : 0;
    return [
        `${PATCH_JOB_HEADER} ${describeRun(options)}`,
        "LC_ALL=C",
        "export LC_ALL",
        `mode=${mode}`,
        `refresh=${refresh}`,
        `say() { printf '${PATCH_MARK} %s\\n' "$*"; }`,
        `fail() { c=$1; shift; printf '${PATCH_MARK} %s\\n' "$*" >&2; exit "$c"; }`,
        "run() { printf '+ %s\\n' \"$*\"; \"$@\" </dev/null; }",
        LINUX_LIMIT_FUNCTION,
        APT_SECURITY_VERSIONS_FUNCTION,
        APT_SECURITY_PACKAGES_FUNCTION,
        "if [ \"$(id -u)\" = 0 ]; then S=",
        "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then S='sudo -n'",
        "else fail 77 error=privilege; fi",
        DETECT_MANAGER,
        "[ -n \"$p\" ] || fail 78 error=no-manager",
        "say \"manager=$p\"",
        // A failed refresh is reported and the run goes on with the lists
        // there are, as an install without the refresh would.
        "refreshed() { r=$?; [ $r -eq 0 ] && return 0; if [ \"$mode\" = refresh ]; then say \"failed=$r\"; exit $r; fi; say \"refresh-failed=$r\"; return 0; }",
        "r=0",
        "case $p in",
        "apt)",
        `  if [ $refresh = 1 ]; then run $S ${APT_ENV} apt-get -q -o DPkg::Lock::Timeout=300 update; refreshed; fi`,
        "  case $mode in",
        `  all) run $S ${APT_ENV} apt-get ${APT_OPTIONS} --with-new-pkgs upgrade; r=$? ;;`,
        "  security) k=$(apt_security_packages)",
        "    if [ -z \"$k\" ]; then say security-updates=none",
        // Naming a package to `install` marks it as installed by hand: the
        // ones installed as dependencies are marked automatic again, so
        // autoremove still sees them.
        "    else a=$(apt-mark showauto $k 2>/dev/null)",
        `      run $S ${APT_ENV} apt-get ${APT_OPTIONS} --no-remove install --only-upgrade $k; r=$?`,
        "      if [ -n \"$a\" ]; then run $S apt-mark auto $a || say \"auto-marks-failed=$?\"; fi",
        "    fi ;;",
        "  esac ;;",
        "dnf|yum)",
        "  if [ $refresh = 1 ]; then run $S $p -y makecache; refreshed; fi",
        "  case $mode in",
        `  all) run $S $p -y ${RPM_NO_REFRESH} upgrade; r=$? ;;`,
        `  security) run $S $p -y ${RPM_NO_REFRESH} upgrade --security; r=$? ;;`,
        "  esac ;;",
        "zypper)",
        "  if [ $refresh = 1 ]; then run $S zypper -n refresh; refreshed; fi",
        "  case $mode in",
        "  all) a=update ;;",
        "  security) a='patch --category security' ;;",
        "  *) a= ;;",
        "  esac",
        // 102: done, a reboot is needed; 103: zypper updated itself and must
        // run again.
        "  if [ -n \"$a\" ]; then run $S zypper -n --no-refresh $a --auto-agree-with-licenses; r=$?",
        "    if [ $r -eq 103 ]; then run $S zypper -n --no-refresh $a --auto-agree-with-licenses; r=$?; fi",
        "    if [ $r -eq 102 ] || [ $r -eq 103 ]; then r=0; fi",
        "  fi ;;",
        "apk)",
        "  if [ $refresh = 1 ]; then run $S apk update; refreshed; fi",
        "  case $mode in",
        `  all) run $S apk ${APK_NO_REFRESH} upgrade; r=$? ;;`,
        "  security) fail 79 error=no-security manager=apk ;;",
        "  esac ;;",
        "pacman)",
        "  case $mode in",
        "  refresh) run $S pacman -Sy --noconfirm; r=$? ;;",
        "  all) if [ $refresh = 1 ]; then run $S pacman -Syu --noconfirm; else run $S pacman -Su --noconfirm; fi; r=$? ;;",
        "  security) fail 79 error=no-security manager=pacman ;;",
        "  esac ;;",
        "esac",
        "if [ $r -ne 0 ]; then say \"failed=$r\"; exit $r; fi",
        // Asked once everything is in: the updates may be what requires it.
        "rb=$(",
        LINUX_REBOOT,
        ")",
        "if [ -z \"$rb\" ] && command -v needrestart >/dev/null 2>&1; then k=$(t $S needrestart -b -r l 2>/dev/null </dev/null | sed -n 's/^NEEDRESTART-KSTA: *//p'); if [ -n \"$k\" ] && [ \"$k\" -ge 2 ] 2>/dev/null; then rb=yes; elif [ -n \"$k\" ] && [ \"$k\" -eq 1 ] 2>/dev/null; then rb=no; fi; fi",
        "say \"reboot-required=${rb:-unknown}\"",
        ""
    ].join("\n");
}

// Before and after a reboot: what tells one boot from the next (the kernel's
// boot id; in a container, which keeps the host's, the start of PID 1), the
// uptime, and the system's state.
export const BOOT_CHECK_SCRIPT = [
    "LC_ALL=C",
    "export LC_ALL",
    POSIX_SECTION_FUNCTION,
    "m boot",
    "cat /proc/sys/kernel/random/boot_id 2>/dev/null",
    "m pid1",
    "sed 's/.*) //' /proc/1/stat 2>/dev/null | cut -d' ' -f20",
    "m hz",
    "getconf CLK_TCK 2>/dev/null",
    "m uptime",
    "cut -d' ' -f1 /proc/uptime 2>/dev/null",
    "y=; command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ] && y=1",
    "m state",
    "[ -n \"$y\" ] && systemctl is-system-running 2>/dev/null",
    "m failed",
    "[ -n \"$y\" ] && systemctl list-units --state=failed --no-legend --plain 2>/dev/null | grep -c .",
    "m end",
    ""
].join("\n");

// The reboot itself: systemd's, else shutdown's, else reboot's. Its exec ends
// (or the connection drops) as the server goes down.
export const REBOOT_SCRIPT = [
    "if [ \"$(id -u)\" = 0 ]; then S=",
    "elif command -v sudo >/dev/null 2>&1 && sudo -n true >/dev/null 2>&1; then S='sudo -n'",
    `else echo '${PATCH_MARK} error=reboot-privilege' >&2; exit 77; fi`,
    "if command -v systemctl >/dev/null 2>&1 && [ -d /run/systemd/system ]; then $S systemctl reboot",
    "elif command -v shutdown >/dev/null 2>&1 && $S shutdown -r now 2>/dev/null; then :",
    "else $S reboot; fi",
    ""
].join("\n");
