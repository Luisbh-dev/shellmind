// Splits a command line into an argv array the way people type it in a
// shell, without ever running one: blanks separate words, '...' and "..."
// group them, and a backslash escapes the next character. On Windows a
// backslash is an ordinary path character except right before a double quote
// (the rules of the Microsoft C runtime), so `C:\Program Files\x.exe` works
// unquoted only when it has no spaces, exactly like in cmd.exe.
//
// Pipes, redirections, command chaining and substitutions are not executed:
// the first unquoted one is reported in `operator` so callers can refuse the
// line with a clear message instead of passing "|" to a program as a word.

export type ParsedCommandLine = {
    argv: string[];
    operator: string | null;
};

export class CommandLineError extends Error {
    // What is wrong, for messages in the user's language (`detail`: which
    // quote); "other" errors only have the message.
    readonly reason: "unterminated-quote" | "batch-unsafe" | "other";
    readonly detail?: string;

    constructor(message: string, reason: CommandLineError["reason"] = "other", detail?: string) {
        super(message);
        this.name = "CommandLineError";
        this.reason = reason;
        this.detail = detail;
    }
}

const BLANK = /[ \t]/;
const OPERATOR_CHARS = new Set(["|", "&", ";", "<", ">", "`", "\n", "\r"]);

export function parseCommandLine(input: string, options: { windows?: boolean } = {}): ParsedCommandLine {
    const windows = options.windows ?? process.platform === "win32";
    const argv: string[] = [];
    let operator: string | null = null;
    // null while between words; "" is an (empty) word in progress, e.g. after ''.
    let word: string | null = null;
    let quote: "'" | "\"" | null = null;

    const endWord = () => {
        if (word !== null) argv.push(word);
        word = null;
    };
    const append = (text: string) => {
        word = (word ?? "") + text;
    };

    for (let i = 0; i < input.length; i++) {
        const ch = input[i];

        if (quote === "'") {
            if (ch === "'") quote = null;
            else append(ch);
            continue;
        }

        if (ch === "\\") {
            if (windows) {
                // A run of backslashes: before a double quote, each pair is one
                // backslash and an odd one escapes the quote; elsewhere literal.
                let end = i;
                while (input[end] === "\\") end++;
                const count = end - i;
                if (input[end] === "\"") {
                    append("\\".repeat(Math.floor(count / 2)));
                    if (count % 2 === 1) {
                        append("\"");
                        i = end;
                    } else {
                        i = end - 1;
                    }
                } else {
                    append("\\".repeat(count));
                    i = end - 1;
                }
                continue;
            }
            const next = input[i + 1];
            if (next === undefined) {
                append("\\");
            } else if (quote === "\"" && !["\"", "\\", "$", "`", "\n"].includes(next)) {
                // Inside double quotes only a few characters can be escaped.
                append("\\" + next);
                i++;
            } else {
                append(next);
                i++;
            }
            continue;
        }

        if (quote === "\"") {
            if (ch === "\"") {
                // Windows: "" inside a quoted region is a literal quote.
                if (windows && input[i + 1] === "\"") {
                    append("\"");
                    i++;
                } else {
                    quote = null;
                }
            } else {
                append(ch);
            }
            continue;
        }

        if (ch === "'" || ch === "\"") {
            quote = ch;
            append("");
            continue;
        }
        if (BLANK.test(ch)) {
            endWord();
            continue;
        }
        if (OPERATOR_CHARS.has(ch) || (ch === "$" && input[i + 1] === "(")) {
            if (operator === null) {
                const pair = input.slice(i, i + 2);
                operator = ch === "$" ? "$(" : ch === "\n" || ch === "\r" ? "newline" : ["||", "&&", ">>"].includes(pair) ? pair : ch;
            }
            endWord();
            continue;
        }
        append(ch);
    }

    if (quote) {
        const kind = quote === "'" ? "single" : "double";
        throw new CommandLineError(`Unterminated ${kind} quote.`, "unterminated-quote", kind);
    }
    endWord();
    return { argv, operator };
}
