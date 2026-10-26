import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandTracker, isSecretPrompt, type TerminalScreen } from './commandTracker';

// A tiny terminal screen: text written at the cursor, CR/LF moving it.
class FakeScreen implements TerminalScreen {
    lines: string[] = [''];
    wrapped = new Set<number>();
    row = 0;
    col = 0;
    alternate = false;
    cols = 40;

    write(text: string): void {
        for (const ch of text) {
            if (ch === '\r') {
                this.col = 0;
            } else if (ch === '\n') {
                this.row += 1;
                this.lines[this.row] ??= '';
            } else {
                if (this.col >= this.cols) {
                    this.row += 1;
                    this.col = 0;
                    this.lines[this.row] ??= '';
                    this.wrapped.add(this.row);
                }
                const line = this.lines[this.row].padEnd(this.col);
                this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
                this.col += 1;
            }
        }
    }

    // Readline redrawing the line after the prompt (history recall, Ctrl+U).
    redraw(prompt: string, text: string): void {
        this.lines[this.row] = prompt + text;
        this.col = (prompt + text).length;
    }

    cursor() {
        return { row: this.row, col: this.col };
    }

    lineText(row: number) {
        return this.lines[row] ?? '';
    }

    isWrapped(row: number) {
        return this.wrapped.has(row);
    }

    isAlternateScreen() {
        return this.alternate;
    }

    trackCursorRow() {
        const row = this.row;
        let disposed = false;
        return {
            get line() {
                return disposed ? -1 : row;
            },
            dispose() {
                disposed = true;
            }
        };
    }
}

let screen: FakeScreen;
let tracker: CommandTracker;
let recorded: string[];

// The user types `keys`; the remote echoes `echo` (by default what was typed).
function type(keys: string, echo = keys): void {
    tracker.input(keys);
    screen.write(echo);
    tracker.output();
}

function enter(output = ''): void {
    tracker.input('\r');
    screen.write(`\r\n${output}`);
    tracker.output();
}

beforeEach(() => {
    vi.useFakeTimers();
    screen = new FakeScreen();
    recorded = [];
    tracker = new CommandTracker(screen, (command) => recorded.push(command));
    screen.write('luis@web:~$ ');
});

afterEach(() => {
    tracker.dispose();
    vi.useRealTimers();
});

describe('CommandTracker', () => {
    it('records the command once the remote side echoed Enter', () => {
        type('ls -la');
        tracker.input('\r');
        expect(recorded).toEqual([]);
        screen.write('\r\ntotal 0\r\n');
        tracker.output();
        expect(recorded).toEqual(['ls -la']);
    });

    it('forgets a line abandoned with Ctrl+C', () => {
        type('foo');
        type('\x03', '^C\r\nluis@web:~$ ');
        type('ls');
        enter();
        expect(recorded).toEqual(['ls']);
    });

    it('takes recalled and completed commands from the screen', () => {
        tracker.input('\x1b[A');
        screen.redraw('luis@web:~$ ', 'docker ps -a');
        enter();
        type('cd /va');
        type('\t', 'r/log/');
        enter();
        expect(recorded).toEqual(['docker ps -a', 'cd /var/log/']);
    });

    it('takes no focus report for a key: a Windows console asks for them before its first prompt (ConPTY)', () => {
        tracker.dispose();
        screen = new FakeScreen();
        tracker = new CommandTracker(screen, (command) => recorded.push(command));
        // xterm reports the focus as soon as ConPTY asks, before the prompt is drawn.
        tracker.input('\x1b[I');
        screen.write('PS C:\\Users\\luis> ');
        type('echo abc');
        tracker.input('\x1b[O');
        tracker.input('\x1b[I');
        enter('abc\r\n');
        expect(recorded).toEqual(['echo abc']);
        expect(tracker.hasLine()).toBe(false);
    });

    it('follows Ctrl+U and backspace', () => {
        type('rm -rf /tmp/x');
        tracker.input('\x15');
        screen.redraw('luis@web:~$ ', '');
        type('pwdd');
        type('\x7f', '\b \b');
        screen.redraw('luis@web:~$ ', 'pwd');
        enter();
        expect(recorded).toEqual(['pwd']);
    });

    it('never records what is typed at a password prompt', () => {
        type('sudo apt update');
        enter('[sudo] password for luis: ');
        // No echo; the password and Enter come in one chunk.
        tracker.input('hunter2\r');
        screen.write('\r\n');
        tracker.output();
        vi.advanceTimersByTime(2000);
        expect(recorded).toEqual(['sudo apt update']);
    });

    it('never records unechoed or masked input, whatever the prompt says', () => {
        screen.write('\r\nType the magic words > ');
        type('open sesame', '');
        enter();
        screen.write('PIN? ');
        type('1234', '****');
        enter();
        expect(recorded).toEqual([]);
    });

    it('ignores keystrokes inside full-screen programs', () => {
        type('vim notes.txt');
        enter();
        screen.alternate = true;
        type(':wq');
        enter();
        screen.alternate = false;
        expect(recorded).toEqual(['vim notes.txt']);
    });

    it('handles a pasted line whose echo arrives after Enter', () => {
        tracker.input('echo pasted\r');
        tracker.output();
        screen.write('echo pasted\r\npasted\r\n');
        tracker.output();
        expect(recorded).toEqual(['echo pasted']);
    });

    it('decides on its own when Enter is never echoed', () => {
        type('read -p "name? " n');
        tracker.input('\r');
        vi.advanceTimersByTime(1000);
        expect(recorded).toEqual(['read -p "name? " n']);
    });

    it('records commands the app typed for the user to complete', () => {
        tracker.programmaticInput();
        screen.write('sudo systemctl restart ');
        type('nginx');
        enter();
        expect(recorded).toEqual(['sudo systemctl restart nginx']);
    });

    it('reads commands that wrap over several rows', () => {
        const long = `echo ${'x'.repeat(50)}`;
        type(long);
        enter();
        expect(recorded).toEqual([long]);
    });

    it('takes a bracketed paste as one edited line', () => {
        tracker.input('\x1b[200~git add .\ngit commit\x1b[201~');
        screen.write('git add . git commit');
        enter();
        expect(recorded).toEqual(['git add . git commit']);
    });

    it('tells right on Enter which command the output that follows comes from', () => {
        const entered: string[] = [];
        tracker.dispose();
        tracker = new CommandTracker(screen, (command) => recorded.push(command), (command) => entered.push(command));

        // Before any echo or output, even when `clear` erases the line later.
        type('clear; cat app.log');
        tracker.input('\r');
        expect(entered).toEqual(['clear; cat app.log']);
        screen.write('\r\n');
        tracker.output();

        // The echo lags behind fast typing: what was typed, as it starts the same.
        tracker.input('tail -f syslog');
        screen.write('tail -');
        tracker.input('\r');
        expect(entered.at(-1)).toBe('tail -f syslog');
        screen.write('f syslog\r\n');
        tracker.output();

        // A password prompt echoes nothing: the answer is never passed on.
        screen.write('[sudo] password for luis: ');
        tracker.input('hunter2\r');
        expect(entered.at(-1)).toBe('');
        expect(entered.join(' ')).not.toContain('hunter2');
    });

    it('says which commands were typed into several terminals at once (broadcast input)', () => {
        const details: Array<{ command: string; broadcast?: number }> = [];
        tracker.dispose();
        tracker = new CommandTracker(screen, (command, info) => details.push({ command, ...info }));

        tracker.markBroadcast(3);
        type('uptime');
        enter();
        type('ls');
        enter();
        expect(details).toEqual([{ command: 'uptime', broadcast: 3 }, { command: 'ls' }]);

        // Nothing is marked inside a full-screen program.
        screen.alternate = true;
        tracker.markBroadcast(2);
        screen.alternate = false;
        type('pwd');
        enter();
        expect(details.at(-1)).toEqual({ command: 'pwd' });
    });

    it('tells what Enter would run: the typed text, the screen\'s, and whether the screen caught up (broadcast input)', () => {
        expect(tracker.pendingLine()).toBeNull();
        expect(tracker.hasLine()).toBe(false);
        screen.write('luis@web:~$ ');
        // Typed, not echoed yet: only the keys know it.
        tracker.input('sudo reboot');
        expect(tracker.hasLine()).toBe(true);
        expect(tracker.pendingLine()).toEqual({ typed: 'sudo reboot', shown: '', edited: false, caughtUp: false });
        screen.write('sudo reboot');
        tracker.output();
        expect(tracker.pendingLine()).toEqual({ typed: 'sudo reboot', shown: 'sudo reboot', edited: false, caughtUp: true });
        // Erased: nothing typed is left on the line.
        tracker.input('\x15');
        expect(tracker.hasLine()).toBe(false);
        tracker.input('x');
        expect(tracker.hasLine()).toBe(true);
        tracker.input('\x03');
        expect(tracker.hasLine()).toBe(false);
        screen.write('^C\r\nluis@web:~$ ');
        tracker.output();

        // History recall: only the screen knows the line, once it redrew it.
        tracker.input('\x1b[A');
        expect(tracker.pendingLine()).toMatchObject({ shown: '', edited: true, caughtUp: false });
        screen.redraw('luis@web:~$ ', 'rm -rf /srv/old');
        tracker.output();
        expect(tracker.pendingLine()).toMatchObject({ shown: 'rm -rf /srv/old', edited: true, caughtUp: true });
        screen.alternate = true;
        expect(tracker.pendingLine()).toBeNull();
        expect(tracker.hasLine()).toBe(false);
    });
});

describe('isSecretPrompt', () => {
    it.each([
        '[sudo] password for luis: ',
        "luis@10.0.0.5's password: ",
        "Enter passphrase for key '/home/luis/.ssh/id_ed25519': ",
        'Enter password: ',
        'Contraseña: ',
        'Verification code: ',
        'Enter PIN for "PIV Card Holder": ',
        'Password for \'https://luis@github.com\':'
    ])('recognizes %j', (prompt) => {
        expect(isSecretPrompt(prompt)).toBe(true);
    });

    it.each(['luis@web:~$ ', 'PS C:\\> ', 'mysql> ', 'docker> '])('does not take %j for one', (prompt) => {
        expect(isSecretPrompt(prompt)).toBe(false);
    });
});
