import { tmpdir } from 'node:os';
import { spawn, type IPty } from 'node-pty';
import { afterEach, describe, expect, it } from 'vitest';
import { encodePowerShellBlock, expandEncodedBlocks, showsRunnerEcho } from '../../shared/powershell';
import { appendTerminalOutput, clearTerminalOutput, readTerminalOutputSince, terminalOutputMark } from '../../src/store/terminalOutput';

// A long runner line typed into a real Windows PowerShell under ConPTY, fed to
// the terminal output store the way the focused terminal tab feeds it. While
// the line arrives, PSReadLine redraws it again and again (a line taller than
// the screen also makes ConPTY repaint the screen): the chat must still read
// the block and everything it printed, without the redraws.
const SERVER_ID = 9001;
const SIZE = { cols: 80, rows: 24 };

// A script of about `size` characters that compresses like real ones (no
// long repeats).
function longBlock(size: number): { block: string; rows: number } {
    let seed = 2024;
    const key = () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return (seed >>> 8).toString(16).padStart(6, '0');
    };
    const lines = ['$rows = @()'];
    let rows = 0;
    while (lines.join('\n').length < size) {
        lines.push(`$rows += [pscustomobject]@{ Id = ${rows}; Key = '${key()}${key()}'; Path = 'C:\\Temp\\${key()}.log'; Note = 'fila ${rows} ñandú' }`);
        rows += 1;
    }
    lines.push('"ROWS=$($rows.Count) LAST=$($rows[-1].Note)"');
    return { block: lines.join('\n'), rows };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('timed out');
        await sleep(200);
    }
}

describe.runIf(process.platform === 'win32')('a long runner line in a Windows PowerShell console', () => {
    let term: IPty | null = null;
    let exited: Promise<boolean> = Promise.resolve(true);
    afterEach(async () => {
        // A killed PTY makes node-pty print "AttachConsole failed": the
        // shell exits by itself unless it hangs.
        term?.write('exit\r');
        if (!(await Promise.race([exited, sleep(5000).then(() => false)]))) term?.kill();
        term = null;
        clearTerminalOutput(SERVER_ID);
    });

    // 16 KB: the redraws outgrow the 40,000 characters the feed retains.
    it.each([4096, 16_384])('reads back as the block and what it printed (%i characters)', async (size) => {
        term = spawn('powershell.exe', ['-NoLogo', '-NoProfile'], { name: 'xterm-256color', ...SIZE, cwd: tmpdir(), env: process.env });
        const shell = term;
        exited = new Promise((resolve) => shell.onExit(() => resolve(true)));
        let lastDataAt = Date.now();
        term.onData((data) => {
            lastDataAt = Date.now();
            appendTerminalOutput(SERVER_ID, data, 'pty', SIZE);
        });
        const atPrompt = (mark: number) => /\nPS [^\n]*>\s*$/.test(`\n${readTerminalOutputSince(SERVER_ID, mark).text}`);
        await waitFor(() => atPrompt(0), 30_000);

        const { block, rows } = longBlock(size);
        const line = encodePowerShellBlock(block);
        expect(line.length).toBeLessThan(block.length / 2);
        const mark = terminalOutputMark(SERVER_ID);
        term.write(`${line}\r`);
        await waitFor(() => readTerminalOutputSince(SERVER_ID, mark).text.includes('ROWS=') && atPrompt(mark) && Date.now() - lastDataAt > 1500, 90_000);

        const since = readTerminalOutputSince(SERVER_ID, mark);
        const text = expandEncodedBlocks(since.text);
        expect(text).toContain(`ROWS=${rows} LAST=fila ${rows - 1} ñandú`);
        // No runner text and no base64 left from the redraws.
        expect(text).not.toMatch(/FromBase64String|\$__s[mt]|[A-Za-z0-9+/=]{60,}/);
        // What a cut feed lost was only the echo of the line.
        if (since.truncated) expect(showsRunnerEcho(since.text)).toBe(true);
        else expect(text).toMatch(/^PS [^\n]*> \$rows = @\(\)\n/);
    }, 150_000);
});
