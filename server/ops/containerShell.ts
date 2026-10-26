import { randomBytes } from "crypto";
import { isValidContainerRef, isValidContainerShell, type OpsCapabilities } from "../../shared/ops";
import type { TerminalAttach } from "../../shared/protocol";
import { AppError } from "../errors";
import type { ExecResult } from "../ssh/exec";
import type { SshLease } from "../ssh/pool";
import { engineCommand, runEngine } from "./containers";
import { commandFailure, isRecord } from "./remote";

// W7-S3: a terminal session inside one of the server's containers
// (StartSshPayload.attach). The client names the engine, the container and
// optionally a shell; everything is validated here and the command is
// `<engine> exec -it <container> <shell>`, run on a pty of the server's
// pooled SSH connection (server/sockets/terminal.ts). The engine and whether
// it needs `sudo -n` come from the server's detected capabilities.
//
// Docker and Podman keep an exec'd process running when its client goes
// away: closing the SSH channel ends `docker exec`, not the shell inside the
// container. So each terminal tags its shell with an environment variable
// (TERMINAL_TAG_VARIABLE), and once the channel has closed without the shell
// exiting, hangUpScript() hangs up that shell and its jobs, as a terminal
// closing would.

const CHECK_TIMEOUT_MS = 15_000;
const HANG_UP_TIMEOUT_MS = 20_000;

export const TERMINAL_TAG_VARIABLE = "SHELLMIND_TERMINAL";
const TAG_PATTERN = /^[a-f0-9]{32}$/;

// A new terminal's tag (random: nothing else in a container carries it).
export function newTerminalTag(): string {
    return randomBytes(16).toString("hex");
}

function requireTag(tag: string): string {
    if (!TAG_PATTERN.test(tag)) throw new Error("Not a terminal tag.");
    return tag;
}

// Without a chosen shell: bash when the container has it, else sh. It runs
// as `sh -c`, so the remote login shell only ever sees it single-quoted.
export const AUTO_SHELL_SCRIPT = "command -v bash >/dev/null 2>&1 && exec bash; exec sh";

const invalid = (message: string) => new AppError("INVALID_ATTACH", message, 400);

// The attach field of a start-ssh request: null when there is none; throws
// INVALID_ATTACH for anything that is not a valid container reference.
export function parseTerminalAttach(value: unknown): TerminalAttach | null {
    if (value === undefined || value === null) return null;
    if (!isRecord(value) || value.kind !== "container") throw invalid("Unknown kind of terminal attachment.");
    const { engine, container, shell } = value;
    if (engine !== "docker" && engine !== "podman") throw invalid("The container engine must be docker or podman.");
    if (typeof container !== "string" || !isValidContainerRef(container)) throw invalid("Not a valid container name or id.");
    if (shell !== undefined && shell !== null && shell !== "" && (typeof shell !== "string" || !isValidContainerShell(shell))) {
        throw invalid("Not a valid shell: give a program name (bash, sh) or an absolute path.");
    }
    return { kind: "container", engine, container, ...(typeof shell === "string" && shell ? { shell } : {}) };
}

function engineFor(caps: OpsCapabilities, attach: TerminalAttach) {
    if (caps.platform !== "linux") {
        throw new AppError("CONTAINER_SHELL_UNSUPPORTED", "Container shells are available on Linux servers.", 409);
    }
    const engine = caps.containers.engine;
    if (!engine) {
        const problem = caps.containers.problem ?? "No container engine is available on this server.";
        throw new AppError("NO_CONTAINER_ENGINE", problem, 409, { problem });
    }
    if (engine !== attach.engine) {
        throw new AppError("CONTAINER_ENGINE_MISMATCH", `This server's container engine is ${engine}, not ${attach.engine}.`, 409, { engine, requested: attach.engine });
    }
    return { engine, caps };
}

// The remote command of the container's terminal (quoted for the login shell).
export function containerShellCommand(caps: OpsCapabilities, attach: TerminalAttach, tag: string): string {
    const shell = attach.shell ? [attach.shell] : ["sh", "-c", AUTO_SHELL_SCRIPT];
    return engineCommand(engineFor(caps, attach), ["exec", "-it", "-e", `${TERMINAL_TAG_VARIABLE}=${requireTag(tag)}`, attach.container, ...shell]);
}

// Run with sh inside the container (as its default user, like the shell):
// the terminal's shell is the tagged process the engine started (parent 0 in
// the container) that leads its own session. Every other process of that
// session (its jobs, in the foreground or not) gets SIGHUP first, so the
// shell can reap them; the shell gets it a second later. Programs started
// with nohup ignore it and keep running; daemons left the session (setsid)
// and are not touched, although they carry the tag. Prints "hung-up <count>".
export function hangUpScript(tag: string): string {
    const stat = "s=; { read -r s < \"$d/stat\"; } 2>/dev/null; set -- ${s##*') '}";
    return [
        `t='${TERMINAL_TAG_VARIABLE}=${requireTag(tag)}'; l=; n=0`,
        `for f in $(grep -l -F "$t" /proc/[0-9]*/environ 2>/dev/null); do d=\${f%/environ}; p=\${d#/proc/}; ${stat}; [ "\${2:-}" = 0 ] && [ "\${4:-}" = "$p" ] && l="$l $p"; done`,
        `[ -z "$l" ] || for d in /proc/[0-9]*; do p=\${d#/proc/}; ${stat}; for x in $l; do [ "\${4:-}" = "$x" ] && [ "$p" != "$x" ] && kill -HUP "$p" 2>/dev/null && n=$((n+1)); done; done`,
        `[ "$n" = 0 ] || sleep 1`,
        `for x in $l; do kill -HUP "$x" 2>/dev/null && n=$((n+1)); done`,
        `echo "hung-up $n"`
    ].join("; ");
}

export type HangUpOutcome = { command: string; result: ExecResult; processes: number | null };

// Hangs up what the terminal tagged `tag` left running in the container.
export async function hangUpContainerShell(lease: SshLease, caps: OpsCapabilities, attach: TerminalAttach, tag: string): Promise<HangUpOutcome> {
    const target = engineFor(caps, attach);
    const args = ["exec", attach.container, "sh", "-c", hangUpScript(tag)];
    const result = await runEngine(lease, target, args, { timeoutMs: HANG_UP_TIMEOUT_MS });
    const count = /hung-up (\d+)/.exec(result.stdout);
    return { command: engineCommand(target, args), result, processes: count ? Number(count[1]) : null };
}

// Fails with CONTAINER_NOT_FOUND or CONTAINER_NOT_RUNNING (details.state)
// before a terminal is opened, instead of a terminal that closes at once.
export async function requireRunningContainer(lease: SshLease, caps: OpsCapabilities, attach: TerminalAttach, signal?: AbortSignal): Promise<void> {
    const target = engineFor(caps, attach);
    const ref = attach.container;
    const result = await runEngine(lease, target, ["inspect", "--type", "container", "--format", "{{.State.Status}}", ref], { timeoutMs: CHECK_TIMEOUT_MS, signal });
    const output = result.stdout.trim();
    if (result.code !== 0) {
        if (/no such (container|object)|no container with name or id/i.test(output)) {
            throw new AppError("CONTAINER_NOT_FOUND", `The container ${ref} does not exist.`, 404, { container: ref });
        }
        throw commandFailure(result, "Checking the container failed");
    }
    const state = output.split("\n").pop()?.trim().toLowerCase() || "unknown";
    if (state !== "running") {
        throw new AppError("CONTAINER_NOT_RUNNING", `The container ${ref} is not running (${state}).`, 409, { container: ref, state });
    }
}
