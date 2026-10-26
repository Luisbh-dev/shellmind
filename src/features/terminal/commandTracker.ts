// Works out which command the user ran from what they typed, for the
// terminal's history. The keystrokes alone are not enough (arrow-key recall,
// Tab completion, Ctrl+U...), so on Enter the tracker reads the command line
// back from the screen once the remote side has echoed it. Nothing is
// recorded when that line belongs to a password prompt, when the typing was
// not echoed (no-echo prompts: sudo, ssh, mysql -p, read -s), when the echo
// does not match what was typed (masked input), or inside full-screen apps.

// A row of the terminal buffer that follows scrollback (an xterm marker).
export interface TrackedRow {
    readonly line: number;
    dispose(): void;
}

// The parts of the terminal the tracker reads.
export interface TerminalScreen {
    // Absolute buffer row and column of the cursor.
    cursor(): { row: number; col: number };
    lineText(row: number): string;
    isWrapped(row: number): boolean;
    isAlternateScreen(): boolean;
    trackCursorRow(): TrackedRow | null;
}

type Entry = {
    row: TrackedRow;
    col: number;
    // Text before the cursor when typing started: the prompt.
    prompt: string;
    // Printable characters typed, minus erased ones.
    typed: string;
    // Keys whose effect only the screen shows (history recall, completion,
    // line-editing shortcuts, a paste).
    edited: boolean;
    // The line was typed into this many terminals at once (broadcast input).
    broadcast?: number;
};

// What the history (and the audit log) learns about a command besides its text.
export type CommandDetails = { broadcast?: number };

// The line Enter would run now: what was typed and what the screen shows
// after the prompt (the shell runs one of them). `edited`: keys whose effect
// only the screen shows were used (arrows, Tab...); `caughtUp`: the terminal
// printed something after the last key.
export type PendingLine = { typed: string; shown: string; edited: boolean; caughtUp: boolean };

// "[sudo] password for luis: ", "Enter passphrase for key '/root/.ssh/id': ",
// "luis@host's password: ", "Contraseña: ", "Verification code: "...
const SECRET_PROMPT = /(pass(word|phrase|code)?|contrase[ñn]a|clave|passwort|kennwort|mot de passe|pin|otp|token|secret|verification code|c[oó]digo)\b.*[:：]\s*$/i;

export function isSecretPrompt(prompt: string): boolean {
    return SECRET_PROMPT.test(prompt);
}

const ECHO_WAIT_MS = 1000;
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

// xterm reports the terminal gaining or losing the focus (CSI I / CSI O) to a
// program that asked for it, as ConPTY does for every Windows console, and
// right away when it asks: the report is no key of the line being typed.
export function isFocusReport(data: string): boolean {
    return data === '\x1b[I' || data === '\x1b[O';
}

export class CommandTracker {
    private entry: Entry | null = null;
    private submitted: Entry[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    // Output came after the last key.
    private caughtUp = true;

    // onCommand: a command for the history, once its echo confirmed it
    // (`details.broadcast`: it was typed into several terminals at once).
    // onEnter: right when Enter is pressed, the command line as far as the
    // screen shows it, to tell what kind of output follows; it is never
    // stored ('' for an answer that was not echoed).
    constructor(
        private readonly screen: TerminalScreen,
        private readonly onCommand: (command: string, details: CommandDetails) => void,
        private readonly onEnter?: (command: string) => void
    ) {}

    // Keystrokes (or a paste) the user sent to the terminal.
    input(data: string): void {
        if (isFocusReport(data)) return;
        this.caughtUp = false;
        if (this.screen.isAlternateScreen()) {
            this.abandon();
            return;
        }
        const text = data;
        if (text.includes(PASTE_START)) {
            // A bracketed paste: its line breaks are part of the command line.
            const pasted = text.replaceAll(PASTE_START, '').replaceAll(PASTE_END, '').replace(/[\r\n]+/g, ' ');
            const current = this.begin();
            if (current) {
                current.typed += pasted;
                current.edited = true;
            }
            return;
        }

        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '\x1b') {
                // Escape sequence (arrows, Home/End, Alt+key): skip it whole.
                const current = this.begin();
                if (current) current.edited = true;
                const next = text[i + 1];
                if (next === '[' || next === 'O') {
                    let j = i + 2;
                    while (j < text.length && !/[@-~]/.test(text[j])) j++;
                    i = j;
                } else {
                    i += 1;
                }
                continue;
            }
            if (ch === '\r') {
                const current = this.begin();
                this.entry = null;
                if (current) {
                    this.onEnter?.(this.visibleCommand(current));
                    this.submit(current);
                }
                continue;
            }
            if (ch === '\x03' || ch === '\x04') {
                // Ctrl+C / Ctrl+D: the line is abandoned.
                this.abandon();
                continue;
            }
            const current = this.begin();
            if (!current) continue;
            if (ch === '\x7f' || ch === '\b') {
                current.typed = current.typed.slice(0, -1);
            } else if (ch === '\x15') {
                current.typed = '';
                current.edited = true;
            } else if (ch < ' ') {
                // Tab completion, Ctrl+A/E/K/W/R/Y and the like.
                current.edited = true;
            } else {
                current.typed += ch;
            }
        }
    }

    // The app typed text into the line for the user to edit (an editable
    // quick command); only the screen knows the final command.
    programmaticInput(): void {
        const current = this.begin();
        if (current) current.edited = true;
    }

    // The line being typed was typed into `size` terminals at once (see
    // broadcast.ts); its command says so when it is recorded.
    markBroadcast(size: number): void {
        if (this.screen.isAlternateScreen()) return;
        const current = this.begin();
        if (current) current.broadcast = Math.max(current.broadcast ?? 0, size);
    }

    // Text was typed (or broadcast) into the line the cursor is on, and not
    // erased since (Backspace, Ctrl+U).
    hasLine(): boolean {
        return Boolean(this.entry?.typed) && !this.screen.isAlternateScreen();
    }

    // The line being typed (null when none, or inside a full-screen program).
    pendingLine(): PendingLine | null {
        const entry = this.entry;
        if (!entry || this.screen.isAlternateScreen()) return null;
        return { typed: entry.typed.trim(), shown: this.shownText(entry), edited: entry.edited, caughtUp: this.caughtUp };
    }

    // Call after output was written: submitted lines whose echo has arrived
    // (the cursor moved past them) are evaluated.
    output(): void {
        this.caughtUp = true;
        if (!this.submitted.length) return;
        const cursorRow = this.screen.cursor().row;
        while (this.submitted.length && this.echoed(this.submitted[0], cursorRow)) {
            this.evaluate(this.submitted.shift()!);
        }
        if (!this.submitted.length) this.clearTimer();
    }

    reset(): void {
        this.abandon();
        for (const entry of this.submitted) entry.row.dispose();
        this.submitted = [];
        this.clearTimer();
    }

    dispose(): void {
        this.reset();
    }

    private begin(): Entry | null {
        if (this.entry) return this.entry;
        const row = this.screen.trackCursorRow();
        if (!row) return null;
        const { col } = this.screen.cursor();
        this.entry = { row, col, prompt: this.screen.lineText(row.line).slice(0, col), typed: '', edited: false };
        return this.entry;
    }

    private abandon(): void {
        this.entry?.row.dispose();
        this.entry = null;
    }

    // The command line on screen now. The typed text stands in for it only
    // while the screen shows a start of it (the echo may lag behind fast
    // typing): what a prompt does not echo is never used.
    private visibleCommand(entry: Entry): string {
        const visible = this.shownText(entry);
        const typed = entry.typed.trim();
        return !entry.edited && visible && typed.startsWith(visible) ? typed : visible;
    }

    // What the screen shows of the line after its prompt (wrapped rows joined).
    private shownText(entry: Entry): string {
        if (entry.row.line < 0) return '';
        let shown = this.screen.lineText(entry.row.line).slice(entry.col);
        for (let row = entry.row.line + 1; this.screen.isWrapped(row); row++) shown += this.screen.lineText(row);
        return shown.trim();
    }

    private submit(entry: Entry): void {
        this.submitted.push(entry);
        if (!this.timer) {
            // No output at all after Enter: decide with what is on screen.
            this.timer = setTimeout(() => {
                this.timer = null;
                const pending = this.submitted;
                this.submitted = [];
                for (const item of pending) this.evaluate(item);
            }, ECHO_WAIT_MS);
        }
    }

    // The cursor moved below the (possibly wrapped) command line: Enter was echoed.
    private echoed(entry: Entry, cursorRow: number): boolean {
        let last = entry.row.line;
        if (last < 0) return true;
        while (this.screen.isWrapped(last + 1)) last++;
        return cursorRow > last;
    }

    private clearTimer(): void {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
    }

    private evaluate(entry: Entry): void {
        const start = entry.row.line;
        entry.row.dispose();
        if (start < 0 || isSecretPrompt(entry.prompt)) return;

        let shown = this.screen.lineText(start).slice(entry.col);
        for (let row = start + 1; this.screen.isWrapped(row); row++) shown += this.screen.lineText(row);
        const command = shown.trim();
        if (!command || /^\*+$/.test(command)) return;
        const details: CommandDetails = entry.broadcast ? { broadcast: entry.broadcast } : {};

        if (!entry.edited) {
            const typed = entry.typed.trim();
            // What was typed must be what the screen shows: anything else is a
            // masked or unechoed answer, or output that raced the typing.
            if (command !== typed) {
                if (!typed || !command.endsWith(typed)) return;
                this.onCommand(typed, details);
                return;
            }
        }
        this.onCommand(command, details);
    }
}
