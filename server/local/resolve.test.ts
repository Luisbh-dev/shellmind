import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { envValue, resolveExecutable } from './resolve';

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-resolve-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

function makeFile(name: string, executable = true): string {
    const file = path.join(dir, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '#!/bin/sh\necho hi\n');
    if (executable) fs.chmodSync(file, 0o755);
    return file;
}

describe('envValue', () => {
    it('ignores the case of variable names on Windows only', () => {
        const env = { Path: 'a;b' };
        expect(envValue(env, 'PATH', 'win32')).toBe('a;b');
        expect(envValue(env, 'PATH', 'linux')).toBeUndefined();
    });
});

describe.runIf(process.platform === 'win32')('resolveExecutable on Windows', () => {
    it('applies PATHEXT in PATH order and accepts explicit extensions', async () => {
        const cmd = makeFile('bin1\\tool.cmd');
        const exe = makeFile('bin2\\tool.exe');
        const env = { Path: `${path.join(dir, 'bin1')};${path.join(dir, 'bin2')}`, PATHEXT: '.EXE;.CMD' };

        // bin1 comes first on PATH, whatever the extension order.
        expect(await resolveExecutable('tool', { env })).toBe(cmd);
        expect(await resolveExecutable('tool.exe', { env })).toBe(exe);
        expect(await resolveExecutable('missing', { env })).toBeNull();
    });

    it('takes names with a directory as paths, including spaces', async () => {
        const file = makeFile('with space\\run.cmd');
        expect(await resolveExecutable(path.join(dir, 'with space', 'run'), { env: { PATHEXT: '.CMD' } })).toBe(file);
        expect(await resolveExecutable(file, { env: {} })).toBe(file);
    });

    it('finds the real node binary', async () => {
        expect((await resolveExecutable('node'))?.toLowerCase()).toBe(process.execPath.toLowerCase());
    });
});

describe.runIf(process.platform !== 'win32')('resolveExecutable on POSIX', () => {
    it('finds executable files on PATH and skips the rest', async () => {
        makeFile('bin1/tool', false);
        const second = makeFile('bin2/tool');
        const env = { PATH: `${path.join(dir, 'bin1')}:${path.join(dir, 'bin2')}` };
        expect(await resolveExecutable('tool', { env })).toBe(second);
        expect(await resolveExecutable('missing', { env })).toBeNull();
    });

    it('takes names with a slash as paths', async () => {
        const file = makeFile('with space/run');
        expect(await resolveExecutable(file, { env: {} })).toBe(file);
        expect(await resolveExecutable(path.join(dir, 'nope'), { env: {} })).toBeNull();
    });
});

describe('resolveExecutable', () => {
    it('refuses empty names and NUL bytes', async () => {
        expect(await resolveExecutable('  ')).toBeNull();
        expect(await resolveExecutable('node\0x')).toBeNull();
    });
});
