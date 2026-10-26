import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    classifyTerminalLine,
    clearTerminalIssues,
    CommandOutputTracker,
    dismissTerminalIssue,
    flushTerminalIssues,
    ingestTerminalOutput,
    isQuietCommand,
    isTerminalDetailLine,
    looksLikePrompt,
    noteTerminalCommand,
    normalizeTerminalText,
    promptCommand,
    reportIssueLine,
    resetTerminalIssues,
    stripAnsi,
    useTerminalIssueStore
} from './terminalIssues';

const SERVER = 42;
const issues = () => useTerminalIssueStore.getState().issues[SERVER] ?? [];

beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalIssues(SERVER);
});

afterEach(() => {
    resetTerminalIssues(SERVER);
    vi.useRealTimers();
});

describe('stripAnsi', () => {
    it('removes colors, cursor movement, window titles and hyperlinks', () => {
        expect(stripAnsi('\x1b[1;31merror\x1b[0m: x')).toBe('error: x');
        expect(stripAnsi('\x1b]0;root@web: ~\x07root@web:~# ls')).toBe('root@web:~# ls');
        expect(stripAnsi('\x1b]8;;https://x.y\x1b\\link\x1b]8;;\x1b\\')).toBe('link');
        expect(stripAnsi('\x1b[?2004hprompt\x1b(B\x1b=')).toBe('prompt');
        expect(stripAnsi('a\x07b\x08c')).toBe('abc');
    });

    it('keeps line breaks for reading', () => {
        expect(normalizeTerminalText('one\r\ntwo\r\n')).toBe('one\ntwo\n');
    });
});

describe('classifyTerminalLine', () => {
    it.each([
        'bash: foo: command not found',
        '-bash: systemctl: command not found',
        'zsh: permission denied: ./run.sh',
        "ls: cannot access 'nope': No such file or directory",
        'cat: /etc/shadow: Permission denied',
        'mkdir: cannot create directory ‘/x’: Read-only file system',
        'Error: Cannot find module "express"',
        'fatal: not a git repository (or any of the parent directories): .git',
        'E: Unable to locate package nginxx',
        'npm ERR! code ENOENT',
        'error[E0425]: cannot find value `x` in this scope',
        'Failed to start nginx.service: Unit nginx.service not found.',
        'sudo: 3 incorrect password attempts',
        'Permission denied (publickey).',
        "ssh: connect to host 10.0.0.1 port 22: Connection refused",
        'Traceback (most recent call last):',
        'ValueError: invalid literal for int() with base 10',
        'Segmentation fault (core dumped)',
        "'foo' is not recognized as an internal or external command,",
        'Error response from daemon: No such container: web',
        'An error occurred (AccessDenied) when calling the ListBuckets operation',
        'ERROR: (gcloud.compute.instances.list) Some requests did not succeed'
    ])('flags %j as an error', (line) => {
        expect(classifyTerminalLine(line)).toBe('error');
    });

    it.each(['warning: LF will be replaced by CRLF', 'W: Some index files failed to download', 'npm WARN deprecated left-pad@1.3.0', 'WARNING: apt does not have a stable CLI interface.'])(
        'flags %j as a warning',
        (line) => {
            expect(classifyTerminalLine(line)).toBe('warning');
        }
    );

    it.each([
        // The prompt and the command echo (issue-classifier-false-positives).
        'root@srv:~# systemctl --failed',
        'luis@web:/srv/errors$ ls',
        '[luis@web failed-jobs]$ cat error.log',
        'PS C:\\Users\\luis> Get-Error',
        'C:\\Windows\\System32> dir errors',
        'docker> ps --filter status=exited',
        // Listings and ordinary text that merely contain the words.
        'failed_jobs.log  error.log  denied.txt',
        '● nginx.service loaded failed failed A high performance web server',
        'Tests: 12 passed, 0 failed',
        '0 errors, 0 warnings',
        'The connection was refused by policy, as configured.',
        ''
    ])('leaves %j alone', (line) => {
        expect(classifyTerminalLine(line)).toBeNull();
    });

    it('reads the line as it ended up on screen', () => {
        expect(classifyTerminalLine('\x1b[31mError: boom\x1b[0m')).toBe('error');
        expect(classifyTerminalLine('Error: stale progress\rDownloaded 100%')).toBeNull();
    });
});

describe('helpers', () => {
    it('recognizes prompts', () => {
        expect(looksLikePrompt('tester@host:~$ ')).toBe(true);
        expect(looksLikePrompt('harness$ echo hi')).toBe(true);
        expect(looksLikePrompt('Error: no prompt here')).toBe(false);
    });

    it('recognizes stack frames and PowerShell detail lines', () => {
        expect(isTerminalDetailLine('    at Object.<anonymous> (/app/index.js:3:9)')).toBe(true);
        expect(isTerminalDetailLine('  File "/app/x.py", line 3, in <module>')).toBe(true);
        expect(isTerminalDetailLine('+ CategoryInfo          : ObjectNotFound')).toBe(true);
        expect(isTerminalDetailLine('plain text')).toBe(false);
    });

    it('knows the commands whose output is other files', () => {
        for (const command of ['ls -la', 'sudo grep -r error /var/log', 'LANG=C tail -f app.log', '/usr/bin/journalctl -xe', 'Get-ChildItem C:\\', 'findstr.exe /s err *']) {
            expect(isQuietCommand(command)).toBe(true);
        }
        for (const command of ['systemctl restart nginx', 'apt install x', 'docker ps', '']) {
            expect(isQuietCommand(command)).toBe(false);
        }
    });
});

describe('per-server issues', () => {
    it('classifies complete lines in the background, once per pass', () => {
        const updates = vi.fn();
        const unsubscribe = useTerminalIssueStore.subscribe(updates);

        ingestTerminalOutput(SERVER, '\x1b]0;t@h: ~\x07t@h:~$ apt install nginxx\r\n');
        ingestTerminalOutput(SERVER, 'E: Unable to locate package nginxx\r\nE: Unable to loc');
        expect(issues()).toEqual([]);

        vi.advanceTimersByTime(250);
        expect(updates).toHaveBeenCalledTimes(1);
        expect(issues()).toEqual([expect.objectContaining({ type: 'error', message: 'E: Unable to locate package nginxx' })]);

        // The repeated line within a few seconds is the same issue.
        ingestTerminalOutput(SERVER, 'ate package nginxx\r\n');
        flushTerminalIssues(SERVER);
        expect(issues()).toHaveLength(1);
        expect(updates).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it('attaches detail lines to the issue above them', () => {
        ingestTerminalOutput(SERVER, 'Traceback (most recent call last):\n  File "/app/x.py", line 3, in <module>\n');
        flushTerminalIssues(SERVER);
        expect(issues()).toEqual([expect.objectContaining({ message: 'Traceback (most recent call last):', details: 'File "/app/x.py", line 3, in <module>' })]);
    });

    it('does not classify the output of listing commands until the next prompt (issue-detector-noisy)', () => {
        // As it really arrives: the command is noted on Enter, then the shell
        // echoes it after its prompt, then the output follows.
        const log = 'ERROR: database down\r\nError: x is broken\r\nFATAL: disk\r\n';
        expect(log.split('\r\n').filter(Boolean).map((line) => classifyTerminalLine(line))).toEqual(['error', 'error', 'error']);

        ingestTerminalOutput(SERVER, 'luis@web:~$ ');
        noteTerminalCommand(SERVER, 'cat /tmp/app.log');
        ingestTerminalOutput(SERVER, 'cat /tmp/app.log\r\n' + log + 'luis@web:~$ ');
        flushTerminalIssues(SERVER);
        expect(issues()).toEqual([]);

        // The same lines from a command that is not a listing are errors.
        noteTerminalCommand(SERVER, './deploy.sh');
        ingestTerminalOutput(SERVER, './deploy.sh\r\n' + log + 'luis@web:~$ ');
        flushTerminalIssues(SERVER);
        expect(issues().map((issue) => issue.message)).toEqual(['ERROR: database down', 'Error: x is broken', 'FATAL: disk']);
    });

    it('stays quiet for a whole batch of a listing command typed at a prompt it does not know', () => {
        ingestTerminalOutput(SERVER, '➜  ~ ');
        noteTerminalCommand(SERVER, 'sudo tail -n 50 /var/log/app.log');
        ingestTerminalOutput(SERVER, 'sudo tail -n 50 /var/log/app.log\r\nERROR: database down\r\n');
        flushTerminalIssues(SERVER);
        expect(issues()).toEqual([]);

        noteTerminalCommand(SERVER, 'make');
        ingestTerminalOutput(SERVER, '\r\n➜  ~ make\r\nError: build failed\r\n');
        flushTerminalIssues(SERVER);
        expect(issues().map((issue) => issue.message)).toEqual(['Error: build failed']);
    });

    it('reads the command of a prompt line, also in CLI consoles', () => {
        expect(promptCommand('luis@web:~$ cat app.log')).toBe('cat app.log');
        expect(promptCommand('[root@db tmp]# grep -r ERROR .')).toBe('grep -r ERROR .');
        expect(promptCommand('PS C:\\Users\\luis> Get-Content app.log')).toBe('Get-Content app.log');
        expect(promptCommand('docker> logs web')).toBe('docker logs web');
        expect(promptCommand('luis@web:~$ ')).toBe('');
        expect(promptCommand('ERROR: database down')).toBeNull();
        // Prompts the terminal knows too (shared/shells.ts): busybox and container shells.
        expect(promptCommand('demo-server:~$ cat /etc/hostname')).toBe('cat /etc/hostname');
        expect(promptCommand('/ # ls /nope')).toBe('ls /nope');
        expect(promptCommand('(venv) luis@web:~/src$ pytest')).toBe('pytest');
        expect(isQuietCommand('docker logs web')).toBe(true);
        expect(isQuietCommand('docker compose logs -f')).toBe(true);
        expect(isQuietCommand('kubectl logs pod/api')).toBe(true);
        expect(isQuietCommand('docker ps')).toBe(false);
        expect(isQuietCommand('clear; cat app.log')).toBe(true);
        expect(isQuietCommand('cd /var/log && tail -f syslog')).toBe(true);
        expect(isQuietCommand('cat app.log | grep -c ERROR')).toBe(true);
        expect(isQuietCommand('cat app.log; make')).toBe(false);
    });

    it('follows commands line by line', () => {
        const tracker = new CommandOutputTracker();
        expect(tracker.accepts('Error: before anything')).toBe(true);
        tracker.startCommand('grep -r ERROR /var/log');
        expect(tracker.accepts('luis@web:~$ grep -r ERROR /var/log')).toBe(false);
        expect(tracker.accepts('/var/log/app.log:ERROR x')).toBe(false);
        expect(tracker.accepts('luis@web:~$ ')).toBe(false);
        expect(tracker.accepts('Error: after a bare prompt')).toBe(true);
        // A command that clears the screen: its prompt line is never read.
        tracker.startCommand('cat app.log');
        tracker.startCommand('clear; ./deploy.sh');
        expect(tracker.accepts('ERROR: deploy failed')).toBe(true);
    });

    it('reads what came before a command with the previous command’s state', () => {
        noteTerminalCommand(SERVER, './deploy.sh');
        ingestTerminalOutput(SERVER, 'luis@web:~$ ./deploy.sh\r\nERROR: deploy failed\r\n');
        // Enter on the next command comes before the next pass.
        noteTerminalCommand(SERVER, 'clear; cat /tmp/app.log');
        ingestTerminalOutput(SERVER, '\x1b[H\x1b[2J\x1b[3JERROR: database down\r\n');
        flushTerminalIssues(SERVER);
        expect(issues().map((issue) => issue.message)).toEqual(['ERROR: deploy failed']);
    });

    it('makes a line the user asked about the latest issue', () => {
        ingestTerminalOutput(SERVER, 'Error: first\nError: second\n');
        flushTerminalIssues(SERVER);
        const [first] = issues();
        const reported = reportIssueLine(SERVER, 'Error: first');
        expect(reported.id).toBe(first.id);
        expect(issues().map((issue) => issue.message)).toEqual(['Error: second', 'Error: first']);

        reportIssueLine(SERVER, 'something odd the classifier missed');
        expect(issues().at(-1)).toMatchObject({ type: 'error', message: 'something odd the classifier missed' });
    });

    it('dismisses, clears and forgets', () => {
        ingestTerminalOutput(SERVER, 'Error: a\nError: b\n');
        flushTerminalIssues(SERVER);
        dismissTerminalIssue(SERVER, issues()[0].id);
        expect(issues().map((issue) => issue.message)).toEqual(['Error: b']);
        clearTerminalIssues(SERVER);
        expect(issues()).toEqual([]);
        // Pending lines and the unfinished one are forgotten too.
        ingestTerminalOutput(SERVER, 'Error: pending\nError: unfini');
        resetTerminalIssues(SERVER);
        vi.advanceTimersByTime(250);
        expect(SERVER in useTerminalIssueStore.getState().issues).toBe(false);
        ingestTerminalOutput(SERVER, 'shed\n');
        flushTerminalIssues(SERVER);
        expect(issues()).toEqual([]);
    });
});
