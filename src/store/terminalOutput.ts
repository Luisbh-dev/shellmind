// Recent output of each server's terminal plus a monotonic count of every
// character ever appended. The count keeps growing when the retained text is
// capped, so "output since mark" stays exact (the AI chat's Auto-Run waits
// for a command's output with it). Kept outside React state: output arrives
// many times per second and nothing renders from it directly.
//
// The raw stream is kept and rendered to plain text when read: shells redraw
// the input line with cursor moves (PSReadLine, readline), which only make
// sense applied in order, as a terminal of the same size would.
//
// A server can have several terminal tabs; only the focused one feeds this.
// The feed follows that tab: when another tab gets the focus it starts over
// with what that tab shows, so the chat never reads two shells mixed.

// Relative: the Node-side tests compile this module too (no path aliases there).
import { forgetTerminalSecrets, maskTerminalSecrets } from '../lib/terminalSecrets';

const MAX_RETAINED_CHARS = 40_000;

export type TerminalSize = { cols: number; rows: number };

// `session`: the terminal tab the retained output comes from; `size`: its
// size when it last printed.
type Feed = { raw: string; total: number; session: string | null; size: TerminalSize | null };

const feeds = new Map<number, Feed>();

// The feed continues with another terminal tab: nothing of the previous one
// is kept, and the count jumps by one, so a mark taken before always reads
// as cut off (never the other tab's output as its own).
function startOver(feed: Feed, session: string): void {
    feed.session = session;
    feed.raw = '';
    feed.total += 1;
}

// Called with every chunk the focused terminal tab of `serverId` prints.
export function appendTerminalOutput(serverId: number, data: string, session: string | null = null, size?: TerminalSize): void {
    if (!data) return;
    const feed = feeds.get(serverId) ?? { raw: '', total: 0, session, size: null };
    // Output of another tab than the retained one (its focus was not
    // reported): start over rather than mix the two.
    if (session !== null && feed.session !== session) startOver(feed, session);
    if (size) feed.size = size;
    feed.total += data.length;
    feed.raw = (feed.raw + data).slice(-MAX_RETAINED_CHARS);
    feeds.set(serverId, feed);
}

// Another terminal tab of `serverId` got the focus: the feed continues
// with what that tab shows (`screen`, plain text up to its cursor).
export function focusTerminalOutput(serverId: number, session: string, screen: string): void {
    const feed = feeds.get(serverId) ?? { raw: '', total: 0, session: null, size: null };
    if (feed.session === session) return;
    startOver(feed, session);
    // Known again once that tab prints.
    feed.size = null;
    feed.raw = screen.slice(-MAX_RETAINED_CHARS);
    feed.total += feed.raw.length;
    feeds.set(serverId, feed);
}

// The terminal tab whose output the feed holds (null: none reported yet).
export function terminalOutputSession(serverId: number): string | null {
    return feeds.get(serverId)?.session ?? null;
}

// The mark to pass to readTerminalOutputSince() later.
export function terminalOutputMark(serverId: number): number {
    return feeds.get(serverId)?.total ?? 0;
}

const ESC = '\x1b';

/* eslint-disable no-control-regex -- terminal escape sequences */
// Operating system commands (window titles, hyperlinks, shell integration).
const OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)?/g;
const CSI = /^\x1b\[([0-?]*)[ -/]*([@-~])/;
/* eslint-enable no-control-regex */

// Applies the stream to a model of the terminal's screen, `size` wide and
// tall when known: printable text with automatic wrapping, CR, LF (the screen
// scrolls at its bottom row), backspace, tab, cursor moves, erase in line and
// erase characters; every other control sequence is dropped. Rows that
// wrapped are joined back into the line they continue.
// The stream may start anywhere on the screen: the first absolute move tells
// where the screen's rows are (it lands on the current row), and text moved
// above the start of the stream is dropped. Without a size nothing wraps or
// scrolls, so an absolute move up stays on the current row (the screen may
// have scrolled since).
export function renderTerminalText(raw: string, size?: TerminalSize | null): string {
    const width = size && size.cols > 0 ? size.cols : Infinity;
    const height = size && size.rows > 0 ? size.rows : Infinity;
    const text = raw.replace(OSC, '');
    const rows: string[][] = [[]];
    // rows[i] continues rows[i - 1] (automatic wrap).
    const wrapped: boolean[] = [false];
    // Negative: above the start of the stream.
    let row = 0;
    let col = 0;
    // The last column was written: the next character goes to the next row.
    let wrapPending = false;
    // The row index of the screen's first row, once an absolute move told.
    let top: number | null = null;

    const goTo = (target: number) => {
        row = target;
        while (rows.length <= row) {
            rows.push([]);
            wrapped.push(false);
        }
        wrapPending = false;
    };
    const lineFeed = () => {
        // At the bottom row the screen scrolls up by one.
        if (top !== null && row + 1 > top + height - 1) top += 1;
        goTo(row + 1);
        wrapped[row] = false;
    };
    const moveUp = (n: number) => goTo(top === null ? row - n : Math.max(top, row - n));
    const moveDown = (n: number) => goTo(top === null ? row + n : Math.min(top + height - 1, row + n));
    const moveToRow = (screenRow: number) => {
        if (top === null) top = row - screenRow;
        const target = top + screenRow;
        goTo(height === Infinity && target < row ? row : target);
    };
    const put = (ch: string) => {
        if (wrapPending) {
            lineFeed();
            wrapped[row] = true;
            col = 0;
        }
        if (row >= 0) {
            const cells = rows[row];
            while (cells.length < col) cells.push(' ');
            cells[col] = ch;
        }
        if (col + 1 >= width) wrapPending = true;
        else col += 1;
    };

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === ESC) {
            const csi = CSI.exec(text.slice(i, i + 32));
            if (csi) {
                const params = csi[1].split(';').map((value) => Number.parseInt(value, 10));
                const n = Number.isFinite(params[0]) && params[0] > 0 ? params[0] : 1;
                const cells = row >= 0 ? rows[row] : [];
                switch (csi[2]) {
                    case 'A': moveUp(n); break;
                    case 'B': moveDown(n); break;
                    case 'C': col = Math.min(width - 1, col + n); wrapPending = false; break;
                    case 'D': col = Math.max(0, col - n); wrapPending = false; break;
                    case 'E': moveDown(n); col = 0; break;
                    case 'F': moveUp(n); col = 0; break;
                    case 'G': col = Math.min(width - 1, n - 1); wrapPending = false; break;
                    case 'H':
                    case 'f':
                        moveToRow(n - 1);
                        col = Math.min(width - 1, Number.isFinite(params[1]) && params[1] > 0 ? params[1] - 1 : 0);
                        break;
                    case 'd': moveToRow(n - 1); break;
                    case 'K': {
                        const mode = Number.isFinite(params[0]) ? params[0] : 0;
                        if (mode === 0) cells.splice(col);
                        else if (mode === 1) cells.fill(' ', 0, Math.min(col + 1, cells.length));
                        else cells.length = 0;
                        break;
                    }
                    case 'X': cells.fill(' ', col, Math.min(col + n, cells.length)); break;
                    default: break;
                }
                i += csi[0].length - 1;
            } else if (/[()*+#%]/.test(text[i + 1] ?? '')) {
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if (ch === '\n') {
            lineFeed();
            col = 0;
        } else if (ch === '\r') {
            col = 0;
            wrapPending = false;
        } else if (ch === '\b') {
            col = Math.max(0, col - 1);
            wrapPending = false;
        } else if (ch === '\t') {
            col = Math.min(width - 1, (Math.floor(col / 8) + 1) * 8);
        } else if (ch >= ' ' && ch !== '\x7f') {
            put(ch);
        }
    }

    const lines: string[] = [];
    rows.forEach((cells, index) => {
        const content = cells.join('');
        if (index > 0 && wrapped[index]) lines[lines.length - 1] += content;
        else lines.push(content);
    });
    // Screen clears leave runs of empty lines.
    return lines.map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n');
}

export type TerminalOutputSince = {
    text: string;
    // The output since `mark` was longer than what is retained.
    truncated: boolean;
    total: number;
};

// Drops the first, partial line of a cut taken mid-stream (it may start in
// the middle of an escape sequence).
const fromFirstLineBreak = (raw: string) => {
    const index = raw.indexOf('\n');
    return index === -1 ? raw : raw.slice(index + 1);
};

// Output since a mark is rendered from the start of the line the mark falls
// in (usually the prompt the command was typed at), so the shell's redraws
// of that line land in the right columns.
const MAX_LINE_PREFIX = 512;

// The text read from here goes to the AI chat: secret values typed into the
// terminal are masked (W7-S4, src/lib/terminalSecrets.ts).
export function readTerminalOutputSince(serverId: number, mark: number): TerminalOutputSince {
    const feed = feeds.get(serverId);
    if (!feed) return { text: '', truncated: false, total: 0 };
    const retainedFrom = feed.total - feed.raw.length;
    const truncated = mark < retainedFrom;
    let raw: string;
    if (truncated) {
        raw = fromFirstLineBreak(feed.raw);
    } else {
        const offset = mark - retainedFrom;
        const lineStart = feed.raw.lastIndexOf('\n', offset - 1) + 1;
        raw = feed.raw.slice(offset - lineStart <= MAX_LINE_PREFIX ? lineStart : offset);
    }
    return { text: maskTerminalSecrets(serverId, renderTerminalText(raw, feed.size)), truncated, total: feed.total };
}

// About the last `maxChars` characters the terminal of `serverId` shows.
export function recentTerminalOutput(serverId: number, maxChars: number): string {
    const feed = feeds.get(serverId);
    if (!feed) return '';
    const raw = feed.raw.length > maxChars * 2 ? fromFirstLineBreak(feed.raw.slice(-maxChars * 2)) : feed.raw;
    return maskTerminalSecrets(serverId, renderTerminalText(raw, feed.size)).slice(-maxChars);
}

export function clearTerminalOutput(serverId: number): void {
    feeds.delete(serverId);
    forgetTerminalSecrets(serverId);
}
