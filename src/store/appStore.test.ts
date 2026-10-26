import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QUEUED_COMMAND_TTL_MS, collectUnsavedWork, useAppStore } from './appStore';

const store = () => useAppStore.getState();

beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
});

describe('pending terminal commands', () => {
    it('queues per server and hands them out in order exactly once', () => {
        store().queueCommand(1, 'df -h', 'ai');
        store().queueCommand(2, 'uptime', 'ai');
        store().queueCommand(1, 'free -m', 'ai');

        expect(store().takeCommands(1).map((entry) => entry.command)).toEqual(['df -h', 'free -m']);
        expect(store().takeCommands(1)).toEqual([]);
        expect(store().pendingCommands[2]).toHaveLength(1);
    });

    it('keeps commands until the terminal takes or the user discards them', () => {
        store().queueCommand(3, 'ls', 'ai');
        expect(store().pendingCommands[3]).toHaveLength(1);

        store().discardCommands(3);

        expect(store().pendingCommands[3]).toBeUndefined();
    });

    it('gives every queued command its own id', () => {
        store().queueCommand(1, 'ls', 'ai');
        store().queueCommand(1, 'ls', 'ai');
        const [first, second] = store().takeCommands(1);
        expect(first.id).not.toBe(second.id);
    });

    it('never hands out a command older than the time to live, and expires it', () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(1_000_000);
            store().queueCommand(1, 'systemctl restart nginx', 'snippet');
            vi.setSystemTime(1_000_000 + QUEUED_COMMAND_TTL_MS - 1);
            store().queueCommand(1, 'uptime', 'ai');
            store().queueCommand(2, 'df -h', 'ai');

            // Taken late: only the fresh one runs, the stale one is gone too.
            vi.setSystemTime(1_000_000 + QUEUED_COMMAND_TTL_MS);
            expect(store().takeCommands(1).map((entry) => entry.command)).toEqual(['uptime']);
            expect(store().pendingCommands[1]).toBeUndefined();

            // The sweep drops them without anyone taking them, and says which.
            vi.setSystemTime(1_000_000 + 2 * QUEUED_COMMAND_TTL_MS);
            store().queueCommand(3, 'ls', 'ai');
            const expired = store().expireCommands();
            expect(Object.keys(expired)).toEqual(['2']);
            expect(expired[2].map((entry) => entry.command)).toEqual(['df -h']);
            expect(store().pendingCommands).toEqual({ 3: [expect.objectContaining({ command: 'ls' })] });
            expect(store().expireCommands()).toEqual({});
        } finally {
            vi.useRealTimers();
        }
    });

    it('reports what it discards', () => {
        store().queueCommand(4, 'reboot', 'ai');
        expect(store().discardCommands(4).map((entry) => entry.command)).toEqual(['reboot']);
        expect(store().discardCommands(4)).toEqual([]);
    });
});

describe('open servers', () => {
    it('opens servers most recently used first and closes them, showing the next one', () => {
        store().activateServer(1);
        store().activateServer(2);
        store().activateServer(3);
        store().activateServer(1);
        expect(store().openServerIds).toEqual([1, 3, 2]);
        expect(store().activeServerId).toBe(1);

        store().queueCommand(1, 'df -h', 'ai');
        store().requestChat({ serverId: 1, kind: 'fix-issue' });
        expect(store().closeServer(1).map((entry) => entry.command)).toEqual(['df -h']);
        expect(store().openServerIds).toEqual([3, 2]);
        expect(store().activeServerId).toBe(3);
        expect(store().pendingCommands[1]).toBeUndefined();
        expect(store().chatRequest).toBeNull();

        // A background one closes without changing the screen.
        store().closeServer(2);
        expect(store().activeServerId).toBe(3);
        expect(store().openServerIds).toEqual([3]);
        store().forgetServer(3);
        expect(store().openServerIds).toEqual([]);
    });

    it('asks the registered guards what closing a server would lose', () => {
        const editor = store().registerUnsavedGuard(1, () => 'Unsaved changes to /etc/hosts');
        const transfers = store().registerUnsavedGuard(1, () => null);
        store().registerUnsavedGuard(1, () => {
            throw new Error('broken guard');
        });
        store().registerUnsavedGuard(2, () => '2 transfers in progress');

        expect(collectUnsavedWork(1)).toEqual(['Unsaved changes to /etc/hosts']);
        editor();
        transfers();
        expect(collectUnsavedWork(1)).toEqual([]);
        store().forgetServer(2);
        expect(collectUnsavedWork(2)).toEqual([]);
        store().forgetServer(1);
    });
});

describe('chat requests', () => {
    it('opens the chat panel and is consumed only once', () => {
        store().setChatOpen(false);
        store().requestChat({ serverId: 5, kind: 'prompt', prompt: 'Analyze this' });

        const request = store().chatRequest;
        expect(store().chatOpen).toBe(true);
        expect(request).toMatchObject({ serverId: 5, kind: 'prompt', prompt: 'Analyze this' });

        expect(store().consumeChatRequest(request!.id)).toBe(true);
        expect(store().consumeChatRequest(request!.id)).toBe(false);
        expect(store().chatRequest).toBeNull();
    });

    it('does not consume a request that was replaced by a newer one', () => {
        store().requestChat({ serverId: 5, kind: 'prompt', prompt: 'first' });
        const first = store().chatRequest!;
        store().requestChat({ serverId: 5, kind: 'fix-issue' });

        expect(store().consumeChatRequest(first.id)).toBe(false);
        expect(store().chatRequest?.kind).toBe('fix-issue');
    });

    it('carries what an Ask AI button is about', () => {
        store().setChatOpen(false);
        store().requestChat({ serverId: 5, kind: 'context', attachment: { kind: 'service', name: 'nginx.service' }, prompt: 'Why?' });
        expect(store().chatOpen).toBe(true);
        expect(store().chatRequest).toMatchObject({ serverId: 5, kind: 'context', attachment: { kind: 'service', name: 'nginx.service' }, prompt: 'Why?' });
    });
});

describe('server tab requests', () => {
    it('is consumed once, and a newer request replaces one not yet handled', () => {
        store().requestServerTab(3, 'status');
        const first = store().serverTabRequest!;
        expect(first).toMatchObject({ serverId: 3, tabId: 'status' });
        store().requestServerTab(4, 'operations');

        expect(store().consumeServerTabRequest(first.id)).toBe(false);
        const second = store().serverTabRequest!;
        expect(second).toMatchObject({ serverId: 4, tabId: 'operations' });
        expect(store().consumeServerTabRequest(second.id)).toBe(true);
        expect(store().consumeServerTabRequest(second.id)).toBe(false);
        expect(store().serverTabRequest).toBeNull();
    });

    it('drops the request of a deleted server', () => {
        store().requestServerTab(3, 'status');
        store().forgetServer(4);
        expect(store().serverTabRequest).not.toBeNull();
        store().forgetServer(3);
        expect(store().serverTabRequest).toBeNull();
    });
});

describe('connections', () => {
    it('tracks the reported state per server', () => {
        store().setConnection(1, { state: 'connected' });
        store().setConnection(2, { state: 'error', error: 'Auth failed' });

        expect(store().connections[1]).toEqual({ state: 'connected' });
        expect(store().connections[2]).toEqual({ state: 'error', error: 'Auth failed' });

        store().clearConnection(1);
        expect(store().connections[1]).toBeUndefined();
    });

    it('forgets everything about a deleted server', () => {
        store().setConnection(7, { state: 'connected' });
        store().queueCommand(7, 'whoami', 'ai');
        store().requestChat({ serverId: 7, kind: 'fix-issue' });
        store().setConnection(8, { state: 'connected' });

        store().forgetServer(7);

        expect(store().connections[7]).toBeUndefined();
        expect(store().pendingCommands[7]).toBeUndefined();
        expect(store().chatRequest).toBeNull();
        expect(store().connections[8]).toEqual({ state: 'connected' });
    });
});

describe('terminal sessions', () => {
    const sessions = (serverId: number) => store().terminalSessions[serverId];

    it('opens numbered tabs, focuses the new one and mirrors its state as the server state', () => {
        const first = store().openTerminalSession(1);
        expect(sessions(1)).toMatchObject({ focusedId: first, sessions: [{ id: first, number: 1, title: null, state: 'connecting' }] });
        expect(store().connections[1]).toEqual({ state: 'connecting', error: undefined });

        store().setTerminalSessionState(1, first, { state: 'connected' });
        expect(store().connections[1]).toEqual({ state: 'connected', error: undefined });

        const second = store().openTerminalSession(1);
        expect(sessions(1).sessions.map((session) => session.number)).toEqual([1, 2]);
        expect(sessions(1).focusedId).toBe(second);
        expect(store().connections[1].state).toBe('connecting');

        // A tab in the background does not change the server state.
        store().setTerminalSessionState(1, first, { state: 'error', error: 'boom' });
        expect(store().connections[1].state).toBe('connecting');
        store().focusTerminalSession(1, first);
        expect(store().connections[1]).toEqual({ state: 'error', error: 'boom' });
    });

    it('duplicates next to the original, renames and closes with focus moving to the neighbour', () => {
        const a = store().openTerminalSession(2);
        const b = store().openTerminalSession(2);
        store().renameTerminalSession(2, a, '  logs  ');
        const copy = store().openTerminalSession(2, { title: 'logs', after: a });
        expect(sessions(2).sessions.map((session) => [session.id, session.title])).toEqual([[a, 'logs'], [copy, 'logs'], [b, null]]);

        store().renameTerminalSession(2, copy, '   ');
        expect(sessions(2).sessions[1].title).toBeNull();

        store().focusTerminalSession(2, copy);
        store().closeTerminalSession(2, copy);
        expect(sessions(2).focusedId).toBe(b);
        store().closeTerminalSession(2, b);
        expect(sessions(2).focusedId).toBe(a);
        store().closeTerminalSession(2, a);
        expect(sessions(2)).toMatchObject({ sessions: [], focusedId: null });
        expect(store().connections[2]).toEqual({ state: 'disconnected' });
        // Numbers keep counting up.
        store().openTerminalSession(2);
        expect(sessions(2).sessions[0].number).toBe(4);
    });

    it('keeps the container a tab is a shell of', () => {
        const attach = { kind: 'container', engine: 'docker', container: 'web', shell: 'bash' } as const;
        const shell = store().openTerminalSession(9, { attach });
        const plain = store().openTerminalSession(9);
        expect(sessions(9).sessions.find((session) => session.id === shell)?.attach).toEqual(attach);
        expect(sessions(9).sessions.find((session) => session.id === plain)).not.toHaveProperty('attach');
    });

    it('ignores unknown tabs and forgets a server’s tabs', () => {
        const a = store().openTerminalSession(3);
        const before = store().terminalSessions;
        store().focusTerminalSession(3, 'nope');
        store().setTerminalSessionState(3, 'nope', { state: 'connected' });
        store().closeTerminalSession(3, 'nope');
        expect(store().terminalSessions).toBe(before);

        store().forgetTerminalSessions(3);
        expect(sessions(3)).toBeUndefined();
        expect(store().connections[3]).toBeUndefined();
        store().openTerminalSession(4);
        store().forgetServer(4);
        expect(sessions(4)).toBeUndefined();
        expect(a).toMatch(/^term-/);
    });

    it('knows whose terminal panel is on screen', () => {
        expect(store().visibleTerminalServer).toBeNull();
        store().setTerminalPanelVisible(5, true);
        expect(store().visibleTerminalServer).toBe(5);
        // Another server's panel going away does not hide this one.
        store().setTerminalPanelVisible(6, false);
        expect(store().visibleTerminalServer).toBe(5);
        store().setTerminalPanelVisible(6, true);
        expect(store().visibleTerminalServer).toBe(6);
        store().forgetTerminalSessions(6);
        expect(store().visibleTerminalServer).toBeNull();
        store().setTerminalPanelVisible(7, true);
        store().forgetServer(7);
        expect(store().visibleTerminalServer).toBeNull();
    });
});
