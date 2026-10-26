import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '@/store/appStore';
import {
    broadcastKey, fanOutInput, includeAnyway, noteBufferChange, noteCommandSent, noteScreenChange, parseBroadcastKey, previewLine,
    previewTargets, registerReceiver, resetBroadcast, serversOf, setLeader, setMember, setMembers, SETTLE_MS, startBroadcast,
    stopBroadcast, useBroadcast, type FanOut, type ReceiverScreen
} from './broadcast';

// A terminal: its screen as the test sets it (as the remote side draws it;
// all of the cursor's line is the part up to the cursor unless set),
// what was typed into it and how many terminals each line went to.
type FakeScreen = Omit<ReceiverScreen, 'line'> & { line?: string };
type Fake = { key: string; screen: FakeScreen; typed: Array<[string, number]>; marked: number[]; unregister: () => void };
const fakes = new Map<string, Fake>();
// eslint-disable-next-line no-control-regex -- control characters typed into a terminal
const LINE_END = /[\r\x03\x04]/;

function terminal(serverId: number, prompt = 'root@web:~# '): Fake {
    const sessionId = useAppStore.getState().openTerminalSession(serverId);
    useAppStore.getState().setTerminalSessionState(serverId, sessionId, { state: 'connected' });
    const key = broadcastKey(serverId, sessionId);
    const fake: Fake = {
        key,
        screen: { connected: true, alternate: false, cursorLine: prompt, row: 0, bracketedPaste: false, lineStarted: false },
        typed: [],
        marked: [],
        unregister: () => undefined
    };
    fake.unregister = registerReceiver(key, {
        screen: () => ({ ...fake.screen, line: fake.screen.line ?? fake.screen.cursorLine }),
        deliver: (data, size) => {
            fake.typed.push([data, size]);
            keysTyped(fake, data);
        },
        markBroadcast: (size) => fake.marked.push(size)
    });
    fakes.set(key, fake);
    return fake;
}

// Like the command tracker: a line is begun once a key of it was typed.
function keysTyped(fake: Fake, data: string) {
    fake.screen.lineStarted = !LINE_END.test(data);
}

// The user types `data` into `source` (as TerminalSession does: out to the
// others first, then into the terminal itself).
function type(source: Fake, data: string): FanOut | null {
    const result = fanOutInput(source.key, data);
    source.typed.push([data, result?.size ?? 1]);
    keysTyped(source, data);
    return result;
}

// The remote side of `fake` printed `data`, and its screen now looks so.
function print(fake: Fake, data: string, screen: Partial<FakeScreen> = {}) {
    Object.assign(fake.screen, screen);
    noteScreenChange(fake.key, data);
}

const typedInto = (fake: Fake) => fake.typed.map(([data]) => data).join('');

beforeEach(() => {
    vi.useFakeTimers();
    useAppStore.setState(useAppStore.getInitialState(), true);
    resetBroadcast();
    fakes.clear();
});

afterEach(() => {
    for (const fake of fakes.values()) fake.unregister();
    vi.useRealTimers();
});

describe('broadcast input', () => {
    it('keys a terminal of the group well-formed and back', () => {
        expect(parseBroadcastKey(broadcastKey(12, 'term-a-1'))).toEqual({ serverId: 12, sessionId: 'term-a-1' });
        expect(parseBroadcastKey('nope')).toBeNull();
        expect(serversOf(['1:a', '2:b', '1:c'])).toEqual([1, 2]);
    });

    it('types what is typed into one member into every member, and nothing elsewhere', () => {
        const [a, b, c] = [terminal(1), terminal(1), terminal(2)];
        const outsider = terminal(3);
        expect(fanOutInput(a.key, 'l')).toBeNull();
        expect(startBroadcast([a.key])).toBe(false);
        expect(startBroadcast([a.key, b.key, c.key], a.key)).toBe(true);
        expect(useBroadcast.getState()).toMatchObject({ active: true, servers: [1, 2], leader: a.key });

        for (const key of ['l', 's', '\r']) expect(type(a, key)).toMatchObject({ mode: 'open', size: 3 });
        expect(typedInto(b)).toBe('ls\r');
        expect(typedInto(c)).toBe('ls\r');
        // The line was typed into three terminals (the audit says so).
        expect(c.typed.map(([, size]) => size)).toEqual([3, 3, 3]);
        expect(typedInto(outsider)).toBe('');
        // A terminal outside the group types only into itself.
        expect(type(outsider, 'x')).toBeNull();
        expect(typedInto(a)).toBe('ls\r');
    });

    it('never sends a line typed at a password prompt to the others', () => {
        const [a, b] = [terminal(1, '[sudo] password for luis: '), terminal(2)];
        startBroadcast([a.key, b.key], a.key);
        expect(previewTargets(a.key)).toEqual([]);
        expect(type(a, 's')).toMatchObject({ mode: 'local', size: 1 });
        expect(type(a, '3cret\r')).toEqual({ mode: 'local', size: 1, kept: null });
        expect(typedInto(b)).toBe('');
        expect(useBroadcast.getState().paused).toEqual({ [a.key]: 'password' });
    });

    it('never sends what is typed ahead of a password prompt that shows up late, nor runs it where none shows (W8-T1 review)', () => {
        // b needs no password (NOPASSWD): what a would read as a password b would run as a command.
        const [a, b, c] = [terminal(1, 'demo@web-a:~$ '), terminal(2, 'demo@web-b:~$ '), terminal(1, 'demo@web-a:~$ ')];
        startBroadcast([a.key, b.key, c.key], a.key);
        for (const key of 'sudo -k; sudo true') type(a, key);
        type(a, '\r');
        expect(typedInto(b)).toBe('sudo -k; sudo true\r');

        // Typed at once, before a answered the Enter: held back.
        for (const key of 'Secr') expect(type(a, key)).toMatchObject({ mode: 'held', size: 1 });
        expect(previewLine(a.key)).toEqual({ mode: 'held', keys: [] });
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'waiting', [c.key]: 'waiting' });
        // The Enter is echoed, the terminal echoes a typed-ahead key before
        // sudo turns echo off, and sudo takes its time.
        print(a, '\r\n', { row: 1, cursorLine: '' });
        print(a, 'S', { cursorLine: 'S' });
        vi.advanceTimersByTime(SETTLE_MS * 3);
        type(a, '3t');
        print(a, '[sudo] password for demo: ', { cursorLine: 'S[sudo] password for demo: ' });
        expect(type(a, 'PW')).toMatchObject({ mode: 'local' });
        expect(type(a, '\r')).toEqual({ mode: 'local', size: 1, kept: null });
        expect(useBroadcast.getState().paused).toEqual({ [a.key]: 'password' });
        expect(typedInto(b)).toBe('sudo -k; sudo true\r');
        expect(typedInto(c)).toBe('sudo -k; sudo true\r');
        expect(a.marked).toEqual([]);
    });

    it('tells a password prompt by all of its line, where a resize may leave the cursor before its end', () => {
        const [a, b] = [terminal(1), terminal(2)];
        a.screen = { ...a.screen, cursorLine: '[sudo] password for de', line: '[sudo] password for demo:' };
        b.screen = { ...b.screen, cursorLine: '[sudo] password for de', line: '[sudo] password for demo:' };
        startBroadcast([a.key, b.key], a.key);
        expect(useBroadcast.getState().paused).toEqual({ [a.key]: 'password', [b.key]: 'password' });
        expect(type(a, 'hunter2\r')).toMatchObject({ mode: 'local' });
        expect(typedInto(b)).toBe('');
        a.screen = { ...a.screen, cursorLine: 'root@web:~# ', line: 'root@web:~#' };
        print(a, '\r\nroot@web:~# ', { row: 1 });
        type(a, 'ls\r');
        expect(typedInto(b)).toBe('');
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'password' });
    });

    it('keeps taking a password prompt cut by a narrower pane for one, until the line changes', () => {
        const [a, b] = [terminal(1), terminal(2, 'demo@db:~$ ')];
        startBroadcast([a.key, b.key], a.key);
        print(b, '[sudo] password for demo: ', { cursorLine: '[sudo] password for demo: ' });
        // The terminal does not reflow the cursor's line: the end of the prompt is gone.
        b.screen = { ...b.screen, cursorLine: '[sudo] password for de', line: '[sudo] password for de' };
        type(a, 'ls\r');
        expect(typedInto(b)).toBe('');
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'password' });
        print(a, '\r\nroot@web:~# ', { row: 1 });
        // A reading with other text in it does not make the prompt forgotten.
        b.screen = { ...b.screen, line: '[sudo] password for de     etup-alpine' };
        expect(previewTargets(a.key)).toEqual([b.key]);
        b.screen = { ...b.screen, line: '[sudo] password for de' };
        expect(previewTargets(a.key)).toEqual([]);
        type(a, 'pwd\r');
        expect(typedInto(b)).toBe('');
        // Answered: a new line, a new prompt.
        print(b, '\r\ndemo@db:~$ ', { row: 1, cursorLine: 'demo@db:~$ ', line: 'demo@db:~$' });
        print(a, '\r\nroot@web:~# ', { row: 1 });
        type(a, 'w\r');
        expect(typedInto(b)).toBe('w\r');
    });

    it('holds a line started while a command runs, and sends it once the source shows it at its prompt', () => {
        const [a, b] = [terminal(1), terminal(2)];
        startBroadcast([a.key, b.key], a.key);
        type(a, 'sleep 2\r');
        print(a, '\r\n', { row: 1, cursorLine: '' });
        // Long after: a quiet, empty line is still no prompt (a command runs there).
        vi.advanceTimersByTime(5000);
        expect(type(a, 'l')).toMatchObject({ mode: 'held' });
        print(a, 'l', { cursorLine: 'l' });
        type(a, 's');
        print(a, 's', { cursorLine: 'ls' });
        expect(typedInto(b)).toBe('sleep 2\r');
        // The shell is back and reads the typed-ahead keys at its prompt.
        print(a, '\r\nroot@web:~# ls', { row: 2, cursorLine: 'root@web:~# ls', bracketedPaste: true });
        expect(typedInto(b)).toBe('sleep 2\rls');
        expect(a.marked).toEqual([2]);
        expect(b.typed.at(-1)).toEqual(['ls', 2]);
        expect(type(a, '\r')).toMatchObject({ mode: 'open', size: 2 });
        expect(typedInto(b)).toBe('sleep 2\rls\r');
    });

    it('runs a held line that ends before its prompt showed in the source only, and says so', () => {
        const [a, b] = [terminal(1), terminal(2)];
        startBroadcast([a.key, b.key], a.key);
        type(a, 'cd /srv\r');
        type(a, 'ls');
        expect(type(a, '\r')).toEqual({ mode: 'local', size: 1, kept: 'typed-ahead' });
        expect(typedInto(b)).toBe('cd /srv\r');
        // The next line, at the prompt, goes out again.
        print(a, '\r\nroot@web:/srv# ', { row: 1, cursorLine: 'root@web:/srv# ' });
        print(a, 'ls\r\nfile\r\nroot@web:/srv# ', { row: 3, cursorLine: 'root@web:/srv# ' });
        type(a, 'w\r');
        expect(typedInto(b)).toBe('cd /srv\rw\r');
    });

    it('takes a question on screen as one only once the terminal went quiet', () => {
        const [a, b] = [terminal(1), terminal(2)];
        startBroadcast([a.key, b.key], a.key);
        const question = 'Do you want to continue? [Y/n] ';
        print(a, question, { cursorLine: question });
        // Typed while it was still printing: the answer stays in a.
        expect(type(a, 'y')).toMatchObject({ mode: 'held' });
        print(a, 'y', { cursorLine: `${question}y` });
        expect(type(a, '\r')).toEqual({ mode: 'local', size: 1, kept: 'typed-ahead' });
        expect(typedInto(b)).toBe('');

        const next = 'Restart services during package upgrades? [y/N] ';
        print(a, `\r\n${next}`, { row: 1, cursorLine: next });
        vi.advanceTimersByTime(SETTLE_MS);
        expect(type(a, 'y')).toMatchObject({ mode: 'open', size: 2 });
        expect(typedInto(b)).toBe('y');
    });

    it('keeps the rest of a line begun before broadcasting in its terminal', () => {
        const [a, b] = [terminal(1), terminal(2)];
        type(a, 'sudo rebo');
        startBroadcast([a.key, b.key], a.key);
        expect(type(a, 'ot')).toMatchObject({ mode: 'local' });
        expect(type(a, '\r')).toEqual({ mode: 'local', size: 1, kept: 'begun' });
        expect(typedInto(b)).toBe('');
    });

    it('holds lines after a command the app typed until the source answers it', () => {
        const [a, b] = [terminal(1), terminal(2)];
        startBroadcast([a.key, b.key], a.key);
        noteCommandSent(a.key);
        expect(type(a, 'x')).toMatchObject({ mode: 'held' });
    });

    it('skips a terminal at a password prompt for the whole line, and includes it again on the next one', () => {
        const [a, b, c] = [terminal(1), terminal(2, "luis@db's password: "), terminal(3)];
        startBroadcast([a.key, b.key, c.key], a.key);
        type(a, 'u');
        // b's prompt goes meanwhile: it still gets nothing of this line.
        b.screen = { ...b.screen, cursorLine: 'luis@db:~$ ' };
        type(a, 'ptime\r');
        expect(typedInto(b)).toBe('');
        expect(typedInto(c)).toBe('uptime\r');
        print(a, '\r\n 10:00 up 3 days\r\nroot@web:~# ', { row: 2 });
        type(a, 'w\r');
        expect(typedInto(b)).toBe('w\r');
        expect(useBroadcast.getState().paused).toEqual({});
    });

    it('keeps keys for a shell out of a full-screen program, and the other way round, unless included anyway', () => {
        const [a, b, c] = [terminal(1), terminal(2), terminal(3)];
        b.screen = { ...b.screen, alternate: true };
        startBroadcast([a.key, b.key, c.key], a.key);
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'full-screen' });
        type(a, 'dd');
        expect(typedInto(b)).toBe('');

        // All in vi: the keys go to every vi, checked on every key.
        a.screen = { ...a.screen, alternate: true };
        c.screen = { ...c.screen, alternate: true };
        type(a, ':');
        expect(typedInto(b)).toBe(':');
        c.screen = { ...c.screen, alternate: false };
        type(a, 'q');
        expect(typedInto(c)).toBe('dd:');
        expect(useBroadcast.getState().paused).toEqual({ [c.key]: 'not-full-screen' });

        includeAnyway(c.key);
        type(a, '!');
        expect(typedInto(c)).toBe('dd:!');
    });

    it('lets "type anyway" hold only while the screens stay as they were (W8-T1 review)', () => {
        const [a, b] = [terminal(1), terminal(2)];
        b.screen = { ...b.screen, alternate: true };
        startBroadcast([a.key, b.key], a.key);
        includeAnyway(b.key);
        type(a, 'j');
        type(a, '\x03');
        expect(typedInto(b)).toBe('j\x03');
        print(a, '^C\r\nroot@web:~# ', { row: 1 });

        // b leaves its program and starts another one: asked again.
        b.screen = { ...b.screen, alternate: false };
        noteBufferChange(b.key);
        b.screen = { ...b.screen, alternate: true };
        noteBufferChange(b.key);
        type(a, 'k');
        expect(typedInto(b)).toBe('j\x03');
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'full-screen' });
        type(a, '\x03');
        print(a, '^C\r\nroot@web:~# ', { row: 2 });

        // Given again, then the source starts a full-screen program too and leaves it.
        includeAnyway(b.key);
        expect(previewTargets(a.key)).toEqual([b.key]);
        a.screen = { ...a.screen, alternate: true };
        noteBufferChange(a.key);
        a.screen = { ...a.screen, alternate: false };
        noteBufferChange(a.key);
        type(a, 'm');
        expect(typedInto(b)).toBe('j\x03');
    });

    it('types the rest of a line into a terminal included anyway, a new member from the next line on, and none into one taken out', () => {
        const [a, b, c, d] = [terminal(1), terminal(1), terminal(1), terminal(1)];
        b.screen = { ...b.screen, alternate: true };
        startBroadcast([a.key, b.key, c.key], a.key);
        type(a, 'ab');
        includeAnyway(b.key);
        setMember(d.key, true);
        setMember(c.key, false);
        type(a, 'cd');
        expect(typedInto(b)).toBe('cd');
        expect(typedInto(c)).toBe('ab');
        expect(typedInto(d)).toBe('');
        type(a, '\r');
        print(a, '\r\nroot@web:~# ', { row: 1 });
        type(a, 'x');
        expect(typedInto(d)).toBe('x');
    });

    it('skips terminals whose session is not live', () => {
        const [a, b] = [terminal(1), terminal(2)];
        b.screen = { ...b.screen, connected: false };
        startBroadcast([a.key, b.key], a.key);
        type(a, 'x');
        expect(typedInto(b)).toBe('');
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'offline' });
        type(a, '\x03');
        print(a, '^C\r\nroot@web:~# ', { row: 1 });
        expect(previewTargets(a.key)).toEqual([]);
        b.screen = { ...b.screen, connected: true };
        expect(previewTargets(a.key)).toEqual([b.key]);
    });

    it('stops when a member tab closes or its session ends, and keeps the rest of the group', () => {
        const [a, b, c] = [terminal(1), terminal(1), terminal(2)];
        startBroadcast([a.key, b.key, c.key], a.key);
        const closed = parseBroadcastKey(c.key)!;
        useAppStore.getState().closeTerminalSession(closed.serverId, closed.sessionId);
        expect(useBroadcast.getState()).toMatchObject({ active: false, members: [a.key, b.key], stopped: { reason: 'closed', serverId: 2 } });
        expect(useBroadcast.getState().stopped?.session?.id).toBe(closed.sessionId);
        expect(type(a, 'x')).toBeNull();

        startBroadcast(useBroadcast.getState().members, a.key);
        const ended = parseBroadcastKey(b.key)!;
        useAppStore.getState().setTerminalSessionState(ended.serverId, ended.sessionId, { state: 'disconnected' });
        expect(useBroadcast.getState()).toMatchObject({ active: false, members: [a.key, b.key], stopped: { reason: 'ended' } });
    });

    it('stops when fewer than two members are left, and starts again with the same group', () => {
        const [a, b, c] = [terminal(1), terminal(1), terminal(1)];
        startBroadcast([a.key, b.key, c.key]);
        setMember(c.key, false);
        expect(useBroadcast.getState().active).toBe(true);
        setMember(b.key, false);
        expect(useBroadcast.getState()).toMatchObject({ active: false, members: [a.key], stopped: { reason: 'too-few' } });
        setMember(b.key, true);
        expect(startBroadcast(useBroadcast.getState().members)).toBe(true);
        stopBroadcast();
        expect(useBroadcast.getState()).toMatchObject({ active: false, stopped: null, members: [a.key, b.key] });
    });

    it('adds several terminals at once, and their servers to the agreed ones', () => {
        const [a, b, c, d] = [terminal(1), terminal(1), terminal(4), terminal(4)];
        startBroadcast([a.key, b.key]);
        setMembers([c.key, d.key, c.key, a.key], true);
        expect(useBroadcast.getState()).toMatchObject({ members: [a.key, b.key, c.key, d.key], servers: [1, 4] });
        setMembers([c.key, d.key], false);
        expect(useBroadcast.getState().members).toEqual([a.key, b.key]);
    });

    it('compares the screens with the focused member and refreshes the paused states after output', () => {
        const [a, b] = [terminal(1), terminal(2)];
        startBroadcast([a.key, b.key], a.key);
        b.screen = { ...b.screen, cursorLine: 'Password: ' };
        noteScreenChange(b.key);
        expect(useBroadcast.getState().paused).toEqual({});
        vi.advanceTimersByTime(300);
        expect(useBroadcast.getState().paused).toEqual({ [b.key]: 'password' });
        setLeader(b.key);
        expect(useBroadcast.getState()).toMatchObject({ leader: b.key, paused: { [b.key]: 'password' } });
    });
});
