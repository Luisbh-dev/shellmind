import path from "path";
import { cliPresetInfo, matchPrompt, programName, shellOfProgram } from "../../shared/shells";
import type { ServerSummary, ServerType } from "../../shared/types";

// Where the chat's commands run, derived from data ShellMind controls (the
// saved server, the backend platform) so the system prompt can describe the
// right shell. Remote text (the OS banner, terminal output) only picks between
// known variants; it never reaches the system prompt verbatim.
export type ShellKind = "posix" | "cmd" | "powershell" | "scoped" | "ftp" | "program" | "none";
export type OsFamily = "linux" | "windows" | "macos" | "unknown";

export type ChatEnvironment = {
    kind: ShellKind;
    location: "remote" | "local" | "none";
    osFamily: OsFamily;
    serverName?: string;
    serverType?: ServerType;
    // bash, zsh, cmd.exe, PowerShell...
    shellName?: string;
    // Scoped CLI console: the tool binary and its name.
    scopedBin?: string;
    toolName?: string;
    // Custom local command (its program name).
    program?: string;
};

export type EnvironmentInput = {
    server: ServerSummary | null;
    // OS reported by the live session (untrusted remote text).
    osDetail?: string;
    // Recent terminal output (untrusted): only its last prompt is looked at.
    terminalOutput?: string;
    platform?: NodeJS.Platform;
    shellPath?: string;
};

export function classifyOs(detail: string | null | undefined): OsFamily {
    const text = detail ?? "";
    if (/windows|microsoft/i.test(text)) return "windows";
    if (/darwin|mac\s?os|os x/i.test(text)) return "macos";
    if (/linux|ubuntu|debian|cent\s?os|red ?hat|rhel|fedora|alpine|arch|suse|rocky|alma|amazon|oracle|raspbian|mint|gentoo|nixos|kali/i.test(text)) return "linux";
    return "unknown";
}

function platformFamily(platform: NodeJS.Platform): OsFamily {
    if (platform === "win32") return "windows";
    if (platform === "darwin") return "macos";
    if (platform === "linux") return "linux";
    return "unknown";
}

// The prompt on the last non-empty lines of the terminal: "PS C:\>" is
// PowerShell, "C:\Users\me>" is cmd.exe.
export function promptShell(terminalOutput: string | undefined): "powershell" | "cmd" | null {
    if (!terminalOutput) return null;
    const lines = terminalOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(-5).reverse();
    for (const line of lines) {
        const shell = matchPrompt(line)?.shell;
        if (shell === "powershell" || shell === "cmd") return shell;
    }
    return null;
}

function localEnvironment(server: ServerSummary, platform: NodeJS.Platform, shellPath: string | undefined): ChatEnvironment {
    const base = { location: "local" as const, osFamily: platformFamily(platform), serverName: server.name, serverType: server.type };

    const preset = cliPresetInfo(server.cli_preset);
    if (preset) return { ...base, kind: "scoped", scopedBin: preset.bin, toolName: preset.name };

    if (server.command?.trim()) {
        const program = programName(server.command);
        switch (shellOfProgram(program)) {
            case "cmd": return { ...base, kind: "cmd", shellName: "cmd.exe" };
            case "powershell": return { ...base, kind: "powershell", shellName: program === "pwsh" ? "PowerShell 7" : "Windows PowerShell" };
            case "posix": return { ...base, kind: "posix", shellName: program };
            default: return { ...base, kind: "program", program };
        }
    }

    // The default local shell (server/local/pty.ts): PowerShell on Windows,
    // the login shell elsewhere.
    if (platform === "win32") return { ...base, kind: "powershell", shellName: "Windows PowerShell" };
    return { ...base, kind: "posix", shellName: shellPath ? path.basename(shellPath) : "bash" };
}

export function resolveChatEnvironment(input: EnvironmentInput): ChatEnvironment {
    const { server } = input;
    const platform = input.platform ?? process.platform;
    if (!server) return { kind: "none", location: "none", osFamily: "unknown" };

    const detected = classifyOs(input.osDetail ?? server.os_detail);
    const base = { serverName: server.name, serverType: server.type };

    switch (server.type) {
        case "local":
            return localEnvironment(server, platform, input.shellPath ?? process.env.SHELL);
        case "ftp":
            return { ...base, kind: "ftp", location: "remote", osFamily: "unknown" };
        case "s3":
            return { ...base, kind: "none", location: "none", osFamily: "unknown" };
        case "windows": {
            // OpenSSH on Windows starts cmd.exe unless DefaultShell says otherwise.
            const shell = promptShell(input.terminalOutput) ?? "cmd";
            return {
                ...base,
                kind: shell,
                location: "remote",
                osFamily: "windows",
                shellName: shell === "cmd" ? "cmd.exe" : "PowerShell"
            };
        }
        default:
            return { ...base, kind: "posix", location: "remote", osFamily: detected === "unknown" ? "linux" : detected, shellName: "bash" };
    }
}
