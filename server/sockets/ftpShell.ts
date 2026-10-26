import type { FileEntry } from "../../shared/files";
import { errorMessage } from "../errors";
import { normalizeRemotePath } from "../files/paths";
import type { RemoteFs } from "../files/remoteFs";
import type { SocketSession } from "./session";

// Virtual shell for FTP connections: echoes input, buffers it into lines and
// runs each complete line as a small file command (ls, cd, pwd, mkdir, rm,
// cat). Lines are taken out of the buffer as soon as they arrive and run one
// after another by a single worker, through the connection's FTP queue.

const PROMPT = "ftp> ";
// A line longer than this is cut (nothing legitimate needs more).
const MAX_LINE = 8 * 1024;
const MAX_CAT_BYTES = 1024 * 1024;

export type FtpShellState = {
    // The line being typed.
    buffer: string;
    // The login directory until the first command reads it.
    cwd: string | null;
    // Submitted lines waiting for the worker.
    lines: string[];
    running: boolean;
};

export function createFtpShellState(): FtpShellState {
    return { buffer: "", cwd: null, lines: [], running: false };
}

// Splits a command line into words; "double" or 'single' quotes keep spaces.
export function shellWords(line: string): string[] {
    return [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
}

function resolvePath(cwd: string, arg: string | undefined): string {
    if (!arg) return cwd;
    return normalizeRemotePath(arg.startsWith("/") ? arg : `${cwd}/${arg}`);
}

function formatEntry(entry: FileEntry): string {
    const type = entry.isDir ? "d" : entry.isLink ? "l" : "-";
    const mode = entry.permissions || (entry.isDir ? 0o755 : 0o644);
    const bits = [6, 3, 0].map((shift) => {
        const value = (mode >> shift) & 7;
        return `${value & 4 ? "r" : "-"}${value & 2 ? "w" : "-"}${value & 1 ? "x" : "-"}`;
    }).join("");
    const date = entry.mtime ? new Date(entry.mtime * 1000).toISOString().slice(0, 10) : "----------";
    return `${type}${bits} ${String(entry.size).padStart(12)} ${date} ${entry.name}`;
}

async function runCommand(fs: RemoteFs, state: FtpShellState, cwd: string, line: string): Promise<string> {
    const [command = "", arg] = shellWords(line);
    switch (command.toLowerCase()) {
        case "ls":
        case "dir":
        case "ll": {
            const { entries } = await fs.list(resolvePath(cwd, arg));
            return entries.map(formatEntry).join("\r\n") + (entries.length ? "\r\n" : "");
        }
        case "cd": {
            const target = resolvePath(cwd, arg ?? "/");
            const stat = await fs.stat(target);
            if (!stat) return `No such directory: ${target}\r\n`;
            if (!stat.isDir) return `Not a directory: ${target}\r\n`;
            // Only a directory that exists becomes the working directory.
            state.cwd = target;
            return `Changed directory to ${target}\r\n`;
        }
        case "pwd":
            return `${cwd}\r\n`;
        case "mkdir": {
            if (!arg) return "Usage: mkdir <path>\r\n";
            await fs.mkdir(resolvePath(cwd, arg));
            return `Created directory ${arg}\r\n`;
        }
        case "rm": {
            if (!arg) return "Usage: rm <path>\r\n";
            const target = resolvePath(cwd, arg);
            const result = await fs.remove([{ path: target, isDir: false }]);
            if (result.failures.length) return `Error: ${result.failures[0].message}\r\n`;
            return `Removed ${target}\r\n`;
        }
        case "cat": {
            if (!arg) return "Usage: cat <path>\r\n";
            const { data } = await fs.readFile(resolvePath(cwd, arg), MAX_CAT_BYTES);
            const text = data.toString("utf8").replace(/\r?\n/g, "\r\n");
            return text.endsWith("\r\n") ? text : `${text}\r\n`;
        }
        case "help":
            return "Supported commands: ls, dir, cd, pwd, mkdir, rm, cat\r\n";
        default:
            return `Command not found: ${command}\r\n`;
    }
}

async function drain(session: SocketSession, state: FtpShellState): Promise<void> {
    const { socket } = session;
    state.running = true;
    try {
        // A reset session gets a new state: its worker just stops.
        while (state.lines.length && session.ftpShell === state) {
            const line = (state.lines.shift() ?? "").trim();
            socket.emit("ssh-output", "\r\n");
            if (line) {
                let output: string;
                try {
                    const fs = session.fs;
                    if (!fs) throw new Error("FTP connection lost");
                    const cwd = state.cwd ?? await fs.home().catch(() => "/");
                    state.cwd ??= cwd;
                    output = await runCommand(fs, state, state.cwd, line);
                } catch (err) {
                    output = `Error: ${errorMessage(err)}\r\n`;
                }
                if (session.ftpShell !== state) return;
                socket.emit("ssh-output", output);
            }
            socket.emit("ssh-output", PROMPT);
        }
    } finally {
        state.running = false;
    }
}

export function handleFtpShellInput(session: SocketSession, data: string): void {
    const { socket } = session;
    const state = session.ftpShell;

    if (data === "\u007F") {
        if (state.buffer.length > 0) {
            state.buffer = state.buffer.slice(0, -1);
            socket.emit("ssh-output", "\b \b");
        }
        return;
    }
    socket.emit("ssh-output", data);

    state.buffer += data.replace(/\r\n?/g, "\n");
    const parts = state.buffer.split("\n");
    state.buffer = parts.pop() ?? "";
    if (state.buffer.length > MAX_LINE) {
        state.buffer = state.buffer.slice(0, MAX_LINE);
        socket.emit("ssh-output", `\r\n[line longer than ${MAX_LINE} characters, truncated]\r\n`);
    }
    if (!parts.length) return;
    state.lines.push(...parts.map((line) => line.slice(0, MAX_LINE)));
    if (!state.running) void drain(session, state);
}
