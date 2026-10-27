import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_TEST_TIMEOUT_MS } from '../../test/setup/timeouts';
import { CommandLineError } from './argv';
import { commandSpec, killProcessTree, runCommand, spawnCommand } from './process';

// Arguments that a shell would interpret; they must reach the program verbatim.
const TRICKY_ARGS = [
    'a&b', 'say "hi" & calc', 'x|y', '(paren)', 'a^b', '<in>', 'C:\\path\\', 'space here', "'single'",
    "[?name=='x']", '`tick`', 'semi;colon', 'comma,arg', '*.txt', '?', 'tab\there', '', 'end\\"', '\\\\server\\share',
];

const PRINT_ARGV = 'console.log(JSON.stringify(process.argv.slice(1)))';

let tmpDir: string | undefined;

afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    tmpDir = undefined;
});

function isAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
}

describe('commandSpec', () => {
    it('runs programs directly', () => {
        expect(commandSpec('/usr/bin/docker', ['ps', 'a&b'], { platform: 'linux' }))
            .toEqual({ file: '/usr/bin/docker', args: ['ps', 'a&b'], windowsVerbatimArguments: false });
        expect(commandSpec('C:\\bin\\kubectl.exe', ['get', 'a|b'], { platform: 'win32' }))
            .toEqual({ file: 'C:\\bin\\kubectl.exe', args: ['get', 'a|b'], windowsVerbatimArguments: false });
    });

    it('escapes every cmd.exe metacharacter for batch files, twice', () => {
        const spec = commandSpec('C:\\Program Files\\Azure\\az.cmd', ['vm', 'a&b'], { platform: 'win32', env: { ComSpec: 'C:\\Windows\\cmd.exe' } });
        expect(spec.file).toBe('C:\\Windows\\cmd.exe');
        expect(spec.windowsVerbatimArguments).toBe(true);
        expect(spec.args.slice(0, 4)).toEqual(['/d', '/v:off', '/s', '/c']);
        expect(spec.args[4]).toBe('"C:\\Program^ Files\\Azure\\az.cmd ^^^"vm^^^" ^^^"a^^^&b^^^""');
    });

    it('refuses arguments cmd.exe cannot carry safely to a batch file', () => {
        for (const arg of ['50%', '%PATH%', 'wow!', 'two\nlines']) {
            expect(() => commandSpec('C:\\az.cmd', [arg], { platform: 'win32' })).toThrow(CommandLineError);
        }
        expect(() => commandSpec('/usr/bin/az', ['50%'], { platform: 'linux' })).not.toThrow();
    });
});

describe('spawnCommand', () => {
    it('passes shell metacharacters through to the program untouched', async () => {
        const result = await runCommand(process.execPath, ['-e', PRINT_ARGV, ...TRICKY_ARGS], { env: process.env, timeoutMs: 15_000 });
        expect(result.code).toBe(0);
        expect(JSON.parse(result.stdout)).toEqual(TRICKY_ARGS);
    });

    it.runIf(process.platform === 'win32')('runs .cmd wrappers through cmd.exe with the arguments intact', async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind cmd '));
        // A script file is argv[1] itself.
        fs.writeFileSync(path.join(tmpDir, 'argv.js'), 'console.log(JSON.stringify(process.argv.slice(2)))');
        // Like az.cmd and gcloud.cmd: the arguments are handed on with %*.
        const wrapper = path.join(tmpDir, 'tool.cmd');
        fs.writeFileSync(wrapper, `@"${process.execPath}" "%~dp0argv.js" %*\r\n`);

        const result = await runCommand(wrapper, TRICKY_ARGS, { env: process.env, timeoutMs: 15_000 });
        expect(result.stderr).toBe('');
        expect(JSON.parse(result.stdout)).toEqual(TRICKY_ARGS);
    });

    it('reports programs that cannot start instead of throwing', async () => {
        const result = await runCommand(path.join(os.tmpdir(), 'shellmind-missing-program'), [], { env: process.env, timeoutMs: 5000 });
        expect(result.code).toBeNull();
        expect(result.stderr).toMatch(/ENOENT/);
    });

    it('stops a program that runs past its timeout', async () => {
        const started = Date.now();
        const result = await runCommand(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, timeoutMs: 300 });
        expect(result.code).toBeNull();
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('killProcessTree', () => {
    it('stops the program and the processes it started', async () => {
        const script = [
            "const { spawn } = require('child_process');",
            "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });",
            'console.log(`grandchild:${child.pid}`);',
            'setInterval(() => {}, 1000);',
        ].join('\n');
        const parent = spawnCommand(process.execPath, ['-e', script], { env: process.env });
        let output = '';
        parent.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString(); });
        await waitFor(() => /grandchild:(\d+)/.test(output));
        const grandchild = Number(/grandchild:(\d+)/.exec(output)![1]);
        expect(isAlive(grandchild)).toBe(true);

        const closed = new Promise((resolve) => parent.on('close', resolve));
        killProcessTree(parent);
        await closed;
        await waitFor(() => !isAlive(grandchild));
    }, PROCESS_TEST_TIMEOUT_MS);
});
