// Broadcast input: keys typed into one terminal of a group of terminal tabs
// (of one server or of several open ones) are typed into the others too.
//
// What is typed is decided per line (from its first key to Enter, Ctrl+C or
// Ctrl+D) by what the terminal typed into, the source, shows when it starts:
//   local   it asks for a password (commandTracker.ts isSecretPrompt), or the
//           line was begun before (broadcasting started, or the focus moved,
//           halfway through it): the line stays in the source;
//   open    a shell or a tool reads a line there (a prompt at the cursor), or
//           a program waits with its question on screen: the others get the
//           keys as they are typed;
//   held    the source has not answered yet (an Enter it got has not been
//           echoed, or it is still printing), or a command runs there: the
//           keys go to the source only, and to the others once the source
//           shows them typed at a prompt. A password prompt that shows up
//           meanwhile, or the line ending first, keeps it in the source: what
//           is typed ahead of a prompt is never sent elsewhere.
// Each other terminal, per line: one at a password prompt or offline gets
// none of it; a full-screen program (vi, top) gets keys only from a terminal
// that runs one too, and a shell only from a shell, unless the user includes
// that terminal anyway (until its screen or the source's changes). In a
// full-screen program this is re-checked on every key. A terminal skipped
// for a line gets none of it, so no half line is left in it.
// Broadcasting stops when a terminal of the group closes or its session
// ends. Commands the app types (AI chat, snippets) never take part: they go
// to the focused terminal only, as always.
import { create } from 'zustand';
import { cursorPromptShell, matchPrompt } from '@shared/shells';
import { useAppStore, type ServerTerminalSessions, type TerminalSessionInfo } from '@/store/appStore';
import { isSecretPrompt } from './commandTracker';

export const broadcastKey = (serverId: number, sessionId: string): string => `${serverId}:${sessionId}`;

export function parseBroadcastKey(key: string): { serverId: number; sessionId: string } | null {
    const index = key.indexOf(':');
    const serverId = Number(key.slice(0, index));
    return index > 0 && Number.isSafeInteger(serverId) ? { serverId, sessionId: key.slice(index + 1) } : null;
}

export type ReceiverScreen = {
    // The session reads input now.
    connected: boolean;
    // A full-screen program holds the terminal.
    alternate: boolean;
    // The line the cursor is on, up to the cursor; and to the end of the
    // cursor's row (a password prompt is told from this one: a resize may
    // leave the cursor before its end).
    cursorLine: string;
    line: string;
    // The cursor's row in the buffer, scrollback included.
    row: number;
    // A line editor turned bracketed paste on (bash, zsh and fish do while
    // they read a line, and turn it off while a command runs).
    bracketedPaste: boolean;
    // Keys of the line the cursor is on were typed already.
    lineStarted: boolean;
};

// A terminal tab as broadcasting sees it (registered by TerminalSession).
export type BroadcastReceiver = {
    screen: () => ReceiverScreen;
    // Types `data` as if the user had typed it there; the line it belongs to
    // was typed into `size` terminals (for the audit log).
    deliver: (data: string, size: number) => void;
    // The line being typed into it, held so far, went to `size` terminals.
    markBroadcast: (size: number) => void;
};

export type PauseReason = 'offline' | 'password' | 'full-screen' | 'not-full-screen' | 'waiting';
export type StopReason = 'closed' | 'ended' | 'too-few';
export type LineMode = 'open' | 'held' | 'local';
// Why a line typed into the source stayed there.
export type KeptReason = 'typed-ahead' | 'begun';

export type BroadcastState = {
    active: boolean;
    // The terminals of the group, in the order they were picked.
    members: string[];
    // The servers the user agreed to type into at once (more than one is
    // asked about first).
    servers: number[];
    // Members that do not get the current line, and why.
    paused: Record<string, PauseReason>;
    // The member typed into last (or focused last): the screens of the
    // others are compared with its own.
    leader: string | null;
    // Why broadcasting stopped by itself, last time, and when (`session`:
    // the tab that closed or ended).
    stopped: { id: number; at: number; reason: StopReason; serverId: number | null; session: TerminalSessionInfo | null } | null;
};

const INITIAL: BroadcastState = { active: false, members: [], servers: [], paused: {}, leader: null, stopped: null };

export const useBroadcast = create<BroadcastState>()(() => INITIAL);

const receivers = new Map<string, BroadcastReceiver>();

// While its terminal is mounted; returns the unregistration.
export function registerReceiver(key: string, receiver: BroadcastReceiver): () => void {
    receivers.set(key, receiver);
    return () => {
        if (receivers.get(key) !== receiver) return;
        receivers.delete(key);
        for (const memory of [lastOutput, unanswered, prompts, overrides]) memory.delete(key);
    };
}

export function serversOf(keys: readonly string[]): number[] {
    const servers: number[] = [];
    for (const key of keys) {
        const serverId = parseBroadcastKey(key)?.serverId;
        if (serverId !== undefined && !servers.includes(serverId)) servers.push(serverId);
    }
    return servers;
}

// Enter, Ctrl+C, Ctrl+D: the line is over.
// eslint-disable-next-line no-control-regex -- control characters typed into a terminal
const LINE_END = /[\r\x03\x04]/;
// A terminal that printed less than this long ago may not have shown what
// it asks for yet.
export const SETTLE_MS = 300;

// The line being typed.
type Line = {
    source: string;
    mode: LineMode;
    // Open: the terminals that get it (decided when it opens).
    targets: string[];
    // Held: the keys the others get once it is released.
    held: string;
    // The text typed (printable keys, Backspace applied), and whether other
    // keys changed the line in ways only the screen shows (arrows, Tab, a
    // paste): then its echo cannot be recognised.
    typed: string;
    edited: boolean;
    // Local: why (a password prompt, or the line was begun before).
    reason: 'password' | 'begun' | 'typed-ahead' | null;
};
let line: Line | null = null;

// When each terminal printed last; an Enter it got whose echo has not come
// yet (until then its screen still shows the line before): the row and the
// line the cursor was on, and whether it printed anything since.
const lastOutput = new Map<string, number>();
const unanswered = new Map<string, { row: number; text: string; printed: boolean }>();

// "Type anyway": the member gets keys across a full-screen program for as
// long as its screen and the source's stay as they were then.
type Override = { alternate: boolean; source: string; sourceAlternate: boolean };
const overrides = new Map<string, Override>();

let stopSequence = 0;

function screenOf(key: string): ReceiverScreen | null {
    return receivers.get(key)?.screen() ?? null;
}

// The password prompt each terminal showed last, until it prints a new
// line. The terminal does not reflow the cursor's line on a resize: a
// narrower pane cuts the prompt ("[sudo] password for de"), which is still
// that prompt.
const prompts = new Map<string, string>();

function asksPassword(key: string, screen: ReceiverScreen): boolean {
    if (screen.alternate) return false;
    const text = screen.line.trimEnd();
    if (isSecretPrompt(screen.line)) {
        prompts.set(key, text);
        return true;
    }
    const seen = prompts.get(key);
    return Boolean(seen && text && seen.startsWith(text));
}

// A shell's or a tool's prompt with nothing typed after it.
function atPrompt(text: string): boolean {
    const match = matchPrompt(text.trim());
    return match ? match.command === '' : cursorPromptShell(text) !== null;
}

// Answered: the cursor moved past the line of the Enter, or (a terminal
// that redraws rather than scrolls) that line was replaced since; an echo
// that comes late only extends it.
function awaitingAnswer(key: string, screen: ReceiverScreen): boolean {
    const enter = unanswered.get(key);
    if (!enter) return false;
    if (screen.row <= enter.row && !(enter.printed && !screen.cursorLine.startsWith(enter.text))) return true;
    unanswered.delete(key);
    return false;
}

// `data` was typed into `key` (by the user, by broadcasting or by the app).
function noteSent(key: string, data: string, screen = screenOf(key)): void {
    if (LINE_END.test(data) && screen && !screen.alternate) unanswered.set(key, { row: screen.row, text: screen.cursorLine, printed: false });
}

// The app typed a command (with its Enter) into the terminal.
export function noteCommandSent(key: string): void {
    noteSent(key, '\r');
}

function samePaused(a: Record<string, PauseReason>, b: Record<string, PauseReason>): boolean {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function overrideHolds(key: string, screen: ReceiverScreen, source: string, from: ReceiverScreen): boolean {
    const override = overrides.get(key);
    return Boolean(override && override.alternate === screen.alternate && override.source === source && override.sourceAlternate === from.alternate);
}

// Which other members would get a line typed into `source` now, and which
// would not (why).
function evaluateTargets(source: string): { targets: string[]; paused: Record<string, PauseReason> } {
    const { members } = useBroadcast.getState();
    const from = screenOf(source);
    const paused: Record<string, PauseReason> = {};
    const targets: string[] = [];
    for (const key of members) {
        if (key === source) continue;
        const screen = screenOf(key);
        let reason: PauseReason | null = null;
        if (!screen?.connected) reason = 'offline';
        else if (asksPassword(key, screen)) reason = 'password';
        else if (from && screen.alternate !== from.alternate && !overrideHolds(key, screen, source, from)) {
            reason = screen.alternate ? 'full-screen' : 'not-full-screen';
        }
        if (reason) paused[key] = reason;
        else targets.push(key);
    }
    return { targets, paused };
}

// How a line typed into `source` now starts (see the top of this file).
function startMode(source: string, screen: ReceiverScreen): { mode: LineMode; reason: Line['reason'] } {
    if (asksPassword(source, screen)) return { mode: 'local', reason: 'password' };
    if (screen.lineStarted) return { mode: 'local', reason: 'begun' };
    if (awaitingAnswer(source, screen)) return { mode: 'held', reason: null };
    if (atPrompt(screen.cursorLine)) return { mode: 'open', reason: null };
    const quiet = Date.now() - (lastOutput.get(source) ?? 0) >= SETTLE_MS;
    if (quiet && (screen.bracketedPaste || screen.cursorLine.trim() !== '')) return { mode: 'open', reason: null };
    return { mode: 'held', reason: null };
}

// What the members show while a line is typed into `source` (or would be).
function pausedFor(source: string): Record<string, PauseReason> {
    const { targets, paused } = evaluateTargets(source);
    const current = line?.source === source ? line : null;
    const screen = screenOf(source);
    const asks = current
        ? current.mode === 'local' && current.reason === 'password'
        : Boolean(screen && asksPassword(source, screen));
    if (asks) {
        // The answer to the source's own password prompt goes nowhere else.
        paused[source] = 'password';
    } else if (current?.mode === 'open') {
        // The terminals that got the start of the line get all of it.
        for (const key of current.targets) delete paused[key];
        for (const key of targets) if (!current.targets.includes(key)) paused[key] = 'waiting';
    } else if (current) {
        // Held, or kept in the source: the others wait.
        for (const key of targets) paused[key] = 'waiting';
    }
    return paused;
}

function showPaused(source: string | null): void {
    const state = useBroadcast.getState();
    const paused = source ? pausedFor(source) : {};
    if (samePaused(state.paused, paused) && state.leader === source) return;
    useBroadcast.setState({ paused, leader: source });
}

function deliver(keys: readonly string[], data: string, size: number): void {
    for (const key of keys) {
        receivers.get(key)?.deliver(data, size);
        noteSent(key, data);
    }
}

const connectedOf = (keys: readonly string[]) => keys.filter((key) => screenOf(key)?.connected);

function startLine(source: string, screen: ReceiverScreen): Line {
    const { mode, reason } = startMode(source, screen);
    const next: Line = { source, mode, targets: [], held: '', typed: '', edited: false, reason };
    if (mode === 'open') next.targets = evaluateTargets(source).targets;
    line = next;
    showPaused(source);
    return next;
}

// Printable keys build the text; Backspace takes one back; any other key
// changes the line in a way only the screen shows.
function trackTyped(current: Line, data: string): void {
    // eslint-disable-next-line no-control-regex -- control characters typed into a terminal
    if (data.startsWith('\x1b') || /[\x00-\x07\x09-\x0c\x0e-\x1f]/.test(data.replace(LINE_END, ''))) {
        current.edited = true;
        return;
    }
    for (const ch of data) {
        if (ch === '\x7f' || ch === '\b') current.typed = current.typed.slice(0, -1);
        else if (ch >= ' ') current.typed += ch;
    }
}

// The source shows the held line typed at a prompt: a shell (or a tool)
// reads it, so the others may get it.
function echoedAtPrompt(screen: ReceiverScreen, typed: string): boolean {
    const text = screen.cursorLine;
    if (!typed.trim() || !text.endsWith(typed)) return false;
    const prompt = text.slice(0, text.length - typed.length);
    return atPrompt(prompt) || (screen.bracketedPaste && !isSecretPrompt(prompt));
}

function release(current: Line): void {
    const keys = connectedOf(evaluateTargets(current.source).targets);
    current.mode = 'open';
    current.targets = keys;
    const size = keys.length + 1;
    if (keys.length && current.held) {
        receivers.get(current.source)?.markBroadcast(size);
        deliver(keys, current.held, size);
    }
    current.held = '';
}

// The source printed something: a held line may go to the others now, or
// stay in the source for good (a password prompt showed up); a password
// prompt that shows up in the middle of an open line keeps the rest of it
// in the source.
function checkLine(): void {
    const current = line;
    if (!current) return;
    const screen = screenOf(current.source);
    if (!screen) return;
    const asks = asksPassword(current.source, screen);
    if (current.mode === 'held') {
        if (asks || screen.alternate) {
            current.mode = 'local';
            current.reason = asks ? 'password' : 'typed-ahead';
            current.held = '';
        } else if (!current.edited && !awaitingAnswer(current.source, screen) && echoedAtPrompt(screen, current.typed)) {
            release(current);
        } else {
            return;
        }
        showPaused(current.source);
    } else if (current.mode === 'open' && asks && !(current.typed.trim() && screen.line.trimEnd().endsWith(current.typed.trimEnd()))) {
        current.mode = 'local';
        current.reason = 'password';
        current.targets = [];
        showPaused(current.source);
    }
}

export type FanOut = {
    mode: LineMode;
    // How many terminals the line went to so far, `source` included.
    size: number;
    // The line, held so far, stays in `source`: say so (null: nothing to say).
    kept: KeptReason | null;
};

// Keys typed into `source`: they go to the other members as its line
// decides (see the top of this file). Returns null when `source` does not
// broadcast now; either way the caller types them into `source` itself.
export function fanOutInput(source: string, data: string): FanOut | null {
    const state = useBroadcast.getState();
    const screen = screenOf(source);
    if (!state.active || !state.members.includes(source) || !screen) {
        if (line?.source === source) line = null;
        noteSent(source, data, screen);
        return null;
    }
    let result: FanOut;
    if (screen.alternate) {
        // Keys of a full-screen program: who gets them is checked on every key.
        line = null;
        const keys = connectedOf(evaluateTargets(source).targets);
        showPaused(source);
        deliver(keys, data, keys.length + 1);
        result = { mode: 'open', size: keys.length + 1, kept: null };
    } else {
        const current = line?.source === source ? line : startLine(source, screen);
        trackTyped(current, data);
        const ends = LINE_END.test(data);
        if (current.mode === 'open') {
            const keys = connectedOf(current.targets);
            deliver(keys, data, keys.length + 1);
            result = { mode: 'open', size: keys.length + 1, kept: null };
        } else if (current.mode === 'held' && !ends) {
            current.held += data;
            result = { mode: 'held', size: 1, kept: null };
        } else {
            // A held line that ends before the source showed it at a prompt
            // ran there only (typed ahead); the others got none of it.
            const typedAhead = current.mode === 'held' && data.includes('\r') && Boolean(current.held + data.slice(0, data.indexOf('\r')));
            const begun = current.reason === 'begun' && data.includes('\r');
            result = { mode: 'local', size: 1, kept: typedAhead ? 'typed-ahead' : begun ? 'begun' : null };
            current.mode = 'local';
            current.held = '';
        }
        if (ends) {
            line = null;
            showPaused(source);
        }
    }
    noteSent(source, data, screen);
    return result;
}

export type LinePreview = { mode: LineMode; keys: string[] };

// Where keys typed into `source` now would go (for the confirmations of a
// paste and of Enter on a destructive command): null when it does not
// broadcast.
export function previewLine(source: string): LinePreview | null {
    const state = useBroadcast.getState();
    const screen = screenOf(source);
    if (!state.active || !state.members.includes(source) || !screen) return null;
    if (screen.alternate) return { mode: 'open', keys: connectedOf(evaluateTargets(source).targets) };
    if (line?.source === source) return { mode: line.mode, keys: line.mode === 'open' ? connectedOf(line.targets) : [] };
    const { mode } = startMode(source, screen);
    return { mode, keys: mode === 'open' ? connectedOf(evaluateTargets(source).targets) : [] };
}

// The members a line typed into `source` would reach now.
export function previewTargets(source: string): string[] {
    const preview = previewLine(source);
    return preview?.mode === 'open' ? preview.keys : [];
}

// Recomputes which members are paused, from the leader's point of view.
function refreshPaused(): void {
    const { active, leader, members } = useBroadcast.getState();
    if (!active) return;
    showPaused(leader && members.includes(leader) ? leader : members[0] ?? null);
}

const REFRESH_MS = 250;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

// A terminal printed `data`: its Enter may be answered, a held line may go
// out, and the paused states of the members are brought up to date shortly.
export function noteScreenChange(key: string, data = ''): void {
    lastOutput.set(key, Date.now());
    const enter = unanswered.get(key);
    if (enter) enter.printed = true;
    if (data.includes('\n')) {
        unanswered.delete(key);
        prompts.delete(key);
    }
    // A password prompt is seen whole before a resize can cut it.
    const screen = screenOf(key);
    if (screen) asksPassword(key, screen);
    if (line?.source === key) checkLine();
    const { active, members } = useBroadcast.getState();
    if (!active || refreshTimer || !members.includes(key)) return;
    refreshTimer = setTimeout(() => {
        refreshTimer = null;
        refreshPaused();
    }, REFRESH_MS);
}

// A full-screen program started or ended in the terminal: a "type anyway"
// given for it (or for the terminals compared with it) no longer holds.
export function noteBufferChange(key: string): void {
    let changed = false;
    for (const [member, override] of overrides) {
        if (member === key || override.source === key) changed = overrides.delete(member) || changed;
    }
    if (changed) refreshPaused();
}

// The focused terminal is the one the others are compared with.
export function setLeader(key: string): void {
    const { active, members, leader } = useBroadcast.getState();
    if (!active || leader === key || !members.includes(key)) return;
    line = null;
    showPaused(key);
}

// Adds terminals to the group or takes them out. While broadcasting, the
// caller has asked first when they add another server (see serversOf);
// fewer than two members left stops it. One added gets keys from the next
// line on; one taken out gets no more of the line being typed.
export function setMembers(keys: readonly string[], member: boolean): void {
    const state = useBroadcast.getState();
    const members = member
        ? [...state.members, ...keys.filter((key, index) => !state.members.includes(key) && keys.indexOf(key) === index)]
        : state.members.filter((item) => !keys.includes(item));
    if (members.length === state.members.length) return;
    if (line && !member) {
        if (keys.includes(line.source)) line = null;
        else line.targets = line.targets.filter((key) => !keys.includes(key));
    }
    for (const key of keys) overrides.delete(key);
    const servers = member && state.active ? [...new Set([...state.servers, ...serversOf(keys)])] : state.servers;
    useBroadcast.setState({ members, servers });
    if (state.active && members.length < 2) stopBroadcast('too-few');
    else refreshPaused();
}

export function setMember(key: string, member: boolean): void {
    setMembers([key], member);
}

// Starts broadcasting to `members` (at least two; the caller has asked
// first when they are on more than one server). `leader`: the terminal the
// user is in.
export function startBroadcast(members: readonly string[], leader: string | null = null): boolean {
    const unique = [...new Set(members)];
    if (unique.length < 2) return false;
    line = null;
    overrides.clear();
    useBroadcast.setState({
        active: true,
        members: unique,
        servers: serversOf(unique),
        paused: {},
        leader: leader && unique.includes(leader) ? leader : unique[0],
        stopped: null
    });
    refreshPaused();
    return true;
}

// The group is kept, so the toggle starts it again.
export function stopBroadcast(reason?: StopReason, cause?: { serverId: number; session: TerminalSessionInfo }): void {
    line = null;
    overrides.clear();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    const state = useBroadcast.getState();
    if (!state.active) return;
    useBroadcast.setState({
        active: false,
        paused: {},
        stopped: reason
            ? { id: (stopSequence += 1), at: Date.now(), reason, serverId: cause?.serverId ?? null, session: cause?.session ?? null }
            : null
    });
}

// A member running a full-screen program (or not running one, while the
// leader does) gets the keys anyway, from the next key on (a full-screen
// program has no lines to cut in half), until its screen or the leader's
// changes (noteBufferChange).
export function includeAnyway(key: string): void {
    const state = useBroadcast.getState();
    const source = state.leader;
    const screen = screenOf(key);
    const from = source ? screenOf(source) : null;
    if (!state.active || !source || !screen || !from || key === source || !state.members.includes(key)) return;
    overrides.set(key, { alternate: screen.alternate, source, sourceAlternate: from.alternate });
    if (line?.source === source && line.mode === 'open' && !line.targets.includes(key)) line.targets.push(key);
    refreshPaused();
}

export function resetBroadcast(): void {
    line = null;
    overrides.clear();
    lastOutput.clear();
    unanswered.clear();
    prompts.clear();
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = null;
    useBroadcast.setState(INITIAL, true);
}

const findSession = (sessions: Record<number, ServerTerminalSessions>, key: string) => {
    const parsed = parseBroadcastKey(key);
    const session = parsed ? sessions[parsed.serverId]?.sessions.find((item) => item.id === parsed.sessionId) : undefined;
    return parsed && session ? { serverId: parsed.serverId, session } : null;
};

// A member tab that closed leaves the group; one that closed or whose
// session ended stops broadcasting (the terminals are out of step now).
useAppStore.subscribe((state, previous) => {
    if (state.terminalSessions === previous.terminalSessions) return;
    const { members, active } = useBroadcast.getState();
    if (!members.length) return;
    let closed: { serverId: number; session: TerminalSessionInfo } | null = null;
    let ended: { serverId: number; session: TerminalSessionInfo } | null = null;
    const remaining: string[] = [];
    for (const key of members) {
        const now = findSession(state.terminalSessions, key);
        const before = findSession(previous.terminalSessions, key);
        if (!now) {
            closed ??= before;
            continue;
        }
        remaining.push(key);
        const down = now.session.state === 'disconnected' || now.session.state === 'error';
        if (down && before && before.session.state !== now.session.state) ended ??= now;
    }
    if (remaining.length !== members.length) {
        line = null;
        useBroadcast.setState({ members: remaining });
    }
    if (!active) return;
    if (closed) stopBroadcast('closed', closed);
    else if (ended) stopBroadcast('ended', ended);
    else if (remaining.length < 2) stopBroadcast('too-few');
});
