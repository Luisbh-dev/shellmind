// Terminal output as the rest of the app reads it: escape sequences removed,
// errors recognized (one classifier for the terminal's inline markers and the
// chat's issue card), and per-server issue state kept outside React so that a
// flood of output never re-renders the app per chunk.
import { useCallback, useEffect } from 'react';
import { create } from 'zustand';
import { matchPrompt } from '@shared/shells';
import { maskTerminalSecrets } from './terminalSecrets';

export type TerminalIssueType = 'error' | 'warning';

export interface TerminalIssue {
    id: string;
    type: TerminalIssueType;
    message: string;
    details?: string;
    timestamp: number;
}

// ---- Text ------------------------------------------------------------------

/* eslint-disable no-control-regex -- terminal escape sequences are control characters */
const ESCAPE_SEQUENCES = new RegExp(
    [
        '\\x1B\\[[0-?]*[ -/]*[@-~]', // CSI: colors, cursor movement
        '\\x1B\\][^\\x07\\x1B]*(?:\\x07|\\x1B\\\\)', // OSC: window titles, hyperlinks
        '\\x1B[PX^_][\\s\\S]*?\\x1B\\\\', // DCS, SOS, PM, APC
        '\\x1B[()*+][0-9A-Za-z]', // character set selection
        '\\x1B[ -/]*[0-~]' // other two-character sequences
    ].join('|'),
    'g'
);
const OTHER_CONTROLS = /[\x00-\x08\x0B\x0C\x0E-\x1A\x1C-\x1F\x7F]/g;
/* eslint-enable no-control-regex */

// Removes terminal escape sequences (colors, cursor movement, window titles)
// and stray control characters; keeps tabs, line feeds and carriage returns.
export function stripAnsi(text: string): string {
    return text.replace(ESCAPE_SEQUENCES, '').replace(OTHER_CONTROLS, '');
}

// Plain text for reading: no escapes, no carriage returns.
export function normalizeTerminalText(text: string): string {
    return stripAnsi(text).replace(/\r/g, '');
}

// A line as it ended up on screen: text before a lone carriage return was
// overwritten (progress bars, spinners).
function visibleLine(raw: string): string {
    const parts = raw.split('\r').filter(Boolean);
    return (parts[parts.length - 1] ?? '').trimEnd();
}

// The line starts with a shell prompt (read as the terminal reads them,
// shared/shells.ts): it shows a command, not its result.
export function looksLikePrompt(line: string): boolean {
    return matchPrompt(line) !== null;
}

// The command shown after the prompt at the start of `line` ('' for a bare
// prompt), or null when the line is no prompt. In a CLI console ("docker>
// logs web") the tool is part of the command.
export function promptCommand(line: string): string | null {
    const match = matchPrompt(line);
    if (!match) return null;
    return match.tool && match.command ? `${match.tool} ${match.command}` : match.command;
}

const ERROR_LINES = [
    // A login shell names itself "-bash".
    /^-?(bash|sh|zsh|fish|dash|ksh|ash)(: line \d+)?: .*(command not found|permission denied|no such file or directory|not a directory|is a directory|operation not permitted|bad substitution|syntax error)/i,
    /^\S+: (command not found|not found)$/i,
    /^[\w.+/-]+: .*: (No such file or directory|Permission denied|Operation not permitted|Is a directory|Not a directory|Read-only file system|No space left on device|Connection refused|Connection timed out|No route to host|Too many levels of symbolic links)$/,
    /^[\w.+/-]+: (cannot|can't|unable to|failed to) .+/i,
    /^(error|fatal|panic|err!|critical)(\[[^\]]*\])?\s*[:!]/i,
    /^npm ERR!/,
    /^E: /,
    /^ERROR\b/,
    /^An error occurred \(/,
    /^Error response from daemon:/,
    /^sudo: .*(incorrect password|not in the sudoers|a password is required|unable to)/i,
    /^Permission denied \(publickey/,
    /^ssh: (connect to host|Could not resolve)/,
    /^curl: \(\d+\)/,
    /^Could not resolve host/i,
    /^Failed to (start|stop|restart|reload|enable|disable|connect|load|mount|open|fetch|get|set)\b/,
    /^Job for \S+ failed/,
    /^Traceback \(most recent call last\):/,
    /^([A-Za-z_][\w.]*)?(Error|Exception)(:|$)/,
    /^Exception in thread /,
    /Segmentation fault|core dumped|Killed$|Out of memory: Kill/,
    /is not recognized as (an internal or external command|the name of a cmdlet)/i,
    /^Access is denied\.?$/i,
    /^The system cannot find the (file|path) specified/i,
    /^\S.*: The term '.+' is not recognized/,
    /^\s*\+ CategoryInfo\s*:/
];

const WARNING_LINES = [
    /^(warning|warn)\b\s*[:!]/i,
    /^W: /,
    /^npm WARN/,
    /^DEPRECATION:|^DeprecationWarning:/,
    /^WARNING\b/
];

const DETAIL_LINES = [
    /^\s*(At line:\d+|At [A-Za-z]:\\|\+ (CategoryInfo|FullyQualifiedErrorId)\s*:|\+\s+~+)/,
    /^\s+File ".*", line \d+/,
    /^\s+at\s+\S/,
    /^\s*(Caused by|Details?|Reason|Hint):\s/i
];

// Whether one line of output reports an error, a warning, or nothing. Lines
// are matched where tools put their error markers (the start of the line, a
// "tool: path: reason" shape), not anywhere in the text: an `ls` listing of
// "failed_jobs.log" or a prompt in /srv/errors is not an error.
export function classifyTerminalLine(line: string): TerminalIssueType | null {
    const text = visibleLine(stripAnsi(line)).trim();
    if (!text || text.length > 2000 || looksLikePrompt(text)) return null;
    if (ERROR_LINES.some((pattern) => pattern.test(text))) return 'error';
    if (WARNING_LINES.some((pattern) => pattern.test(text))) return 'warning';
    return null;
}

// Stack frames and similar lines that belong to the error above them.
export function isTerminalDetailLine(line: string): boolean {
    return DETAIL_LINES.some((pattern) => pattern.test(line));
}

const QUIET_COMMANDS = new Set([
    'ls', 'll', 'la', 'dir', 'tree', 'grep', 'egrep', 'fgrep', 'zgrep', 'rg', 'ag', 'ack', 'find', 'fd', 'locate', 'cat', 'bat',
    'less', 'more', 'head', 'tail', 'journalctl', 'dmesg', 'history', 'man', 'help', 'type', 'findstr', 'get-childitem', 'gci',
    'get-content', 'gc', 'select-string', 'sls', 'get-winevent', 'get-eventlog'
]);

// Tools whose `logs` subcommand prints what other programs logged.
const LOG_TOOLS = new Set(['docker', 'podman', 'nerdctl', 'kubectl', 'oc', 'docker-compose']);

// Commands whose output is other files' contents or names: words like
// "error" in it say nothing about the command itself. In a chain
// (`clear; cat app.log`, `cd /var/log && tail -f syslog`) the last command
// prints what follows; in a pipeline, the first one decides.
export function isQuietCommand(command: string): boolean {
    const last = command.split(/;|&&|\|\||\n/).map((part) => part.trim()).filter(Boolean).pop() ?? '';
    const words = last.split(/\s+/);
    while (words.length && /^(sudo|doas|env|command|time|nice|\w+=\S*)$/i.test(words[0])) words.shift();
    const program = (words[0] ?? '').split(/[\\/]/).pop()?.toLowerCase().replace(/\.exe$/, '') ?? '';
    if (LOG_TOOLS.has(program) && words.slice(1, 3).includes('logs')) return true;
    return QUIET_COMMANDS.has(program);
}

// Follows which command the lines being read come from, so that the output
// of listing and search commands (`cat app.log`, `grep -r error`) is not
// read as errors. The command takes effect when it is sent (the caller has
// read every line that came before), so a command that clears the screen or
// prints more than is read still counts; a prompt line seen later tells the
// same, and also covers commands nobody noted (a bare prompt: none).
export class CommandOutputTracker {
    private quiet = false;
    // The command just sent, until its echo line went by.
    private echo: string | null = null;

    startCommand(command: string): void {
        const text = command.trim();
        this.quiet = isQuietCommand(text);
        this.echo = text || null;
    }

    // Whether `line` (as shown, escapes removed) is output that may report an
    // error. Prompt and echo lines are not.
    accepts(line: string): boolean {
        const command = promptCommand(line);
        if (command !== null) {
            this.quiet = isQuietCommand(command);
            this.echo = null;
            return false;
        }
        // The echo after a prompt the patterns do not know ("➜  ~ make").
        if (this.echo && line.trimEnd().endsWith(this.echo)) {
            this.echo = null;
            return false;
        }
        return !this.quiet;
    }
}

// ---- Per-server state -----------------------------------------------------------

const PENDING_LINE_LIMIT = 400;
const ISSUE_LIMIT = 20;
const CLASSIFY_INTERVAL_MS = 250;
const DUPLICATE_WINDOW_MS = 5000;

type Feed = {
    // The unfinished last line (carriage returns kept).
    partial: string;
    // Complete lines waiting for the next classification pass.
    pending: string[];
    // Which command the lines come from (listing/search output is skipped).
    tracker: CommandOutputTracker;
    timer: ReturnType<typeof setTimeout> | null;
    lastIssueId: string | null;
    recent: Map<string, number>;
};

const feeds = new Map<number, Feed>();

function feedFor(serverId: number): Feed {
    let feed = feeds.get(serverId);
    if (!feed) {
        feed = { partial: '', pending: [], tracker: new CommandOutputTracker(), timer: null, lastIssueId: null, recent: new Map() };
        feeds.set(serverId, feed);
    }
    return feed;
}

interface TerminalIssueState {
    issues: Record<number, TerminalIssue[]>;
}

export const useTerminalIssueStore = create<TerminalIssueState>()(() => ({ issues: {} }));

const EMPTY: TerminalIssue[] = [];

let sequence = 0;
const nextIssueId = () => `${Date.now().toString(36)}-${(sequence += 1)}`;

const summarize = (value: string, maxLength = 180) => {
    const compact = value.replace(/\s+/g, ' ').trim();
    return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength).trimEnd()}...`;
};

function setIssues(serverId: number, update: (issues: TerminalIssue[]) => TerminalIssue[]): void {
    useTerminalIssueStore.setState((state) => {
        const current = state.issues[serverId] ?? EMPTY;
        const next = update(current);
        return next === current ? state : { issues: { ...state.issues, [serverId]: next } };
    });
}

// Classifies the lines collected since the last pass: at most one store
// update per pass, none when nothing new was found.
function classifyPending(serverId: number): void {
    const feed = feeds.get(serverId);
    if (!feed) return;
    feed.timer = null;
    const lines = feed.pending;
    feed.pending = [];

    const added: TerminalIssue[] = [];
    const details = new Map<string, string[]>();
    const now = Date.now();
    for (const raw of lines) {
        // Issues go to the AI chat: secret values typed into the terminal are masked (W7-S4).
        const visible = maskTerminalSecrets(serverId, visibleLine(raw));
        const line = visible.trim();
        if (!line || !feed.tracker.accepts(line)) continue;
        // Indentation tells a stack frame from a line of its own.
        if (isTerminalDetailLine(visible)) {
            if (feed.lastIssueId) details.set(feed.lastIssueId, [...(details.get(feed.lastIssueId) ?? []), summarize(line, 220)]);
            continue;
        }
        const type = classifyTerminalLine(line);
        if (!type) continue;
        const message = summarize(line);
        const key = `${type}:${message.toLowerCase()}`;
        if (now - (feed.recent.get(key) ?? 0) < DUPLICATE_WINDOW_MS) continue;
        feed.recent.set(key, now);
        if (feed.recent.size > 50) feed.recent.delete(feed.recent.keys().next().value as string);
        const issue: TerminalIssue = { id: nextIssueId(), type, message, timestamp: now };
        feed.lastIssueId = issue.id;
        added.push(issue);
    }
    if (!added.length && !details.size) return;

    setIssues(serverId, (issues) => {
        const withDetails = details.size
            ? issues.concat(added).map((issue) => {
                const extra = details.get(issue.id);
                if (!extra) return issue;
                const combined = [issue.details, ...extra].filter(Boolean).slice(0, 4).join('\n');
                return { ...issue, details: combined };
            })
            : issues.concat(added);
        return withDetails.slice(-ISSUE_LIMIT);
    });
}

// Output of the focused terminal of a server, classified in the background.
// (The chat reads terminal output from src/store/terminalOutput.ts.)
export function ingestTerminalOutput(serverId: number, data: string): void {
    const feed = feedFor(serverId);
    const clean = stripAnsi(data);
    const lines = (feed.partial + clean).split('\n');
    feed.partial = (lines.pop() ?? '').slice(-4000);
    if (lines.length) {
        feed.pending.push(...lines);
        if (feed.pending.length > PENDING_LINE_LIMIT) feed.pending = feed.pending.slice(-PENDING_LINE_LIMIT);
        feed.timer ??= setTimeout(() => classifyPending(serverId), CLASSIFY_INTERVAL_MS);
    }
}

// A command was sent to the server's terminal: the output of listing and
// search commands is not classified. Lines already received came before it.
export function noteTerminalCommand(serverId: number, command: string): void {
    const feed = feedFor(serverId);
    if (feed.pending.length) {
        if (feed.timer) clearTimeout(feed.timer);
        classifyPending(serverId);
    }
    feed.tracker.startCommand(command);
}

// The user asked about one specific line (the terminal's inline "!" button):
// it becomes the latest issue, which the chat's fix-it request reads.
export function reportIssueLine(serverId: number, line: string): TerminalIssue {
    const message = summarize(maskTerminalSecrets(serverId, visibleLine(stripAnsi(line))));
    const type = classifyTerminalLine(line) ?? 'error';
    const existing = (useTerminalIssueStore.getState().issues[serverId] ?? EMPTY).find((issue) => issue.message === message);
    const issue = existing ? { ...existing, timestamp: Date.now() } : { id: nextIssueId(), type, message, timestamp: Date.now() };
    feedFor(serverId).lastIssueId = issue.id;
    setIssues(serverId, (issues) => [...issues.filter((item) => item.id !== issue.id), issue].slice(-ISSUE_LIMIT));
    return issue;
}

export function dismissTerminalIssue(serverId: number, issueId: string): void {
    const feed = feeds.get(serverId);
    if (feed?.lastIssueId === issueId) feed.lastIssueId = null;
    setIssues(serverId, (issues) => (issues.some((issue) => issue.id === issueId) ? issues.filter((issue) => issue.id !== issueId) : issues));
}

export function clearTerminalIssues(serverId: number): void {
    const feed = feeds.get(serverId);
    if (feed) feed.lastIssueId = null;
    setIssues(serverId, (issues) => (issues.length ? EMPTY : issues));
}

// Forgets everything kept for a server (pending lines, issues).
export function resetTerminalIssues(serverId: number): void {
    const feed = feeds.get(serverId);
    if (feed?.timer) clearTimeout(feed.timer);
    feeds.delete(serverId);
    useTerminalIssueStore.setState((state) => {
        if (!(serverId in state.issues)) return state;
        const issues = { ...state.issues };
        delete issues[serverId];
        return { issues };
    });
}

// Runs the pending classification now (tests, and before reading issues).
export function flushTerminalIssues(serverId: number): void {
    const feed = feeds.get(serverId);
    if (!feed) return;
    if (feed.timer) clearTimeout(feed.timer);
    classifyPending(serverId);
}

// Everything the app shell wires between a server's terminal and its chat
// (one per open server).
export function useTerminalIssues(serverId: number | undefined) {
    const terminalIssues = useTerminalIssueStore((state) => (serverId == null ? EMPTY : state.issues[serverId] ?? EMPTY));

    const handleTerminalOutput = useCallback((data: string) => {
        if (serverId != null) ingestTerminalOutput(serverId, data);
    }, [serverId]);
    const dismiss = useCallback((issueId: string) => {
        if (serverId != null) dismissTerminalIssue(serverId, issueId);
    }, [serverId]);
    const clear = useCallback(() => {
        if (serverId != null) clearTerminalIssues(serverId);
    }, [serverId]);

    // Closing the server (its chat goes away) drops what was collected for
    // it; a server opened again starts from a clean slate.
    useEffect(() => {
        if (serverId == null) return undefined;
        return () => resetTerminalIssues(serverId);
    }, [serverId]);

    return {
        terminalIssues,
        handleTerminalOutput,
        dismissTerminalIssue: dismiss,
        clearTerminalIssues: clear
    };
}
