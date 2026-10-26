import type { ChildProcess } from "child_process";
import { StringDecoder } from "string_decoder";
import type { CliRefusal } from "../../shared/terminal";
import { CommandLineError, parseCommandLine } from "./argv";
import { localProcessEnv } from "./env";
import { killProcessTree, spawnCommand } from "./process";
import type { LocalTermHandle, LocalTermHandlers } from "./pty";
import { resolveExecutable } from "./resolve";

// How long a finished command may keep its output pipes open (held by a
// process it left behind) before the console takes the prompt back.
const CLOSE_GRACE_MS = 1500;
const HISTORY_LIMIT = 100;

export type ScopedCliConfig = {
    // The tool every line runs, e.g. "docker".
    bin: string;
    cwd?: string;
    initialCommand?: string;
    subcommands?: string[];
    initialHistory?: string[];
    onHistoryChange?: (history: string[]) => void;
    // A line was refused. Without this handler the console prints the reason
    // itself (in English); with it, the caller tells the user.
    onRefused?: (reason: CliRefusal, detail?: string) => void;
};

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function defaultCwd(): string {
    return process.env.HOME || process.env.USERPROFILE || process.cwd();
}

// The console reads the tool's output from pipes as UTF-8. On Windows,
// Python writes to a pipe in the ANSI code page (cp1252...), and three of the
// presets (az, aws, gcloud) are Python: "Configuración" arrived as
// "Configuraci�n". Python's UTF-8 mode makes them write UTF-8, unless the
// user chose an encoding of their own.
export function scopedCliEnv(platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
    const env = localProcessEnv();
    if (platform !== "win32") return env;
    // Windows variable names are case-insensitive.
    const names = new Set(Object.keys(env).map((name) => name.toUpperCase()));
    if (!names.has("PYTHONUTF8")) env.PYTHONUTF8 = "1";
    if (!names.has("PYTHONIOENCODING")) env.PYTHONIOENCODING = "utf-8";
    return env;
}

/**
 * Scoped CLI console: shows a `<bin>>` prompt and runs each entered line as
 * `<bin> <args>`. The line is split into arguments here and the tool is
 * started directly, never through a shell, so pipes, redirections, `;`/`&&`
 * chains and substitutions are refused instead of reaching cmd.exe or sh.
 * `exit`/`quit` closes it; Ctrl+C stops the running command and everything
 * it started.
 */
export function startScopedCli(config: ScopedCliConfig, handlers: LocalTermHandlers): LocalTermHandle {
    const cwd = config.cwd?.trim() || defaultCwd();
    const env = scopedCliEnv();
    const bin = config.bin;
    const subcommands = config.subcommands || [];
    const promptLabel = `\x1b[36m${bin}>\x1b[0m `;
    const history: string[] = (config.initialHistory || []).filter((entry) => typeof entry === "string").slice(-HISTORY_LIMIT);
    let histIdx = history.length;
    const resolved = resolveExecutable(bin, { env });

    let mode: "prompt" | "running" = "prompt";
    // Read through a function: submit() changes the mode as a side effect.
    const isRunning = () => mode === "running";
    let line = "";
    let child: ChildProcess | null = null;
    let cancelled = false;
    let closed = false;
    let paused = false;

    const emit = (text: string) => { if (!closed) handlers.onData(text); };
    // A refused line: the caller's notice, or the English text.
    const refuse = (reason: CliRefusal, text: string, detail?: string) => {
        if (closed) return;
        if (config.onRefused) config.onRefused(reason, detail);
        else emit(`\x1b[33m${text}\x1b[0m\r\n`);
    };
    // Errors from parsing or starting a command line.
    const refuseLine = (err: CommandLineError) => {
        if (err.reason === "other") emit(`\x1b[33m${err.message}\x1b[0m\r\n`);
        else refuse(err.reason, err.message, err.detail);
    };
    const writePrompt = () => emit("\r\n" + promptLabel);
    // Redraws the current input line in place (history recall).
    const redrawLine = () => emit("\r\x1b[K" + promptLabel + line);
    const recall = (delta: number) => {
        if (!history.length) return;
        histIdx = Math.max(0, Math.min(history.length, histIdx + delta));
        line = histIdx < history.length ? history[histIdx] : "";
        redrawLine();
    };

    const commonPrefix = (items: string[]) => {
        let prefix = items[0] ?? "";
        for (const item of items) { while (!item.startsWith(prefix)) prefix = prefix.slice(0, -1); }
        return prefix;
    };
    // Tab-completes the first word against the tool's common subcommands.
    const complete = () => {
        if (!subcommands.length || /\s/.test(line)) return;
        const matches = subcommands.filter((sub) => sub.startsWith(line.toLowerCase()));
        if (!matches.length) return;
        if (matches.length === 1) {
            line = matches[0] + " ";
            redrawLine();
        } else {
            const common = commonPrefix(matches);
            if (common.length > line.length) line = common;
            emit("\r\n" + matches.join("   ") + "\r\n" + promptLabel + line);
        }
    };

    // Lines typed or pasted while a command runs wait for the next prompt.
    let typeAhead = "";
    const backToPrompt = () => {
        child = null;
        cancelled = false;
        mode = "prompt";
        line = "";
        writePrompt();
        if (typeAhead) {
            const pending = typeAhead;
            typeAhead = "";
            handleInput(pending);
        }
    };

    const close = () => {
        if (closed) return;
        closed = true;
        if (child) killProcessTree(child);
        child = null;
        handlers.onExit();
    };

    const startChild = (file: string, args: string[]) => {
        let cp: ChildProcess;
        try {
            cp = spawnCommand(file, args, { cwd, env });
        } catch (err) {
            if (err instanceof CommandLineError) refuseLine(err);
            else emit(`${bin}: ${(err as Error).message}\r\n`);
            backToPrompt();
            return;
        }
        child = cp;
        let finished = false;
        let graceTimer: NodeJS.Timeout | null = null;
        const finish = () => {
            if (finished) return;
            finished = true;
            if (graceTimer) clearTimeout(graceTimer);
            const tail = out.end() + errOut.end();
            if (tail) emit(tail.replace(/\r?\n/g, "\r\n"));
            if (child === cp && !closed) backToPrompt();
        };

        // Bare LF becomes CRLF so the terminal does not stair-step.
        const out = new StringDecoder("utf8");
        const errOut = new StringDecoder("utf8");
        cp.stdout?.on("data", (chunk: Buffer) => emit(out.write(chunk).replace(/\r?\n/g, "\r\n")));
        cp.stderr?.on("data", (chunk: Buffer) => emit(errOut.write(chunk).replace(/\r?\n/g, "\r\n")));
        cp.stdin?.on("error", () => { /* the command stopped reading its input */ });
        if (paused) {
            cp.stdout?.pause();
            cp.stderr?.pause();
        }
        cp.on("error", (err) => {
            emit(`${bin}: ${err.message}\r\n`);
            finish();
        });
        // A process the command started may hold the pipes open after it
        // exits; output held back by flow control is still read first.
        const awaitClose = () => {
            graceTimer = setTimeout(() => {
                if (paused) {
                    awaitClose();
                    return;
                }
                cp.stdout?.destroy();
                cp.stderr?.destroy();
                finish();
            }, CLOSE_GRACE_MS);
        };
        cp.on("exit", awaitClose);
        cp.on("close", finish);
    };

    const runLine = async (raw: string) => {
        // Pasted or AI-written lines often repeat the prompt or the tool:
        // "docker> ps", "docker> docker ps" and "docker docker ps" are all "ps".
        const toolName = escapeRegExp(bin);
        let input = raw.trim().replace(new RegExp(`^(?:${toolName}>\\s*)+`, "i"), "").trim();
        while (new RegExp(`^${toolName}(?:\\s+${toolName})+(?:\\s|$)`, "i").test(input)) {
            input = input.replace(new RegExp(`^${toolName}\\s+`, "i"), "").trim();
        }

        if (!input) { writePrompt(); return; }
        const lower = input.toLowerCase();
        if (lower === "exit" || lower === "quit") { emit("\r\n"); close(); return; }
        if (lower === "clear" || lower === "cls") { emit("\x1b[2J\x1b[H"); writePrompt(); return; }
        emit("\r\n");

        let argv: string[];
        try {
            const parsed = parseCommandLine(input);
            if (parsed.operator === "newline") {
                refuse("line-break", `This console only runs ${bin} commands: pipes, redirections and chaining with line breaks are not available. Run one command per line, or open a shell connection for a full shell.`);
                writePrompt();
                return;
            }
            if (parsed.operator) {
                refuse("operator", `This console only runs ${bin} commands: pipes, redirections and chaining with "${parsed.operator}" are not available. Quote the character if it is part of an argument, or open a shell connection for a full shell.`, parsed.operator);
                writePrompt();
                return;
            }
            argv = parsed.argv;
        } catch (err) {
            if (!(err instanceof CommandLineError)) throw err;
            refuseLine(err);
            writePrompt();
            return;
        }
        // Both "ps" and "docker ps" run `docker ps`.
        if (argv[0]?.toLowerCase() === bin.toLowerCase()) argv = argv.slice(1);

        mode = "running";
        const file = await resolved;
        if (closed) return;
        if (cancelled) { backToPrompt(); return; }
        if (!file) {
            if (config.onRefused) config.onRefused("not-found");
            else emit(`${bin}: command not found on PATH\r\n`);
            backToPrompt();
            return;
        }
        startChild(file, argv);
    };

    const submit = (raw: string) => {
        runLine(raw).catch((err: Error) => {
            emit(`${bin}: ${err.message}\r\n`);
            backToPrompt();
        });
    };

    // First prompt (and the optional context command); the caller prints the
    // console's help line before it.
    setTimeout(() => {
        if (closed) return;
        if (config.initialCommand?.trim()) submit(config.initialCommand.trim());
        else writePrompt();
    }, 60);

    const setPaused = (value: boolean) => {
        paused = value;
        for (const stream of [child?.stdout, child?.stderr]) {
            if (!stream) continue;
            if (value) stream.pause();
            else stream.resume();
        }
    };

    function handleInput(data: string): void {
        if (closed) return;
        if (mode === "running") {
            // Ctrl+C stops the command and whatever it started; anything
            // else is its input (Enter as a newline: there is no TTY).
            if (data.includes("\x03")) {
                typeAhead = "";
                emit("^C\r\n");
                if (child) killProcessTree(child, "SIGINT");
                else cancelled = true;
            } else if (child?.stdin?.writable) {
                child.stdin.write(data.replace(/\r\n?/g, "\n"));
            }
            return;
        }
        // Prompt mode: line editor with echo, history (↑/↓) and Ctrl+L.
        for (let i = 0; i < data.length; i++) {
            const ch = data[i];
            if (ch === "\x1b") {
                // Arrow keys: ESC [ A / ESC O A (up), B (down).
                const intro = data[i + 1];
                const code = data[i + 2];
                if ((intro === "[" || intro === "O") && (code === "A" || code === "B")) {
                    recall(code === "A" ? -1 : 1);
                    i += 2;
                } else {
                    // Skips any other escape sequence up to its final byte.
                    let j = i + 1;
                    while (j < data.length && !/[A-Za-z~]/.test(data[j])) j++;
                    i = j;
                }
                continue;
            }
            if (ch === "\n" && data[i - 1] === "\r") continue;
            if (ch === "\r" || ch === "\n") {
                const current = line.trim();
                if (current && history[history.length - 1] !== current) {
                    history.push(current);
                    if (history.length > HISTORY_LIMIT) history.shift();
                    config.onHistoryChange?.(history.slice());
                }
                histIdx = history.length;
                const submitted = line;
                line = "";
                submit(submitted);
                if (isRunning()) {
                    // The rest of a pasted block runs once this command is done.
                    typeAhead += data.slice(i + 1).replace(/^\n/, "");
                    return;
                }
            } else if (ch === "\t") {
                complete();
            } else if (ch === "\x7f" || ch === "\b") {
                if (line.length) { line = line.slice(0, -1); emit("\b \b"); }
            } else if (ch === "\x03") {
                line = "";
                emit("^C");
                writePrompt();
            } else if (ch === "\x15") {
                // Ctrl+U: clear the line.
                line = "";
                redrawLine();
            } else if (ch === "\x0c") {
                // Ctrl+L: clear the screen but keep the current line.
                emit("\x1b[2J\x1b[H" + promptLabel + line);
            } else if (ch >= " ") {
                line += ch;
                emit(ch);
            }
        }
    }

    return {
        write: handleInput,
        resize: () => { /* pipes have no size */ },
        pause: () => setPaused(true),
        resume: () => setPaused(false),
        kill: () => {
            if (closed) return;
            closed = true;
            typeAhead = "";
            if (child) killProcessTree(child);
            child = null;
        }
    };
}
