// App-wide UI state shared between the workspace panels and the chat. It
// replaces the old window CustomEvent bus, whose events were lost whenever the
// listening component was not mounted at that moment.
import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import type { ChatAttachment } from '@shared/chat';
import type { AnyTerminalAttach } from '@shared/protocol';
import type { ConnState } from '@/components/ui/StatusDot';

export type ConnectionInfo = { state: ConnState; error?: string };

// Where a command typed into a terminal came from (shown in its history; the
// non-typed sources are also recorded in the audit log when they are sent).
export type CommandSource = 'typed' | 'hint' | 'ai' | 'ai-autorun' | 'snippet' | 'multi-exec' | 'ops';

// `queuedAt`: when it was queued (Date.now()); entries older than
// QUEUED_COMMAND_TTL_MS are never typed (see takeCommands). `display`: the
// form recorded instead of `command` (terminal history, audit log), e.g. a
// snippet with its secret values masked (W7-S4).
export type QueuedCommand = { id: string; command: string; source: CommandSource; queuedAt: number; display?: string };

// A command still waiting after this long was meant for a moment that has
// passed: it is dropped instead of running unattended later.
export const QUEUED_COMMAND_TTL_MS = 2 * 60_000;

// Servers kept open in the background (their panels stay mounted): switching
// back to one finds its terminals, transfers and editor as they were.
export const MAX_OPEN_SERVERS = 6;

const isFresh = (entry: QueuedCommand, now: number) => now - entry.queuedAt < QUEUED_COMMAND_TTL_MS;

// Work that closing a server would lose, as one translated phrase each
// ("Unsaved changes to /etc/hosts", "2 transfers in progress"); null: none.
export type UnsavedGuard = () => string | null;

export type ChatRequestInput =
    | { serverId: number; kind: 'prompt'; prompt: string }
    // The terminal's inline "!" button: ask the AI for a fix of the latest issue.
    | { serverId: number; kind: 'fix-issue' }
    // An "Ask AI" button (AskAiButton) about something on the server: a
    // service, a container, logs, its status. The chat attaches the evidence
    // the backend collects for it and puts `prompt` in the message box; the
    // user sends the diagnosis.
    | { serverId: number; kind: 'context'; attachment: ChatAttachment; prompt?: string };
// `requestedAt`: Date.now() when it was made.
export type ChatRequest = ChatRequestInput & { id: string; requestedAt: number };

// The workspace tab an "Ask AI" request about `attachment` shows when it
// has to open its server first.
export function contextTabFor(attachment: ChatAttachment): string {
    // W8-T2: a pod's server opens on its Kubernetes tab.
    if (attachment.kind === 'pod') return 'kubernetes';
    // W8-T4: the disk toolkit opens from the Status tab.
    return attachment.kind === 'status' || attachment.kind === 'triage' || attachment.kind === 'disk' ? 'status' : 'operations';
}

// A request to show one workspace tab of a server (requestServerTab).
export type ServerTabRequest = { id: string; serverId: number; tabId: string };

// What the command palette asks a server's terminal panel to do: split the
// focused pane, move the keyboard to the next pane, turn broadcast input on
// or off (requestPaneCommand).
export type PaneCommand = 'split-right' | 'split-down' | 'focus-next' | 'toggle-broadcast';
export type PaneCommandRequest = { id: string; serverId: number; command: PaneCommand };

// One terminal tab of a server (its own socket and shell; SSH tabs share the
// pooled connection). `title` is the user's name for it, if renamed.
// `attach`: the tab is a shell inside a container (W7-S3 opens it so).
export type TerminalSessionInfo = {
    id: string;
    number: number;
    title: string | null;
    state: ConnState;
    error?: string;
    // W8-T2: or a shell inside a Kubernetes pod's container.
    attach?: AnyTerminalAttach;
};

export type ServerTerminalSessions = {
    sessions: TerminalSessionInfo[];
    focusedId: string | null;
    nextNumber: number;
};

// The container the server's focused terminal tab is a shell in (that tab's
// output is what the AI chat reads), if it is one.
export function focusedTerminalAttach(server: ServerTerminalSessions | undefined): AnyTerminalAttach | undefined {
    return server?.sessions.find((session) => session.id === server.focusedId)?.attach;
}

interface AppState {
    // Live terminal session state, reported by each server's terminal.
    connections: Record<number, ConnectionInfo>;
    // Commands waiting to be typed into a server's terminal. The terminal
    // drains its queue once it is mounted and connected.
    pendingCommands: Record<number, QueuedCommand[]>;
    chatOpen: boolean;
    // A request for the chat panel; the chat of that server consumes it when
    // it is (or becomes) mounted.
    chatRequest: ChatRequest | null;

    setConnection: (serverId: number, info: ConnectionInfo) => void;
    clearConnection: (serverId: number) => void;
    queueCommand: (serverId: number, command: string, source: CommandSource, options?: { display?: string }) => void;
    // The server's commands still within QUEUED_COMMAND_TTL_MS, in order;
    // older ones are dropped, never handed out.
    takeCommands: (serverId: number) => QueuedCommand[];
    // Returns what was discarded.
    discardCommands: (serverId: number) => QueuedCommand[];
    // Drops every command older than QUEUED_COMMAND_TTL_MS; returns them per server.
    expireCommands: (now?: number) => Record<number, QueuedCommand[]>;
    setChatOpen: (open: boolean) => void;
    // Opens the chat on the request. An "Ask AI" request ('context') about a
    // server that is not on screen also opens that server (requestServerTab,
    // on the tab the attachment comes from), so its chat can take it.
    requestChat: (request: ChatRequestInput) => void;
    // Returns false when the request was already consumed (or replaced).
    consumeChatRequest: (id: string) => boolean;
    // Drops everything kept for a deleted server.
    forgetServer: (serverId: number) => void;

    // Shows `tabId` (a workspace tab id: 'status', 'operations', ...) of a
    // server from anywhere (the fleet board, a notification). App opens the
    // server as if picked in the sidebar, then shows the tab if the server
    // has it; a newer request replaces one not yet handled.
    serverTabRequest: ServerTabRequest | null;
    requestServerTab: (serverId: number, tabId: string) => void;
    // Returns false when the request was already consumed (or replaced).
    consumeServerTabRequest: (id: string) => boolean;

    // For the terminal panel of the server on screen (TerminalPanel consumes it).
    paneCommand: PaneCommandRequest | null;
    requestPaneCommand: (serverId: number, command: PaneCommand) => void;
    consumePaneCommand: (id: string) => boolean;

    // The global action (src/workspace/actions) whose surface is open.
    activeActionId: string | null;
    openAction: (id: string) => void;
    closeAction: () => void;

    // Bumped when the AI settings change (an API key saved or removed), so an
    // open chat reads the provider route again.
    aiConfigRevision: number;
    aiConfigChanged: () => void;

    // --- terminal sessions ---
    // Terminal tabs per server. connections[serverId] mirrors the focused
    // tab, which is also the one queued commands are typed into.
    terminalSessions: Record<number, ServerTerminalSessions>;
    // Opens a tab (after `after`, or last) and focuses it; returns its id.
    // With `attach` the tab is a shell inside that container (W7-S3: until
    // the terminal passes it on, it opens the login shell).
    openTerminalSession: (serverId: number, options?: { title?: string | null; after?: string; attach?: AnyTerminalAttach }) => string;
    closeTerminalSession: (serverId: number, sessionId: string) => void;
    renameTerminalSession: (serverId: number, sessionId: string, title: string | null) => void;
    focusTerminalSession: (serverId: number, sessionId: string) => void;
    setTerminalSessionState: (serverId: number, sessionId: string, info: ConnectionInfo) => void;
    forgetTerminalSessions: (serverId: number) => void;
    // The server whose terminal panel is on screen (null: none is).
    visibleTerminalServer: number | null;
    setTerminalPanelVisible: (serverId: number, visible: boolean) => void;

    // --- open servers (slice V4a) ---
    // The servers open in the workspace, most recently used first (at most
    // MAX_OPEN_SERVERS: App asks before closing one to make room), and the
    // one on screen.
    openServerIds: number[];
    activeServerId: number | null;
    // Opens `serverId` (or brings it back to the front) and shows it.
    activateServer: (serverId: number) => void;
    // Closes a server: its panels unmount (sessions end), its queued commands
    // and chat request are dropped. The most recent other one is shown if it
    // was on screen. Returns the commands that were still queued.
    closeServer: (serverId: number) => QueuedCommand[];
    // Registers a check for work that closing `serverId` would lose (an
    // unsaved editor buffer, running transfers); returns its unregistration.
    // Components use useUnsavedGuard(); collectUnsavedWork() runs them.
    registerUnsavedGuard: (serverId: number, guard: UnsavedGuard) => () => void;
}

let sequence = 0;
const nextId = () => `${Date.now().toString(36)}-${(sequence += 1)}`;

const without = <T>(record: Record<number, T>, key: number): Record<number, T> => {
    if (!(key in record)) return record;
    const next = { ...record };
    delete next[key];
    return next;
};

// The server's connection state as the rest of the app sees it: its focused
// terminal tab's (no tabs left: disconnected).
function mirrorFocused(connections: Record<number, ConnectionInfo>, serverId: number, server: ServerTerminalSessions | undefined): Record<number, ConnectionInfo> {
    const focused = server?.sessions.find((session) => session.id === server.focusedId);
    const info: ConnectionInfo = focused ? { state: focused.state, error: focused.error } : { state: 'disconnected' };
    const current = connections[serverId];
    if (current && current.state === info.state && current.error === info.error) return connections;
    return { ...connections, [serverId]: info };
}

export const useAppStore = create<AppState>()((set, get) => ({
    connections: {},
    pendingCommands: {},
    chatOpen: true,
    chatRequest: null,
    activeActionId: null,

    openAction: (id) => set({ activeActionId: id }),
    closeAction: () => set({ activeActionId: null }),

    aiConfigRevision: 0,
    aiConfigChanged: () => set((state) => ({ aiConfigRevision: state.aiConfigRevision + 1 })),

    setConnection: (serverId, info) => set((state) => ({
        connections: { ...state.connections, [serverId]: info }
    })),

    clearConnection: (serverId) => set((state) => ({
        connections: without(state.connections, serverId)
    })),

    queueCommand: (serverId, command, source, options) => set((state) => ({
        pendingCommands: {
            ...state.pendingCommands,
            [serverId]: [
                ...(state.pendingCommands[serverId] ?? []),
                { id: nextId(), command, source, queuedAt: Date.now(), ...(options?.display !== undefined && options.display !== command ? { display: options.display } : {}) }
            ]
        }
    })),

    takeCommands: (serverId) => {
        const queued = get().pendingCommands[serverId] ?? [];
        if (queued.length) {
            set((state) => ({ pendingCommands: without(state.pendingCommands, serverId) }));
        }
        const now = Date.now();
        return queued.filter((entry) => isFresh(entry, now));
    },

    discardCommands: (serverId) => {
        const queued = get().pendingCommands[serverId] ?? [];
        if (queued.length) set((state) => ({ pendingCommands: without(state.pendingCommands, serverId) }));
        return queued;
    },

    expireCommands: (now = Date.now()) => {
        const expired: Record<number, QueuedCommand[]> = {};
        const pending: Record<number, QueuedCommand[]> = {};
        for (const [key, queued] of Object.entries(get().pendingCommands)) {
            const serverId = Number(key);
            const fresh = queued.filter((entry) => isFresh(entry, now));
            if (fresh.length < queued.length) expired[serverId] = queued.filter((entry) => !isFresh(entry, now));
            if (fresh.length) pending[serverId] = fresh;
        }
        if (Object.keys(expired).length) set({ pendingCommands: pending });
        return expired;
    },

    setChatOpen: (open) => set({ chatOpen: open }),

    requestChat: (request) => set((state) => {
        const chatRequest: ChatRequest = { ...request, id: nextId(), requestedAt: Date.now() };
        if (request.kind !== 'context' || state.activeServerId === request.serverId) return { chatRequest, chatOpen: true };
        return {
            chatRequest,
            chatOpen: true,
            serverTabRequest: { id: nextId(), serverId: request.serverId, tabId: contextTabFor(request.attachment) }
        };
    }),

    consumeChatRequest: (id) => {
        if (get().chatRequest?.id !== id) return false;
        set({ chatRequest: null });
        return true;
    },

    serverTabRequest: null,

    requestServerTab: (serverId, tabId) => set({ serverTabRequest: { id: nextId(), serverId, tabId } }),

    consumeServerTabRequest: (id) => {
        if (get().serverTabRequest?.id !== id) return false;
        set({ serverTabRequest: null });
        return true;
    },

    paneCommand: null,

    requestPaneCommand: (serverId, command) => set({ paneCommand: { id: nextId(), serverId, command } }),

    consumePaneCommand: (id) => {
        if (get().paneCommand?.id !== id) return false;
        set({ paneCommand: null });
        return true;
    },

    forgetServer: (serverId) => {
        unsavedGuards.delete(serverId);
        set((state) => ({
            connections: without(state.connections, serverId),
            pendingCommands: without(state.pendingCommands, serverId),
            chatRequest: state.chatRequest?.serverId === serverId ? null : state.chatRequest,
            serverTabRequest: state.serverTabRequest?.serverId === serverId ? null : state.serverTabRequest,
            terminalSessions: without(state.terminalSessions, serverId),
            visibleTerminalServer: state.visibleTerminalServer === serverId ? null : state.visibleTerminalServer,
            ...closedState(state, serverId)
        }));
    },

    terminalSessions: {},

    openTerminalSession: (serverId, options = {}) => {
        const id = `term-${nextId()}`;
        set((state) => {
            const current = state.terminalSessions[serverId] ?? { sessions: [], focusedId: null, nextNumber: 1 };
            const session: TerminalSessionInfo = {
                id, number: current.nextNumber, title: options.title ?? null, state: 'connecting',
                ...(options.attach ? { attach: options.attach } : {})
            };
            const index = options.after ? current.sessions.findIndex((item) => item.id === options.after) : -1;
            const sessions = index >= 0
                ? [...current.sessions.slice(0, index + 1), session, ...current.sessions.slice(index + 1)]
                : [...current.sessions, session];
            const server: ServerTerminalSessions = { sessions, focusedId: id, nextNumber: current.nextNumber + 1 };
            return {
                terminalSessions: { ...state.terminalSessions, [serverId]: server },
                connections: mirrorFocused(state.connections, serverId, server)
            };
        });
        return id;
    },

    closeTerminalSession: (serverId, sessionId) => set((state) => {
        const current = state.terminalSessions[serverId];
        const index = current?.sessions.findIndex((session) => session.id === sessionId) ?? -1;
        if (!current || index < 0) return state;
        const sessions = current.sessions.filter((session) => session.id !== sessionId);
        // Focus moves to the neighbour, like closing a browser tab.
        const focusedId = current.focusedId !== sessionId
            ? current.focusedId
            : (sessions[Math.min(index, sessions.length - 1)]?.id ?? null);
        const server: ServerTerminalSessions = { ...current, sessions, focusedId };
        return {
            terminalSessions: { ...state.terminalSessions, [serverId]: server },
            connections: mirrorFocused(state.connections, serverId, server)
        };
    }),

    renameTerminalSession: (serverId, sessionId, title) => set((state) => {
        const current = state.terminalSessions[serverId];
        if (!current) return state;
        const clean = title?.trim() || null;
        const sessions = current.sessions.map((session) => (session.id === sessionId ? { ...session, title: clean } : session));
        return { terminalSessions: { ...state.terminalSessions, [serverId]: { ...current, sessions } } };
    }),

    focusTerminalSession: (serverId, sessionId) => set((state) => {
        const current = state.terminalSessions[serverId];
        if (!current || current.focusedId === sessionId || !current.sessions.some((session) => session.id === sessionId)) return state;
        const server = { ...current, focusedId: sessionId };
        return {
            terminalSessions: { ...state.terminalSessions, [serverId]: server },
            connections: mirrorFocused(state.connections, serverId, server)
        };
    }),

    setTerminalSessionState: (serverId, sessionId, info) => set((state) => {
        const current = state.terminalSessions[serverId];
        const target = current?.sessions.find((session) => session.id === sessionId);
        if (!current || !target || (target.state === info.state && target.error === info.error)) return state;
        const sessions = current.sessions.map((session) => (session.id === sessionId ? { ...session, state: info.state, error: info.error } : session));
        const server = { ...current, sessions };
        return {
            terminalSessions: { ...state.terminalSessions, [serverId]: server },
            connections: mirrorFocused(state.connections, serverId, server)
        };
    }),

    forgetTerminalSessions: (serverId) => set((state) => ({
        terminalSessions: without(state.terminalSessions, serverId),
        connections: without(state.connections, serverId),
        visibleTerminalServer: state.visibleTerminalServer === serverId ? null : state.visibleTerminalServer
    })),

    visibleTerminalServer: null,

    setTerminalPanelVisible: (serverId, visible) => set((state) => {
        if (visible) return state.visibleTerminalServer === serverId ? state : { visibleTerminalServer: serverId };
        return state.visibleTerminalServer === serverId ? { visibleTerminalServer: null } : state;
    }),

    // --- open servers (slice V4a) ---

    openServerIds: [],
    activeServerId: null,

    activateServer: (serverId) => set((state) => {
        if (state.activeServerId === serverId && state.openServerIds[0] === serverId) return state;
        return {
            activeServerId: serverId,
            openServerIds: [serverId, ...state.openServerIds.filter((id) => id !== serverId)]
        };
    }),

    closeServer: (serverId) => {
        const discarded = get().pendingCommands[serverId] ?? [];
        set((state) => ({
            pendingCommands: without(state.pendingCommands, serverId),
            chatRequest: state.chatRequest?.serverId === serverId ? null : state.chatRequest,
            ...closedState(state, serverId)
        }));
        return discarded;
    },

    registerUnsavedGuard: (serverId, guard) => {
        const guards = unsavedGuards.get(serverId) ?? new Set<UnsavedGuard>();
        guards.add(guard);
        unsavedGuards.set(serverId, guards);
        return () => {
            guards.delete(guard);
            if (!guards.size && unsavedGuards.get(serverId) === guards) unsavedGuards.delete(serverId);
        };
    }
}));

// The open-server fields once `serverId` is closed: the most recently used
// other server takes the screen if it had it.
function closedState(state: Pick<AppState, 'openServerIds' | 'activeServerId'>, serverId: number): Pick<AppState, 'openServerIds' | 'activeServerId'> {
    const openServerIds = state.openServerIds.filter((id) => id !== serverId);
    const activeServerId = state.activeServerId === serverId ? openServerIds[0] ?? null : state.activeServerId;
    return { openServerIds, activeServerId };
}

// Outside the state: functions, asked only when a server is about to close.
const unsavedGuards = new Map<number, Set<UnsavedGuard>>();

// What closing `serverId` would lose, as reported by its registered guards
// (a guard that throws reports nothing).
export function collectUnsavedWork(serverId: number): string[] {
    const found: string[] = [];
    for (const guard of unsavedGuards.get(serverId) ?? []) {
        try {
            const work = guard();
            if (work) found.push(work);
        } catch {
            // A broken guard must not block closing the server.
        }
    }
    return found;
}

// Registers `guard` for `serverId` while the calling component is mounted;
// the latest `guard` is the one asked. Pass null to report nothing.
//
//   useUnsavedGuard(serverId, dirty ? () => t('app.openServers.work.unsavedFile', { path }) : null);
//
// RemoteEditor (unsaved changes) and FileExplorer (transfers still to
// finish) register one.
export function useUnsavedGuard(serverId: number, guard: UnsavedGuard | null): void {
    const guardRef = useRef(guard);
    useEffect(() => {
        guardRef.current = guard;
    });
    useEffect(() => useAppStore.getState().registerUnsavedGuard(serverId, () => guardRef.current?.() ?? null), [serverId]);
}
