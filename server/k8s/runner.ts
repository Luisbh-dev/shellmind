import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import type { K8sRunner } from "../../shared/k8s";
import { AppError } from "../errors";
import { localProcessEnv } from "../local/env";
import { killProcessTree, spawnCommand } from "../local/process";
import { runPosixScript, shellQuote } from "../ops/remote";
import { ExecAbortedError, ExecOutputTooLargeError, ExecTimeoutError, execStream, type StreamFlow } from "../ssh/exec";
import type { SshLease } from "../ssh/pool";

// Where kubectl runs. A local server with the kubectl preset runs the
// backend machine's kubectl (and kubeconfig) directly, never through a shell;
// an SSH server runs it on the server, as a script for `sh -s` whose every
// argument is single-quoted. Both take a fixed argv that server/k8s builds
// from validated names, and both are bounded: a timeout (credential plugins
// can wait for a browser sign-in forever), a cap on the output, and an abort
// signal that kills the command when its request goes away.

export type KubectlResult = { stdout: string; stderr: string; code: number | null };

export type KubectlRunOptions = {
    timeoutMs: number;
    signal?: AbortSignal;
    // Bytes of stdout and stderr together (DEFAULT_MAX_OUTPUT_BYTES by default).
    maxOutputBytes?: number;
};

export type KubectlStreamOptions = {
    signal: AbortSignal;
    // stdout as it arrives (and stderr, without onStderr).
    onData: (text: string) => void;
    // kubectl's own messages (stderr), kept apart from the output.
    onStderr?: (text: string) => void;
    // Pause/resume of the source, for backpressure (see server/sockets/logs.ts).
    onFlow?: (flow: StreamFlow) => void;
};

export interface KubectlRunner {
    readonly kind: K8sRunner;
    readonly serverId: number;
    // The command as a user would type it (audit log, evidence sources).
    display(args: readonly string[]): string;
    run(args: readonly string[], options: KubectlRunOptions): Promise<KubectlResult>;
    // Until the command ends or the signal aborts it.
    stream(args: readonly string[], options: KubectlStreamOptions): Promise<{ code: number | null }>;
}

// A namespace with a few thousand pods prints tens of MB of JSON.
export const DEFAULT_MAX_OUTPUT_BYTES = 48 * 1024 * 1024;

export class K8sTimeoutError extends AppError {
    constructor(timeoutMs: number) {
        super(
            "K8S_TIMEOUT",
            `kubectl did not answer within ${Math.round(timeoutMs / 1000)} s. The cluster may be unreachable, or its credential plugin may be waiting for a sign-in: run any kubectl command once in a terminal.`,
            504,
            { seconds: Math.round(timeoutMs / 1000) }
        );
        this.name = "K8sTimeoutError";
    }
}

// An argument as the audit log shows it: quoted only when a shell would need it.
export function displayArg(arg: string): string {
    return /^[A-Za-z0-9_./:@=,+%-]+$/.test(arg) ? arg : shellQuote(arg);
}

// --- local (the backend's own machine) ---

type Collected = { stdout: string; stderr: string };

// Runs `file args` to completion with pipes and no shell (Windows batch
// wrappers get the escaped cmd.exe line of server/local/process.ts).
function runLocal(file: string, args: readonly string[], options: KubectlRunOptions): Promise<KubectlResult> {
    return new Promise((resolve, reject) => {
        const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
        if (options.signal?.aborted) {
            reject(new ExecAbortedError());
            return;
        }
        let child: ChildProcess;
        try {
            child = spawnCommand(file, [...args], { env: localProcessEnv() });
        } catch (err) {
            resolve({ stdout: "", stderr: (err as Error).message, code: null });
            return;
        }
        const out = new StringDecoder("utf8");
        const errOut = new StringDecoder("utf8");
        const collected: Collected = { stdout: "", stderr: "" };
        let received = 0;
        let settled = false;
        const finish = (outcome: { code: number | null } | { error: Error }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            options.signal?.removeEventListener("abort", onAbort);
            if ("error" in outcome) {
                killProcessTree(child, "SIGKILL");
                reject(outcome.error);
                return;
            }
            resolve({ stdout: collected.stdout + out.end(), stderr: collected.stderr + errOut.end(), code: outcome.code });
        };
        const take = (stream: "stdout" | "stderr", decoder: StringDecoder) => (chunk: Buffer) => {
            received += chunk.length;
            if (received > maxBytes) {
                finish({ error: new ExecOutputTooLargeError(maxBytes) });
                return;
            }
            collected[stream] += decoder.write(chunk);
        };
        const onAbort = () => finish({ error: new ExecAbortedError() });
        const timer = setTimeout(() => finish({ error: new K8sTimeoutError(options.timeoutMs) }), options.timeoutMs);
        options.signal?.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", take("stdout", out));
        child.stderr?.on("data", take("stderr", errOut));
        // kubectl reads nothing; a credential plugin asking for input gets EOF.
        child.stdin?.on("error", () => { /* the program does not read stdin */ });
        child.stdin?.end();
        child.on("error", (err) => {
            collected.stderr += err.message;
            finish({ code: null });
        });
        child.on("close", (code) => finish({ code }));
    });
}

function streamLocal(file: string, args: readonly string[], options: KubectlStreamOptions): Promise<{ code: number | null }> {
    return new Promise((resolve, reject) => {
        if (options.signal.aborted) {
            reject(new ExecAbortedError());
            return;
        }
        let child: ChildProcess;
        try {
            child = spawnCommand(file, [...args], { env: localProcessEnv() });
        } catch (err) {
            reject(new AppError("K8S_COMMAND_FAILED", (err as Error).message, 502));
            return;
        }
        const out = new StringDecoder("utf8");
        const errOut = new StringDecoder("utf8");
        let settled = false;
        const onAbort = () => killProcessTree(child);
        const onStderr = options.onStderr ?? options.onData;
        options.signal.addEventListener("abort", onAbort, { once: true });
        child.stdout?.on("data", (chunk: Buffer) => options.onData(out.write(chunk)));
        child.stderr?.on("data", (chunk: Buffer) => onStderr(errOut.write(chunk)));
        child.stdin?.on("error", () => { /* the program does not read stdin */ });
        child.stdin?.end();
        options.onFlow?.({
            pause: () => { child.stdout?.pause(); child.stderr?.pause(); },
            resume: () => { child.stdout?.resume(); child.stderr?.resume(); }
        });
        const finish = (code: number | null, error?: Error) => {
            if (settled) return;
            settled = true;
            options.signal.removeEventListener("abort", onAbort);
            const rest = out.end();
            if (rest) options.onData(rest);
            const restErr = errOut.end();
            if (restErr) onStderr(restErr);
            if (error) reject(new AppError("K8S_COMMAND_FAILED", error.message, 502));
            else if (options.signal.aborted) reject(new ExecAbortedError());
            else resolve({ code });
        };
        child.on("error", (err) => finish(null, err));
        child.on("close", (code) => finish(code));
    });
}

export function localRunner(serverId: number, kubectl: string): KubectlRunner {
    return {
        kind: "local",
        serverId,
        display: (args) => ["kubectl", ...args].map(displayArg).join(" "),
        run: (args, options) => runLocal(kubectl, args, options),
        stream: (args, options) => streamLocal(kubectl, args, options)
    };
}

// --- SSH (the saved server) ---

// The kubectl command line for the server's shell: the path detection found
// (an absolute path, see detect.ts), every argument single-quoted.
export function sshKubectlCommand(kubectl: string, sudo: boolean, args: readonly string[]): string {
    return `${sudo ? "sudo -n " : ""}${shellQuote(kubectl)} ${args.map(shellQuote).join(" ")}`.trimEnd();
}

// A streaming command that ends when its SSH channel closes, like
// withWatchdog() of server/ops/logs.ts (which this mirrors), but with
// kubectl's stderr left on the channel's stderr instead of in the output.
export function watched(command: string): string {
    const script = `exec 3<&0; ${command} </dev/null & p=$!; { read -r _ <&3; kill $p 2>/dev/null; } & w=$!; wait $p; r=$?; kill $w 2>/dev/null; exit $r`;
    return `sh -c ${shellQuote(script)}`;
}

export function sshRunner(lease: SshLease, kubectl: string, sudo: boolean): KubectlRunner {
    const command = (args: readonly string[]) => sshKubectlCommand(kubectl, sudo, args);
    return {
        kind: "ssh",
        serverId: lease.serverId,
        display: (args) => `${sudo ? "sudo -n " : ""}${["kubectl", ...args].map(displayArg).join(" ")}`,
        run: async (args, options) => {
            try {
                const result = await runPosixScript(lease, `LC_ALL=C\nexport LC_ALL\nexec ${command(args)}\n`, {
                    timeoutMs: options.timeoutMs,
                    signal: options.signal,
                    maxOutputBytes: options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
                });
                return { stdout: result.stdout, stderr: result.stderr, code: result.code };
            } catch (err) {
                if (err instanceof ExecTimeoutError) throw new K8sTimeoutError(options.timeoutMs);
                throw err;
            }
        },
        stream: async (args, options) => {
            const { code } = await execStream(lease, watched(`LC_ALL=C ${command(args)}`), {
                onData: options.onData,
                onStderr: options.onStderr ?? options.onData,
                signal: options.signal,
                onFlow: options.onFlow
            });
            return { code };
        }
    };
}
