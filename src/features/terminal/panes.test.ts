// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { useAppStore } from '@/store/appStore';
import { leaves, paneRects } from './layout';
import { closePane, focusPane, moveToEdge, resizeActivePane, restorePanes, showInPane, splitActivePane, usePanes } from './panes';

const SERVER = 1;
const store = () => useAppStore.getState();
const layout = () => usePanes.getState().layouts[SERVER];
const shown = () => leaves(layout().root).map((leaf) => leaf.sessionId);
const focused = () => store().terminalSessions[SERVER]?.focusedId ?? null;
const activeSession = () => leaves(layout().root).find((leaf) => leaf.id === layout().activePaneId)?.sessionId;

beforeEach(() => {
    useAppStore.setState(useAppStore.getInitialState(), true);
    usePanes.setState({ layouts: {} });
    localStorage.clear();
});

describe('terminal panes', () => {
    it('starts with one pane showing the focused tab, which follows the focus', () => {
        const first = store().openTerminalSession(SERVER);
        expect(shown()).toEqual([first]);
        const second = store().openTerminalSession(SERVER);
        expect(shown()).toEqual([second]);
        store().focusTerminalSession(SERVER, first);
        expect(shown()).toEqual([first]);
    });

    it('splits the active pane with a new tab that takes the focus, up to four panes', () => {
        const first = store().openTerminalSession(SERVER);
        expect(splitActivePane(SERVER, 'row')).toBe(true);
        const second = focused();
        expect(second).not.toBe(first);
        expect(shown()).toEqual([first, second]);
        expect(activeSession()).toBe(second);
        expect(splitActivePane(SERVER, 'column')).toBe(true);
        expect(splitActivePane(SERVER, 'column')).toBe(true);
        expect(splitActivePane(SERVER, 'row')).toBe(false);
        expect(leaves(layout().root)).toHaveLength(4);
        expect(store().terminalSessions[SERVER].sessions).toHaveLength(4);
    });

    it('duplicates the focused tab’s container when splitting a container shell', () => {
        const attach = { kind: 'container' as const, engine: 'docker' as const, container: 'web' };
        store().openTerminalSession(SERVER, { attach });
        splitActivePane(SERVER, 'row');
        expect(store().terminalSessions[SERVER].sessions.map((session) => session.attach)).toEqual([attach, attach]);
    });

    it('moves the focus between panes by direction and the active pane follows', () => {
        const first = store().openTerminalSession(SERVER);
        splitActivePane(SERVER, 'row');
        const second = focused();
        expect(focusPane(SERVER, 'left')).toBe(true);
        expect(focused()).toBe(first);
        expect(activeSession()).toBe(first);
        expect(focusPane(SERVER, 'left')).toBe(false);
        expect(focusPane(SERVER, 'right')).toBe(true);
        expect(focused()).toBe(second);
    });

    it('closing a tab closes its pane, and the focus stays in the pane that grew', () => {
        const first = store().openTerminalSession(SERVER);
        const hidden = store().openTerminalSession(SERVER);
        store().focusTerminalSession(SERVER, first);
        splitActivePane(SERVER, 'row');
        const third = focused()!;
        expect(shown()).toEqual([first, third]);
        // The tabs would focus the hidden neighbour; the remaining pane keeps its tab.
        store().closeTerminalSession(SERVER, third);
        expect(shown()).toEqual([first]);
        expect(focused()).toBe(first);
        expect(store().terminalSessions[SERVER].sessions.map((session) => session.id)).toEqual([first, hidden]);
    });

    it('closing a pane keeps its tab running in the background', () => {
        const first = store().openTerminalSession(SERVER);
        splitActivePane(SERVER, 'row');
        const second = focused()!;
        expect(closePane(SERVER, layout().activePaneId)).toBe(true);
        expect(shown()).toEqual([first]);
        expect(focused()).toBe(first);
        expect(store().terminalSessions[SERVER].sessions.map((session) => session.id)).toEqual([first, second]);
        expect(closePane(SERVER, layout().activePaneId)).toBe(false);
    });

    it('shows a tab in a chosen pane (swapping) and moves one to a side of a pane', () => {
        const first = store().openTerminalSession(SERVER);
        splitActivePane(SERVER, 'row');
        const second = focused()!;
        const [left, right] = leaves(layout().root);
        showInPane(SERVER, first, right.id);
        expect(shown()).toEqual([second, first]);
        expect(focused()).toBe(first);

        const third = store().openTerminalSession(SERVER);
        // The new tab showed in the active pane; put it below the left one instead.
        showInPane(SERVER, first, layout().activePaneId);
        expect(moveToEdge(SERVER, third, left.id, 'bottom')).toBe(true);
        expect(shown()).toEqual([second, third, first]);
        expect(focused()).toBe(third);
        expect(paneRects(layout().root).get(leaves(layout().root)[1].id)).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    });

    it('moves a tab just picked in the tab strip to another pane, putting back the tab it pushed out', () => {
        const first = store().openTerminalSession(SERVER);
        splitActivePane(SERVER, 'row');
        const second = focused()!;
        const hidden = store().openTerminalSession(SERVER);
        store().focusTerminalSession(SERVER, second);
        const [left, right] = leaves(layout().root);
        // Picked from the tabs (arrow keys): it shows in the active pane, the left one now.
        store().focusTerminalSession(SERVER, first);
        store().focusTerminalSession(SERVER, hidden);
        expect(shown()).toEqual([hidden, second]);
        showInPane(SERVER, hidden, right.id);
        expect(shown()).toEqual([first, hidden]);
        expect(layout().activePaneId).toBe(right.id);
        // Otherwise the two panes swap.
        showInPane(SERVER, first, right.id);
        expect(shown()).toEqual([hidden, first]);
        expect(left.id).toBe(leaves(layout().root)[0].id);
    });

    it('resizes the active pane from the keyboard and remembers the shape for the next time', () => {
        store().openTerminalSession(SERVER);
        splitActivePane(SERVER, 'row');
        expect(resizeActivePane(SERVER, 'left')).toBe(true);
        expect(paneRects(layout().root).get(leaves(layout().root)[0].id)?.w).toBeCloseTo(0.45);
        expect(resizeActivePane(SERVER, 'up')).toBe(false);
        expect(JSON.parse(localStorage.getItem('shellmind.terminal.panes.1')!)).toMatchObject({ type: 'split', direction: 'row', ratio: 0.45 });

        // The terminal closes (its tabs are forgotten) and opens again.
        store().forgetTerminalSessions(SERVER);
        expect(layout()).toBeUndefined();
        expect(restorePanes(SERVER)).toBe(true);
        const sessions = store().terminalSessions[SERVER].sessions.map((session) => session.id);
        expect(sessions).toHaveLength(2);
        expect(shown()).toEqual(sessions);
        expect(focused()).toBe(sessions[0]);
        expect(paneRects(layout().root).get(leaves(layout().root)[0].id)?.w).toBeCloseTo(0.45);
        // Not again while it has tabs.
        expect(restorePanes(SERVER)).toBe(false);
    });

    it('forgets the shape when the panes are closed down to one', () => {
        store().openTerminalSession(SERVER);
        splitActivePane(SERVER, 'column');
        expect(localStorage.getItem('shellmind.terminal.panes.1')).not.toBeNull();
        store().closeTerminalSession(SERVER, focused()!);
        expect(localStorage.getItem('shellmind.terminal.panes.1')).toBeNull();
        store().forgetTerminalSessions(SERVER);
        expect(restorePanes(SERVER)).toBe(false);
    });

    it('ignores a remembered shape that is not valid', () => {
        localStorage.setItem('shellmind.terminal.panes.1', '{"type":"split","direction":"sideways"}');
        expect(restorePanes(SERVER)).toBe(false);
        localStorage.setItem('shellmind.terminal.panes.1', 'not json');
        expect(restorePanes(SERVER)).toBe(false);
    });
});
