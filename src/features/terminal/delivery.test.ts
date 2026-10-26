import { describe, expect, it } from 'vitest';
import { encodePowerShellBlock } from '@shared/powershell';
import { configuredShell, deliveryFor, lineCount, promptShell, sessionShell, terminalInput, typingRisk, type ShellServer } from './delivery';

const LINUX: ShellServer = { type: 'linux' };
const WINDOWS_SSH: ShellServer = { type: 'windows' };
const LOCAL_WINDOWS: ShellServer = { type: 'local', os_detail: 'Windows_NT 10.0.26100' };

describe('promptShell', () => {
    it('recognizes the prompt the cursor is on', () => {
        expect(promptShell('PS C:\\Users\\admin> ')).toBe('powershell');
        expect(promptShell('PS /home/luis> ')).toBe('powershell');
        expect(promptShell('C:\\Windows\\system32>')).toBe('cmd');
        expect(promptShell('luis@web-1:~$ ')).toBe('posix');
        expect(promptShell('[root@centos ~]# ')).toBe('posix');
        expect(promptShell('demo-server:/tmp$ ')).toBe('posix');
        expect(promptShell('Progress 45%')).toBeNull();
        expect(promptShell('>>> ')).toBeNull();
        expect(promptShell('')).toBeNull();
    });

    it('recognizes the bare prompts of shells started in a container or from another shell', () => {
        for (const line of ['$ ', '# ', '/ # ', 'bash-5.2$ ', 'sh-5.2# ', '~ $ ', '/app $ ', 'mac% ']) {
            expect(promptShell(line)).toBe('posix');
        }
        // Output the cursor stops after, and custom Windows prompts.
        for (const line of ['Downloading 45%', 'Total: 12$', '##########', 'C:\\Users\\luis $ ', '>> ']) {
            expect(promptShell(line)).toBeNull();
        }
    });
});

describe('configuredShell', () => {
    it('follows the server type and the local console settings', () => {
        expect(configuredShell(LINUX)).toBe('posix');
        expect(configuredShell(WINDOWS_SSH)).toBe('cmd');
        expect(configuredShell({ type: 'ftp' })).toBe('console');
        expect(configuredShell({ type: 'local', cli_preset: 'docker' })).toBe('console');
        expect(configuredShell({ type: 'local', cli_preset: 'Kubectl' })).toBe('console');
        expect(configuredShell({ type: 'local', command: 'C:\\Windows\\System32\\cmd.exe' })).toBe('cmd');
        expect(configuredShell({ type: 'local', command: '"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -NoLogo' })).toBe('powershell');
        expect(configuredShell({ type: 'local', command: '/bin/zsh -l' })).toBe('posix');
        expect(configuredShell({ type: 'local', command: 'python3' })).toBe('unknown');
    });

    it('takes the default local shell from the detected OS', () => {
        expect(configuredShell(LOCAL_WINDOWS)).toBe('powershell');
        expect(configuredShell({ type: 'local', osDetail: 'Darwin 23.4.0' })).toBe('posix');
        expect(configuredShell({ type: 'local' })).toBe('unknown');
    });
});

describe('sessionShell', () => {
    it('trusts the prompt on screen over the configured shell', () => {
        expect(sessionShell(WINDOWS_SSH, 'PS C:\\Users\\admin> ', false)).toBe('powershell');
        expect(sessionShell(LINUX, 'PS /root> ', false)).toBe('powershell');
        expect(sessionShell(LOCAL_WINDOWS, 'luis@desktop:/mnt/c$ ', false)).toBe('posix');
        expect(sessionShell(LOCAL_WINDOWS, 'C:\\Users\\luis>', false)).toBe('cmd');
        // No prompt in sight (a command still running): the configured shell.
        expect(sessionShell(LOCAL_WINDOWS, 'Downloading 45%', false)).toBe('powershell');
        // A PowerShell prompt wins over a bracketed-paste mode left on.
        expect(sessionShell(LOCAL_WINDOWS, 'PS C:\\Users\\luis> ', true)).toBe('powershell');
    });

    it('never runs a POSIX shell started from a local PowerShell console as PowerShell', () => {
        // docker exec -it <container> sh, bash, Git Bash...
        const block = 'cd /tmp\necho "in $(pwd)"';
        for (const prompt of ['$ ', '/ # ', 'bash-5.2$ ']) {
            expect(deliveryFor(block, sessionShell(LOCAL_WINDOWS, prompt, false), false)).toBe('lines');
            expect(deliveryFor(block, sessionShell(LOCAL_WINDOWS, prompt, true), true)).toBe('bracketed-paste');
        }
        // A prompt it does not know, with bracketed paste on: not PowerShell.
        expect(deliveryFor(block, sessionShell(LOCAL_WINDOWS, '❯ ', true), true)).toBe('bracketed-paste');
        expect(deliveryFor(block, sessionShell(WINDOWS_SSH, '❯ ', true), true)).toBe('bracketed-paste');
        expect(deliveryFor(block, sessionShell(LOCAL_WINDOWS, '❯ ', false), false)).toBe('powershell');
    });

    it('never leaves an app console', () => {
        expect(sessionShell({ type: 'local', cli_preset: 'docker' }, 'PS C:\\> ', false)).toBe('console');
        expect(sessionShell({ type: 'ftp' }, 'user@host:~$ ', true)).toBe('console');
    });
});

describe('deliveryFor', () => {
    const block = 'Get-Process |\n  Select-Object -First 5';

    it('sends single lines as typed in every shell', () => {
        for (const shell of ['powershell', 'cmd', 'posix', 'console', 'unknown'] as const) {
            expect(deliveryFor('uptime', shell, true)).toBe('single-line');
            expect(deliveryFor('uptime\r\n\n', shell, false)).toBe('single-line');
        }
    });

    it('picks the delivery of a block by shell', () => {
        expect(deliveryFor(block, 'powershell', false)).toBe('powershell');
        expect(deliveryFor(block, 'powershell', true)).toBe('powershell');
        expect(deliveryFor(block, 'posix', true)).toBe('bracketed-paste');
        expect(deliveryFor(block, 'unknown', true)).toBe('bracketed-paste');
        expect(deliveryFor(block, 'posix', false)).toBe('lines');
        expect(deliveryFor(block, 'cmd', true)).toBe('lines');
        expect(deliveryFor(block, 'console', true)).toBe('lines');
    });
});

describe('terminalInput', () => {
    it('ends every delivery with one Enter', () => {
        expect(terminalInput('uptime\n', 'single-line')).toBe('uptime\r');
        expect(terminalInput('a\r\nb\n', 'lines')).toBe('a\rb\r');
        const powershell = terminalInput('a\nb', 'powershell');
        expect(powershell).toBe(`${encodePowerShellBlock('a\nb')}\r`);
        expect(powershell.match(/\r/g)).toHaveLength(1);
    });

    it('pastes a heredoc as one bracketed paste', () => {
        const heredoc = "cat > /tmp/t.yml <<'EOF'\nname: test\n  - item\nEOF\ncat /tmp/t.yml";
        expect(terminalInput(heredoc, 'bracketed-paste')).toBe(
            "\x1b[200~cat > /tmp/t.yml <<'EOF'\rname: test\r  - item\rEOF\rcat /tmp/t.yml\x1b[201~\r"
        );
        // The paste cannot be ended early by the text itself.
        expect(terminalInput('echo a\n\x1b[201~rm -rf x', 'bracketed-paste')).toBe('\x1b[200~echo a\rrm -rf x\x1b[201~\r');
    });
});

describe('typingRisk', () => {
    const atPrompt = { alternateScreen: false, bracketedPaste: false, cursorLine: 'root@web-1:~# ' };

    it('never types into a full-screen program unasked (FE-08)', () => {
        expect(typingRisk('echo hi', LINUX, { ...atPrompt, alternateScreen: true })).toBe('full-screen');
        expect(typingRisk('cd /srv\nls', LINUX, { ...atPrompt, alternateScreen: true, bracketedPaste: true })).toBe('full-screen');
    });

    it('asks before a block of lines where no shell prompt is in sight', () => {
        expect(typingRisk('cd /srv\nls', LINUX, { ...atPrompt, cursorLine: 'mysql> ' })).toBe('no-prompt');
        expect(typingRisk('y\nn', LINUX, { ...atPrompt, cursorLine: 'Proceed? [y/N] ' })).toBe('no-prompt');
        // A single line, a known prompt, a line editor taking a paste, an app console.
        expect(typingRisk('ls', LINUX, { ...atPrompt, cursorLine: 'mysql> ' })).toBeNull();
        expect(typingRisk('cd /srv\nls', LINUX, atPrompt)).toBeNull();
        expect(typingRisk('cd /srv\nls', LINUX, { ...atPrompt, cursorLine: '❯ ', bracketedPaste: true })).toBeNull();
        expect(typingRisk('ps\nimages', { type: 'local', cli_preset: 'docker' }, { ...atPrompt, cursorLine: 'docker> ' })).toBeNull();
        expect(lineCount('a\r\nb\nc\n')).toBe(3);
    });
});
