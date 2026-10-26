import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LocalTermHandle } from './pty';
import { scopedCliEnv, startScopedCli } from './scopedCli';

// A scoped console for `node`: every line runs `node <args>`, without a shell.

vi.setConfig({ testTimeout: 20_000 });

type Console = {
    handle: LocalTermHandle;
    output: () => string;
    exited: () => boolean;
    // Resolves once `needle` was printed `count` times in total.
    waitFor: (needle: string, count?: number) => Promise<void>;
};

const consoles: LocalTermHandle[] = [];
let tmpDir: string | undefined;

afterEach(() => {
    while (consoles.length) consoles.pop()?.kill();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    tmpDir = undefined;
});

function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
}

function openConsole(): Console {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-cli-'));
    let output = '';
    let exited = false;
    const handle = startScopedCli({ bin: 'node', cwd: tmpDir }, {
        onData: (chunk) => { output += chunk; },
        onExit: () => { exited = true; },
    });
    consoles.push(handle);
    return {
        handle,
        output: () => output,
        exited: () => exited,
        waitFor: async (needle, count = 1) => {
            const deadline = Date.now() + 15_000;
            while (occurrences(output, needle) < count) {
                if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(needle)}; got ${JSON.stringify(output)}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        },
    };
}

const PROMPT = 'node>';

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe('scoped CLI console', () => {
    it('passes quoted arguments to the tool, without a shell', async () => {
        const cli = openConsole();
        await cli.waitFor(PROMPT);
        cli.handle.write(`-e "console.log(JSON.stringify(process.argv.slice(1)))" "a b" 'c|d' %PATH% $HOME\r`);
        await cli.waitFor('["a b","c|d","%PATH%","$HOME"]');
        await cli.waitFor(PROMPT, 2);
    });

    it.each(['-e "1" | calc', '-e "1" & calc', '-e "1"; id', '-e "1" > out.txt', '-e $(id)'])(
        'refuses %j instead of handing it to a shell',
        async (line) => {
            const cli = openConsole();
            await cli.waitFor(PROMPT);
            cli.handle.write(`${line}\r`);
            await cli.waitFor('pipes, redirections and chaining');
            await cli.waitFor(PROMPT, 2);
            expect(fs.readdirSync(tmpDir!)).toEqual([]);
        }
    );

    it('reports refused lines to the caller, which tells the user in their language', async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-cli-'));
        const refusals: Array<[string, string | undefined]> = [];
        let output = '';
        const handle = startScopedCli(
            { bin: 'node', cwd: tmpDir, onRefused: (reason, detail) => refusals.push([reason, detail]) },
            { onData: (chunk) => { output += chunk; }, onExit: () => undefined }
        );
        consoles.push(handle);
        const prompts = (count: number) => vi.waitFor(() => expect(occurrences(output, PROMPT)).toBe(count), { timeout: 15_000 });
        await prompts(1);

        handle.write('-e "1" | calc\r');
        await prompts(2);
        handle.write('-e "it\'s\r');
        await prompts(3);
        expect(refusals).toEqual([['operator', '|'], ['unterminated-quote', 'double']]);
        // Nothing in English: the notice is the caller's.
        expect(output).not.toMatch(/pipes|quote/);
    });

    it('stays closed after exit', async () => {
        const cli = openConsole();
        await cli.waitFor(PROMPT);
        cli.handle.write('exit\r');
        expect(cli.exited()).toBe(true);

        const before = cli.output();
        cli.handle.write(`-e "require('fs').writeFileSync('marker', 'x')"\r`);
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(fs.existsSync(path.join(tmpDir!, 'marker'))).toBe(false);
        expect(cli.output()).toBe(before);
    });

    it('stops the command and everything it started on Ctrl+C', async () => {
        const cli = openConsole();
        await cli.waitFor(PROMPT);
        // The marker is computed, so the echo of the typed line does not contain it.
        const script = "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});console.log('grand'+'child:'+c.pid);setInterval(()=>{},1000)";
        cli.handle.write(`-e "${script}"\r`);
        await cli.waitFor('grandchild:');
        expect(cli.output()).toMatch(/grandchild:\d+/);
        const pid = Number(/grandchild:(\d+)/.exec(cli.output())![1]);

        cli.handle.write('\x03');
        await cli.waitFor('^C');
        await cli.waitFor(PROMPT, 2);
        await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 10_000 });
    });

    it('runs a pasted block line by line', async () => {
        const cli = openConsole();
        await cli.waitFor(PROMPT);
        cli.handle.write(`-e "console.log('first')"\r\n-e "console.log('second')"\r`);
        await cli.waitFor(PROMPT, 3);
        const output = cli.output();
        expect(output.indexOf('first')).toBeGreaterThan(-1);
        expect(output.indexOf('second')).toBeGreaterThan(output.indexOf('first'));
    });

    it('makes Python tools write UTF-8 to its pipes on Windows', async () => {
        const cli = openConsole();
        await cli.waitFor(PROMPT);
        cli.handle.write(`-e "console.log('en' + 'c=' + process.env.PYTHONUTF8 + '/' + process.env.PYTHONIOENCODING)"\r`);
        await cli.waitFor('enc=');
        await cli.waitFor(PROMPT, 2);
        const inherited = `${process.env.PYTHONUTF8}/${process.env.PYTHONIOENCODING}`;
        expect(/enc=(\S+)/.exec(cli.output())?.[1]).toBe(process.platform === 'win32' ? '1/utf-8' : inherited);
    });

    it('keeps an encoding the user chose for Python', () => {
        const before = process.env.PYTHONIOENCODING;
        process.env.PYTHONIOENCODING = 'cp850';
        try {
            expect(scopedCliEnv('win32')).toMatchObject({ PYTHONUTF8: '1', PYTHONIOENCODING: 'cp850' });
            expect(scopedCliEnv('linux').PYTHONUTF8).toBe(process.env.PYTHONUTF8);
        } finally {
            if (before === undefined) delete process.env.PYTHONIOENCODING;
            else process.env.PYTHONIOENCODING = before;
        }
    });

    it('pauses and resumes the output of the running command', async () => {
        const cli = openConsole();
        await cli.waitFor(PROMPT);
        cli.handle.pause();
        // Computed, so the echo of the typed line does not contain it.
        cli.handle.write(`-e "setInterval(() => console.log('tick' + '-tock'), 20)"\r`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        expect(cli.output()).not.toContain('tick-tock');
        cli.handle.resume();
        await cli.waitFor('tick-tock', 3);
        cli.handle.write('\x03');
        await cli.waitFor(PROMPT, 2);
    });
});
