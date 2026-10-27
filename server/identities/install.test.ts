import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PROCESS_TEST_TIMEOUT_MS } from '../../test/setup/timeouts';
import { encodedPowerShellCommand, powershellInvocation, psQuote } from '../ops/remote';
import { INSTALL_MARKER, parseInstallOutput, parseRemoveOutput, posixInstallScript, posixRemoveScript, windowsInstallScript, windowsRemoveScript } from './install';
import { generateEd25519 } from './keys';

// The install scripts run for real where a shell is at hand: sh (Linux,
// macOS, or Git for Windows' sh.exe) and Windows PowerShell, in temp homes.

const key = generateEd25519('shellmind:test');
const dirs: string[] = [];

function tempDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-install-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length) fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function posixShell(): string | null {
    if (process.platform !== 'win32') return 'sh';
    const gitSh = path.join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'sh.exe');
    return fs.existsSync(gitSh) ? gitSh : null;
}

describe('parseInstallOutput', () => {
    it('reads the outcome, the file and the warnings the scripts print', () => {
        expect(parseInstallOutput(`noise\n${INSTALL_MARKER}warning:home-writable\r\n${INSTALL_MARKER}file:/home/a/.ssh/authorized_keys\n${INSTALL_MARKER}installed\n`))
            .toEqual({ status: 'installed', file: '/home/a/.ssh/authorized_keys', warnings: ['home-writable'] });
        expect(parseInstallOutput(`${INSTALL_MARKER}present`)).toEqual({ status: 'present', file: null, warnings: [] });
        // A script that stopped early printed no outcome.
        expect(parseInstallOutput(`${INSTALL_MARKER}file:/x`)).toBeNull();
        expect(parseInstallOutput('')).toBeNull();
    });
});

describe('posixInstallScript', () => {
    it('quotes the key and never interpolates it into the script', () => {
        const script = posixInstallScript(key);
        expect(script).toContain(`key='${key.publicKey}'`);
        expect(script).toContain(`data='${key.blob.split(' ')[1]}'`);
        expect(script).not.toMatch(/eval|\$\(\s*echo \$key/);
    });

    const shell = posixShell();
    it.skipIf(!shell)('creates ~/.ssh and authorized_keys, appends once, and keeps other keys', () => {
        const home = tempDir();
        const run = () => {
            const result = spawnSync(shell as string, ['-s'], { input: posixInstallScript(key), env: { ...process.env, HOME: home }, encoding: 'utf8' });
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
            return parseInstallOutput(result.stdout);
        };
        const file = path.join(home, '.ssh', 'authorized_keys');

        expect(run()).toMatchObject({ status: 'installed' });
        expect(fs.readFileSync(file, 'utf8')).toBe(`${key.publicKey}\n`);
        expect(run()).toMatchObject({ status: 'present' });
        expect(fs.readFileSync(file, 'utf8')).toBe(`${key.publicKey}\n`);
        if (process.platform !== 'win32') {
            expect(fs.statSync(path.join(home, '.ssh')).mode & 0o777).toBe(0o700);
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }

        // Another key without a final newline, and this key with options and
        // another comment: found, nothing written.
        const other = generateEd25519('other');
        fs.writeFileSync(file, `from="10.0.0.0/8",no-pty ${key.blob} renamed\n${other.publicKey}`);
        expect(run()).toMatchObject({ status: 'present' });
        fs.writeFileSync(file, other.publicKey);
        expect(run()).toMatchObject({ status: 'installed' });
        expect(fs.readFileSync(file, 'utf8')).toBe(`${other.publicKey}\n${key.publicKey}\n`);

        // A copy an administrator commented out does not count: the key is added again.
        fs.writeFileSync(file, `  # ${key.publicKey}\n`);
        expect(run()).toMatchObject({ status: 'installed' });
        expect(fs.readFileSync(file, 'utf8')).toBe(`  # ${key.publicKey}\n${key.publicKey}\n`);
    }, PROCESS_TEST_TIMEOUT_MS);
});

describe('windowsInstallScript', () => {
    it('quotes the key for PowerShell and restricts the administrators file by SID', () => {
        const script = windowsInstallScript(key);
        expect(script).toContain(`$key = '${key.publicKey}'`);
        expect(script).toContain('administrators_authorized_keys');
        expect(script).toContain("'*S-1-5-32-544:F'");
        // Fits a cmd.exe command line in the encoded fallback.
        expect(encodedPowerShellCommand(script).length).toBeLessThan(8191);
    });

    it.skipIf(process.platform !== 'win32')('appends once to the file sshd reads for this user', () => {
        const programData = tempDir();
        const profile = tempDir();
        // The script's own folders are replaced in its text: an environment
        // override does not reliably reach the child, and this machine's real
        // %ProgramData%\ssh must never be written by a test.
        const script = windowsInstallScript(key)
            .replaceAll('$env:ProgramData', psQuote(programData))
            .replaceAll('$env:USERPROFILE', psQuote(profile));
        expect(script).not.toMatch(/\$env:/i);
        // Delivered as the backend delivers it: on stdin.
        const { command, stdin } = powershellInvocation(script, 'stdin');
        const [program, ...args] = command.split(' ');
        const run = () => parseInstallOutput(execFileSync(`${program}.exe`, args, { input: stdin, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] }));

        const first = run();
        expect(first?.status).toBe('installed');
        expect(first?.file).toMatch(/administrators_authorized_keys$|[\\/]\.ssh[\\/]authorized_keys$/);
        const file = first?.file as string;
        expect(file.startsWith(programData) || file.startsWith(profile)).toBe(true);
        expect(fs.readFileSync(file, 'utf8')).toBe(`${key.publicKey}\r\n`);
        expect(run()?.status).toBe('present');
        expect(fs.readFileSync(file, 'utf8')).toBe(`${key.publicKey}\r\n`);

        fs.writeFileSync(file, ` # ${key.publicKey}\r\n`);
        expect(run()?.status).toBe('installed');
        expect(fs.readFileSync(file, 'utf8')).toBe(` # ${key.publicKey}\r\n${key.publicKey}\r\n`);
    }, PROCESS_TEST_TIMEOUT_MS);
});

// SEC-6: after a rotation the previous key is taken out of authorized_keys,
// so that a copy of it (a leaked key, a lost laptop) stops signing in.
describe('removing a key from authorized_keys', () => {
    const other = generateEd25519('other');

    it('reads the outcome and the file the scripts print', () => {
        expect(parseRemoveOutput(`${INSTALL_MARKER}removed:2\r\n${INSTALL_MARKER}file:/home/a/.ssh/authorized_keys\n`)).toEqual({ status: 'removed', removed: 2, file: '/home/a/.ssh/authorized_keys' });
        expect(parseRemoveOutput(`${INSTALL_MARKER}file:/x\n${INSTALL_MARKER}absent`)).toEqual({ status: 'absent', removed: 0, file: '/x' });
        expect(parseRemoveOutput(`${INSTALL_MARKER}file:/x`)).toBeNull();
    });

    it('quotes the key data and never takes the key line itself into the script', () => {
        const script = posixRemoveScript(key);
        expect(script).toContain(`data='${key.blob.split(' ')[1]}'`);
        expect(script).not.toContain(key.publicKey);
        expect(windowsRemoveScript(key)).toContain(`$data = '${key.blob.split(' ')[1]}'`);
        expect(encodedPowerShellCommand(windowsRemoveScript(key)).length).toBeLessThan(8191);
    });

    const shell = posixShell();
    it.skipIf(!shell)('removes every line of the key, keeps the rest and a commented-out copy, and is idempotent', () => {
        const home = tempDir();
        const run = () => {
            const result = spawnSync(shell as string, ['-s'], { input: posixRemoveScript(key), env: { ...process.env, HOME: home }, encoding: 'utf8' });
            expect(result.stderr).toBe('');
            expect(result.status).toBe(0);
            return parseRemoveOutput(result.stdout);
        };
        // No ~/.ssh at all.
        expect(run()).toMatchObject({ status: 'absent', removed: 0 });

        fs.mkdirSync(path.join(home, '.ssh'));
        const file = path.join(home, '.ssh', 'authorized_keys');
        fs.writeFileSync(file, [
            other.publicKey,
            `from="10.0.0.0/8",no-pty ${key.blob} renamed`,
            `# ${key.publicKey}`,
            `${key.publicKey}\r`,
            `${other.blob}`,
        ].join('\n'));
        // (Git for Windows' sh names the file its own way.)
        expect(run()).toMatchObject({ status: 'removed', removed: 2, file: expect.stringMatching(/[\\/]\.ssh[\\/]authorized_keys$/) });
        expect(fs.readFileSync(file, 'utf8')).toBe(`${other.publicKey}\n# ${key.publicKey}\n${other.blob}\n`);
        if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        expect(fs.readdirSync(path.join(home, '.ssh'))).toEqual(['authorized_keys']);
        expect(run()).toMatchObject({ status: 'absent', removed: 0 });
        expect(fs.readFileSync(file, 'utf8')).toBe(`${other.publicKey}\n# ${key.publicKey}\n${other.blob}\n`);

        // The only key of the file: an empty file stays.
        fs.writeFileSync(file, `${key.publicKey}\n`);
        expect(run()).toMatchObject({ status: 'removed', removed: 1 });
        expect(fs.readFileSync(file, 'utf8')).toBe('');
    }, PROCESS_TEST_TIMEOUT_MS);

    it.skipIf(process.platform !== 'win32')('removes the key from the file sshd reads for this user, in place', () => {
        const programData = tempDir();
        const profile = tempDir();
        const forTest = (script: string) => script.replaceAll('$env:ProgramData', psQuote(programData)).replaceAll('$env:USERPROFILE', psQuote(profile));
        const exec = (script: string) => {
            const { command, stdin } = powershellInvocation(forTest(script), 'stdin');
            const [program, ...args] = command.split(' ');
            return execFileSync(`${program}.exe`, args, { input: stdin, encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        };
        const file = parseInstallOutput(exec(windowsInstallScript(key)))?.file as string;
        expect(file.startsWith(programData) || file.startsWith(profile)).toBe(true);
        fs.writeFileSync(file, `${other.publicKey}\r\n${key.publicKey}\r\n # ${key.publicKey}\r\n`);
        expect(parseRemoveOutput(exec(windowsRemoveScript(key)))).toEqual({ status: 'removed', removed: 1, file });
        expect(fs.readFileSync(file, 'utf8')).toBe(`${other.publicKey}\r\n # ${key.publicKey}\r\n`);
        expect(parseRemoveOutput(exec(windowsRemoveScript(key)))).toMatchObject({ status: 'absent' });
    }, PROCESS_TEST_TIMEOUT_MS);
});
