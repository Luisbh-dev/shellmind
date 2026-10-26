import type { CleanupId, CleanupItem, CleanupParams, CleanupPreview, CleanupUnavailable } from "../../../shared/disk";
import { resolveCleanupParams } from "../../../shared/disk";
import type { OpsCapabilities } from "../../../shared/ops";
import { AppError } from "../../errors";
import { POSIX_SECTION_FUNCTION, parseSections, shellQuote } from "../../ops/remote";
import { NOT_ELEVATED_MESSAGE, TEMP_DIR, TEMP_DIR_CLEANUP, isElevated, parseBinarySize, runDiskScript, sudoPrefix, toInteger } from "../remote";
import { MAX_ITEMS, topItems, type CleanupContext, type CleanupProvider, type PreparedCleanup } from "./types";

// The cleanups of well-known files on Linux. One read-only script measures
// all of them (what each would remove with the chosen parameters, and which
// filesystem each path is on); a run executes the matching command as root.
// The find expressions of a preview and of its run are built by the same
// functions, so the run removes what the preview listed (and what has aged
// into it meanwhile), never anything else.

const PREVIEW_TIMEOUT_MS = 60_000;
const RUN_TIMEOUT_MS = 10 * 60_000;
// A cache directory this small holds its own bookkeeping, nothing to free.
const EMPTY_CACHE_BYTES = 1024 * 1024;

export const FILE_CLEANUPS = ["journal", "package-cache", "rotated-logs", "tmp", "core-dumps"] as const;
type FileCleanupId = typeof FILE_CLEANUPS[number];

const JOURNAL_DIRS = ["/var/log/journal", "/run/log/journal"];
const TMP_DIRS = ["/tmp", "/var/tmp"];
const CORE_DIRS = ["/var/lib/systemd/coredump", "/var/crash", "/var/lib/apport/coredump"];

// Rotated logs: compressed, numbered (syslog.1), dated (messages-20261018)
// or renamed .old. The journal has a cleanup of its own.
const ROTATED_NAMES = ["*.gz", "*.xz", "*.bz2", "*.zst", "*.lz4", "*.[0-9]", "*.old", "*-[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]"];
// The private /tmp of services and the X11/ICE socket folders stay.
const TMP_KEEP = ["/tmp/systemd-private-*", "/var/tmp/systemd-private-*", "*/.X11-unix/*", "*/.ICE-unix/*", "*/.XIM-unix/*", "*/.font-unix/*", "*/.Test-unix/*"];

type Manager = { id: "apt" | "dnf" | "yum" | "apk" | "zypper"; command: string; dirs: string[] };

const MANAGERS: Manager[] = [
    { id: "apt", command: "apt-get clean", dirs: ["/var/cache/apt"] },
    { id: "dnf", command: "dnf clean all", dirs: ["/var/cache/dnf", "/var/cache/libdnf5"] },
    { id: "yum", command: "yum clean all", dirs: ["/var/cache/yum"] },
    { id: "apk", command: "apk cache clean", dirs: [] },
    { id: "zypper", command: "zypper --non-interactive clean --all", dirs: ["/var/cache/zypp"] }
];

const names = (patterns: string[]) => `\\( ${patterns.map((pattern) => `-name ${shellQuote(pattern)}`).join(" -o ")} \\)`;
const age = (flag: string, days: number) => (days > 0 ? ` ${flag} +${days - 1}` : "");

// find's -mtime +N means "more than N whole days": +(days - 1) is "older than days".
export function rotatedLogsExpression(days: number): string {
    return `/var/log -xdev -type f ! -path '/var/log/journal/*' ${names(ROTATED_NAMES)}${age("-mtime", days)}`;
}

// Untouched (read, written or changed) for `days`.
export function tmpExpression(dirs: string, days: number): string {
    return `${dirs} -xdev -type f ${TMP_KEEP.map((path) => `! -path ${shellQuote(path)}`).join(" ")}${age("-atime", days)}${age("-mtime", days)}${age("-ctime", days)}`;
}

export function coreDumpsExpression(dirs: string, days: number): string {
    return `${dirs} -xdev -type f${age("-mtime", days)}`;
}

// How a run removes the files find selects. With -delete (GNU find, most
// busybox builds), GNU find unlinks each one relative to the directory it is
// walking, never through a symbolic link: a user who swaps a folder of /tmp
// for a link to /etc meanwhile cannot redirect root's removal. Without it
// (some busybox builds) the files go to rm by their path, and the preview
// says so.
export type Removal = "delete" | "rm";

const removing = (mode: Removal) => (mode === "delete" ? "-delete" : "-exec rm -f -- {} +");

// Whether this server's find takes -delete, tried on an empty folder of its own.
const REMOVAL_PROBE = "p=$(mktemp -d 2>/dev/null) && { if find \"$p\" -maxdepth 0 -type f -delete 2>/dev/null; then echo delete; else echo rm; fi; rmdir \"$p\" 2>/dev/null; }";

// The existing ones of `dirs` as the positional parameters ($@).
const existing = (dirs: string[]) => `set --; for d in ${dirs.map(shellQuote).join(" ")}; do [ -d "$d" ] && set -- "$@" "$d"; done`;

// "<allocated bytes> <mtime> <path>" per file, the largest first, then
// "@@TOTAL <count> <bytes>". printf %.0f: some awks print large integers in
// exponent form.
const TOP_FUNCTION = [
    "top() { awk '{ p = $0; sub(/^[0-9]+ [0-9]+ /, \"\", p); printf \"%.0f %s\\n\", $1 * $2, p }' | sort -rn |",
    `  awk 'NR <= ${MAX_ITEMS} { print } { s += $1; c++ } END { printf "@@TOTAL %d %.0f\\n", c, s }'; }`
].join("\n");
const STAT = "-exec stat -c '%b %B %Y %n' {} + 2>/dev/null";

export function linuxCleanupScript(params: Record<FileCleanupId, CleanupParams>): string {
    const where = [...JOURNAL_DIRS, ...MANAGERS.flatMap((manager) => manager.dirs), "/var/log", ...TMP_DIRS, ...CORE_DIRS];
    return [
        "LC_ALL=C",
        "export LC_ALL",
        POSIX_SECTION_FUNCTION,
        TOP_FUNCTION,
        "m journal",
        "if command -v journalctl >/dev/null 2>&1; then",
        "  echo tool",
        `  ${existing(JOURNAL_DIRS)}`,
        `  [ $# -gt 0 ] && find "$@" -xdev -type f ${names(["*.journal", "*.journal~"])} ${STAT} | awk '{ p = $0; sub(/^[0-9]+ [0-9]+ /, "", p); printf "%.0f %s\\n", $1 * $2, p }'`,
        "fi",
        "m packages",
        "cache() { [ -d \"$2\" ] && printf '%s %s %s\\n' \"$1\" \"$(du -sk -- \"$2\" 2>/dev/null | cut -f 1)\" \"$2\"; return 0; }",
        "if command -v apt-get >/dev/null 2>&1; then echo apt; cache apt /var/cache/apt; fi",
        "if command -v dnf >/dev/null 2>&1; then echo dnf; cache dnf /var/cache/dnf; cache dnf /var/cache/libdnf5; elif command -v yum >/dev/null 2>&1; then echo yum; cache yum /var/cache/yum; fi",
        // apk keeps packages only when a cache is set up (/etc/apk/cache).
        "if command -v apk >/dev/null 2>&1; then echo apk; [ -e /etc/apk/cache ] && cache apk \"$(readlink -f /etc/apk/cache 2>/dev/null || echo /etc/apk/cache)\"; fi",
        "if command -v zypper >/dev/null 2>&1; then echo zypper; cache zypper /var/cache/zypp; fi",
        "m rotated",
        `[ -d /var/log ] && find ${rotatedLogsExpression(params["rotated-logs"].days ?? 0)} ${STAT} | top`,
        "m tmp",
        existing(TMP_DIRS),
        `[ $# -gt 0 ] && find ${tmpExpression("\"$@\"", params.tmp.days ?? 0)} ${STAT} | top`,
        "m core",
        existing(CORE_DIRS),
        `[ $# -gt 0 ] && find ${coreDumpsExpression("\"$@\"", params["core-dumps"].days ?? 0)} ${STAT} | top`,
        "m remove",
        REMOVAL_PROBE,
        "m where",
        `for d in ${where.map(shellQuote).join(" ")}; do [ -e "$d" ] && printf '%s\\t%s\\n' "$d" "$(df -P -- "$d" 2>/dev/null | awk 'NR == 2 { for (i = 6; i <= NF; i++) printf "%s%s", $i, (i < NF ? " " : "") }')"; done`,
        "m end",
        ""
    ].join("\n");
}

type FileLine = { bytes: number; modifiedAt: number; path: string };

function parseFileLines(text: string | undefined): { files: FileLine[]; count: number; bytes: number } {
    const files: FileLine[] = [];
    let count = 0;
    let bytes = 0;
    let total = false;
    for (const line of (text ?? "").split("\n")) {
        const sum = /^@@TOTAL (\d+) (\d+)$/.exec(line.trim());
        if (sum) {
            count = Number(sum[1]);
            bytes = Number(sum[2]);
            total = true;
            continue;
        }
        const match = /^(\d+) (\d+) (\/.*)$/.exec(line);
        if (match) files.push({ bytes: Number(match[1]), modifiedAt: Number(match[2]) * 1000, path: match[3] });
    }
    if (!total) {
        count = files.length;
        bytes = files.reduce((sum, file) => sum + file.bytes, 0);
    }
    return { files, count, bytes };
}

const asItems = (files: FileLine[]): CleanupItem[] => topItems(files.map((file) => ({ label: file.path, bytes: file.bytes, modifiedAt: file.modifiedAt })));

// Journal files with "@" in their name, or ending in "~", are archived: the
// only ones a vacuum removes, oldest first, while the journal as a whole
// (active files included) is over the size, or while they are too old.
const isArchived = (path: string) => path.endsWith("~") || path.slice(path.lastIndexOf("/") + 1).includes("@");

export function estimateVacuum(files: FileLine[], keepMB: number, keepDays: number, now = Date.now()): { bytes: number; removed: FileLine[] } {
    let total = files.reduce((sum, file) => sum + file.bytes, 0);
    const limit = keepMB * 1024 * 1024;
    const cutoff = keepDays > 0 ? now - keepDays * 86_400_000 : -Infinity;
    const removed: FileLine[] = [];
    for (const file of files.filter((entry) => isArchived(entry.path)).sort((a, b) => a.modifiedAt - b.modifiedAt)) {
        if (total <= limit && file.modifiedAt >= cutoff) break;
        removed.push(file);
        total -= file.bytes;
    }
    return { bytes: removed.reduce((sum, file) => sum + file.bytes, 0), removed };
}

export function journalCommand(params: CleanupParams): string {
    return `journalctl --vacuum-size=${params.keepMB ?? 200}M${params.keepDays ? ` --vacuum-time=${params.keepDays}d` : ""}`;
}

// "Vacuuming done, freed 1.2G of archived journals from /var/log/journal/..."
// (one line per journal directory).
export function parseVacuumOutput(output: string): number | null {
    const freed = [...output.matchAll(/freed ([\d.]+\s*[KMGTPE]?i?B?) of archived journals/gi)].map((match) => parseBinarySize(match[1]));
    if (!freed.length || freed.some((value) => value === null)) return null;
    return freed.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function managersOf(text: string | undefined): Array<{ manager: Manager; bytes: number }> {
    const found = new Map<Manager["id"], number>();
    for (const line of (text ?? "").split("\n")) {
        const [id, kb] = line.trim().split(" ");
        const manager = MANAGERS.find((entry) => entry.id === id);
        if (!manager) continue;
        found.set(manager.id, (found.get(manager.id) ?? 0) + (toInteger(kb) ?? 0) * 1024);
    }
    return MANAGERS.filter((manager) => found.has(manager.id)).map((manager) => ({ manager, bytes: found.get(manager.id) ?? 0 }));
}

function mountsOf(where: Map<string, string>, paths: string[], local: Set<string>): string[] {
    return [...new Set(paths.flatMap((path) => {
        const mount = where.get(path);
        return mount && local.has(mount) ? [mount] : [];
    }))];
}

export function fileCommand(id: Exclude<FileCleanupId, "journal" | "package-cache">, params: CleanupParams, mode: Removal = "delete"): string {
    const days = params.days ?? 0;
    if (id === "rotated-logs") return `find ${rotatedLogsExpression(days)} ${removing(mode)}`;
    if (id === "tmp") return `find ${tmpExpression(TMP_DIRS.join(" "), days)} ${removing(mode)}`;
    return `find ${coreDumpsExpression(CORE_DIRS.join(" "), days)} ${removing(mode)}`;
}

export function parseLinuxCleanups(output: string, caps: OpsCapabilities, localMounts: string[], params: Record<FileCleanupId, CleanupParams>, now = Date.now()): CleanupPreview[] {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new AppError("OPS_COMMAND_FAILED", "The cleanup check was cut off before it finished.", 502);
    const local = new Set(localMounts);
    const where = new Map((sections.get("where") ?? "").split("\n").flatMap((line) => {
        const [path, mount] = line.split("\t");
        return path && mount ? [[path, mount] as const] : [];
    }));
    const notElevated: CleanupUnavailable | undefined = isElevated(caps) ? undefined : { code: "NOT_ELEVATED", message: NOT_ELEVATED_MESSAGE.linux };
    const ready = (bytes: number | null, count: number | null) => (notElevated ? "unavailable" as const : (bytes ?? 0) > 0 || (count ?? 0) > 0 ? "ready" as const : "nothing" as const);
    const sudo = sudoPrefix(caps);
    const removal: Removal = sections.get("remove")?.trim() === "delete" ? "delete" : "rm";
    const previews: CleanupPreview[] = [];

    // The journal.
    const journalText = sections.get("journal") ?? "";
    const journalParams = params.journal;
    if (!journalText.startsWith("tool")) {
        previews.push({ id: "journal", status: "unavailable", reason: { code: "NOT_FOUND", message: "This server has no systemd journal." }, bytes: null, estimate: "about", count: null, items: [], mounts: [], command: journalCommand(journalParams), params: journalParams });
    } else {
        const files = parseFileLines(journalText.replace(/^tool\n?/, "")).files;
        const usage = files.reduce((sum, file) => sum + file.bytes, 0);
        const vacuum = estimateVacuum(files, journalParams.keepMB ?? 200, journalParams.keepDays ?? 0, now);
        previews.push({
            id: "journal",
            status: notElevated ? "unavailable" : vacuum.removed.length ? "ready" : "nothing",
            ...(notElevated ? { reason: notElevated } : {}),
            bytes: vacuum.bytes,
            estimate: "about",
            count: vacuum.removed.length,
            items: asItems(vacuum.removed),
            mounts: mountsOf(where, JOURNAL_DIRS, local),
            command: `${sudo}${journalCommand(journalParams)}`,
            params: journalParams,
            facts: { usage, files: files.length, archived: files.filter((file) => isArchived(file.path)).length }
        });
    }

    // Package caches.
    const managers = managersOf(sections.get("packages"));
    const packageParams = params["package-cache"];
    if (!managers.length) {
        previews.push({ id: "package-cache", status: "unavailable", reason: { code: "NOT_FOUND", message: "No apt, dnf, yum, apk or zypper on this server." }, bytes: null, estimate: "up-to", count: null, items: [], mounts: [], command: "apt-get clean", params: packageParams });
    } else {
        const bytes = managers.reduce((sum, entry) => sum + entry.bytes, 0);
        previews.push({
            id: "package-cache",
            status: notElevated ? "unavailable" : bytes > EMPTY_CACHE_BYTES ? "ready" : "nothing",
            ...(notElevated ? { reason: notElevated } : {}),
            bytes,
            estimate: "up-to",
            count: null,
            items: managers.map((entry) => ({ label: entry.manager.dirs.filter((dir) => where.has(dir)).join(", ") || entry.manager.id, bytes: entry.bytes })),
            mounts: mountsOf(where, managers.flatMap((entry) => entry.manager.dirs), local),
            command: managers.map((entry) => `${sudo}${entry.manager.command}`).join(" && "),
            params: packageParams,
            facts: { manager: managers.map((entry) => entry.manager.id).join(", ") }
        });
    }

    // Rotated logs, temporary files, core dumps.
    const lists: Array<[Exclude<FileCleanupId, "journal" | "package-cache">, string, string[]]> = [
        ["rotated-logs", "rotated", ["/var/log"]],
        ["tmp", "tmp", TMP_DIRS],
        ["core-dumps", "core", CORE_DIRS]
    ];
    for (const [id, section, paths] of lists) {
        const listed = parseFileLines(sections.get(section));
        previews.push({
            id,
            status: ready(listed.bytes, listed.count),
            ...(notElevated ? { reason: notElevated } : {}),
            bytes: listed.bytes,
            estimate: "about",
            count: listed.count,
            items: asItems(listed.files),
            mounts: mountsOf(where, paths, local),
            command: `${sudo}${fileCommand(id, params[id], removal)}`,
            params: params[id],
            facts: { removal }
        });
    }
    return previews;
}

function defaultParams(): Record<FileCleanupId, CleanupParams> {
    return Object.fromEntries(FILE_CLEANUPS.map((id) => [id, resolveCleanupParams(id, {}) ?? {}])) as Record<FileCleanupId, CleanupParams>;
}

async function measure(ctx: CleanupContext, params: Record<FileCleanupId, CleanupParams>): Promise<CleanupPreview[]> {
    const result = await runDiskScript(ctx.lease, ctx.caps, linuxCleanupScript(params), { timeoutMs: PREVIEW_TIMEOUT_MS, signal: ctx.signal });
    return parseLinuxCleanups(result.stdout, ctx.caps, ctx.mounts.map((mount) => mount.mount), params);
}

const isFileCleanup = (id: CleanupId): id is FileCleanupId => (FILE_CLEANUPS as readonly string[]).includes(id);

// Removes the files of a preview's expression (over the folders that exist),
// printing the first of them and how many there were. find exits 1 when a
// file vanished or could not be read on the way: what it could remove is
// gone all the same (its messages go with the output); worse is a failure.
// `mode`: what the preview found this server's find can do (see Removal).
export function fileRunScript(id: Exclude<FileCleanupId, "journal" | "package-cache">, params: CleanupParams, mode: Removal): string {
    const days = params.days ?? 0;
    const select = id === "rotated-logs"
        ? ["[ -d /var/log ] || { echo '0 files removed'; exit 0; }", `find ${rotatedLogsExpression(days)}`]
        : [
            existing(id === "tmp" ? TMP_DIRS : CORE_DIRS),
            "[ $# -gt 0 ] || { echo '0 files removed'; exit 0; }",
            `find ${id === "tmp" ? tmpExpression("\"$@\"", days) : coreDumpsExpression("\"$@\"", days)}`
        ];
    const find = select.pop()!;
    return [
        "LC_ALL=C",
        "export LC_ALL",
        ...select,
        TEMP_DIR,
        `{ ${find} -print ${removing(mode)} 2>"$e"; echo $? >"$d/rc"; } | awk 'NR <= 20 { print } END { print NR " files removed" }'`,
        "head -n 20 \"$e\" >&2",
        "r=$(cat \"$d/rc\" 2>/dev/null)",
        TEMP_DIR_CLEANUP,
        "[ \"${r:-1}\" -le 1 ] && exit 0",
        "exit \"$r\"",
        ""
    ].join("\n");
}

function journalRun(params: CleanupParams): string {
    return ["LC_ALL=C", "export LC_ALL", `${journalCommand(params)} 2>&1`, ""].join("\n");
}

function packageRun(preview: CleanupPreview): string {
    const commands = preview.command.split(" && ").map((command) => command.replace(/^sudo -n /, ""));
    return ["LC_ALL=C", "export LC_ALL", "r=0", ...commands.map((command) => `${command} 2>&1 || r=$?`), "exit $r", ""].join("\n");
}

export const linuxFileCleanups: CleanupProvider = {
    ids: FILE_CLEANUPS,
    overview: (ctx) => measure(ctx, defaultParams()),
    preview: async (ctx, id, params) => {
        if (!isFileCleanup(id)) throw new AppError("OPS_UNSUPPORTED", `${id} is not a file cleanup.`, 409);
        const all = await measure(ctx, { ...defaultParams(), [id]: params });
        return all.find((preview) => preview.id === id)!;
    },
    prepare: async (ctx, id, params): Promise<PreparedCleanup> => {
        const preview = await linuxFileCleanups.preview(ctx, id, params);
        const fileId = id as FileCleanupId;
        const removal: Removal = preview.facts?.removal === "delete" ? "delete" : "rm";
        const script = fileId === "journal" ? journalRun(params) : fileId === "package-cache" ? packageRun(preview) : fileRunScript(fileId, params, removal);
        return {
            preview,
            action: {
                display: preview.command,
                meta: { kind: "disk", action: `cleanup-${id}`, target: preview.mounts.join(", ") || "/" },
                run: (lease, signal) => runDiskScript(lease, ctx.caps, script, { timeoutMs: RUN_TIMEOUT_MS, signal })
            },
            reported: fileId === "journal" ? parseVacuumOutput : undefined
        };
    }
};
