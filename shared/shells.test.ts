import { describe, expect, it } from 'vitest';
import { cliPresetInfo, cursorPromptShell, isBarePrompt, matchPrompt, programName, scopedPresetKey, shellOfProgram } from './shells';

// One table for every consumer (terminal delivery, AI environment, auto-run,
// issue detection): the cases where they used to disagree are pinned here.

describe('programName / shellOfProgram', () => {
    it.each([
        ['bash', 'bash', 'posix'],
        ['/bin/zsh -l', 'zsh', 'posix'],
        // ash was posix for the terminal but a custom program for the AI.
        ['ash', 'ash', 'posix'],
        ['/bin/busybox', 'busybox', null],
        ['wsl.exe', 'wsl', 'posix'],
        ['C:\\Windows\\System32\\cmd.exe', 'cmd', 'cmd'],
        ['"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo', 'pwsh', 'powershell'],
        ['PowerShell.EXE', 'powershell', 'powershell'],
        ['python3 -i', 'python3', null],
        ['', '', null],
    ])('%j starts %j (%s)', (command, program, shell) => {
        expect(programName(command)).toBe(program);
        expect(shellOfProgram(programName(command))).toBe(shell);
    });
});

describe('scopedPresetKey', () => {
    it('finds the preset whatever its case or stray spaces', () => {
        // "Docker" was a console for the terminal but a bash shell for the AI.
        expect(scopedPresetKey('Docker')).toBe('docker');
        expect(scopedPresetKey(' kubectl ')).toBe('kubectl');
        expect(cliPresetInfo('AZURE')?.bin).toBe('az');
        for (const value of [null, undefined, '', 'shell', 'custom', 'toString', 'constructor']) {
            expect(scopedPresetKey(value)).toBeNull();
        }
    });
});

describe('matchPrompt', () => {
    it.each([
        ['luis@web-1:~$ ls -la', 'posix', 'ls -la'],
        ['root@db:/srv# systemctl status nginx', 'posix', 'systemctl status nginx'],
        ['luis@mac ~ % git status', 'posix', 'git status'],
        ['[root@centos ~]# uptime', 'posix', 'uptime'],
        ['demo-server:/tmp$ df -h', 'posix', 'df -h'],
        // Bare prompts that only some detectors knew.
        ['bash-5.2$ ', 'posix', ''],
        ['/ # ', 'posix', ''],
        ['~ $ id', 'posix', 'id'],
        ['$ echo hi', 'posix', 'echo hi'],
        ['(venv) luis@web-1:~/app$ pytest', 'posix', 'pytest'],
        ['PS C:\\Users\\admin> Get-Service', 'powershell', 'Get-Service'],
        ['C:\\Windows\\system32>dir', 'cmd', 'dir'],
        ['docker> ps -a', 'console', 'ps -a'],
        ['mysql>', 'console', ''],
    ])('%j is a %s prompt followed by %j', (line, shell, command) => {
        expect(matchPrompt(line)).toMatchObject({ shell, command });
    });

    it('tells which tool a console prompt belongs to', () => {
        expect(matchPrompt('kubectl> get pods')).toMatchObject({ tool: 'kubectl', prompt: 'kubectl>' });
    });

    it.each([
        'Downloading 45%',
        'Total: 12$',
        '##########',
        'Error: connection refused',
        'john@example.com $5',
        '>>> print(1)',
        '>> ',
        'http://example.com/a$b',
        '',
    ])('%j is no prompt', (line) => {
        expect(matchPrompt(line)).toBeNull();
    });
});

describe('isBarePrompt', () => {
    it('is a prompt with nothing typed after it', () => {
        for (const line of ['luis@web-1:~$', 'bash-5.2$ ', '/ #', 'PS C:\\>', 'C:\\Users\\luis>', 'docker>', '$']) {
            expect(isBarePrompt(line)).toBe(true);
        }
        for (const line of ['luis@web-1:~$ ls', 'Downloading 45%', 'docker> ps']) {
            expect(isBarePrompt(line)).toBe(false);
        }
    });
});

describe('cursorPromptShell', () => {
    it('is the shell whose prompt the cursor is on', () => {
        expect(cursorPromptShell('PS C:\\Users\\admin> ')).toBe('powershell');
        expect(cursorPromptShell('C:\\Windows\\system32>')).toBe('cmd');
        expect(cursorPromptShell('luis@web-1:~$ ')).toBe('posix');
        expect(cursorPromptShell('/ # ')).toBe('posix');
        // A prompt the table does not know, ending where the cursor is.
        expect(cursorPromptShell('❯ $ ')).toBe('posix');
        // A custom Windows prompt, a tool prompt, output.
        expect(cursorPromptShell('C:\\Users\\luis $ ')).toBeNull();
        expect(cursorPromptShell('mysql> ')).toBeNull();
        expect(cursorPromptShell('Downloading 45%')).toBeNull();
    });
});
