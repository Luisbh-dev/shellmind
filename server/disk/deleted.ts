import {
    DELETED_RELEASE_ACTIONS,
    isValidDecimal,
    isValidFd,
    isValidPid,
    isValidProcessName,
    type DeletedOpenFile,
    type DeletedOpenResult,
    type DeletedReleaseAction,
    type DiskMount
} from "../../shared/disk";
import { isValidContainerRef, isValidServiceName, type OpsCapabilities } from "../../shared/ops";
import { AppError } from "../errors";
import type { PreparedAction } from "../ops/actions";
import { prepareContainerAction } from "../ops/containers";
import { POSIX_SECTION_FUNCTION, parseSections, shellQuote } from "../ops/remote";
import { OpsUnsupportedError, prepareServiceAction } from "../ops/services";
import type { SshLease } from "../ssh/pool";
import { isElevated, requireElevated, runDiskScript, sudoPrefix, toInteger } from "./remote";
import { InvalidDiskInputError } from "./usage";

// Files that were deleted while a process still holds them open: their
// space only comes back when the process closes them. Found with
// `lsof +L1` where lsof is installed, else from the /proc/<pid>/fd links
// that end in " (deleted)"; either way each one is checked in /proc (still
// deleted, on this filesystem) and sized there. The process's cgroup tells
// the systemd unit or the container that runs it.

const SCAN_TIMEOUT_MS = 45_000;
const ACTION_TIMEOUT_MS = 30_000;
// Candidates checked at most (a process may hold thousands).
const MAX_CANDIDATES = 2000;

// $st: the start time of process $pid, in clock ticks after boot ('' when it
// has ended). The 20th field after the name, which ends at the last ") ".
const PROCESS_START = [
    "  st=$(cat \"/proc/$pid/stat\" 2>/dev/null)",
    "  st=${st##*\") \"}",
    "  set -- $st",
    "  st=${20:-}"
];

export function deletedScanScript(mount: string): string {
    return [
        "LC_ALL=C",
        "export LC_ALL",
        POSIX_SECTION_FUNCTION,
        `p=${shellQuote(mount)}`,
        "dev=$(stat -c %d -- \"$p\" 2>/dev/null)",
        "T=",
        "command -v timeout >/dev/null 2>&1 && T=\"timeout 30\"",
        // The real lsof (busybox has an applet of that name without options).
        "S=proc",
        "command -v lsof >/dev/null 2>&1 && lsof -v 2>&1 | grep -qi revision && S=lsof",
        // pid<TAB>fd of every open file that has no name left.
        "candidates() {",
        "  if [ \"$S\" = lsof ]; then",
        "    $T lsof -nP -w +L1 -F pf 2>/dev/null | awk '/^p[0-9]+$/ { pid = substr($0, 2); next } /^f[0-9]+$/ { print pid \"\\t\" substr($0, 2) }'",
        "  else",
        "    ls -l /proc/[0-9]*/fd 2>/dev/null | awk '/^\\/proc\\/[0-9]+\\/fd:$/ { split($0, a, \"/\"); pid = a[3]; next } / \\(deleted\\)$/ { i = index($0, \" -> \"); if (!i) next; n = split(substr($0, 1, i - 1), f, \" \"); print pid \"\\t\" f[n] }'",
        "  fi",
        "}",
        "m source",
        "echo \"$S\"",
        "m files",
        `out=$(candidates | head -n ${MAX_CANDIDATES} | while IFS="$(printf '\\t')" read -r pid fd; do`,
        "  f=/proc/$pid/fd/$fd",
        "  t=$(readlink \"$f\" 2>/dev/null) || continue",
        "  case \"$t\" in *' (deleted)') ;; *) continue;; esac",
        // Size, device and inode: the inode names the file for a release.
        "  s=$(stat -L -c '%s %d %i' \"$f\" 2>/dev/null) || continue",
        "  set -- $s",
        "  [ \"$2\" = \"$dev\" ] || continue",
        "  printf 'F\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$pid\" \"$fd\" \"$1\" \"$3\" \"$t\"",
        "done)",
        "[ -n \"$out\" ] && printf '%s\\n' \"$out\"",
        "m procs",
        "printf '%s\\n' \"$out\" | cut -f 2 | sort -u | while read -r pid; do",
        "  [ -n \"$pid\" ] || continue",
        "  u=$(stat -c %U \"/proc/$pid\" 2>/dev/null)",
        "  c=$(tr '\\n' ' ' < \"/proc/$pid/cgroup\" 2>/dev/null)",
        "  n=$(cat \"/proc/$pid/comm\" 2>/dev/null)",
        // The start time (field 22 of /proc/<pid>/stat, after the name in
        // parentheses, which may hold anything): with the pid, it names the
        // process, as a new process can get the pid of one that ended.
        ...PROCESS_START,
        "  printf 'P\\t%s\\t%s\\t%s\\t%s\\t%s\\n' \"$pid\" \"$u\" \"$c\" \"$st\" \"$n\"",
        "done",
        "m end",
        ""
    ].join("\n");
}

const CONTAINER_PATTERNS = [
    /docker-([0-9a-f]{64})\.scope/,
    /\/docker\/([0-9a-f]{64})(?:[/\s]|$)/,
    /libpod-([0-9a-f]{64})\.scope/,
    /\/libpod-([0-9a-f]{64})(?:[/\s]|$)/
];

// What runs a process, from /proc/<pid>/cgroup (its lines joined by
// spaces): a system service (/system.slice/<unit>.service), or a Docker or
// Podman container. User sessions and Kubernetes pods are neither.
export function ownerOf(cgroup: string): { unit: string | null; container: string | null } {
    for (const pattern of CONTAINER_PATTERNS) {
        const match = pattern.exec(cgroup);
        if (match) return { unit: null, container: match[1].slice(0, 12) };
    }
    const paths = cgroup.split(/\s+/).flatMap((line) => {
        const match = /^\d+:([^:]*):(.*)$/.exec(line);
        // The unified hierarchy (cgroup v2) or systemd's own (v1).
        return match && (match[1] === "" || match[1] === "name=systemd") ? [match[2]] : [];
    });
    for (const path of paths) {
        if (!path.startsWith("/system.slice/")) continue;
        const unit = path.split("/").filter((segment) => segment.endsWith(".service")).pop();
        if (unit && isValidServiceName("linux", unit)) return { unit, container: null };
    }
    return { unit: null, container: null };
}

const digits = (value: string | undefined): string | null => (value !== undefined && isValidDecimal(value.trim()) ? value.trim() : null);

export function parseDeletedScan(output: string): { files: DeletedOpenFile[]; source: DeletedOpenResult["source"] } {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new AppError("OPS_COMMAND_FAILED", "The open-file check was cut off before it finished.", 502);
    type Owner = Pick<DeletedOpenFile, "user" | "process" | "started" | "unit" | "container">;
    const processes = new Map<number, Owner>();
    for (const line of (sections.get("procs") ?? "").split("\n")) {
        const [tag, pid, user, cgroup, started, ...name] = line.split("\t");
        if (tag !== "P" || !pid) continue;
        processes.set(Number(pid), { user: user || null, process: name.join("\t").trim() || "?", started: digits(started), ...ownerOf(cgroup ?? "") });
    }
    const files = (sections.get("files") ?? "").split("\n").flatMap((line): DeletedOpenFile[] => {
        const [tag, pid, fd, size, inode, ...target] = line.split("\t");
        const pidNumber = toInteger(pid);
        const fdNumber = toInteger(fd);
        const bytes = toInteger(size);
        // Empty ones hold no space (a log emptied already, the temporary
        // files programs unlink right away): not worth a row.
        if (tag !== "F" || pidNumber === null || fdNumber === null || bytes === null || bytes === 0) return [];
        const owner: Owner = processes.get(pidNumber) ?? { user: null, process: "?", started: null, unit: null, container: null };
        const path = target.join("\t").replace(/ \(deleted\)$/, "");
        return [{ pid: pidNumber, fd: fdNumber, bytes, path, inode: digits(inode), ...owner }];
    }).sort((a, b) => b.bytes - a.bytes || a.pid - b.pid || a.fd - b.fd);
    return { files, source: sections.get("source")?.trim() === "lsof" ? "lsof" : "proc" };
}

export function requireLinuxProcFs(caps: OpsCapabilities): void {
    if (caps.platform !== "linux") throw new OpsUnsupportedError("Windows does not keep deleted files open: this check is for Linux servers.");
}

export async function findDeletedOpenFiles(lease: SshLease, caps: OpsCapabilities, mount: DiskMount, signal?: AbortSignal): Promise<DeletedOpenResult> {
    requireLinuxProcFs(caps);
    const result = await runDiskScript(lease, caps, deletedScanScript(mount.mount), { timeoutMs: SCAN_TIMEOUT_MS, signal });
    const { files, source } = parseDeletedScan(result.stdout);
    const elevated = isElevated(caps);
    return {
        mount: mount.mount,
        files,
        totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
        source,
        partial: !elevated,
        elevated,
        collectedAt: Date.now()
    };
}

export type ReleaseInput = {
    action: DeletedReleaseAction;
    pid: number;
    fd: number | null;
    process: string;
    // From the scan (digits), when it could read them.
    started: string | null;
    inode: string | null;
    unit: string | null;
    container: string | null;
};

export function parseReleaseInput(body: Record<string, unknown>): ReleaseInput {
    const action = typeof body.action === "string" ? body.action : "";
    if (!(DELETED_RELEASE_ACTIONS as readonly string[]).includes(action)) throw new InvalidDiskInputError(`"${action.slice(0, 40)}" is not a way to release a deleted file.`);
    if (!isValidPid(body.pid)) throw new InvalidDiskInputError("pid must be a process id.");
    if (!isValidProcessName(body.process)) throw new InvalidDiskInputError("process must be the name of the process.");
    if (body.started !== undefined && !isValidDecimal(body.started)) throw new InvalidDiskInputError("started must be the start time of the process, in digits.");
    const input: ReleaseInput = { action: action as DeletedReleaseAction, pid: body.pid, fd: null, process: body.process, started: body.started ?? null, inode: null, unit: null, container: null };
    if (input.action === "truncate") {
        if (!isValidFd(body.fd)) throw new InvalidDiskInputError("fd must be a file descriptor number.");
        if (body.inode !== undefined && !isValidDecimal(body.inode)) throw new InvalidDiskInputError("inode must be the inode number of the file, in digits.");
        input.fd = body.fd;
        input.inode = body.inode ?? null;
    }
    if (input.action === "restart-service") {
        if (typeof body.unit !== "string" || !isValidServiceName("linux", body.unit)) throw new InvalidDiskInputError("unit must be a systemd service name.");
        input.unit = body.unit;
    }
    if (input.action === "restart-container") {
        if (typeof body.container !== "string" || !isValidContainerRef(body.container)) throw new InvalidDiskInputError("container must be a container id.");
        input.container = body.container;
    }
    return input;
}

// The checks before a process is touched: it still runs under the name the
// user saw, and started when the scan saw it start (a pid can be reused).
// Exit 3 with the reason otherwise.
function processCheck(pid: number, name: string, started: string | null): string[] {
    const lines = [
        `c=$(cat /proc/${pid}/comm 2>/dev/null) || { echo 'Process ${pid} is no longer running.' >&2; exit 3; }`,
        `[ "$c" = ${shellQuote(name)} ] || { echo "Process ${pid} is now $c, not the one listed." >&2; exit 3; }`
    ];
    if (started !== null) {
        lines.push(
            `pid=${pid}`,
            ...PROCESS_START.map((line) => line.trim()),
            `[ "$st" = ${started} ] || { echo 'Process ${pid} is another process than the one listed: it started after the scan.' >&2; exit 3; }`
        );
    }
    return lines;
}

// Truncating opens the descriptor once, as fd 3 of this shell: the checks
// (still deleted, a regular file of this filesystem, the inode the scan
// saw) and the truncation all go through /proc/$$/fd/3. Going through
// /proc/<pid>/fd/<fd> each time would let the process, which may belong to
// any user, point that descriptor at another file between the checks and
// root's write.
const HELD = "/proc/$$/fd/3";

export function releaseScript(mount: string, input: ReleaseInput, command: string): string {
    const lines = ["LC_ALL=C", "export LC_ALL", ...processCheck(input.pid, input.process, input.started)];
    if (input.action === "truncate") {
        const link = `/proc/${input.pid}/fd/${input.fd}`;
        lines.push(
            // A FIFO would block the open below, which ends the script if it
            // fails (a redirection of exec).
            `[ -f ${link} ] || { echo 'The process closed that file already, or it is not a regular file.' >&2; exit 3; }`,
            `exec 3< ${link}`,
            `t=$(readlink ${HELD} 2>/dev/null) || { echo 'The process closed that file already.' >&2; exit 3; }`,
            "case \"$t\" in *' (deleted)') ;; *) echo 'That descriptor no longer holds a deleted file.' >&2; exit 3;; esac",
            `[ -f ${HELD} ] || { echo 'That descriptor no longer holds a regular file.' >&2; exit 3; }`,
            `[ "$(stat -L -c %d ${HELD} 2>/dev/null)" = "$(stat -c %d -- ${shellQuote(mount)} 2>/dev/null)" ] || { echo 'That file is not on this filesystem.' >&2; exit 3; }`,
            ...(input.inode === null ? [] : [`[ "$(stat -L -c %i ${HELD} 2>/dev/null)" = ${input.inode} ] || { echo 'That descriptor now holds another file than the one listed.' >&2; exit 3; }`])
        );
    }
    if (input.action === "restart-service" && input.unit) {
        lines.push(`grep -q ${shellQuote(`/${input.unit}`)} /proc/${input.pid}/cgroup 2>/dev/null || { echo 'The process no longer runs in ${input.unit}.' >&2; exit 3; }`);
    }
    if (input.action === "restart-container" && input.container) {
        lines.push(`grep -q ${shellQuote(input.container)} /proc/${input.pid}/cgroup 2>/dev/null || { echo 'The process no longer runs in that container.' >&2; exit 3; }`);
    }
    lines.push(command, "");
    return lines.join("\n");
}

// The release as an audited action. Restarts reuse the operations panels'
// service and container actions after the same checks.
export function prepareRelease(caps: OpsCapabilities, mount: DiskMount, input: ReleaseInput): PreparedAction {
    requireLinuxProcFs(caps);
    const target = `${input.process} (pid ${input.pid})`;
    if (input.action === "restart-service" || input.action === "restart-container") {
        const inner = input.action === "restart-service"
            ? prepareServiceAction(caps, input.unit ?? "", "restart")
            : prepareContainerAction(caps, input.container ?? "", "restart");
        return {
            display: inner.display,
            meta: { kind: "disk", action: input.action, target: input.unit ?? input.container ?? target },
            run: async (lease, signal) => {
                // The check runs with the privileges of the scan, then the restart itself.
                const check = await runDiskScript(lease, caps, releaseScript(mount.mount, input, "exit 0"), { timeoutMs: ACTION_TIMEOUT_MS, signal });
                if (check.code !== 0) return check;
                return inner.run(lease, signal);
            }
        };
    }
    requireElevated(caps);
    // The script opens fd 3 among its checks; the display says it in one line.
    const command = input.action === "truncate" ? `: > ${HELD}` : `kill -TERM ${input.pid}`;
    const shown = input.action === "truncate" ? `exec 3< /proc/${input.pid}/fd/${input.fd} && ${command}` : command;
    const sudo = sudoPrefix(caps);
    // A redirection needs a shell of its own to run as root.
    const display = sudo && input.action === "truncate" ? `${sudo}sh -c ${shellQuote(shown)}` : `${sudo}${shown}`;
    return {
        display,
        meta: { kind: "disk", action: input.action, target: input.fd === null ? target : `${target}, fd ${input.fd}` },
        run: (lease, signal) => runDiskScript(lease, caps, releaseScript(mount.mount, input, command), { timeoutMs: ACTION_TIMEOUT_MS, signal })
    };
}
