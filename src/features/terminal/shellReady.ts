import { cursorPromptShell, matchPrompt } from '@shared/shells';

// When a session connects, its shell has printed nothing yet: the line the
// cursor is on is empty or the "Connected to…" notice, which says nothing
// about whether a shell reads input. Commands queued for the terminal (AI
// chat, Auto-Run, snippets) wait until the shell is ready:
//   - a prompt shows at the cursor, or a line editor turned bracketed paste
//     on (bash and zsh do as they show their prompt), checked after each
//     output;
//   - otherwise once the output went quiet for `quietMs` (a prompt this app
//     does not recognise, a question), or `maxMs` after connecting at the
//     latest (a shell that prints nothing, a login script that keeps going).
// Only then is what the screen shows judged (see typingRisk in delivery.ts).

export type ReadinessTiming = { quietMs: number; maxMs: number };

export const DEFAULT_READINESS_TIMING: ReadinessTiming = { quietMs: 1000, maxMs: 5000 };

export type ReadingScreen = {
    // The line the cursor is on, up to the cursor.
    cursorLine: string;
    bracketedPaste: boolean;
};

// Whether a shell (or a tool's console: "mysql> ", "ftp> ") is reading a
// line now.
export function isReadingInput(screen: ReadingScreen): boolean {
    if (screen.bracketedPaste) return true;
    return cursorPromptShell(screen.cursorLine) !== null || matchPrompt(screen.cursorLine.trim()) !== null;
}

export class ShellReadiness {
    private phase: 'idle' | 'waiting' | 'ready' = 'idle';
    private quietTimer: ReturnType<typeof setTimeout> | null = null;
    private maxTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly reading: () => boolean,
        private readonly onReady: () => void,
        private readonly timing: ReadinessTiming = DEFAULT_READINESS_TIMING
    ) {}

    // A new session is up.
    start(): void {
        this.stop();
        this.phase = 'waiting';
        if (this.reading()) {
            this.becomeReady();
            return;
        }
        this.maxTimer = setTimeout(() => this.becomeReady(), this.timing.maxMs);
    }

    // Output of the session was written to the terminal.
    output(): void {
        if (this.phase !== 'waiting') return;
        if (this.reading()) {
            this.becomeReady();
            return;
        }
        if (this.quietTimer) clearTimeout(this.quietTimer);
        this.quietTimer = setTimeout(() => this.becomeReady(), this.timing.quietMs);
    }

    // The session ended, or the terminal is going away.
    stop(): void {
        this.clearTimers();
        this.phase = 'idle';
    }

    private becomeReady(): void {
        this.clearTimers();
        this.phase = 'ready';
        this.onReady();
    }

    private clearTimers(): void {
        if (this.quietTimer) clearTimeout(this.quietTimer);
        if (this.maxTimer) clearTimeout(this.maxTimer);
        this.quietTimer = null;
        this.maxTimer = null;
    }
}
