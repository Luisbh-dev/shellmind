import { execFile, spawn, type ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import { createLogger } from "../logger";
import { CommandLineError } from "./argv";
import { localProcessEnv } from "./env";
import { envValue } from "./resolve";

// Starting local programs without a shell, and stopping them with everything
// they started.

const log = createLogger("local");

export type CommandSpec = {
    file: string;
    args: string[];
    windowsVerbatimArguments: boolean;
};

// Characters cmd.exe gives a meaning to; each is escaped with a caret.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;
// cmd.exe expands %VAR% and (with delayed expansion) !VAR! even when escaped
// in some contexts, and a command line cannot hold line breaks or NULs.
const CMD_UNSAFE = /[%!\r\n\0]/;

function escapeCmdCommand(file: string): string {
    return file.replace(CMD_META, "^$1");
}

// Quotes one argument for the Microsoft C runtime (what the program parses),
// then escapes every cmd.exe metacharacter, quotes included, twice: once for
// the `cmd /c` line and once more because batch wrappers such as az.cmd and
// gcloud.cmd hand their arguments on with %*, which cmd parses again.
function escapeCmdArgument(arg: string): string {
    let quoted = arg.replace(/(\\*)"/g, "$1$1\\\"");
    quoted = quoted.replace(/(\\*)$/, "$1$1");
    quoted = `"${quoted}"`;
    return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

// How to start `file` with `args`. Programs run directly (no shell). Windows
// batch files (.cmd/.bat) can only run through cmd.exe, so they get an
// explicitly escaped command line; arguments cmd.exe cannot carry safely are
// refused.
export function commandSpec(
    file: string,
    args: string[],
    options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {}
): CommandSpec {
    const platform = options.platform ?? process.platform;
    if (platform !== "win32" || !/\.(cmd|bat)$/i.test(file)) {
        return { file, args, windowsVerbatimArguments: false };
    }
    const unsafe = args.find((arg) => CMD_UNSAFE.test(arg));
    if (unsafe !== undefined) {
        throw new CommandLineError(
            "The characters % and ! and line breaks cannot be passed safely to a Windows batch command; remove them from the arguments.",
            "batch-unsafe"
        );
    }
    const comspec = envValue(options.env ?? process.env, "ComSpec", platform) || "cmd.exe";
    const line = [escapeCmdCommand(file), ...args.map(escapeCmdArgument)].join(" ");
    return { file: comspec, args: ["/d", "/v:off", "/s", "/c", `"${line}"`], windowsVerbatimArguments: true };
}

export type SpawnOptions = {
    cwd?: string;
    env: NodeJS.ProcessEnv;
};

// Spawns the program with pipes. On POSIX it leads its own process group, so
// killProcessTree() reaches whatever it starts.
export function spawnCommand(file: string, args: string[], options: SpawnOptions): ChildProcess {
    const spec = commandSpec(file, args, { env: options.env });
    return spawn(spec.file, spec.args, {
        cwd: options.cwd,
        env: options.env,
        windowsHide: true,
        windowsVerbatimArguments: spec.windowsVerbatimArguments,
        detached: process.platform !== "win32",
        stdio: "pipe"
    });
}

function isRunning(child: ChildProcess): boolean {
    return child.pid !== undefined && child.exitCode === null && child.signalCode === null;
}

// Stops the process and every process it started. Windows has no process
// groups: taskkill /T walks the tree. Elsewhere the group gets `signal`
// (SIGINT for Ctrl+C, SIGTERM otherwise).
export function killProcessTree(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
    const pid = child.pid;
    if (pid === undefined || !isRunning(child)) return;
    if (process.platform === "win32") {
        execFile("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, env: localProcessEnv() }, (err) => {
            // Already gone, or taskkill unavailable: at least end the direct child.
            if (err && isRunning(child)) {
                try { child.kill(); } catch { /* already exited */ }
            }
        });
        return;
    }
    try {
        process.kill(-pid, signal);
    } catch {
        try { child.kill(signal); } catch { /* already exited */ }
    }
}

export type RunResult = { stdout: string; stderr: string; code: number | null };

// Runs a program to completion (no shell) and collects its output. Never
// rejects: a spawn failure comes back as code null with the reason in stderr.
export function runCommand(file: string, args: string[], options: SpawnOptions & { timeoutMs: number }): Promise<RunResult> {
    return new Promise((resolve) => {
        let child: ChildProcess;
        try {
            child = spawnCommand(file, args, options);
        } catch (err) {
            resolve({ stdout: "", stderr: (err as Error).message, code: null });
            return;
        }
        const out = new StringDecoder("utf8");
        const errOut = new StringDecoder("utf8");
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (code: number | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ stdout: stdout + out.end(), stderr: stderr + errOut.end(), code });
        };
        const timer = setTimeout(() => {
            killProcessTree(child, "SIGKILL");
            finish(null);
        }, options.timeoutMs);
        child.stdout?.on("data", (chunk: Buffer) => { stdout += out.write(chunk); });
        child.stderr?.on("data", (chunk: Buffer) => { stderr += errOut.write(chunk); });
        child.stdin?.on("error", () => { /* the program does not read stdin */ });
        child.stdin?.end();
        child.on("error", (err) => {
            log.debug(`Could not run ${file}: ${err.message}`);
            stderr += err.message;
            finish(null);
        });
        child.on("close", (code) => finish(code));
    });
}
