import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startLocalTerminal, type LocalTermHandle } from './pty';

// Local terminals: the saved command is split like a shell would (quotes,
// paths with spaces), resolved on PATH and started in a PTY.

vi.setConfig({ testTimeout: 20_000 });

const handles: LocalTermHandle[] = [];
let tmpDir: string | undefined;

afterEach(() => {
    while (handles.length) handles.pop()?.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    tmpDir = undefined;
});

async function run(command: string): Promise<{ output: string; exited: boolean }> {
    let output = '';
    let exited = false;
    const handle = await startLocalTerminal({ command, cols: 120, rows: 30 }, {
        onData: (chunk) => { output += chunk; },
        onExit: () => { exited = true; },
    });
    handles.push(handle);
    await vi.waitFor(() => expect(exited).toBe(true), { timeout: 15_000, interval: 50 });
    return { output, exited };
}

describe('startLocalTerminal', () => {
    it('runs a program from a quoted path with spaces and quoted arguments', async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind pty '));
        let program: string;
        if (process.platform === 'win32') {
            program = path.join(tmpDir, 'hello tool.cmd');
            fs.writeFileSync(program, '@echo hello from %1\r\n');
        } else {
            program = path.join(tmpDir, 'hello tool');
            fs.writeFileSync(program, '#!/bin/sh\necho "hello from $1"\n');
            fs.chmodSync(program, 0o755);
        }

        const { output } = await run(`"${program}" "the pty"`);
        expect(output).toMatch(/hello from "?the pty/);
    });

    it('finds bare program names on PATH (PATHEXT on Windows)', async () => {
        const { output } = await run('node -e "console.log(\'answer:\' + (6 * 7))"');
        expect(output).toContain('answer:42');
    });

    it('ends the session with the reason when the program cannot start', async () => {
        const { output } = await run('shellmind-no-such-program --flag');
        expect(output).toContain('The local terminal could not start');
        expect(output).toContain('"shellmind-no-such-program" was not found');
    });

    it('refuses shell operators in the saved command', async () => {
        const { output } = await run('node -e 1 && calc');
        expect(output).toContain('runs without a shell');
    });
});
