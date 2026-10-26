import { beforeEach, describe, expect, it } from 'vitest';
import {
    appendTerminalOutput,
    clearTerminalOutput,
    focusTerminalOutput,
    readTerminalOutputSince,
    recentTerminalOutput,
    renderTerminalText,
    terminalOutputMark,
    terminalOutputSession
} from './terminalOutput';

beforeEach(() => {
    clearTerminalOutput(1);
    clearTerminalOutput(2);
});

describe('terminal output feed', () => {
    it('drops escape sequences, also when a chunk splits one', () => {
        appendTerminalOutput(1, '\x1b[1;32mroot@web\x1b[0m:~# ls\r\n');
        appendTerminalOutput(1, '\x1b]0;title\x07file.txt \x1b[');
        appendTerminalOutput(1, '01;34mdir\x1b[0m\r\n');
        expect(recentTerminalOutput(1, 1000)).toBe('root@web:~# ls\nfile.txt dir\n');
    });

    it('keeps counting after the retained text is capped', () => {
        const mark = terminalOutputMark(1);
        appendTerminalOutput(1, 'a'.repeat(30_000));
        appendTerminalOutput(1, 'b'.repeat(30_000));
        expect(terminalOutputMark(1)).toBe(mark + 60_000);

        const before = terminalOutputMark(1);
        appendTerminalOutput(1, '\r\nnew output\r\n');
        expect(readTerminalOutputSince(1, before)).toEqual({ text: '\nnew output\n', truncated: false, total: 60_014 });
    });

    it('flags output that outgrew the retained text and drops its partial first line', () => {
        const mark = terminalOutputMark(1);
        appendTerminalOutput(1, `start\n${'x'.repeat(45_000)}\nend`);
        const since = readTerminalOutputSince(1, mark);
        expect(since).toMatchObject({ truncated: true, text: 'end' });
    });

    it('renders output since a mark from the start of its line, so prompt redraws land in place', () => {
        appendTerminalOutput(1, 'banner\r\nPS C:\\> ');
        const mark = terminalOutputMark(1);
        appendTerminalOutput(1, 'Ge');
        // ConPTY redraws the input line with an absolute cursor move.
        appendTerminalOutput(1, '\x1b[5;9H\x1b[93mGet-Date\x1b[0m -Format o\r\n2026-10-23\r\nPS C:\\> ');
        expect(readTerminalOutputSince(1, mark).text).toBe('PS C:\\> Get-Date -Format o\n2026-10-23\nPS C:\\>');
    });

    it('follows the focused terminal tab instead of mixing two shells', () => {
        appendTerminalOutput(1, 'root@web:~# top\r\n', 'tab-1');
        const mark = terminalOutputMark(1);
        expect(terminalOutputSession(1)).toBe('tab-1');

        // The second tab shows its own screen; the count keeps growing.
        focusTerminalOutput(1, 'tab-2', 'root@web:/srv# ');
        expect(terminalOutputSession(1)).toBe('tab-2');
        expect(recentTerminalOutput(1, 1000)).toBe('root@web:/srv#');
        expect(terminalOutputMark(1)).toBeGreaterThanOrEqual(mark + 'root@web:/srv# '.length);
        appendTerminalOutput(1, 'ls\r\napp.js\r\n', 'tab-2');
        expect(recentTerminalOutput(1, 1000)).toBe('root@web:/srv# ls\napp.js\n');
        // A mark from before the switch reads as cut off.
        expect(readTerminalOutputSince(1, mark).truncated).toBe(true);

        // Focusing the same tab again changes nothing; output of a tab whose
        // focus was not reported starts the feed over.
        focusTerminalOutput(1, 'tab-2', 'ignored');
        expect(recentTerminalOutput(1, 1000)).toBe('root@web:/srv# ls\napp.js\n');
        appendTerminalOutput(1, 'other\r\n', 'tab-3');
        expect(recentTerminalOutput(1, 1000)).toBe('other\n');
        expect(terminalOutputSession(1)).toBe('tab-3');
    });

    it('keeps servers apart', () => {
        appendTerminalOutput(1, 'one');
        appendTerminalOutput(2, 'two');
        expect(recentTerminalOutput(1, 100)).toBe('one');
        expect(recentTerminalOutput(2, 100)).toBe('two');
        expect(readTerminalOutputSince(3, 0)).toEqual({ text: '', truncated: false, total: 0 });
    });
});

describe('renderTerminalText', () => {
    it('applies carriage-return redraws (progress bars)', () => {
        expect(renderTerminalText('Progress 10%\rProgress 50%\rProgress 100%\r\ndone\r\n')).toBe('Progress 100%\ndone\n');
        expect(renderTerminalText('typed\r')).toBe('typed');
    });

    it('applies line-editor redraws (cursor moves and erase in line)', () => {
        // PSReadLine re-renders the input line after a paste.
        expect(renderTerminalText('PS C:\\> Get-Date -For\x1b[13D\x1b[93mGet-Date\x1b[0m -Format o\r\n2026\r\n')).toBe('PS C:\\> Get-Date -Format o\n2026\n');
        expect(renderTerminalText('abcdef\x1b[3D\x1b[K')).toBe('abc');
        expect(renderTerminalText('abc\x1b[2K\rdef')).toBe('def');
        expect(renderTerminalText('ab\bc')).toBe('ac');
        expect(renderTerminalText('x\x1b[5Gy')).toBe('x   y');
    });

    it('starts a new line on a move further down and collapses blank runs', () => {
        expect(renderTerminalText('\x1b[3;1Hfirst\x1b[4;1Hsecond')).toBe('first\nsecond');
        // The first absolute move only sets the origin.
        expect(renderTerminalText('one\x1b[5;1Htwo')).toBe('two');
        expect(renderTerminalText('a\r\n\r\n\r\n\r\n\r\nb')).toBe('a\n\nb');
    });

    it('wraps at the terminal width and joins the wrapped rows back', () => {
        expect(renderTerminalText('abcdefghij', { cols: 4, rows: 10 })).toBe('abcdefghij');
        // A line that just fills the row does not wrap before its line break.
        expect(renderTerminalText('abcd\r\nx', { cols: 4, rows: 10 })).toBe('abcd\nx');
        expect(renderTerminalText('abcdefghij')).toBe('abcdefghij');
    });

    it('follows a long input line redrawn while the screen scrolls (PSReadLine through ConPTY)', () => {
        const size = { cols: 10, rows: 3 };
        appendTerminalOutput(1, 'line1\r\nline2\r\nPS> ', null, size);
        const mark = terminalOutputMark(1);
        // First render of the typed text fills the bottom row.
        appendTerminalOutput(1, '\x1b[3;5Habcdef', null, size);
        // ConPTY scrolls, rewrites the row's last cell and lets it wrap on.
        appendTerminalOutput(1, '\r\n\x1b[2;10Hfghijk', null, size);
        // The final render of the whole line, from the prompt row (now 2).
        appendTerminalOutput(1, '\x1b[2;5Habcdefghijklmno\r\nout\r\nPS> ', null, size);
        expect(readTerminalOutputSince(1, mark).text).toBe('PS> abcdefghijklmno\nout\nPS>');
        expect(recentTerminalOutput(1, 1000)).toBe('line1\nline2\nPS> abcdefghijklmno\nout\nPS>');
    });

    it('applies relative moves up, as readline does after a bracketed paste', () => {
        const echo = 'host$ \x1b[7mecho one\x1b[27m\r\n\r\x1b[7mecho three\x1b[27m\x1b[A\b\b\b\becho one\r\n\recho three\r\n\x1b[?2004l\r';
        expect(renderTerminalText(`${echo}one\r\nthree\r\nhost$ `, { cols: 80, rows: 24 })).toBe('host$ echo one\necho three\none\nthree\nhost$');
        // Text moved above the start of the stream is not part of it.
        expect(renderTerminalText('one\r\n\x1b[3Agone', { cols: 80, rows: 24 })).toBe('one\n');
    });

    it('erases characters in place', () => {
        expect(renderTerminalText('abcdef\r\x1b[2C\x1b[2X')).toBe('ab  ef');
    });
});
