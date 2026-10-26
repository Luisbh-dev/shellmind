// Best-effort detection of destructive commands (wiping files or disks,
// powering a host off, dropping databases, running a script downloaded from
// the internet, opening a backdoor...). Anything it flags must be confirmed by
// the user before it is typed into a terminal, also in Auto-Run. It is a
// confirmation gate against obvious accidents and prompt injection, not a
// sandbox: a determined script can always hide what it does, so it errs on the
// side of asking (false positives are acceptable here; missed destructive
// commands are not). It works by normalizing targets and inspecting the
// structure of each command rather than by matching ever longer literal forms:
// a line is parsed into pipelines and simple commands with quotes and
// backslash escapes resolved, wrappers (sudo, env, su -c, xargs...) are peeled
// off, same-line variables and aliases are expanded, and the command and its
// targets are then matched.

export type DangerReason =
    | "recursive-delete"
    | "disk"
    | "power"
    | "fork-bomb"
    | "permissions"
    | "database"
    | "firewall"
    | "cloud-delete"
    | "container-data"
    | "processes"
    | "scheduler"
    | "remote-code"
    | "backdoor"
    | "overwrite";

export type DangerMatch = {
    reason: DangerReason;
    // The offending line (trimmed), for display.
    line: string;
};

export type CommandSafetyOptions = {
    // Scoped CLI console: lines are run as `<bin> <line>`.
    scopedBin?: string | null;
};

const POSIX_SYSTEM_DIRS = [
    "bin", "boot", "dev", "etc", "home", "lib", "lib32", "lib64", "opt", "proc",
    "root", "run", "sbin", "srv", "sys", "usr", "var"
];

// Scripts handed to another shell (bash -c "...", eval, cmd /c) are checked
// as scripts of their own, this many levels deep.
const MAX_NESTING = 4;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Brace expansion grows exponentially with the number of groups; past this
// many members (or this much text) the target is not expanded any further and
// counts as dangerous instead, so a crafted target cannot stall the gate.
const MAX_BRACE_MEMBERS = 64;
const MAX_BRACE_CHARS = 8192;

// Expands brace groups ("rm -rf /{etc,usr}" -> "/etc", "/usr") so each
// expansion is matched on its own. A group without a comma is left as literal
// text (a path can contain braces). Returns null when the expansion would
// exceed the limits above.
function expandBraces(value: string): string[] | null {
    let members = [value];
    for (;;) {
        const next: string[] = [];
        let expanded = false;
        let chars = 0;
        for (const member of members) {
            const match = /^(.*?)\{([^{}]*,[^{}]*)\}(.*)$/.exec(member);
            if (!match) {
                next.push(member);
                chars += member.length;
                continue;
            }
            expanded = true;
            const [, pre, body, post] = match;
            for (const part of body.split(",")) {
                const result = `${pre}${part}${post}`;
                next.push(result);
                chars += result.length;
                if (next.length > MAX_BRACE_MEMBERS || chars > MAX_BRACE_CHARS) return null;
            }
        }
        members = next;
        if (!expanded) return members;
    }
}

// Lexically resolves ".", ".." and duplicate or trailing separators in a path,
// treating "/" and "\" alike, so "/usr/..", "/tmp/../etc" and "C:\Windows\.."
// are seen for what they target. ".." is clamped at the root (an absolute
// path, a drive or a home path cannot climb above it); the leading ".." of a
// relative path are kept. Returns the path with "/" separators and the drive
// upper-cased.
function normalizePath(raw: string): string {
    const driveMatch = /^([a-zA-Z]:)(.*)$/.exec(raw);
    const drive = driveMatch ? driveMatch[1].toUpperCase() : "";
    let rest = driveMatch ? driveMatch[2] : raw;
    const home = !drive && rest.startsWith("~");
    if (home) rest = rest.slice(1);
    const absolute = /^[\\/]/.test(rest);
    const rooted = absolute || Boolean(drive) || home;

    const out: string[] = [];
    for (const segment of rest.split(/[\\/]+/)) {
        if (segment === "" || segment === ".") continue;
        if (segment === "..") {
            if (out.length && out[out.length - 1] !== "..") out.pop();
            else if (!rooted) out.push("..");
            continue;
        }
        out.push(segment);
    }

    const body = out.join("/");
    if (drive) return body ? `${drive}/${body}` : `${drive}/`;
    if (home) return body ? `~/${body}` : "~";
    if (absolute) return `/${body}`;
    return body || ".";
}

// The root, a system directory, a home directory or a Windows system folder,
// given an already normalized path.
function matchSystemPath(normalized: string): boolean {
    if (["/", "/*", "/.*", "~", "~/*", "~/.*"].includes(normalized)) return true;
    if (/^\$\{?HOME\}?(\/\*?)?$/i.test(normalized)) return true;

    const system = /^\/([a-z0-9]+)(\/\*?)?$/i.exec(normalized);
    if (system && POSIX_SYSTEM_DIRS.includes(system[1].toLowerCase())) return true;

    // Windows: drive roots, the system and users folders, the profile.
    const win = normalized.replace(/\//g, "\\");
    if (/^[a-z]:(\\)?(\*(\.\*)?)?$/i.test(win)) return true;
    if (/^\\(\*)?$/.test(win)) return true;
    if (/^[a-z]:\\(windows|users|program files( \(x86\))?|programdata)(\\\*?)?$/i.test(win)) return true;
    if (/^\$env:(systemroot|windir|systemdrive|userprofile|homedrive|programfiles)(\\\*?)?$/i.test(win)) return true;
    return false;
}

// The root, a system directory or a Windows system folder — through brace
// expansion and path normalization, so "/{etc,usr}" and "C:\Windows\.." count.
function isSystemTarget(raw: string): boolean {
    const members = expandBraces(raw.replace(/["']/g, ""));
    return members === null || members.some((member) => matchSystemPath(normalizePath(member)));
}

// A target whose value cannot be read statically: a shell variable or
// positional ("$DIR", "${DIR:-/}", "$@", "$1"), or a command substitution
// ("$(echo /)", "`echo /`"). Unset or "/" such a target wipes the root, so it
// always confirms.
function isVariableTarget(unquoted: string): boolean {
    return /^\$/.test(unquoted) || unquoted.includes("$(") || unquoted.includes("`");
}

// A relative target made only of ".." segments (the parent chain), with or
// without a trailing "/*": "../../..", "../../../*".
const ONLY_DOTDOT = /^\.\.(\/\.\.)*(\/\*)?$/;

// Targets whose recursive deletion wipes a system, a home directory or
// everything under the current directory.
function isDangerousDeleteTarget(raw: string): boolean {
    const unquoted = raw.replace(/["']/g, "");
    if (isVariableTarget(unquoted)) return true;
    const members = expandBraces(unquoted);
    if (members === null) return true;
    for (const member of members) {
        const normalized = normalizePath(member);
        if (["*", ".*", "/", "/*", ".", ".."].includes(normalized)) return true;
        if (ONLY_DOTDOT.test(normalized)) return true;
        if (matchSystemPath(normalized)) return true;
    }
    return false;
}

// ---------------------------------------------------------------------------
// Parsing: a line into pipelines of simple commands, with quotes and (for the
// POSIX reading) backslash escapes resolved, and command/process substitutions
// captured for their own check.
// ---------------------------------------------------------------------------

type Parsed = {
    // Pipelines (separated by ; && || & newline), each a list of simple
    // commands (separated by |), each a list of words with quotes removed.
    pipelines: string[][][];
    // The scripts inside $(...), `...`, <(...) and >(...), to check on their own.
    subs: string[];
};

// Captures a bracketed span (the opener already consumed, `start` at the first
// inner char). Returns the balanced inner text and the index past the closer.
function captureBalanced(line: string, start: number, open: string, close: string): [string, number] {
    let depth = 1;
    let i = start;
    for (; i < line.length; i++) {
        if (line[i] === open) depth++;
        else if (line[i] === close && --depth === 0) break;
    }
    return [line.slice(start, i), i + 1];
}

// Splits a line into pipelines and simple commands. With `posixEscapes`, a
// backslash escapes the next character (so `r\m` is `rm`, `/e\tc` is `/etc`,
// `\bash` is `bash`); without it, a backslash stays literal (a Windows path
// separator). A line is read both ways and matched both ways.
function parsePipelines(line: string, posixEscapes: boolean): Parsed {
    const pipelines: string[][][] = [];
    const subs: string[] = [];
    let pipe: string[][] = [];
    let cmd: string[] = [];
    let word = "";
    let inWord = false;
    let quote: "'" | "\"" | null = null;

    const endWord = () => { if (inWord) cmd.push(word); word = ""; inWord = false; };
    const endCmd = () => { endWord(); if (cmd.length) pipe.push(cmd); cmd = []; };
    const endPipe = () => { endCmd(); if (pipe.length) pipelines.push(pipe); pipe = []; };
    const add = (text: string) => { word += text; inWord = true; };
    const pushToken = (token: string) => { endWord(); cmd.push(token); };

    const captureSub = (i: number, prefix: string): number => {
        const [inner, next] = captureBalanced(line, i, "(", ")");
        subs.push(inner);
        add(`${prefix}(${inner})`);
        return next - 1;
    };
    const captureBacktick = (i: number): number => {
        const end = line.indexOf("`", i);
        const inner = end === -1 ? line.slice(i) : line.slice(i, end);
        subs.push(inner);
        add(`\`${inner}\``);
        return end === -1 ? line.length : end;
    };

    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (quote === "'") { if (ch === "'") quote = null; else add(ch); continue; }
        if (quote === "\"") {
            if (ch === "\"") { quote = null; inWord = true; continue; }
            if (ch === "$" && line[i + 1] === "(") { i = captureSub(i + 2, "$"); continue; }
            if (ch === "`") { i = captureBacktick(i + 1); continue; }
            if (ch === "\\" && /["$`\\]/.test(line[i + 1] ?? "")) { add(line[++i]); continue; }
            add(ch);
            continue;
        }
        if (ch === "\\") {
            if (posixEscapes) { if (i + 1 < line.length) add(line[++i]); }
            else add("\\");
            continue;
        }
        if (ch === "'" || ch === "\"") { quote = ch; inWord = true; continue; }
        if (ch === "$" && line[i + 1] === "(") { i = captureSub(i + 2, "$"); continue; }
        if (ch === "`") { i = captureBacktick(i + 1); continue; }
        if ((ch === "<" || ch === ">") && line[i + 1] === "(") { i = captureSub(i + 2, ch); continue; }
        if (ch === "|") { if (line[i + 1] === "|") { endPipe(); i++; } else { endCmd(); if (line[i + 1] === "&") i++; } continue; }
        if (ch === "&") { if (line[i + 1] === "&") i++; endPipe(); continue; }
        if (ch === ";") { endPipe(); continue; }
        if (ch === "(" || ch === ")") { endPipe(); continue; }
        if (ch === ">") { pushToken(line[i + 1] === ">" ? ">>" : ">"); if (line[i + 1] === ">") i++; continue; }
        if (ch === "<") { pushToken(line[i + 1] === "<" ? "<<" : "<"); if (line[i + 1] === "<") i++; continue; }
        if (/\s/.test(ch)) { endWord(); continue; }
        add(ch);
    }
    endPipe();
    return { pipelines, subs };
}

// The name a word runs: \rm (alias bypass), /usr/bin/rm and C:\...\cmd.exe
// all run rm or cmd.
function commandName(word: string): string {
    const base = word.replace(/^\\/, "").split(/[\\/]/).pop() || word;
    return base.toLowerCase().replace(/\.exe$/, "");
}

// A redirect operator leaves its target in the words; strip both so the target
// is not mistaken for an argument, and report the files written for download
// tracking.
function stripRedirects(words: string[]): { words: string[]; writes: string[] } {
    const out: string[] = [];
    const writes: string[] = [];
    for (let i = 0; i < words.length; i++) {
        const word = words[i];
        if (word === ">" || word === ">>") { if (words[i + 1] !== undefined) writes.push(words[++i]); continue; }
        if (word === "<" || word === "<<") { if (words[i + 1] !== undefined) i++; continue; }
        out.push(word);
    }
    return { words: out, writes };
}

// Wrappers that run the command after them, with the options that take a value.
const VALUE_WRAPPERS: Record<string, string[]> = {
    doas: ["-u", "-C"],
    busybox: [],
    nohup: [],
    time: [],
    setsid: ["-c"],
    nice: ["-n"],
    ionice: ["-c", "-n", "-p"],
    stdbuf: ["-i", "-o", "-e"],
    exec: ["-a"],
    command: [],
    builtin: [],
    start: [],
    watch: ["-n", "-d"],
    xargs: ["-n", "-I", "-L", "-P", "-d", "-E", "-s", "-a"],
    env: ["-u", "-C"],
    timeout: ["-s", "-k"],
    // Shell keywords before a command: `if ...; then rm -rf /; fi`.
    then: [],
    do: [],
    else: [],
    elif: [],
    "!": [],
    "{": []
};

// Privilege wrappers that run a trailing command (sudo -u x CMD, runuser -u x
// -- CMD): their short options cluster and the last letter may take a value.
const PRIVILEGE_WRAPPERS = new Set(["sudo", "su", "runuser", "pkexec"]);
// Short option letters of sudo/su/runuser that take a value.
const PRIVILEGE_VALUE_LETTERS = "ugCphUrtsD";

// Drops the wrappers that run the actual command, so `sudo -u root nice -n 5 rm
// -rf /` is checked as `rm -rf /`. Leading `VAR=x` assignments and `export`
// are dropped too.
function commandWords(words: string[]): string[] {
    let i = 0;
    while (i < words.length) {
        const word = words[i];
        const name = commandName(word);
        if (name === "function") { i += 2; continue; }
        if (name === "chroot") {
            i++;
            while (i < words.length && words[i].startsWith("-")) i++;
            if (i < words.length) i++; // the new-root directory
            continue;
        }
        if (PRIVILEGE_WRAPPERS.has(name)) {
            i++;
            while (i < words.length && words[i].startsWith("-")) {
                const option = words[i];
                if (option === "--") { i++; break; }
                const takesValue = /^--/.test(option)
                    ? /^--(user|group|chdir|prompt|role|type|shell|other-user)$/.test(option)
                    : PRIVILEGE_VALUE_LETTERS.includes(option[option.length - 1]);
                i += takesValue ? 2 : 1;
            }
            continue;
        }
        const valueOptions = VALUE_WRAPPERS[name];
        if (valueOptions) {
            i++;
            while (i < words.length && words[i].startsWith("-")) {
                if (words[i] === "--") { i++; break; }
                i += valueOptions.includes(words[i]) ? 2 : 1;
            }
            if (name === "timeout" && i < words.length) i++;
            continue;
        }
        if (/^(export|declare|local|readonly|typeset)$/.test(name)) { i++; continue; }
        if (/^\w+=/.test(word)) { i++; continue; }
        break;
    }
    return words.slice(i);
}

// Variables assigned on the same line (`a=rm; $a -rf /`, `export a=rm`), so a
// command or target that reads one is expanded back to its value.
function collectAssignments(commands: string[][]): Record<string, string> {
    const assignments: Record<string, string> = {};
    for (const words of commands) {
        const rest = /^(export|declare|local|readonly|typeset)$/.test(commandName(words[0])) ? words.slice(1) : words;
        if (rest.length !== 1) continue;
        const match = /^(\w+)=(.*)$/.exec(rest[0]);
        if (match) assignments[match[1]] = match[2];
    }
    return assignments;
}

// PowerShell aliases (`Set-Alias x Remove-Item`, `sal -Name x -Value ri`), so a
// command run through one is expanded back to what it names.
function collectAliases(commands: string[][]): Record<string, string> {
    const aliases: Record<string, string> = {};
    for (const words of commands) {
        if (!/^(set-alias|new-alias|sal|nal)$/.test(commandName(words[0]))) continue;
        let name: string | undefined;
        let value: string | undefined;
        const positional: string[] = [];
        for (let i = 1; i < words.length; i++) {
            if (/^-name$/i.test(words[i])) name = words[++i];
            else if (/^-value$/i.test(words[i])) value = words[++i];
            else if (!words[i].startsWith("-")) positional.push(words[i]);
        }
        name = name ?? positional[0];
        value = value ?? positional[1];
        if (name && value) aliases[name.toLowerCase()] = value;
    }
    return aliases;
}

// Expands `$name`/`${name}` in a command's words from the same-line
// assignments: an exact `$name` is replaced by its value split into words
// (`a="rm -rf"; $a /` -> `rm -rf /`), an embedded one is substituted in place
// (`x=; r${x}m` -> `rm`).
function resolveWords(words: string[], assignments: Record<string, string>): string[] {
    const out: string[] = [];
    for (const word of words) {
        const exact = /^\$\{?(\w+)\}?$/.exec(word);
        if (exact && assignments[exact[1]] !== undefined) {
            const value = assignments[exact[1]].trim();
            if (value) out.push(...value.split(/\s+/));
            continue;
        }
        out.push(word.replace(/\$\{(\w+)\}|\$(\w+)/g, (match, braced, bare) => {
            const key = braced ?? bare;
            return assignments[key] !== undefined ? assignments[key] : match;
        }));
    }
    return out;
}

// Replaces a command run through a PowerShell alias (`x -Recurse C:\` after
// `Set-Alias x Remove-Item`) with what it names.
function resolveAlias(command: string[], aliases: Record<string, string>): string[] {
    const target = command.length ? aliases[commandName(command[0])] : undefined;
    return target ? [target, ...command.slice(1)] : command;
}

// Any prefix of PowerShell's -Recurse, with or without a `:value`: -r, -rec,
// -recu, -recurse, -recurse:$true.
const PS_RECURSE = /^-r(e(c(u(r(s(e)?)?)?)?)?)?(:\$?\w+)?$/i;
// A cmd.exe switch cluster of single letters: /s, /q, /s/q, /S/Q.
const CMD_SWITCHES = /^(\/[a-z])+$/i;

function hasLetter(cluster: string, letter: string): boolean {
    return cluster.toLowerCase().includes(letter);
}

// A recursive flag of rm or a PowerShell delete.
function isRecursiveFlag(word: string): boolean {
    if (word === "--recursive" || word === "--no-preserve-root") return true;
    if (/^-[a-z]+$/i.test(word) && /r/i.test(word)) return true; // rm -rf, -Rf
    return PS_RECURSE.test(word);
}

function isRecursiveDelete(words: string[]): boolean {
    const [cmd, ...rest] = words;
    const name = commandName(cmd);

    if (name === "rm") {
        const recursive = rest.some(isRecursiveFlag);
        const targets = rest.filter((word) => !word.startsWith("-"));
        return recursive && targets.some(isDangerousDeleteTarget);
    }

    if (["remove-item", "ri", "del", "erase", "rd", "rmdir"].includes(name)) {
        let recursive = false;
        const targets: string[] = [];
        for (let i = 0; i < rest.length; i++) {
            const word = rest[i];
            if (PS_RECURSE.test(word)) { recursive = true; continue; }
            if (/^-(path|literalpath)$/i.test(word)) { if (rest[i + 1]) targets.push(rest[++i]); continue; }
            if (word.startsWith("-")) continue;
            if (CMD_SWITCHES.test(word)) { if (hasLetter(word, "s")) recursive = true; continue; }
            targets.push(word);
        }
        return recursive && targets.some(isDangerousDeleteTarget);
    }

    if (name === "find") {
        // find with no start path defaults to the current directory.
        const start = rest.find((word) => !word.startsWith("-")) ?? ".";
        if (!isDangerousDeleteTarget(start)) return false;
        if (rest.includes("-delete")) return true;
        // find / -exec rm -rf {} +
        return rest.some((word, index) => /^-(exec|execdir|ok|okdir)$/.test(word) && /^(rm|shred|unlink|rmdir)$/.test(commandName(rest[index + 1] ?? "")));
    }
    return false;
}

// A system target, or an unreadable one (a variable or substitution — unset or
// "/" it becomes the root): a recursive chmod/chown on either wipes a system's
// permissions.
const isPermissionsTarget = (target: string) => isSystemTarget(target) || isVariableTarget(target.replace(/["']/g, ""));

// chmod/chown/chgrp -R (anywhere in the arguments) on the root or a system
// directory, chmod 777 on the root itself, and their Windows counterparts.
function isPermissionsWipe(words: string[]): boolean {
    const [cmd, ...rest] = words;
    const name = commandName(cmd);

    if (name === "chmod" || name === "chown" || name === "chgrp") {
        const recursive = rest.some((word) => word === "--recursive" || /^-[a-z]*R[a-z]*$/.test(word));
        const [mode, ...targets] = rest.filter((word) => !word.startsWith("-"));
        if (recursive && targets.some(isPermissionsTarget)) return true;
        return name === "chmod" && /^0?777$/.test(mode ?? "") && targets.some(isSystemTarget);
    }
    if (name === "icacls") {
        return rest.some((word) => /^\/t$/i.test(word)) && rest.some(isSystemTarget);
    }
    if (name === "takeown") {
        return rest.some((word) => /^\/r$/i.test(word)) && rest.some(isSystemTarget);
    }
    return false;
}

const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh", "ash", "fish"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "perl", "ruby", "node", "nodejs", "php", "pwsh", "powershell"]);
const POWERSHELL_FLAGS = /^-(noprofile|nop|nologo|noninteractive|noni|sta|mta)$/i;
const POWERSHELL_VALUE_FLAGS = /^-(executionpolicy|ep|ex|windowstyle|w|inputformat|outputformat)$/i;
// Any prefix of PowerShell's -EncodedCommand (-e, -en, -enc, -encodedcommand).
const POWERSHELL_ENCODED = /^-e(n(c(o(d(e(d(c(o(m(m(a(n(d)?)?)?)?)?)?)?)?)?)?)?)?)?$/i;
// base64 run with a decode flag (-d, -D, --decode, -di).
const BASE64_DECODE = /\bbase64\b[^\n]*?(?:--decode\b|\s-[a-z]*d[a-z]*\b)/i;

// A command that executes whatever it reads: a shell, `$SHELL`/a variable, or
// an interpreter with no script argument (so it runs standard input).
function isExecSink(command: string[]): boolean {
    if (!command.length) return false;
    const head = command[0];
    if (/^\$/.test(head)) return true;
    const name = commandName(head);
    if (SHELLS.has(name)) return true;
    if (INTERPRETERS.has(name)) return command.slice(1).every((word) => word.startsWith("-"));
    return false;
}

// Decodes a base64 PowerShell -EncodedCommand (UTF-16LE), in the browser and in
// Node, or null when it is not valid base64.
function decodeUtf16le(encoded: string): string | null {
    try {
        // atob in the browser; Buffer in Node (reached without a Node type dep).
        const fromBase64 = (globalThis as { Buffer?: { from(data: string, encoding: string): { toString(encoding: string): string } } }).Buffer;
        const binary = typeof atob === "function"
            ? atob(encoded)
            : fromBase64
                ? fromBase64.from(encoded, "base64").toString("binary")
                : "";
        if (!binary) return null;
        let out = "";
        for (let i = 0; i + 1 < binary.length; i += 2) out += String.fromCharCode(binary.charCodeAt(i) | (binary.charCodeAt(i + 1) << 8));
        return out;
    } catch {
        return null;
    }
}

// The scripts a command hands to another interpreter, to check on their own:
// bash -c "<script>", eval <script>, su/runuser -c <script>, env -S <script>,
// cmd /c <script>, powershell -Command <script> and -EncodedCommand <base64>.
function nestedScripts(words: string[]): string[] {
    const scripts: string[] = [];

    // env -S '<script>' and -S<script> (env is also peeled off as a wrapper).
    for (let i = 0; i < words.length; i++) {
        if (commandName(words[i]) !== "env") continue;
        for (let j = i + 1; j < words.length; j++) {
            if (words[j] === "-S") { if (words[j + 1] !== undefined) scripts.push(words[j + 1]); break; }
            const inline = /^-S(.+)$/.exec(words[j]);
            if (inline) { scripts.push(inline[1]); break; }
            if (!words[j].startsWith("-")) break;
        }
    }

    // su/runuser -c '<script>', before the wrapper is peeled off (it keeps the
    // trailing form, `su -u x -- CMD`, which commandWords reaches instead).
    for (let i = 0; i < words.length; i++) {
        if (!/^(su|runuser)$/.test(commandName(words[i]))) continue;
        const flag = words.slice(i + 1).findIndex((word) => /^(-c|--command)$/i.test(word));
        if (flag !== -1 && words[i + 1 + flag + 1] !== undefined) scripts.push(words[i + 1 + flag + 1]);
    }

    const command = commandWords(words);
    const [cmd, ...rest] = command;
    const name = commandName(cmd ?? "");

    if (SHELLS.has(name)) {
        const flag = rest.findIndex((word) => /^-[a-z]*c[a-z]*$/i.test(word) && !word.startsWith("--"));
        if (flag !== -1 && rest[flag + 1] !== undefined) scripts.push(rest[flag + 1]);
    } else if (name === "eval") {
        scripts.push(rest.join(" "));
    } else if (name === "cmd") {
        // /c and /k, also glued to a quote: cmd /c"rd /s /q C:\".
        const index = rest.findIndex((word) => /^\/[ck]/i.test(word));
        if (index !== -1) {
            const remainder = rest[index].slice(2);
            scripts.push([remainder, ...rest.slice(index + 1)].filter(Boolean).join(" "));
        }
    } else if (name === "powershell" || name === "pwsh") {
        for (let i = 0; i < rest.length; i++) {
            const word = rest[i];
            if (/^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(word)) { scripts.push(rest.slice(i + 1).join(" ")); break; }
            if (POWERSHELL_ENCODED.test(word) && rest[i + 1] !== undefined) {
                const decoded = decodeUtf16le(rest[i + 1]);
                if (decoded !== null) scripts.push(decoded);
                break;
            }
            if (POWERSHELL_VALUE_FLAGS.test(word)) i++;
            else if (!POWERSHELL_FLAGS.test(word)) { if (!word.startsWith("-")) scripts.push(rest.slice(i).join(" ")); break; }
        }
    }

    // A bash alias definition carries a script: alias x='rm -rf /'.
    if (name === "alias") {
        for (const word of rest) {
            const match = /^\w+=(.*)$/.exec(word);
            if (match && match[1]) scripts.push(match[1]);
        }
    }
    return scripts;
}

// The last path component of a URL or path, without query or fragment.
function basename(value: string): string {
    const parts = value.split(/[?#]/)[0].split(/[\\/]/).filter(Boolean);
    return parts[parts.length - 1] ?? "";
}

// Files a curl/wget command writes: -o/--output (curl), -O/--remote-name (the
// URL's basename), -O/--output-document (wget), short-flag clusters that end in
// o/O (`curl -fsSLo file`, `wget -qO file`), and — for wget — the URL's
// basename by default.
function downloadTargets(name: string, rest: string[]): string[] {
    const targets: string[] = [];
    let remoteName = false;
    const urls: string[] = [];
    for (let i = 0; i < rest.length; i++) {
        const word = rest[i];
        if (name === "wget") {
            if (word === "-O" || word === "--output-document") { if (rest[i + 1]) targets.push(rest[++i]); continue; }
            const inline = /^--output-document=(.+)$/.exec(word);
            if (inline) { targets.push(inline[1]); continue; }
            if (/^-[a-z]*O$/.test(word)) { if (rest[i + 1]) targets.push(rest[++i]); continue; }
            if (!word.startsWith("-")) urls.push(word);
            continue;
        }
        // curl / fetch
        if (word === "-o" || word === "--output") { if (rest[i + 1]) targets.push(rest[++i]); continue; }
        const inline = /^--output=(.+)$/.exec(word);
        if (inline) { targets.push(inline[1]); continue; }
        if (word === "-O" || word === "--remote-name") { remoteName = true; continue; }
        const cluster = /^-[a-zA-Z]*[oO]$/.exec(word);
        if (cluster) {
            if (/o/.test(word) && rest[i + 1]) targets.push(rest[++i]);
            if (/O/.test(word)) remoteName = true;
            continue;
        }
        if (!word.startsWith("-")) urls.push(word);
    }
    // wget saves to the URL's basename unless told otherwise; curl only with -O.
    if (name === "wget" || remoteName) for (const url of urls) targets.push(basename(url));
    return targets;
}

// Records the files a curl/wget/fetch command wrote, including a `> file`
// redirect, for download-then-run tracking.
function addDownloads(command: string[], writes: string[], downloaded: Set<string>): void {
    const name = commandName(command[0] ?? "");
    const files = name === "curl" || name === "wget" || name === "fetch"
        ? [...downloadTargets(name, command.slice(1)), ...writes]
        : [];
    for (const file of files) {
        if (!file || file.startsWith("-")) continue;
        downloaded.add(file.replace(/["']/g, ""));
        const base = basename(file);
        if (base) downloaded.add(base);
    }
}

function isDownloadedToken(token: string, downloaded: Set<string>): boolean {
    const clean = token.replace(/["']/g, "");
    return downloaded.has(clean) || downloaded.has(basename(clean));
}

// Download-then-run: a command runs a file an earlier curl/wget wrote — a
// shell or interpreter reading it, or the file itself (after a chmod +x).
function runsDownloaded(command: string[], downloaded: Set<string>): boolean {
    if (!downloaded.size) return false;
    const [cmd, ...rest] = command;
    if (isDownloadedToken(cmd, downloaded)) return true;
    const name = commandName(cmd);
    if (SHELLS.has(name) || INTERPRETERS.has(name) || name === "source" || cmd === ".") {
        return rest.some((word) => !word.startsWith("-") && isDownloadedToken(word, downloaded));
    }
    return false;
}

// A pipeline that downloads (or base64-decodes) a payload and pipes it into a
// shell or an interpreter that runs it: curl ... | sh, ... | base64 -d | bash,
// wget -qO- ... | sudo python3.
function pipesIntoShell(pipeline: string[][]): boolean {
    const commands = pipeline.map((words) => commandWords(stripRedirects(words).words));
    const producer = commands.findIndex((command) => {
        const name = commandName(command[0] ?? "");
        return name === "curl" || name === "wget" || name === "fetch"
            || (name === "base64" && command.some((word) => /^-[a-z]*d[a-z]*$/i.test(word) || /^--decode$/i.test(word)));
    });
    if (producer === -1) return false;
    return commands.slice(producer + 1).some(isExecSink);
}

// A PowerShell delete fed by a recursive Get-ChildItem of a system target:
// Get-ChildItem C:\Windows -Recurse | Remove-Item -Force.
function pipesIntoDelete(pipeline: string[][]): boolean {
    const commands = pipeline.map((words) => resolveAlias(commandWords(stripRedirects(words).words), {}));
    const source = commands.findIndex((command) => {
        const name = commandName(command[0] ?? "");
        if (!/^(get-childitem|gci|ls|dir|childitem)$/.test(name)) return false;
        const rest = command.slice(1);
        return rest.some(PS_RECURSE.test.bind(PS_RECURSE)) && rest.some((word) => !word.startsWith("-") && isDangerousDeleteTarget(word));
    });
    if (source === -1) return false;
    return commands.slice(source + 1).some((command) => /^(remove-item|ri|rm|del|erase|rmdir|rd)$/.test(commandName(command[0] ?? "")));
}

const DOWNLOADERS = String.raw`\b(curl|wget|fetch)\b`;
const SUDO = String.raw`(sudo\s+(-\S+\s+)*)?`;
const PIPED_SHELL = String.raw`\|\s*${SUDO}(env\s+)?(\S*/)?(ba|z|da|k|fi|a)?sh\b`;

const LINE_PATTERNS: Array<{ reason: DangerReason; pattern: RegExp }> = [
    { reason: "fork-bomb", pattern: /(\w+|:)\s*\(\s*\)\s*\{[^}]*\1\s*\|\s*\1\s*&/ },
    { reason: "disk", pattern: /\b(mkfs(\.\w+)?|mkswap|wipefs|sgdisk|sfdisk|blkdiscard)\b/i },
    { reason: "disk", pattern: /\b(fdisk|parted)\s+\/dev\//i },
    { reason: "disk", pattern: /\bdd\b[^\n]*\bof=\/dev\//i },
    { reason: "disk", pattern: /\bshred\b[^\n]*\/dev\//i },
    { reason: "disk", pattern: />\s*\/dev\/(sd[a-z]|nvme\d|hd[a-z]|vd[a-z]|xvd[a-z]|mmcblk\d|disk\d)/i },
    { reason: "disk", pattern: /\b(Format-Volume|Clear-Disk|Initialize-Disk|Remove-Partition)\b/i },
    { reason: "disk", pattern: /\bformat(\.com)?\s+[a-z]:/i },
    { reason: "disk", pattern: /\bdiskpart\b/i },
    { reason: "power", pattern: /(^|[\s;&|("'\\/])(shutdown|reboot|poweroff|halt)(\.exe)?(\s|$|;|["'])/i },
    { reason: "power", pattern: /\b(systemctl|loginctl)\s+(reboot|poweroff|halt|kexec|suspend|hibernate)\b/i },
    { reason: "power", pattern: /(^|[\s;&|("'])(tel)?init\s+[06](\s|$|;|["'])/i },
    { reason: "power", pattern: /\b(Restart-Computer|Stop-Computer)\b/i },
    { reason: "database", pattern: /\bdrop\s+(database|schema|table)\b/i },
    { reason: "database", pattern: /\btruncate\s+table\b/i },
    { reason: "database", pattern: /\b(flushall|flushdb)\b/i },
    { reason: "database", pattern: /\bdropdb\b/i },
    { reason: "firewall", pattern: /\biptables\s+(-\w+\s+)*(-F|--flush|-P\s+INPUT\s+DROP)\b/ },
    { reason: "firewall", pattern: /\bnft\s+flush\s+ruleset\b/i },
    { reason: "firewall", pattern: /\bufw\s+(reset|default\s+deny\s+incoming)\b/i },
    { reason: "processes", pattern: /\bkill\s+(-9|-KILL|-SIGKILL)\s+-1\b/i },
    { reason: "processes", pattern: /\bkill\s+(-\w+\s+)?1(\s|$|;)/ },
    { reason: "scheduler", pattern: /\bcrontab\s+(-\w+\s+)*-r\b/ },
    { reason: "container-data", pattern: /\bdocker\s+(volume\s+(rm|prune)|system\s+prune)\b/i },
    { reason: "container-data", pattern: /\bdocker\s+rm\s+(-\w+\s+)*\$\(docker\s+ps\s+-a?q/i },
    { reason: "cloud-delete", pattern: /\bkubectl\s+delete\s+(ns|namespaces?|--all|-A|--all-namespaces|nodes?|pv|persistentvolumes?)\b/i },
    { reason: "cloud-delete", pattern: /\bterraform\s+destroy\b/i },
    { reason: "cloud-delete", pattern: /\baz\s+(group|vm|storage\s+account|aks|sql\s+server)\s+delete\b/i },
    { reason: "cloud-delete", pattern: /\baws\s+s3\s+(rb|rm)\b[^\n]*--(force|recursive)\b/i },
    { reason: "cloud-delete", pattern: /\baws\s+(ec2\s+terminate-instances|rds\s+delete-db-(instance|cluster)|cloudformation\s+delete-stack)\b/i },
    { reason: "cloud-delete", pattern: /\bgcloud\s+(projects|compute\s+instances|sql\s+instances|container\s+clusters)\s+delete\b/i },
    // A download piped into a shell or an interpreter reading stdin.
    { reason: "remote-code", pattern: new RegExp(`${DOWNLOADERS}[^\\n]*${PIPED_SHELL}`, "i") },
    { reason: "remote-code", pattern: new RegExp(`${DOWNLOADERS}[^\\n]*\\|\\s*${SUDO}(\\S*/)?(python[\\d.]*|perl|ruby|node|php)\\s*(-\\s*)?($|[;&|)])`, "i") },
    // An encoded payload decoded straight into a shell: base64 -d ... | sh
    { reason: "remote-code", pattern: new RegExp(`\\bbase64\\b[^\\n]*\\s(-d|-D|--decode)\\b[^\\n]*${PIPED_SHELL}`, "i") },
    // bash <(curl ...), bash -c "$(curl ...)", eval "$(wget ...)", source <(curl ...)
    { reason: "remote-code", pattern: new RegExp(`\\b((ba|z|da|k)?sh|source|eval)\\b[^\\n|;&]*[<$]\\(\\s*${DOWNLOADERS}`, "i") },
    { reason: "remote-code", pattern: new RegExp(`(^|[\\s;&|])\\.\\s+<\\(\\s*${DOWNLOADERS}`, "i") },
    // PowerShell: iwr ... | iex, iex (New-Object Net.WebClient).DownloadString(...)
    {
        reason: "remote-code",
        pattern: /^(?=[^\n]*\b(iex|invoke-expression)\b)(?=[^\n]*\b(iwr|irm|curl|wget|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|net\.webclient|start-bitstransfer)\b)/i
    },
    // Backdoors and exfiltration: a reverse shell, an appended SSH key, or a
    // system file sent to a remote host.
    { reason: "backdoor", pattern: /\/dev\/(tcp|udp)\//i },
    { reason: "backdoor", pattern: /\b(nc|ncat|netcat)\b[^\n]*\s-[a-z]*e\b/i },
    { reason: "backdoor", pattern: new RegExp(`\\bmkfifo\\b[^\\n]*${PIPED_SHELL}`, "i") },
    { reason: "backdoor", pattern: />>?\s*["']?[^\s"'|&;]*\.ssh\/authorized_keys/i },
    { reason: "backdoor", pattern: /\b(curl|wget)\b[^\n]*\s(-d|--data[a-z-]*|-T|--upload-file|-F|--form)[=\s]+["']?@?\/(etc|root|home)\//i },
    // Overwriting or emptying a credential or boot file.
    { reason: "overwrite", pattern: /(^|[\s;&|(>])>{1,2}\s*["']?\/(etc\/(passwd|shadow|gshadow|sudoers)|boot)\b/i },
    { reason: "overwrite", pattern: /\btruncate\b[^\n]*\s["']?\/(etc|boot)\b/i }
];

// Checks one parsing of a line (POSIX escapes or Windows backslashes).
function checkParsed(parsed: Parsed, depth: number, downloaded: Set<string>): DangerReason | null {
    const { pipelines, subs } = parsed;
    const flat = pipelines.flat();
    const assignments = collectAssignments(flat);
    const aliases = collectAliases(flat);

    for (const pipeline of pipelines) {
        if (pipesIntoShell(pipeline)) return "remote-code";
        if (pipesIntoDelete(pipeline)) return "recursive-delete";
    }

    for (const words of flat) {
        const resolved = resolveWords(words, assignments);
        const { words: bare, writes } = stripRedirects(resolved);
        let command = commandWords(bare);
        command = resolveAlias(command, aliases);
        if (!command.length) continue;

        if (runsDownloaded(command, downloaded)) return "remote-code";
        addDownloads(command, writes, downloaded);

        if (isRecursiveDelete(command)) return "recursive-delete";
        if (isPermissionsWipe(command)) return "permissions";

        // A command run through a substitution or an unknown variable
        // (`$(echo rm) -rf /`, `$a -rf /`): check its arguments as rm or chmod.
        if (/^[$`]/.test(command[0]) || command[0].includes("$(")) {
            const rest = command.slice(1);
            if (isRecursiveDelete(["rm", ...rest])) return "recursive-delete";
            if (isPermissionsWipe(["chmod", ...rest])) return "permissions";
        }

        // xargs runs its command once per line of input, so the target comes
        // from stdin: a recursive rm/chmod or shred through it is unbounded.
        if (commandName(words[0]) === "xargs") {
            const inner = command;
            const innerName = commandName(inner[0]);
            if (innerName === "rm" && inner.slice(1).some(isRecursiveFlag)) return "recursive-delete";
            if (/^(chmod|chown|chgrp)$/.test(innerName) && inner.some((word) => /^-[a-z]*R[a-z]*$/.test(word) || word === "--recursive")) return "permissions";
            if (innerName === "shred") return "recursive-delete";
        }

        // A shell, eval or source that runs a base64-decoded payload.
        const name = commandName(command[0]);
        if ((SHELLS.has(name) || name === "eval" || name === "source" || command[0] === ".") && BASE64_DECODE.test(command.join(" "))) {
            return "remote-code";
        }
    }

    if (depth >= MAX_NESTING) return null;

    for (const words of flat) {
        const resolved = resolveWords(words, assignments);
        for (const script of nestedScripts(resolved)) {
            const reason = checkScript(script, depth + 1);
            if (reason) return reason;
        }
    }
    for (const sub of subs) {
        const reason = checkScript(sub, depth + 1);
        if (reason) return reason;
    }
    return null;
}

function checkLine(line: string, depth: number, downloaded: Set<string>): DangerReason | null {
    for (const { reason, pattern } of LINE_PATTERNS) {
        if (pattern.test(line)) return reason;
    }
    // A line is read both as POSIX (backslash escapes) and as Windows
    // (backslash a separator); either reading flagging it is enough.
    for (const posixEscapes of [true, false]) {
        const reason = checkParsed(parsePipelines(line, posixEscapes), depth, downloaded);
        if (reason) return reason;
    }
    return null;
}

function checkScript(script: string, depth: number): DangerReason | null {
    const downloaded = new Set<string>();
    for (const line of logicalLines(script)) {
        const reason = checkLine(line, depth, downloaded);
        if (reason) return reason;
    }
    return null;
}

// Lines with continuations joined (\ in POSIX shells, ` in PowerShell, ^ in
// cmd), trimmed, without blank lines and comments.
function logicalLines(script: string): string[] {
    return script
        .replace(/[\\`^]\r?\n/g, " ")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"));
}

// The first destructive line of `script`, or null. Each line is checked on
// its own; a scoped console's lines are checked as `<bin> <line>`. A file
// downloaded by one line and run by a later one is tracked across the script.
export function findDangerousCommand(script: string, options: CommandSafetyOptions = {}): DangerMatch | null {
    const bin = options.scopedBin?.trim();
    const binPrefix = bin ? new RegExp(`^${escapeRegExp(bin)}(\\s|$)`, "i") : null;
    const binPrompt = bin ? new RegExp(`^(${escapeRegExp(bin)}>\\s*)+`, "i") : null;
    const downloaded = new Set<string>();

    for (const trimmed of logicalLines(script)) {
        let line = trimmed;
        if (bin && binPrefix && binPrompt) {
            line = line.replace(binPrompt, "");
            if (!binPrefix.test(line)) line = `${bin} ${line}`;
        }
        const reason = checkLine(line, 0, downloaded);
        if (reason) return { reason, line: trimmed };
    }
    return null;
}
