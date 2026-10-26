import type { PodTerminalAttach } from "../../shared/k8s";
import { recordAudit } from "../db/auditRepo";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { hangUpScript, TERMINAL_TAG_VARIABLE } from "../ops/containerShell";
import { asString, extractJson, isRecord } from "../ops/remote";
import { kubectlFailure, kubectlMessage } from "./errors";
import { sshKubectlCommand, type KubectlRunner } from "./runner";
import { contextArgs, READ_TIMEOUT_MS } from "./service";
import { openKubectl, requireKnownContext, type KubectlSession } from "./session";

const log = createLogger("k8s");

// A terminal inside a pod's container (StartSshPayload.attach kind "pod"):
// `kubectl exec -it`, on a pty of the server's pooled SSH connection or, for
// a local kubectl server, in a local pseudo-terminal. bash when the
// container has it, else sh. Like a container's shell (ops/containerShell),
// the shell carries a random tag in its environment: when the terminal goes
// away while the shell still runs, the exec stream may leave it running in
// the container, and hangUpPodShell() hangs it up the way a closing
// terminal would. Opening and ending one is recorded in the audit log.

const HANG_UP_TIMEOUT_MS = 20_000;

// Run by `sh -c` inside the container (the remote login shell only ever sees
// it single-quoted).
export function podShellScript(tag: string): string {
    return `export ${TERMINAL_TAG_VARIABLE}=${tag}; command -v bash >/dev/null 2>&1 && exec bash; exec sh`;
}

export function podExecArgs(attach: PodTerminalAttach, interactive: boolean, script: string): string[] {
    return [
        "--context", attach.context,
        "-n", attach.namespace,
        "exec", ...(interactive ? ["-it"] : []),
        attach.pod, "-c", attach.container,
        "--", "sh", "-c", script
    ];
}

// One command line for the local pseudo-terminal: each argument quoted the
// way server/local/argv.ts splits it again (single quotes keep everything,
// backslashes of a Windows path included).
export function localCommandLine(argv: string[]): string {
    return argv.map((arg) => {
        if (!arg.includes("'")) return `'${arg}'`;
        if (!arg.includes("\"") && !arg.includes("\\")) return `"${arg}"`;
        throw new AppError("K8S_INVALID_INPUT", "The kubectl path contains quotes ShellMind cannot pass on.", 400);
    }).join(" ");
}

// Fails with K8S_NOT_FOUND or K8S_CONTAINER_NOT_RUNNING (details.state) before
// a terminal opens, instead of a terminal that closes at once.
export async function requireRunningContainer(runner: KubectlRunner, attach: PodTerminalAttach, signal?: AbortSignal): Promise<void> {
    const result = await runner.run([...contextArgs(attach.context), "get", "pod", attach.pod, "-n", attach.namespace, "-o", "json"], { timeoutMs: READ_TIMEOUT_MS, signal });
    if (result.code !== 0) throw kubectlFailure(result);
    const pod = extractJson(result.stdout);
    const status = isRecord(pod) && isRecord(pod.status) ? pod.status : {};
    const statuses = [...(Array.isArray(status.containerStatuses) ? status.containerStatuses : []), ...(Array.isArray(status.initContainerStatuses) ? status.initContainerStatuses : [])];
    const container = statuses.find((entry) => isRecord(entry) && entry.name === attach.container);
    if (!isRecord(container)) {
        throw new AppError("K8S_NOT_FOUND", `The pod ${attach.pod} has no container ${attach.container}.`, 404, { container: attach.container });
    }
    const state = isRecord(container.state) ? container.state : {};
    if (isRecord(state.running)) return;
    const reason = isRecord(state.waiting) ? asString(state.waiting.reason) : isRecord(state.terminated) ? asString(state.terminated.reason) || "Terminated" : "";
    throw new AppError("K8S_CONTAINER_NOT_RUNNING", `The container ${attach.container} of ${attach.pod} is not running${reason ? ` (${reason})` : ""}.`, 409, { state: reason || "unknown" });
}

export type PodShell =
    // The pty command for the SSH server's login shell.
    | { runner: "ssh"; command: string; display: string }
    // The program and arguments for this machine's pseudo-terminal.
    | { runner: "local"; commandLine: string; display: string };

// Checks everything a pod terminal needs (kubectl, the context, a running
// container) and returns its command. The opening is audited here.
export async function preparePodShell(serverId: unknown, attach: PodTerminalAttach, tag: string, signal?: AbortSignal): Promise<PodShell> {
    const session = await openKubectl(serverId, { signal });
    try {
        requireKnownContext(session.status, attach.context);
        await requireRunningContainer(session.runner, attach, signal);
        const args = podExecArgs(attach, true, podShellScript(tag));
        const path = session.status.kubectl?.path ?? "kubectl";
        // The tag stays out of the audit log: it names a terminal, not a command.
        const display = session.runner.display(podExecArgs(attach, true, "command -v bash >/dev/null && exec bash || exec sh"));
        const shell: PodShell = session.lease
            ? { runner: "ssh", command: sshKubectlCommand(path, session.status.sudo, args), display }
            : { runner: "local", commandLine: localCommandLine([path, ...args]), display };
        await audit(session.runner.serverId, display, attach, "shell", null);
        return shell;
    } finally {
        session.release();
    }
}

async function audit(serverId: number, command: string, attach: PodTerminalAttach, action: "shell" | "shell-end", exitCode: number | null, extra: Record<string, unknown> = {}): Promise<void> {
    try {
        await recordAudit({
            serverId,
            source: "ops",
            command,
            exitCode,
            meta: { kind: "k8s", action, target: attach.pod, context: attach.context, namespace: attach.namespace, container: attach.container, ...extra }
        });
    } catch (err) {
        log.error(`Could not record the shell of ${attach.pod} in the audit log:`, err);
    }
}

// Hangs up what the terminal tagged `tag` left running in the container
// (best effort: a cluster that cannot be reached now keeps it).
export function hangUpPodShell(serverId: number, attach: PodTerminalAttach, tag: string): void {
    void (async () => {
        let session: KubectlSession;
        try {
            session = await openKubectl(serverId);
        } catch (err) {
            log.info(`Could not end the shell in ${attach.namespace}/${attach.pod} on server #${serverId}: ${errorMessage(err)}`);
            return;
        }
        try {
            const args = podExecArgs(attach, false, hangUpScript(tag));
            const result = await session.runner.run(args, { timeoutMs: HANG_UP_TIMEOUT_MS });
            const count = /hung-up (\d+)/.exec(result.stdout);
            if (result.code !== 0) log.info(`Ending the shell in ${attach.pod} on server #${serverId} failed (exit ${result.code}): ${kubectlMessage(result).slice(0, 300)}`);
            await audit(serverId, session.runner.display(podExecArgs(attach, false, "<hang-up script of the closed terminal>")), attach, "shell-end", result.code, { processes: count ? Number(count[1]) : null });
        } catch (err) {
            log.warn(`Could not end the shell in ${attach.pod} on server #${serverId}: ${errorMessage(err)}`);
        } finally {
            session.release();
        }
    })();
}
