// The lines of a live log view: chunks arrive cut anywhere, so the last
// unterminated piece is carried over; the oldest lines go once the buffer is
// full; terminal colour codes are removed (journalctl and docker emit them).

export type LogBuffer = {
    lines: string[];
    // Text after the last newline, waiting for the rest of its line.
    partial: string;
    // Lines dropped from the front to stay within the limit.
    discarded: number;
};

export const EMPTY_BUFFER: LogBuffer = { lines: [], partial: '', discarded: 0 };

// CSI sequences (colours, cursor movement) and other single-character escapes.
// eslint-disable-next-line no-control-regex -- escape sequences are what it removes
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]/g;

export function appendChunk(buffer: LogBuffer, chunk: string, maxLines: number): LogBuffer {
    if (!chunk) return buffer;
    const text = buffer.partial + chunk.replace(ANSI, '');
    const parts = text.split('\n');
    const partial = parts.pop() ?? '';
    const added = parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
    return trimTo({ lines: added.length ? [...buffer.lines, ...added] : buffer.lines, partial, discarded: buffer.discarded }, maxLines);
}

export function trimTo(buffer: LogBuffer, maxLines: number): LogBuffer {
    const excess = buffer.lines.length - maxLines;
    if (excess <= 0) return buffer;
    return { ...buffer, lines: buffer.lines.slice(excess), discarded: buffer.discarded + excess };
}

// Every complete line plus the one still being written.
export function allLines(buffer: LogBuffer): string[] {
    return buffer.partial ? [...buffer.lines, buffer.partial] : buffer.lines;
}

export type LineFilter = { test: (line: string) => boolean; error: boolean };

// A case-insensitive filter: a regular expression when asked for (an invalid
// one falls back to plain text and is flagged), plain text otherwise.
export function compileFilter(text: string, regex: boolean): LineFilter {
    const needle = text.trim();
    if (!needle) return { test: () => true, error: false };
    if (regex) {
        try {
            const pattern = new RegExp(needle, 'i');
            return { test: (line) => pattern.test(line), error: false };
        } catch {
            // Fall through to a plain-text match.
            const lower = needle.toLowerCase();
            return { test: (line) => line.toLowerCase().includes(lower), error: true };
        }
    }
    const lower = needle.toLowerCase();
    return { test: (line) => line.toLowerCase().includes(lower), error: false };
}
