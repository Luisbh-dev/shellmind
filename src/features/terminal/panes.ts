// The pane layout of each server's terminal (see layout.ts), kept in step
// with its tabs in the app store: closing a tab closes its pane, a tab that
// gets the focus shows in the active pane, and the focused tab is always the
// active pane's. The shape (splits and sizes, not the tabs) is remembered per
// server on this device and comes back the next time its terminal opens.
import { create } from 'zustand';
import { useAppStore } from '@/store/appStore';
import {
    findLeaf, findSplit, fromShape, leafOfSession, leaves, moveSessionToEdge, nearestSplit, neighbourPane, parseShape, reconcile,
    removePane, resizeSplit, setLeafSession, shapeOf, shapePanes, showSession, singlePane, splitPane, MAX_PANES, RATIO_STEP,
    type DropEdge, type FocusDirection, type PaneLayout, type PaneLeaf, type SplitDirection
} from './layout';

type PanesState = { layouts: Record<number, PaneLayout> };

export const usePanes = create<PanesState>()(() => ({ layouts: {} }));

let sequence = 0;
const nextId = (kind: 'pane' | 'split') => `${kind}-${Date.now().toString(36)}-${(sequence += 1)}`;

const STORAGE_PREFIX = 'shellmind.terminal.panes.';

function readShape(serverId: number) {
    try {
        const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${serverId}`);
        return raw ? parseShape(JSON.parse(raw)) : null;
    } catch {
        return null;
    }
}

// One pane needs no remembering.
function rememberShape(serverId: number, layout: PaneLayout): void {
    try {
        const key = `${STORAGE_PREFIX}${serverId}`;
        if (leaves(layout.root).length > 1) window.localStorage.setItem(key, JSON.stringify(shapeOf(layout.root)));
        else window.localStorage.removeItem(key);
    } catch {
        // Not remembered; the layout still applies until the server closes.
    }
}

const layoutOf = (serverId: number): PaneLayout | undefined => usePanes.getState().layouts[serverId];

function setLayout(serverId: number, layout: PaneLayout): void {
    if (layoutOf(serverId) === layout) return;
    usePanes.setState((state) => ({ layouts: { ...state.layouts, [serverId]: layout } }));
}

// The tab a tab picked in the tab strip pushed out of the active pane (the
// picked one took its place there), per server: "Show in pane N" on the
// picked tab then puts it back (see showInPane).
const displaced = new Map<number, { paneId: string; sessionId: string; by: string }>();

// Brings the server's layout in line with its tabs (layout.ts reconcile).
// A server without tabs in the store (its terminal closed) has none.
function syncPanes(serverId: number): void {
    const sessions = useAppStore.getState().terminalSessions[serverId];
    const current = layoutOf(serverId);
    if (!sessions) {
        displaced.delete(serverId);
        if (current) {
            usePanes.setState((state) => {
                const layouts = { ...state.layouts };
                delete layouts[serverId];
                return { layouts };
            });
        }
        return;
    }
    const base = current ?? singlePane(nextId('pane'), null);
    const { layout, focus } = reconcile(base, sessions.sessions.map((session) => session.id), sessions.focusedId);
    const before = findLeaf(base.root, layout.activePaneId)?.sessionId ?? null;
    const now = findLeaf(layout.root, layout.activePaneId)?.sessionId ?? null;
    if (before && now && before !== now && now === sessions.focusedId && !leafOfSession(base.root, now)) {
        displaced.set(serverId, { paneId: layout.activePaneId, sessionId: before, by: now });
    }
    setLayout(serverId, layout);
    // Panes closed with their tabs: the smaller layout is the one to come back.
    if (current && leaves(layout.root).length < leaves(current.root).length) rememberShape(serverId, layout);
    if (focus) useAppStore.getState().focusTerminalSession(serverId, focus);
}

useAppStore.subscribe((state, previous) => {
    if (state.terminalSessions === previous.terminalSessions) return;
    const servers = new Set([...Object.keys(state.terminalSessions), ...Object.keys(previous.terminalSessions)].map(Number));
    for (const serverId of servers) {
        if (state.terminalSessions[serverId] !== previous.terminalSessions[serverId]) syncPanes(serverId);
    }
});

// The layout as it is now (created for a server whose terminal has tabs).
function currentLayout(serverId: number): PaneLayout | undefined {
    if (!layoutOf(serverId)) syncPanes(serverId);
    return layoutOf(serverId);
}

const focusTab = (serverId: number, sessionId: string | null) => {
    if (sessionId) useAppStore.getState().focusTerminalSession(serverId, sessionId);
};

// A new pane next to the active one (right of it for 'row', below it for
// 'column') with a new tab of the same kind as the focused one (a shell in
// the same container for a container's tab). False at MAX_PANES.
export function splitActivePane(serverId: number, direction: SplitDirection): boolean {
    const layout = currentLayout(serverId);
    const sessions = useAppStore.getState().terminalSessions[serverId];
    if (!layout || leaves(layout.root).length >= MAX_PANES) return false;
    const added: PaneLeaf = { type: 'pane', id: nextId('pane'), sessionId: null };
    const next = { root: splitPane(layout.root, layout.activePaneId, direction, added, nextId('split')), activePaneId: added.id };
    setLayout(serverId, next);
    const focused = sessions?.sessions.find((session) => session.id === sessions.focusedId);
    // The new tab takes the focus, so it shows in the new (active) pane.
    useAppStore.getState().openTerminalSession(serverId, { after: focused?.id, attach: focused?.attach });
    rememberShape(serverId, layoutOf(serverId) ?? next);
    return true;
}

// Closes a pane; its tab keeps running (it stays in the tab strip). The
// last pane cannot be closed.
export function closePane(serverId: number, paneId: string): boolean {
    const layout = currentLayout(serverId);
    if (!layout || !findLeaf(layout.root, paneId) || leaves(layout.root).length < 2) return false;
    const { root, takeover } = removePane(layout.root, paneId);
    const wasActive = layout.activePaneId === paneId;
    const next = { root, activePaneId: wasActive && takeover ? takeover.id : layout.activePaneId };
    setLayout(serverId, next);
    rememberShape(serverId, next);
    if (wasActive) focusTab(serverId, takeover?.sessionId ?? null);
    return true;
}

// Shows `sessionId` in the pane `paneId` and gives it the focus. The pane
// that showed it gets the tab it pushed out when it was picked in the tab
// strip, if that tab is not on screen; otherwise the two panes swap tabs.
export function showInPane(serverId: number, sessionId: string, paneId: string): void {
    const layout = currentLayout(serverId);
    if (!layout || !findLeaf(layout.root, paneId)) return;
    const pushed = displaced.get(serverId);
    const source = leafOfSession(layout.root, sessionId);
    const alive = useAppStore.getState().terminalSessions[serverId]?.sessions.some((session) => session.id === pushed?.sessionId);
    const restore = pushed && pushed.by === sessionId && source?.id === pushed.paneId && source.id !== paneId
        && alive && !leafOfSession(layout.root, pushed.sessionId);
    const root = restore
        ? setLeafSession(setLeafSession(layout.root, paneId, sessionId), source.id, pushed.sessionId)
        : showSession(layout.root, paneId, sessionId);
    displaced.delete(serverId);
    setLayout(serverId, { root, activePaneId: paneId });
    focusTab(serverId, sessionId);
}

// `sessionId` in a new pane on `edge` of `paneId` (layout.ts moveSessionToEdge).
export function moveToEdge(serverId: number, sessionId: string, paneId: string, edge: DropEdge): boolean {
    const layout = currentLayout(serverId);
    if (!layout) return false;
    const ids = { paneId: nextId('pane'), splitId: nextId('split') };
    const root = moveSessionToEdge(layout.root, sessionId, paneId, edge, ids);
    if (root === layout.root) return false;
    const next = { root, activePaneId: ids.paneId };
    setLayout(serverId, next);
    rememberShape(serverId, next);
    focusTab(serverId, sessionId);
    return true;
}

// `remember`: false while a divider is being dragged (remembered on release).
export function resizePanes(serverId: number, splitId: string, ratio: number, remember = true): void {
    const layout = layoutOf(serverId);
    if (!layout) return;
    const next = { ...layout, root: resizeSplit(layout.root, splitId, ratio) };
    if (next.root === layout.root) {
        if (remember) rememberShape(serverId, layout);
        return;
    }
    setLayout(serverId, next);
    if (remember) rememberShape(serverId, next);
}

// The focus moves to the pane next to the active one. False at the edge.
export function focusPane(serverId: number, direction: FocusDirection): boolean {
    const layout = layoutOf(serverId);
    const target = layout ? neighbourPane(layout.root, layout.activePaneId, direction) : null;
    if (!target?.sessionId) return false;
    focusTab(serverId, target.sessionId);
    return true;
}

// Moves the divider nearest to the active pane along `direction` (the
// arrows move it, whichever side of it the pane is on).
export function resizeActivePane(serverId: number, direction: FocusDirection): boolean {
    const layout = layoutOf(serverId);
    if (!layout) return false;
    const split = nearestSplit(layout.root, layout.activePaneId, direction === 'left' || direction === 'right' ? 'row' : 'column');
    if (!split) return false;
    const step = direction === 'right' || direction === 'down' ? RATIO_STEP : -RATIO_STEP;
    resizePanes(serverId, split.id, split.ratio + step);
    return findSplit(layoutOf(serverId)!.root, split.id)?.ratio !== split.ratio;
}

// The terminal of a server opens with the layout it had last time: a tab
// for each remembered pane, the first pane focused. False when there is
// nothing to restore (a single pane), so the caller opens its one tab.
export function restorePanes(serverId: number): boolean {
    const shape = readShape(serverId);
    if (!shape || shapePanes(shape) < 2 || useAppStore.getState().terminalSessions[serverId]?.sessions.length) return false;
    const root = fromShape(shape, nextId);
    const panes = leaves(root);
    setLayout(serverId, { root, activePaneId: panes[0].id });
    for (const pane of panes) {
        const layout = layoutOf(serverId);
        if (layout) setLayout(serverId, { ...layout, activePaneId: pane.id });
        useAppStore.getState().openTerminalSession(serverId);
    }
    const first = layoutOf(serverId) && findLeaf(layoutOf(serverId)!.root, panes[0].id);
    focusTab(serverId, first?.sessionId ?? null);
    return true;
}
