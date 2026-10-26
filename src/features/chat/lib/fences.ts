// Splits an AI answer into Markdown text and fenced code blocks. The same
// parse drives rendering, the Run buttons, Auto-Run and Fix it, so what runs
// is always exactly what the user sees as a runnable block.

import { trimTrailingNewlines } from '@shared/text';

export type TextSegment = { type: 'text'; text: string };
export type CodeSegment = {
    type: 'code';
    // First word of the info string, lower-case ('' when untagged).
    lang: string;
    code: string;
    // False while the closing fence has not arrived (a streaming answer).
    closed: boolean;
};
export type Segment = TextSegment | CodeSegment;

const OPENING_FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;
const SINGLE_LINE_FENCE = /^\s*(`{3,})([^`]+?)\1\s*$/;
// "Run this:```bash": a tagged opening fence after text on the same line.
const GLUED_OPENING_FENCE = /^(.*?[^`~\s])[ \t]*(`{3,}|~{3,})([\w+#.-]+)[ \t]*$/;

const isOpeningFence = (match: RegExpExecArray | null): match is RegExpExecArray =>
    match !== null && !(match[2][0] === '`' && match[3].includes('`'));

const closingFence = (fence: string) => new RegExp(`^\\s*${fence[0] === '`' ? '`' : '~'}{${fence.length},}\\s*$`);
// "uname -a```": the closing fence after the last line of code.
const gluedClosingFence = (fence: string) => {
    const char = fence[0] === '`' ? '`' : '~';
    return new RegExp(`^(.*[^${char}\\s])[ \\t]*(${char}{${fence.length},})[ \\t]*$`);
};
// "```Con esto verás la versión.": the closing fence before the text that
// follows the block. A bare word after it ("```bash") reads as an info
// string, which a closing fence cannot have, so that line stays code.
const closingFenceBeforeText = (fence: string) => {
    const char = fence[0] === '`' ? '`' : '~';
    return new RegExp(`^(\\s*${char}{${fence.length},})(?!${char})[ \\t]*(\\S.*)$`);
};
const INFO_STRING = /^[\w+#.-]+$/;

// Whether `text` ends inside an inline code span (a backtick run that no run
// of the same length closes).
function endsInCodeSpan(text: string): boolean {
    let open = 0;
    for (const run of text.match(/`+/g) ?? []) {
        if (!open) open = run.length;
        else if (run.length === open) open = 0;
    }
    return open !== 0;
}

// Models sometimes glue a fence to the text around it: an opening fence at
// the end of a sentence ("...as follows:```bash"), a closing fence at the
// end of the last command, or text right after a closing fence. Markdown then
// shows the code as a paragraph, or the block never closes and the text
// after it would run as part of it. Each such fence gets a line of its own;
// fences inside inline code are left alone. Line breaks become \n.
export function normalizeFences(content: string): string {
    const output: string[] = [];
    let fence: string | null = null;

    // A line outside any block; returns the fence it opens, if any.
    const outsideBlock = (line: string): string | null => {
        const opening = OPENING_FENCE.exec(line);
        if (isOpeningFence(opening)) {
            output.push(line);
            return opening[2];
        }
        const glued = GLUED_OPENING_FENCE.exec(line);
        if (glued && !endsInCodeSpan(glued[1])) {
            output.push(glued[1], '', `${glued[2]}${glued[3]}`);
            return glued[2];
        }
        output.push(line);
        return null;
    };

    for (const line of content.replace(/\r\n?/g, '\n').split('\n')) {
        if (fence === null) {
            fence = outsideBlock(line);
            continue;
        }
        const glued = gluedClosingFence(fence).exec(line);
        const beforeText = glued ? null : closingFenceBeforeText(fence).exec(line);
        if (glued) {
            output.push(glued[1], glued[2]);
            fence = null;
        } else if (beforeText && !INFO_STRING.test(beforeText[2].trim())) {
            output.push(beforeText[1]);
            fence = outsideBlock(beforeText[2]);
        } else {
            output.push(line);
            if (closingFence(fence).test(line)) fence = null;
        }
    }
    return output.join('\n');
}

export type ParseOptions = {
    // The answer is complete: a block still open at its end is closed (the
    // model left out the closing fence). While an answer streams, or when it
    // was stopped or cut off, that block stays open.
    complete?: boolean;
};

export function parseSegments(content: string, options: ParseOptions = {}): Segment[] {
    const segments: Segment[] = [];
    const lines = normalizeFences(content).split('\n');
    let text: string[] = [];

    const flushText = () => {
        const joined = text.join('\n');
        if (joined.trim()) segments.push({ type: 'text', text: joined });
        text = [];
    };

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];

        // "```ls -la```" on a line of its own: an untagged one-line block.
        const single = SINGLE_LINE_FENCE.exec(line);
        if (single) {
            flushText();
            segments.push({ type: 'code', lang: '', code: single[2].trim(), closed: true });
            continue;
        }

        const opening = OPENING_FENCE.exec(line);
        if (!isOpeningFence(opening)) {
            text.push(line);
            continue;
        }

        flushText();
        const [, indent, fence, info] = opening;
        const closing = closingFence(fence);
        const body: string[] = [];
        let closed = false;
        for (i += 1; i < lines.length; i++) {
            if (closing.test(lines[i])) {
                closed = true;
                break;
            }
            // Lines of a nested (indented) block lose the fence's indentation.
            body.push(lines[i].startsWith(indent) ? lines[i].slice(indent.length) : lines[i].trimStart());
        }
        segments.push({ type: 'code', lang: info.trim().split(/\s+/)[0]?.toLowerCase() ?? '', code: body.join('\n'), closed: closed || options.complete === true });
    }
    flushText();
    return segments;
}

// Where commands would run, as far as runnable languages are concerned.
export type RunTarget = {
    // Scoped CLI console (lines run as `<bin> <line>`).
    scopedBin?: string | null;
    // FTP console (ls, cd, get...).
    ftp?: boolean;
};

const SHELL_LANGUAGES = new Set([
    'bash', 'sh', 'zsh', 'shell', 'console', 'shell-session', 'shellsession',
    'powershell', 'pwsh', 'ps1', 'cmd', 'bat', 'batch'
]);

// Only shell blocks run; YAML, JSON, text, output... are shown for reference.
// Untagged blocks run only in consoles that accept a single tool's commands.
export function isRunnableLanguage(lang: string, target: RunTarget): boolean {
    if (SHELL_LANGUAGES.has(lang)) return true;
    if (target.scopedBin && (lang === '' || lang === target.scopedBin.toLowerCase())) return true;
    if (target.ftp && (lang === '' || lang === 'ftp')) return true;
    return false;
}

// Prompts of a console transcript: "$ ", "> ", "PS C:\> ", "user@host:~$ ",
// "root@host:/etc# ", "[root@host ~]# ".
const PROMPT_LINES = [
    /^\s*[\w.-]+@[\w.-]+(?::[^\n]*?)?\s?[$#%]\s(.*)$/,
    /^\s*\[[^\]\n]+\][$#]\s(.*)$/,
    /^\s*PS [^>\n]*>\s(.*)$/,
    /^\s*[$>]\s(.*)$/
];
// A bare "# " is a root prompt or a comment: it counts as a prompt only in a
// transcript without any other prompt, and not when it reads like prose.
const ROOT_PROMPT_LINE = /^\s*#\s(.*)$/;
const PROSE = /^[A-Z][a-z]|[.:!?]$/;

const promptCommand = (line: string): string | undefined => {
    for (const pattern of PROMPT_LINES) {
        const match = pattern.exec(line);
        if (match) return match[1];
    }
    return undefined;
};

const rootPromptCommand = (line: string): string | undefined => {
    const command = ROOT_PROMPT_LINE.exec(line)?.[1];
    return command !== undefined && !PROSE.test(command.trim()) ? command : undefined;
};

const isDefined = (value: string | undefined): value is string => value !== undefined;

// The text typed into the terminal for a block: exactly its content. A
// console transcript (```console with "$ " prompts) contributes only its
// prompt lines, without the prompt; comments and output are left out.
export function commandForBlock(block: CodeSegment): string {
    const code = trimTrailingNewlines(block.code);
    if (block.lang !== 'console' && block.lang !== 'shell-session' && block.lang !== 'shellsession') return code;
    const lines = code.split('\n');
    let commands = lines.map(promptCommand).filter(isDefined);
    if (!commands.length) commands = lines.map(rootPromptCommand).filter(isDefined);
    return commands.length ? commands.join('\n') : code;
}

// Commands of the complete runnable blocks of an answer, in order.
export function runnableCommands(content: string, target: RunTarget, options: ParseOptions = {}): string[] {
    return parseSegments(content, options)
        .filter((segment): segment is CodeSegment => segment.type === 'code' && segment.closed && isRunnableLanguage(segment.lang, target))
        .map(commandForBlock)
        .filter((command) => command.trim() !== '');
}
