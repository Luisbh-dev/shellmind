import { POWERSHELL_DELIVERY } from "../config";
import { AppError } from "../errors";
import { exec, type ExecResult } from "../ssh/exec";
import type { SshLease } from "../ssh/pool";

// Building and running the remote commands of the status dashboard and the
// operations panels. Commands are assembled here from validated names only;
// arguments are quoted even so.
//
// Scripts go on stdin, so the user's login shell (bash, zsh, fish, csh...;
// cmd.exe or PowerShell on Windows) only ever parses a short, fixed command:
// `sh -s` for POSIX scripts, `powershell ... -Command -` for PowerShell ones
// (see powershellStdin). -EncodedCommand (the script as base64 on the command
// line) remains as the fallback: endpoint protection tends to flag those long
// encoded command lines as obfuscated PowerShell.

type Leased = Pick<SshLease, "client">;

export type RunOptions = {
    timeoutMs: number;
    signal?: AbortSignal;
    // Below exec's default cap (EXEC_MAX_OUTPUT_BYTES): a script whose output
    // is only kept in part (the AI diagnosis evidence) stops earlier.
    maxOutputBytes?: number;
};

// POSIX single quotes: nothing inside is special except the quote itself.
export function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]*$/;

// A PowerShell string of exactly `value`, in printable ASCII (a script on
// stdin is decoded with the console code page, see powershellStdin): a
// single-quoted (verbatim) string, where only the quote itself is special
// and doubling it is the escape. Every other character (accented letters,
// line breaks, the typographic single quotes U+2018-U+201B, which would end
// the string too) is spelled outside the quotes as a [char] code, and
// ('C:\Users\Jos'+[char]0x00e9) works in argument and expression mode alike.
export function psQuote(value: string): string {
    if (PRINTABLE_ASCII.test(value)) return `'${value.replace(/'/g, "''")}'`;
    const parts: string[] = [];
    let literal = "";
    for (let index = 0; index < value.length; index++) {
        const char = value[index];
        if (PRINTABLE_ASCII.test(char)) {
            literal += char === "'" ? "''" : char;
            continue;
        }
        if (literal || !parts.length) parts.push(`'${literal}'`);
        literal = "";
        parts.push(`[char]0x${value.charCodeAt(index).toString(16).padStart(4, "0")}`);
    }
    if (literal) parts.push(`'${literal}'`);
    return `(${parts.join("+")})`;
}

// Drops indentation, blank lines and full-line comments: on stdin an empty
// line would end the script early (see powershellStdin), and cmd.exe refuses
// command lines over 8191 characters, which the encoded fallback makes ~2.7x
// longer than the script.
export function compactPowerShell(script: string): string {
    return script
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith("#"))
        .join("\n");
}

export const CMD_LINE_LIMIT = 8191;

// Output as UTF-8 (the console code page would mangle accented names). There
// may be no console to configure, hence the try.
const POWERSHELL_PRELUDE = "try{[Console]::OutputEncoding=New-Object Text.UTF8Encoding $false}catch{}";

// PowerShell reading its commands from stdin.
export const POWERSHELL_STDIN_COMMAND = "powershell -NoProfile -NonInteractive -Command -";

// The stdin of POWERSHELL_STDIN_COMMAND for `script`. In that mode PowerShell
// reads its input the way it reads a console: a statement that spans lines
// runs only once an empty line follows it (until then, and at the end of the
// input, it is dropped without a word), each statement on its own, decoded
// with the console code page. So the script travels as one block that an
// empty line closes, and must be ASCII (psQuote spells anything else in
// ASCII). The block ends as -Command does: exit 1 when its last statement
// failed, unless the script exits itself.
export function powershellStdin(script: string): string {
    return `& {\n${POWERSHELL_PRELUDE}\n${compactPowerShell(script)}\nif(-not $?){exit 1}\n}\n\n`;
}

// The fallback: the script as -EncodedCommand (base64 UTF-16LE), which runs
// the same whatever the OpenSSH default shell, but makes a command line of
// up to CMD_LINE_LIMIT characters that endpoint protection may flag.
export function encodedPowerShellCommand(script: string): string {
    const encoded = Buffer.from(`${POWERSHELL_PRELUDE}\n${compactPowerShell(script)}`, "utf16le").toString("base64");
    return `powershell -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

export type PowerShellInvocation = {
    command: string;
    // What the command reads on stdin ("" for the encoded fallback, which
    // reads nothing: stdin closes at once, as powershell.exe can wait for it).
    stdin: string;
};

// How `script` reaches PowerShell: on stdin, or encoded for a script that is
// not ASCII (none of ShellMind's is) and for every script with
// SHELLMIND_POWERSHELL_DELIVERY=encoded.
export function powershellInvocation(script: string, delivery: "stdin" | "encoded" = POWERSHELL_DELIVERY): PowerShellInvocation {
    // eslint-disable-next-line no-control-regex -- ASCII is \x00-\x7f
    if (delivery === "encoded" || /[^\x00-\x7f]/.test(script)) return { command: encodedPowerShellCommand(script), stdin: "" };
    return { command: POWERSHELL_STDIN_COMMAND, stdin: powershellStdin(script) };
}

// Section markers let one script report several things over one channel.
export const SECTION_MARKER = "@@SM:";

// Prints `@@SM:<name>` on a line of its own (a missing trailing newline of the
// previous command cannot glue it to output).
export const POSIX_SECTION_FUNCTION = `m() { printf '\\n${SECTION_MARKER}%s\\n' "$1"; }`;

export function parseSections(output: string): Map<string, string> {
    const sections = new Map<string, string>();
    let name: string | null = null;
    let lines: string[] = [];
    const flush = () => {
        if (name !== null) sections.set(name, lines.join("\n").trim());
    };
    for (const line of output.split(/\r?\n/)) {
        if (line.startsWith(SECTION_MARKER)) {
            flush();
            name = line.slice(SECTION_MARKER.length).trim();
            lines = [];
        } else if (name !== null) {
            lines.push(line);
        }
    }
    flush();
    return sections;
}

export function runPosixScript(lease: Leased, script: string, options: RunOptions): Promise<ExecResult> {
    return exec(lease, "sh -s", { ...options, stdin: script });
}

export function runPowerShell(lease: Leased, script: string, options: RunOptions): Promise<ExecResult> {
    const { command, stdin } = powershellInvocation(script);
    return exec(lease, command, { ...options, stdin });
}

// A script that runs until it is stopped (a log stream) and watches its
// stdin to notice the channel closing: `input` is written to stdin, which
// then stays open.
export function powershellStream(script: string, delivery: "stdin" | "encoded" = POWERSHELL_DELIVERY): { command: string; input?: string } {
    const { command, stdin } = powershellInvocation(script, delivery);
    return stdin ? { command, input: stdin } : { command };
}

// One argument of a Windows command line (the CommandLineToArgvW rules).
export function windowsArgument(value: string): string {
    if (value && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

const XML_ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

function decodeClixmlString(text: string): string {
    return text
        .replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-f]+);/gi, (entity, name: string) => {
            if (name[0] !== "#") return XML_ENTITIES[name.toLowerCase()] ?? entity;
            const code = name[1] === "x" || name[1] === "X" ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10);
            return code <= 0x10ffff ? String.fromCodePoint(code) : entity;
        })
        // The serializer's own escape for characters XML cannot carry (CR, LF...).
        .replace(/_x([0-9a-f]{4})_/gi, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

// The error text of CLIXML records (`<Objs ...>` documents); progress and
// other records carry nothing worth showing.
export function clixmlErrorText(xml: string): string {
    return [...xml.matchAll(/<S S="Error">([^<]*)<\/S>/g)].map((match) => decodeClixmlString(match[1])).join("");
}

const MAX_PARTIAL_LINE = 64 * 1024;

export type TextFilter = { write: (text: string) => void; end: () => void };

// PowerShell run with -EncodedCommand (the fallback) writes its own errors and
// progress as CLIXML on stderr, one record per line after a "#< CLIXML"
// header, mixed with whatever the script or a native program wrote there
// directly; on stdin delivery they are plain text already. This keeps the
// text: the header and progress go, error records become their message,
// other lines pass unchanged. A partial line waits for its end.
export function createClixmlFilter(push: (text: string) => void): TextFilter {
    let partial = "";
    const line = (text: string) => {
        if (text.startsWith("#< CLIXML")) return;
        if (text.startsWith("<Objs")) {
            const message = clixmlErrorText(text).replace(/\r\n/g, "\n");
            if (message.trim()) push(message.endsWith("\n") ? message : `${message}\n`);
            return;
        }
        push(`${text}\n`);
    };
    return {
        write: (text) => {
            partial += text;
            let index = partial.indexOf("\n");
            while (index !== -1) {
                line(partial.slice(0, index).replace(/\r$/, ""));
                partial = partial.slice(index + 1);
                index = partial.indexOf("\n");
            }
            if (partial.length > MAX_PARTIAL_LINE) {
                push(partial);
                partial = "";
            }
        },
        end: () => {
            if (partial) line(partial.replace(/\r$/, ""));
            partial = "";
        }
    };
}

export function cleanStderr(stderr: string): string {
    if (!stderr.includes("#< CLIXML")) return stderr.trim();
    let text = "";
    const filter = createClixmlFilter((chunk) => { text += chunk; });
    filter.write(stderr);
    filter.end();
    return text.trim();
}

const PERMISSION_PATTERN = /permission denied|access is denied|access denied|interactive authentication required|not permitted|a password is required|must be root|requires (root|administrator)|are not authorized|unauthorized/i;

// A failed remote command as an API error: the command's own message, and
// 403 when it failed for lack of privileges.
export function commandFailure(result: ExecResult, fallback: string): AppError {
    const message = (cleanStderr(result.stderr) || result.stdout.trim() || fallback).slice(0, 2000);
    const details = { exitCode: result.code, signal: result.signal };
    if (PERMISSION_PATTERN.test(message)) return new AppError("OPS_PERMISSION_DENIED", message, 403, details);
    return new AppError("OPS_COMMAND_FAILED", message, 502, details);
}

// The JSON document in PowerShell output (anything printed around it is ignored).
export function extractJson(output: string): unknown {
    const start = output.search(/[[{]/);
    if (start === -1) return null;
    const end = Math.max(output.lastIndexOf("}"), output.lastIndexOf("]"));
    if (end < start) return null;
    try {
        return JSON.parse(output.slice(start, end + 1));
    } catch {
        return null;
    }
}

export function ensureArray<T>(value: T | T[] | null | undefined): T[] {
    if (Array.isArray(value)) return value;
    if (value === null || value === undefined) return [];
    return [value];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function asString(value: unknown): string {
    return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

export function asNumber(value: unknown): number | null {
    const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? number : null;
}
