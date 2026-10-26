// One classification of shells, prompts and CLI presets for every place that
// needs it: how the terminal types a command (src/features/terminal/
// delivery.ts), which shell the AI's system prompt describes
// (server/ai/environment.ts), where a command's output ends (auto-run) and
// which lines are prompts rather than output (issue detection).
import { CLI_PRESET_INFO, normalizeCliPreset } from "./cliPresets";

export type ShellFamily = "posix" | "powershell" | "cmd";
// A prompt's shell; "console" is a tool prompt ("docker>", "mysql>").
export type PromptShell = ShellFamily | "console";

// Shells that read POSIX sh syntax, by program name (wsl starts the default
// Linux distribution's shell).
export const POSIX_SHELLS: ReadonlySet<string> = new Set(["bash", "sh", "ash", "dash", "zsh", "ksh", "mksh", "fish", "wsl"]);

// The program a command line starts, lowercase, without its directory or
// ".exe": '"C:\Program Files\PowerShell\7\pwsh.exe" -NoLogo' is "pwsh".
export function programName(command: string): string {
    const first = command.trim().match(/^"([^"]+)"|^(\S+)/);
    const file = first?.[1] ?? first?.[2] ?? "";
    return (file.replace(/\\/g, "/").split("/").pop() ?? "").replace(/\.exe$/i, "").toLowerCase();
}

// The shell family of a program name, or null when it is no shell.
export function shellOfProgram(program: string): ShellFamily | null {
    if (program === "cmd") return "cmd";
    if (program === "powershell" || program === "pwsh") return "powershell";
    return POSIX_SHELLS.has(program) ? "posix" : null;
}

// A saved cli_preset as the key of the tool console it opens ("Docker",
// " kubectl " -> "docker", "kubectl"), or null for none, "shell", "custom"
// and unknown values.
export function scopedPresetKey(value: string | null | undefined): string | null {
    const key = value ? normalizeCliPreset(value) : null;
    return key !== null && Object.prototype.hasOwnProperty.call(CLI_PRESET_INFO, key) ? key : null;
}

export function cliPresetInfo(value: string | null | undefined): { bin: string; name: string; url: string } | null {
    const key = scopedPresetKey(value);
    return key ? CLI_PRESET_INFO[key] : null;
}

// "(venv) ", "(base) ": a virtualenv or conda environment before the prompt.
const ENV = String.raw`(?:\([^)\n]{1,60}\)\s)?`;

// Prompts at the start of a line, first match wins. A POSIX prompt ends in
// $, # or % (> for some) followed by a space or the end of the line.
const PROMPTS: Array<{ pattern: RegExp; shell: PromptShell }> = [
    { pattern: /^PS [^>\n]{1,200}>/, shell: "powershell" },
    { pattern: /^[A-Za-z]:\\[^>\n]{0,200}>/, shell: "cmd" },
    // user@host:~/src$   user@host ~ %   (venv) user@host:/srv#
    { pattern: new RegExp(String.raw`^${ENV}[\w.-]+@[\w.-]+(?:[:\s][^\s$#%>]*)?\s?[$#%>](?=\s|$)`), shell: "posix" },
    // [root@centos ~]#
    { pattern: new RegExp(String.raw`^${ENV}\[[^\]\n]{1,200}\]\s?[$#%](?=\s|$)`), shell: "posix" },
    // demo-server:/tmp$
    { pattern: new RegExp(String.raw`^${ENV}[\w.-]+:[^\s$#%]*[$#%](?=\s|$)`), shell: "posix" },
    // $   #   bash-5.2$   sh-4.4#   mac%
    { pattern: new RegExp(String.raw`^${ENV}[\w.-]*[$#%](?=\s|$)`), shell: "posix" },
    // / #   ~ $   /app $   (a shell in a container)
    { pattern: new RegExp(String.raw`^${ENV}[~/][^\s$#%]*\s?[$#%](?=\s|$)`), shell: "posix" },
    // docker> ps   mysql>   (a tool's console)
    { pattern: /^([\w.-]+)>(?=\s|$)/, shell: "console" }
];

export type PromptMatch = {
    shell: PromptShell;
    // The prompt itself, and what follows it (the command typed, trimmed).
    prompt: string;
    command: string;
    // The tool of a console prompt ("docker" for "docker> ps").
    tool?: string;
};

// The prompt `line` starts with, or null when it starts with no prompt.
export function matchPrompt(line: string): PromptMatch | null {
    for (const { pattern, shell } of PROMPTS) {
        const match = pattern.exec(line);
        if (!match) continue;
        const result: PromptMatch = { shell, prompt: match[0], command: line.slice(match[0].length).trim() };
        if (shell === "console") result.tool = match[1];
        return result;
    }
    return null;
}

// The whole line (trailing spaces aside) is a prompt with nothing typed.
export function isBarePrompt(line: string): boolean {
    const match = matchPrompt(line.trimEnd());
    return match !== null && match.command === "";
}

// The shell whose prompt the cursor is on: `line` is the line the cursor is
// on, up to the cursor. Tool prompts are no shell (null).
export function cursorPromptShell(line: string): ShellFamily | null {
    const text = line.trim();
    const match = matchPrompt(text);
    if (match && (match.shell === "powershell" || match.shell === "cmd")) return match.shell;
    // A Windows path in it: a custom PowerShell or cmd prompt.
    if (/[A-Za-z]:\\/.test(text)) return null;
    if (match?.shell === "posix" && match.command === "") return "posix";
    // A short line that ends in $, # or % and the space before the cursor:
    // a prompt this table does not know ("❯ $ ", "(env) ~/src $ ").
    if (/^.{0,80}[$#%] $/.test(line.trimStart())) return "posix";
    return null;
}
