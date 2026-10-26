import { deflateRaw, inflateRaw } from "./deflate";
import { trimTrailingNewlines } from "./text";

// A multi-line PowerShell block typed into a terminal as one line (see
// src/features/terminal/delivery.ts): the line decodes the block (the
// DEFLATE-compressed UTF-8, in base64) and runs it in the current scope,
// statement by statement, so cd and variables persist and each statement's
// output is formatted on its own, as if it had been typed. A block that does
// not parse fails as a whole, before anything runs; one with a param block,
// named blocks (begin, process, end), using statements or traps runs as one
// script.
//
// The block is compressed because the line's length costs twice: PSReadLine
// redraws the whole input line each time more of it arrives, so the
// terminal prints about the square of its length before the block runs.

const RUNNER_HEAD = "try { $__sm = [scriptblock]::Create([IO.StreamReader]::new([IO.Compression.DeflateStream]::new([IO.MemoryStream]::new([Convert]::FromBase64String('";
const RUNNER_TAIL = "')), [IO.Compression.CompressionMode]::Decompress)).ReadToEnd()); "
    + "if ($__sm.Ast.EndBlock.Unnamed -and -not ($__sm.Ast.ParamBlock -or $__sm.Ast.UsingStatements -or $__sm.Ast.EndBlock.Traps)) { "
    + "foreach ($__st in $__sm.Ast.EndBlock.Statements) { . ([scriptblock]::Create($__st.Extent.Text)) | Out-Default } "
    + "} else { . $__sm } } finally { Remove-Variable __sm, __st -ErrorAction Ignore }";

function toBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function decodeBlock(base64: string): string | null {
    try {
        const inflated = inflateRaw(Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0)));
        return inflated && new TextDecoder("utf-8", { fatal: true }).decode(inflated);
    } catch {
        return null;
    }
}

export function encodePowerShellBlock(script: string): string {
    const block = trimTrailingNewlines(script.replace(/\r\n?/g, "\n"));
    return `${RUNNER_HEAD}${toBase64(deflateRaw(new TextEncoder().encode(block)))}${RUNNER_TAIL}`;
}

// The terminal echoes such a block as its runner line, possibly wrapped.
const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const allowBreaks = (text: string) => [...text].map(escapeRegExp).join("\\n?");
const ECHO = new RegExp(`${allowBreaks(RUNNER_HEAD)}([A-Za-z0-9+/=\\n]+)${allowBreaks(RUNNER_TAIL)}`, "g");
const ECHO_END = new RegExp(allowBreaks(RUNNER_TAIL), "g");
const HAS_ECHO_END = new RegExp(ECHO_END.source);
const PS_PROMPT = /PS [^>\n]{1,200}> ?/g;
// What earlier redraws of a runner line leave: pieces of its text or of its
// base64.
const RUNNER_PIECE = /\$__s[mt]\b|FromBase64String|IO\.Compression\./;
const hasRemnants = (text: string) => RUNNER_PIECE.test(text) || /[A-Za-z0-9+/=]{40,}/.test(text);
const isRemnantLine = (line: string) => RUNNER_PIECE.test(line) || /^[A-Za-z0-9+/=]{40,}$/.test(line);

const lastPrompt = (text: string) => [...text.matchAll(PS_PROMPT)].at(-1)?.[0] ?? "";

// Whether `output` shows where the echo of a runner line ends: everything
// after it is what the block printed, even when the start of the echo was
// cut off.
export function showsRunnerEcho(output: string): boolean {
    return HAS_ECHO_END.test(output);
}

// Output as the AI and the chat read it: each runner line's echo gives way to
// its block. While a long line arrives, PSReadLine redraws it again and
// again; redraws that scrolled away, or a capture that starts in the middle
// of them, leave remnants before the final echo, on its line and on whole
// lines above it (where ConPTY's repaints broke them off). They go, and only
// the prompt in front stays (the whole echo when its start is missing).
export function expandEncodedBlocks(output: string): string {
    const complete = new Map<number, { start: number; block: string | null }>();
    for (const echo of output.matchAll(ECHO)) {
        complete.set(echo.index + echo[0].length, { start: echo.index, block: decodeBlock(echo[1].replace(/\n/g, "")) });
    }
    let result = "";
    let from = 0;
    for (const end of output.matchAll(ECHO_END)) {
        const endIndex = end.index + end[0].length;
        const echo = complete.get(endIndex);
        // A runner echo whose block does not decode is left as it is.
        if (echo && echo.block === null) continue;
        const start = echo ? echo.start : end.index;
        let lineStart = Math.max(from, output.lastIndexOf("\n", start - 1) + 1);
        while (lineStart > from) {
            const above = Math.max(from, output.lastIndexOf("\n", lineStart - 2) + 1);
            if (!isRemnantLine(output.slice(above, lineStart - 1))) break;
            lineStart = above;
        }
        const before = output.slice(lineStart, start);
        const kept = echo && !hasRemnants(before) ? before : lastPrompt(before);
        result += output.slice(from, lineStart) + kept + (echo?.block ?? "");
        from = endIndex;
    }
    return result + output.slice(from);
}
