import { StringDecoder } from "string_decoder";
import type * as NodePty from "node-pty";
import { createLogger } from "../logger";
import { CommandLineError, parseCommandLine } from "./argv";
import { localProcessEnv } from "./env";
import { killProcessTree, spawnCommand } from "./process";
import { resolveExecutable } from "./resolve";

const log = createLogger("local");

let nodePtyModule: typeof NodePty | null = null;
let nodePtyTried = false;
function loadNodePty(): typeof NodePty | null {
    if (nodePtyTried) return nodePtyModule;
    nodePtyTried = true;
    try {
        // Optional native module, loaded lazily so the server still starts without it.
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        nodePtyModule = require("node-pty") as typeof NodePty;
    } catch (err) {
        log.warn(`node-pty unavailable, local terminals use basic mode: ${(err as Error).message}`);
        nodePtyModule = null;
    }
    return nodePtyModule;
}

function defaultLocalShell(): { file: string; args: string[] } {
    if (process.platform === "win32") return { file: "powershell.exe", args: ["-NoLogo"] };
    return { file: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

export type LocalTermHandlers = {
    onData: (chunk: string) => void;
    onExit: () => void;
};

export interface LocalTermHandle {
    write(data: string): void;
    resize(cols: number, rows: number): void;
    // Flow control: stop reading the program's output until resume().
    pause(): void;
    resume(): void;
    kill(): void;
}

export type LocalTerminalConfig = {
    // Program and arguments as typed in the connection settings; the
    // platform's shell when empty.
    command?: string;
    cwd?: string;
    initialCommand?: string;
    cols?: number;
    rows?: number;
};

const DEAD_HANDLE: LocalTermHandle = {
    write: () => undefined,
    resize: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    kill: () => undefined
};

// The program a local terminal runs: the saved command split into arguments
// (quotes and paths with spaces work) and resolved on PATH.
async function resolveProgram(command: string | undefined, env: NodeJS.ProcessEnv): Promise<{ file: string; args: string[] }> {
    let program = defaultLocalShell();
    if (command?.trim()) {
        const parsed = parseCommandLine(command.trim());
        if (parsed.operator) {
            throw new CommandLineError(`The command runs without a shell, so "${parsed.operator === "newline" ? "line breaks" : parsed.operator}" is not supported. Start a shell instead, e.g. cmd /c "…" or sh -c '…'.`);
        }
        if (!parsed.argv.length) throw new CommandLineError("The command is empty.");
        program = { file: parsed.argv[0], args: parsed.argv.slice(1) };
    }
    const file = await resolveExecutable(program.file, { env });
    if (!file) throw new CommandLineError(`"${program.file}" was not found. Check the command in the connection settings.`);
    return { file, args: program.args };
}

// Starts a local shell (or the configured program) in a pseudo-terminal. When
// it cannot be started the session ends right away with the reason.
export async function startLocalTerminal(config: LocalTerminalConfig, handlers: LocalTermHandlers): Promise<LocalTermHandle> {
    const cols = config.cols || 80;
    const rows = config.rows || 24;
    const cwd = config.cwd?.trim() || process.env.HOME || process.env.USERPROFILE || process.cwd();
    const env = localProcessEnv();

    let ended = false;
    const end = () => {
        if (ended) return;
        ended = true;
        handlers.onExit();
    };
    const failToStart = (reason: string) => {
        // After the caller has the handle, like any other exit.
        setImmediate(() => {
            handlers.onData(`\r\n\x1b[31m[ShellMind] The local terminal could not start: ${reason}\x1b[0m\r\n`);
            end();
        });
        return DEAD_HANDLE;
    };

    let program: { file: string; args: string[] };
    try {
        program = await resolveProgram(config.command, env);
    } catch (err) {
        return failToStart((err as Error).message);
    }
    const { file, args } = program;

    const sendInitial = (write: (text: string) => void, newline: string) => {
        const cmd = config.initialCommand?.trim();
        if (!cmd) return;
        setTimeout(() => {
            if (!ended) write(cmd + newline);
        }, 700);
    };

    const pty = loadNodePty();
    if (pty) {
        let term: NodePty.IPty;
        try {
            term = pty.spawn(file, args, { name: "xterm-256color", cols, rows, cwd, env });
        } catch (err) {
            return failToStart((err as Error).message);
        }
        term.onData((chunk) => { if (!ended) handlers.onData(chunk); });
        term.onExit(() => end());
        sendInitial((text) => term.write(text), "\r");
        return {
            write: (data) => { if (!ended) { try { term.write(data); } catch { /* exited */ } } },
            resize: (c, r) => { try { term.resize(Math.max(1, c), Math.max(1, r)); } catch { /* exited */ } },
            pause: () => { try { term.pause(); } catch { /* exited */ } },
            resume: () => { try { term.resume(); } catch { /* exited */ } },
            kill: () => {
                ended = true;
                try { term.kill(); } catch { /* already exited */ }
            }
        };
    }

    // Without node-pty: plain pipes (no line editing, no full-screen programs).
    handlers.onData("\r\n[ShellMind] node-pty is not available: basic mode (limited interactivity).\r\n");
    let child: ReturnType<typeof spawnCommand>;
    try {
        child = spawnCommand(file, args, { cwd, env });
    } catch (err) {
        return failToStart((err as Error).message);
    }
    const out = new StringDecoder("utf8");
    const errOut = new StringDecoder("utf8");
    child.stdout?.on("data", (chunk: Buffer) => { if (!ended) handlers.onData(out.write(chunk)); });
    child.stderr?.on("data", (chunk: Buffer) => { if (!ended) handlers.onData(errOut.write(chunk)); });
    child.stdin?.on("error", () => { /* the program stopped reading */ });
    child.on("error", (err) => {
        handlers.onData(`\r\n\x1b[31m[ShellMind] Failed to start '${file}': ${err.message}\x1b[0m\r\n`);
        end();
    });
    // 'close', not 'exit': a failed spawn only emits 'error' and 'close'.
    child.on("close", () => end());
    sendInitial((text) => child.stdin?.write(text), "\n");
    return {
        write: (data) => { if (!ended && child.stdin?.writable) child.stdin.write(data); },
        resize: () => { /* pipes have no size */ },
        pause: () => { child.stdout?.pause(); child.stderr?.pause(); },
        resume: () => { child.stdout?.resume(); child.stderr?.resume(); },
        kill: () => {
            ended = true;
            killProcessTree(child);
        }
    };
}
