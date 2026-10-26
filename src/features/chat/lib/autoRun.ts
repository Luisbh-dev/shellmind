import type { ChatCommandOutput } from '@shared/chat';
import { findDangerousCommand, type DangerMatch } from '@shared/commandSafety';

// Auto-Run: when enabled, the shell blocks of each AI answer are typed into
// the terminal of the chat's server, their output is captured and sent back
// for analysis, and the next answer's blocks run in turn, up to a maximum
// number of steps. Destructive commands always wait for the user. Every
// asynchronous step is tied to a chain generation, so Stop, turning Auto-Run
// off or leaving the server cancels everything still in flight.
//
// A command is complete when its output went quiet AND the terminal shows a
// shell prompt again below the line the command was typed at (the shell's
// echo of the command does not count). When that does not happen in time, the
// output is analyzed as "still running" and the chain pauses: nothing is typed
// into a command that is still running or waiting for input.

export type AutoRunPhase =
    | 'idle'
    // A destructive command waits for the user's decision.
    | 'awaiting-approval'
    // A command was sent; waiting for its output to settle.
    | 'running'
    // The output went to the AI; waiting for its answer.
    | 'analyzing';

export type AutoRunState = {
    enabled: boolean;
    phase: AutoRunPhase;
    // Commands run in the current chain.
    step: number;
    pending: { command: string; danger: DangerMatch } | null;
};

export type AutoRunNotice =
    | { type: 'paused-limit'; steps: number }
    | { type: 'paused-running'; seconds: number }
    | { type: 'not-connected' }
    | { type: 'no-output' }
    // Another terminal tab got the focus while the command ran.
    | { type: 'session-changed' }
    | { type: 'skipped' }
    | { type: 'stopped' }
    // The terminal did not type the step (features/terminal/commandDelivery).
    | { type: 'not-typed'; reason: AutoRunNotTypedReason };

// A full-screen program held the terminal, no shell prompt was in sight, the
// session ended first, or the focused tab is a shell inside a container.
export type AutoRunNotTypedReason = 'full-screen' | 'no-prompt' | 'not-connected' | 'container-shell';

export type AutoRunTiming = {
    // How often the output counter is checked.
    pollMs: number;
    // Output must stop growing for this long before it is checked for the
    // returning prompt.
    quietMs: number;
    // Give up when the terminal printed nothing at all (not even the echo).
    noOutputMs: number;
    // Analyze whatever arrived after this long, as a command still running.
    maxWaitMs: number;
};

export const DEFAULT_AUTO_RUN_TIMING: AutoRunTiming = {
    pollMs: 500,
    quietMs: 1500,
    noOutputMs: 8000,
    maxWaitMs: 120_000
};

const MAX_PROMPT_LENGTH = 200;

// Prompts of common shells, for when the prompt the command was typed at is
// unknown or changed (sudo -i, ssh to another host).
const SHELL_PROMPTS = [
    // PowerShell
    /^PS [^\n]*>$/,
    // cmd.exe
    /^[A-Za-z]:\\[^\n]*>$/,
    // user@host:~$ (bash, zsh, sh)
    /^[\w.-]+@[\w.-]+[^\n]*[$#%>]$/,
    // [user@host dir]$
    /^\[[^\]\n]+\][$#]$/
];

// The prompt the command is typed at: the line of the mark (the terminal
// renders it from the start of that line).
export function promptAtMark(text: string): string {
    const line = text.split('\n').pop()?.trimEnd() ?? '';
    return line.length <= MAX_PROMPT_LENGTH ? line : '';
}

// Whether `line` is a shell prompt: the one the command was typed at, the
// same prompt in another directory (same first word and final character), or
// a common shell prompt. With no known prompt, bare and tool prompts count
// too ("$", "docker>").
export function looksLikePrompt(line: string, knownPrompt: string): boolean {
    const text = line.trimEnd();
    if (!text || text.length > MAX_PROMPT_LENGTH) return false;
    const known = knownPrompt.trimEnd();
    if (known) {
        if (text === known) return true;
        const head = (value: string) => value.split(/[\s:\\/]/)[0];
        if (head(text) && head(text) === head(known) && text.at(-1) === known.at(-1)) return true;
    } else if (/^([\w.-]+>|[$#%>])$/.test(text)) {
        return true;
    }
    return SHELL_PROMPTS.some((pattern) => pattern.test(text));
}

// Output since the mark ends at a prompt below the echoed command.
export function endsAtPrompt(output: string, knownPrompt: string): boolean {
    const lines = output.split('\n');
    let last = lines.length - 1;
    while (last > 0 && !lines[last].trim()) last--;
    return last > 0 && looksLikePrompt(lines[last], knownPrompt);
}

export const AUTO_RUN_MAX_STEPS = 5;

export type AutoRunDeps = {
    // Commands of the runnable blocks of an answer (`complete`: it was not
    // cut off, so a block left open at its end counts).
    runnableCommands: (answer: string, complete: boolean) => string[];
    scopedBin: () => string | null;
    isConnected: () => boolean;
    // Types the command into the server's terminal.
    run: (command: string) => void;
    // Monotonic count of the terminal's output (cheap, polled), and the
    // output since a mark, rendered from the start of the mark's line.
    outputMark: () => number;
    readOutputSince: (mark: number) => { text: string; truncated: boolean; total: number };
    // The terminal tab that output comes from (polled). When it changes while
    // a command runs, the output no longer belongs to that command.
    outputSession?: () => string | null;
    // Sends the captured output to the AI; its answer comes back through
    // onAnswer() (or analysisFailed()).
    analyze: (output: ChatCommandOutput) => void;
    notify: (notice: AutoRunNotice) => void;
    maxSteps?: number;
    timing?: Partial<AutoRunTiming>;
};

export type AutoRunController = {
    getState: () => AutoRunState;
    subscribe: (listener: () => void) => () => void;
    // Call after the user confirmed enabling it.
    enable: () => void;
    disable: () => void;
    // An AI answer arrived (`complete`: false when it was cut off).
    onAnswer: (answer: string, complete?: boolean) => void;
    // The analysis request failed or was cancelled.
    analysisFailed: () => void;
    // The user approved / skipped the pending destructive command.
    approve: () => void;
    skip: () => void;
    // Cancels the chain in flight (Auto-Run stays enabled).
    stop: () => void;
    // The terminal did not type the running step: the chain ends now instead
    // of waiting for output that never comes.
    notTyped: (reason: AutoRunNotTypedReason) => void;
    // A message typed by the user starts a new chain budget.
    resetBudget: () => void;
    dispose: () => void;
};

export function createAutoRun(deps: AutoRunDeps): AutoRunController {
    const timing = { ...DEFAULT_AUTO_RUN_TIMING, ...deps.timing };
    const maxSteps = deps.maxSteps ?? AUTO_RUN_MAX_STEPS;
    let state: AutoRunState = { enabled: false, phase: 'idle', step: 0, pending: null };
    let generation = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // The step being analyzed did not finish: its answer must not run more.
    let lastStepRunning = false;
    const listeners = new Set<() => void>();

    const setState = (patch: Partial<AutoRunState>) => {
        state = { ...state, ...patch };
        listeners.forEach((listener) => listener());
    };

    const clearTimer = () => {
        if (timer) clearTimeout(timer);
        timer = null;
    };

    // Ends the chain in flight: pending timers and decisions are dropped and
    // late callbacks of the old generation are ignored.
    const cancelChain = () => {
        generation += 1;
        clearTimer();
        lastStepRunning = false;
        if (state.phase !== 'idle' || state.pending) setState({ phase: 'idle', pending: null });
    };

    const finish = (command: string, output: { text: string; truncated: boolean }, stillRunning: boolean) => {
        lastStepRunning = stillRunning;
        setState({ phase: 'analyzing' });
        deps.analyze({ command, output: output.text, truncated: output.truncated, ...(stillRunning ? { stillRunning: true } : {}) });
    };

    const execute = (command: string) => {
        if (!deps.isConnected()) {
            setState({ phase: 'idle', pending: null });
            deps.notify({ type: 'not-connected' });
            return;
        }
        const chain = generation;
        const session = deps.outputSession?.() ?? null;
        const mark = deps.outputMark();
        const prompt = promptAtMark(deps.readOutputSince(mark).text);
        const startedAt = Date.now();
        let lastTotal = mark;
        let lastGrowthAt = startedAt;
        // Output already checked for a prompt (rendering it again would not
        // change the answer).
        let checkedTotal = mark;

        setState({ phase: 'running', pending: null, step: state.step + 1 });
        deps.run(command);

        const poll = () => {
            timer = setTimeout(() => {
                timer = null;
                if (chain !== generation) return;
                if (session !== null && deps.outputSession?.() !== session) {
                    setState({ phase: 'idle' });
                    deps.notify({ type: 'session-changed' });
                    return;
                }
                const now = Date.now();
                const total = deps.outputMark();
                if (total > lastTotal) {
                    lastTotal = total;
                    lastGrowthAt = now;
                }
                const waited = now - startedAt;

                if (lastTotal === mark) {
                    if (waited >= timing.noOutputMs) {
                        setState({ phase: 'idle' });
                        deps.notify({ type: 'no-output' });
                        return;
                    }
                } else if (now - lastGrowthAt >= timing.quietMs && lastTotal !== checkedTotal) {
                    checkedTotal = lastTotal;
                    const output = deps.readOutputSince(mark);
                    if (endsAtPrompt(output.text, prompt)) {
                        finish(command, output, false);
                        return;
                    }
                }
                if (waited >= timing.maxWaitMs) {
                    finish(command, deps.readOutputSince(mark), true);
                    return;
                }
                poll();
            }, timing.pollMs);
        };
        poll();
    };

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        enable() {
            setState({ enabled: true, step: 0 });
        },
        disable() {
            cancelChain();
            setState({ enabled: false, step: 0 });
        },
        onAnswer(answer, complete = true) {
            if (!state.enabled) return;
            if (state.phase === 'running' || state.phase === 'awaiting-approval') return;
            const afterRunningStep = lastStepRunning;
            lastStepRunning = false;
            const commands = deps.runnableCommands(answer, complete);
            if (!commands.length) {
                setState({ phase: 'idle' });
                return;
            }
            if (afterRunningStep) {
                setState({ phase: 'idle' });
                deps.notify({ type: 'paused-running', seconds: Math.round(timing.maxWaitMs / 1000) });
                return;
            }
            if (state.step >= maxSteps) {
                setState({ phase: 'idle' });
                deps.notify({ type: 'paused-limit', steps: maxSteps });
                return;
            }
            const command = commands.join('\n');
            const danger = findDangerousCommand(command, { scopedBin: deps.scopedBin() });
            if (danger) {
                setState({ phase: 'awaiting-approval', pending: { command, danger } });
                return;
            }
            execute(command);
        },
        analysisFailed() {
            lastStepRunning = false;
            if (state.phase === 'analyzing') setState({ phase: 'idle' });
        },
        approve() {
            if (state.phase !== 'awaiting-approval' || !state.pending) return;
            execute(state.pending.command);
        },
        skip() {
            if (state.phase !== 'awaiting-approval') return;
            setState({ phase: 'idle', pending: null });
            deps.notify({ type: 'skipped' });
        },
        stop() {
            const wasBusy = state.phase !== 'idle';
            cancelChain();
            if (wasBusy) deps.notify({ type: 'stopped' });
        },
        notTyped(reason) {
            if (state.phase !== 'running') return;
            cancelChain();
            deps.notify({ type: 'not-typed', reason });
        },
        resetBudget() {
            setState({ step: 0 });
        },
        // The chat unmounted: Auto-Run is off and nothing in flight survives.
        // (React's development double-mount enables it again from scratch.)
        dispose() {
            cancelChain();
            if (state.enabled || state.step) setState({ enabled: false, step: 0 });
        }
    };
}
