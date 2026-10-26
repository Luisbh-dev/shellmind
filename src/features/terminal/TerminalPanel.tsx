import { useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type KeyboardEvent } from 'react';
import { Columns2, LayoutPanelLeft, Plus, Radio, Rows2, TerminalSquare, XSquare } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import type { MenuItem } from '@/components/ui/Menu';
import { Menu } from '@/components/ui/Menu';
import { useToast } from '@/components/ui/Toast';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useAppStore, type ServerTerminalSessions, type TerminalSessionInfo } from '@/store/appStore';
import type { TerminalSize } from '@/store/terminalOutput';
import { formatShortcut, isMacPlatform } from '@/workspace/actions/registry';
import type { WorkspaceServer } from '@/workspace/types';
import { BroadcastBar, BroadcastButton, BroadcastPicker, useBroadcastActions } from './BroadcastControls';
import { broadcastKey, includeAnyway, parseBroadcastKey, stopBroadcast, useBroadcast, type PauseReason } from './broadcast';
import { useCommandHistory } from './history';
import { PANE_SHORTCUTS, paneKeyAction } from './keyboard';
import { MAX_PANES, leaves, paneRects, splitRects, type DropEdge, type PaneLeaf, type Rect } from './layout';
import { terminalName } from './names';
import { DropTargets, PaneHeader, SESSION_DRAG_TYPE } from './Pane';
import { PaneDivider } from './PaneDivider';
import { closePane, focusPane, moveToEdge, resizeActivePane, resizePanes, restorePanes, showInPane, splitActivePane, usePanes } from './panes';
import { isDesktopApp, NEW_TERMINAL_TAB_SHORTCUT } from './platform';
import { SessionTabBar, sessionName } from './SessionTabBar';
import TerminalSession, { type SessionCallbacks } from './TerminalSession';

export type TerminalPanelProps = {
    server: WorkspaceServer;
    // The workspace shows this panel (hidden panels stay mounted).
    isActive?: boolean;
    onOsDetected?: (os: string) => void;
    // Output of the focused tab, for the chat's context and issue detection.
    onOutput?: (data: string, sessionId: string, size: TerminalSize) => void;
    // Another tab got the focus (`screen`: what it shows, up to the cursor).
    onSessionFocused?: (sessionId: string, screen: string) => void;
};

const NO_SESSIONS: ServerTerminalSessions = { sessions: [], focusedId: null, nextNumber: 1 };
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 };
// Room around each pane of a split, for the dividers between them.
const PANE_GAP_PX = 3;
// A "broadcast stopped" notice older than this is not shown any more.
const STOP_NOTICE_MS = 5000;

const percent = (value: number) => `${value * 100}%`;
const rectStyle = (rect: Rect, gap: number): CSSProperties => ({
    left: percent(rect.x), top: percent(rect.y), width: percent(rect.w), height: percent(rect.h), padding: gap
});

// Shown once, by the panel on screen.
let announcedStop = 0;

// The terminal of a server: one or more tabs, each its own session (SSH tabs
// share the pooled connection; local consoles get their own process), shown
// in up to MAX_PANES panes side by side (panes.ts). Every tab stays mounted
// in one flat list, placed over the pane that shows it: moving a tab to
// another pane never restarts its terminal. Broadcast input (broadcast.ts)
// types into several of them at once.
export default function TerminalPanel({ server, isActive = true, onOsDetected, onOutput, onSessionFocused }: TerminalPanelProps) {
    const t = useT();
    const toast = useToast();
    const mac = isMacPlatform();
    const serverId = server.id;
    const sessionsState = useAppStore((state) => state.terminalSessions[serverId] ?? NO_SESSIONS);
    const queuedCount = useAppStore((state) => state.pendingCommands[serverId]?.length ?? 0);
    const { openTerminalSession, closeTerminalSession, renameTerminalSession, focusTerminalSession, forgetTerminalSessions } = useAppStore.getState();
    const [toolbarSlot, setToolbarSlot] = useState<HTMLDivElement | null>(null);
    const layout = usePanes((state) => state.layouts[serverId]);
    const broadcast = useBroadcast(useShallow((state) => ({ active: state.active, members: state.members, paused: state.paused, stopped: state.stopped })));
    const broadcastActions = useBroadcastActions();
    const [pickerOpen, setPickerOpen] = useState(false);
    const broadcastButtonRef = useRef<HTMLButtonElement>(null);
    const gridRef = useRef<HTMLDivElement>(null);
    const [dragging, setDragging] = useState<string | null>(null);
    const [announcement, setAnnouncement] = useState('');

    // The props may change on every render of the app; the sessions get
    // stable callbacks that read the latest ones.
    const propsRef = useRef({ onOsDetected, onOutput, onSessionFocused });
    useEffect(() => {
        propsRef.current = { onOsDetected, onOutput, onSessionFocused };
    });
    const callbacks = useMemo<SessionCallbacks>(() => ({
        onOutput: (data, sessionId, size) => propsRef.current.onOutput?.(data, sessionId, size),
        onFocused: (sessionId, screen) => propsRef.current.onSessionFocused?.(sessionId, screen),
        onOsDetected: (os) => propsRef.current.onOsDetected?.(os)
    }), []);

    // The tabs the panel had last time (one per remembered pane), or a first
    // tab; nothing is kept once it closes.
    useEffect(() => {
        useCommandHistory.getState().load(serverId);
        if (!useAppStore.getState().terminalSessions[serverId]?.sessions.length && !restorePanes(serverId)) openTerminalSession(serverId);
        return () => forgetTerminalSessions(serverId);
    }, [serverId, openTerminalSession, forgetTerminalSessions]);

    // Commands queued while every tab was closed need a terminal to run in.
    const noSessions = sessionsState.sessions.length === 0;
    useEffect(() => {
        if (noSessions && queuedCount > 0 && !useAppStore.getState().terminalSessions[serverId]?.sessions.length) {
            openTerminalSession(serverId);
        }
    }, [noSessions, queuedCount, serverId, openTerminalSession]);

    // Tab shortcuts such as "close tab" act only on a terminal on screen.
    useEffect(() => {
        useAppStore.getState().setTerminalPanelVisible(serverId, isActive);
        return () => useAppStore.getState().setTerminalPanelVisible(serverId, false);
    }, [serverId, isActive]);

    // Broadcasting stopped by itself (a terminal closed or its session ended).
    const stoppedId = broadcast.stopped?.id ?? 0;
    useEffect(() => {
        const stopped = useBroadcast.getState().stopped;
        if (!stopped || !isActive || stopped.id === announcedStop || Date.now() - stopped.at > STOP_NOTICE_MS) return;
        announcedStop = stopped.id;
        const name = stopped.session && stopped.serverId !== null ? terminalName(stopped.serverId, stopped.session, t) : '';
        toast.warning(t(`terminal.broadcast.stopped.${stopped.reason}`, { name }));
    }, [stoppedId, isActive, t, toast]);

    const { sessions, focusedId } = sessionsState;
    const root = layout?.root;
    const panes = useMemo<PaneLeaf[]>(() => (root ? leaves(root) : []), [root]);
    const rects = useMemo(() => (root ? paneRects(root) : new Map<string, Rect>()), [root]);
    const dividers = useMemo(() => (root ? splitRects(root) : []), [root]);
    const multi = panes.length > 1;
    const paneOf = new Map(panes.flatMap((pane) => (pane.sessionId ? [[pane.sessionId, pane] as const] : [])));
    const paneIndex = new Map(panes.map((pane, index) => [pane.id, index]));
    const activePaneId = layout?.activePaneId ?? null;
    // Before the layout exists (the very first render), the focused tab fills the panel.
    const rectOf = (sessionId: string): Rect | undefined => {
        if (!root) return sessionId === focusedId ? FULL : undefined;
        const pane = paneOf.get(sessionId);
        return pane ? rects.get(pane.id) : undefined;
    };
    const canSplit = panes.length < MAX_PANES;
    const onScreen = panes.flatMap((pane) => (pane.sessionId ? [broadcastKey(serverId, pane.sessionId)] : []));
    const focusedKey = focusedId ? broadcastKey(serverId, focusedId) : null;
    const memberIds = new Set(broadcast.members.flatMap((key) => {
        const parsed = parseBroadcastKey(key);
        return parsed?.serverId === serverId ? [parsed.sessionId] : [];
    }));
    // What is typed in this panel goes to other terminals (its focused tab is in the group).
    const typingBroadcasts = broadcast.active && focusedId !== null && memberIds.has(focusedId);
    const nameOf = (session: TerminalSessionInfo) => sessionName(session, t);

    // Said to screen readers by the panel on screen: broadcasting on (with
    // how many terminals) or off, and a terminal of this panel that stops
    // getting what is typed (a password prompt, a full-screen program,
    // offline; not a moment on hold). Stopping by itself has its own notice.
    const seen = useRef<{ active: boolean; paused: Record<string, PauseReason> }>({ active: false, paused: {} });
    const memberCount = broadcast.members.length;
    useEffect(() => {
        const before = seen.current;
        seen.current = { active: broadcast.active, paused: broadcast.paused };
        if (!isActive) return;
        if (!broadcast.active) {
            if (before.active && !useBroadcast.getState().stopped) setAnnouncement(t('terminal.broadcast.off'));
            return;
        }
        const pausedBefore = before.active ? before.paused : {};
        const news = Object.entries(broadcast.paused).flatMap(([key, reason]) => {
            const parsed = parseBroadcastKey(key);
            if (reason === 'waiting' || pausedBefore[key] === reason || parsed?.serverId !== serverId) return [];
            const session = useAppStore.getState().terminalSessions[serverId]?.sessions.find((item) => item.id === parsed.sessionId);
            return session ? [t('terminal.broadcast.pausedOf', { name: sessionName(session, t), reason: t(`terminal.broadcast.paused.${reason}`) })] : [];
        });
        if (!before.active) news.unshift(t('terminal.broadcast.on', { count: memberCount }));
        if (news.length) setAnnouncement(news.join('. '));
    }, [broadcast.paused, broadcast.active, memberCount, isActive, serverId, t]);

    const tabId = (sessionId: string) => `terminal-tab-${sessionId}`;
    const panelId = (sessionId: string) => `terminal-panel-${sessionId}`;
    const paneLabelId = (sessionId: string) => `terminal-pane-label-${sessionId}`;
    const newTabShortcut = isDesktopApp() ? formatShortcut(NEW_TERMINAL_TAB_SHORTCUT) : undefined;

    // ---- Actions -----------------------------------------------------------

    // With every tab closed there is nothing to split: a tab opens instead.
    const split = (direction: 'row' | 'column') => {
        if (noSessions) openTerminalSession(serverId);
        else if (!splitActivePane(serverId, direction)) toast.info(t('terminal.panes.maxPanes', { max: MAX_PANES }));
    };

    // The terminal of the tab gets the keys (a click on its pane's strip).
    const activate = (sessionId: string) => {
        focusTerminalSession(serverId, sessionId);
        requestAnimationFrame(() => document.getElementById(panelId(sessionId))?.querySelector<HTMLElement>('.xterm-helper-textarea')?.focus());
    };

    // Said to screen readers after a move with Mod+Alt+arrows.
    const announceFocus = () => {
        const state = useAppStore.getState().terminalSessions[serverId];
        const current = usePanes.getState().layouts[serverId];
        const session = state?.sessions.find((item) => item.id === state.focusedId);
        if (!session || !current) return;
        const all = leaves(current.root);
        const index = all.findIndex((pane) => pane.sessionId === session.id);
        setAnnouncement(t('terminal.panes.focused', { index: index + 1, count: all.length, name: nameOf(session) }));
    };

    // Mod+Shift+B: stops broadcasting, or starts it with the terminals picked
    // last time when the one the user is in is among them, else with the
    // panes on screen; without two, the picker opens.
    const toggleBroadcast = async () => {
        const state = useBroadcast.getState();
        if (state.active) {
            stopBroadcast();
            return;
        }
        const keep = focusedKey !== null && state.members.length >= 2 && state.members.includes(focusedKey);
        const group = keep ? state.members : onScreen;
        if (group.length < 2) setPickerOpen(true);
        else await broadcastActions.start(group, focusedKey);
    };

    // The command palette's "next pane": the panes in reading order, around.
    const focusNextPane = () => {
        const current = usePanes.getState().layouts[serverId];
        const focused = useAppStore.getState().terminalSessions[serverId]?.focusedId;
        const shown = current ? leaves(current.root).flatMap((pane) => (pane.sessionId ? [pane.sessionId] : [])) : [];
        if (shown.length < 2) return;
        activate(shown[(shown.indexOf(focused ?? '') + 1) % shown.length]);
        announceFocus();
    };

    // A command from the palette (requestPaneCommand) for this server, run
    // by its panel on screen with the latest handlers.
    const paneHandlers = useRef({ split, toggleBroadcast, focusNextPane });
    useEffect(() => {
        paneHandlers.current = { split, toggleBroadcast, focusNextPane };
    });
    const paneCommand = useAppStore((state) => state.paneCommand);
    useEffect(() => {
        if (!paneCommand || paneCommand.serverId !== serverId || !isActive) return;
        if (!useAppStore.getState().consumePaneCommand(paneCommand.id)) return;
        const handlers = paneHandlers.current;
        if (paneCommand.command === 'split-right') handlers.split('row');
        else if (paneCommand.command === 'split-down') handlers.split('column');
        else if (paneCommand.command === 'focus-next') handlers.focusNextPane();
        else void handlers.toggleBroadcast();
    }, [paneCommand, serverId, isActive]);

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const action = paneKeyAction(event.nativeEvent, mac);
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        if (event.repeat && (action.kind === 'split' || action.kind === 'toggle-broadcast')) return;
        if (action.kind === 'split') split(action.direction);
        else if (action.kind === 'focus-pane') {
            if (focusPane(serverId, action.direction)) announceFocus();
        } else if (action.kind === 'resize-pane') resizeActivePane(serverId, action.direction);
        else void toggleBroadcast();
    };

    const onTabDragStart = (sessionId: string, event: DragEvent<HTMLElement>) => {
        event.dataTransfer.setData(SESSION_DRAG_TYPE, sessionId);
        event.dataTransfer.effectAllowed = 'move';
        setDragging(sessionId);
    };
    const onDragEnd = () => setDragging(null);
    const dropOn = (paneId: string, edge: DropEdge | null) => {
        const sessionId = dragging;
        setDragging(null);
        if (!sessionId) return;
        if (edge) moveToEdge(serverId, sessionId, paneId, edge);
        else showInPane(serverId, sessionId, paneId);
        // The keys go where the tab went (the drag left the focus on its tab).
        activate(sessionId);
    };

    const tabMenuItems = (session: TerminalSessionInfo): Array<MenuItem | 'separator'> => {
        const pane = paneOf.get(session.id);
        const key = broadcastKey(serverId, session.id);
        const member = memberIds.has(session.id);
        const items: Array<MenuItem | 'separator'> = ['separator'];
        if (multi) {
            panes.forEach((target, index) => {
                if (target.id === pane?.id) return;
                items.push({
                    id: `pane-${target.id}`,
                    label: t('terminal.panes.showInPane', { index: index + 1 }),
                    icon: <LayoutPanelLeft className="h-4 w-4" />,
                    onSelect: () => showInPane(serverId, session.id, target.id)
                });
            });
        }
        items.push({
            id: 'broadcast',
            label: member ? t('terminal.broadcast.exclude', { name: nameOf(session) }) : t('terminal.broadcast.include', { name: nameOf(session) }),
            icon: <Radio className="h-4 w-4" />,
            onSelect: () => void broadcastActions.setMembership([key], !member)
        });
        return items;
    };

    const layoutItems: MenuItem[] = [
        {
            id: 'split-right',
            label: t('terminal.panes.splitRight'),
            icon: <Columns2 className="h-4 w-4" />,
            hint: formatShortcut(PANE_SHORTCUTS.splitRight),
            disabled: !canSplit || noSessions,
            onSelect: () => split('row')
        },
        {
            id: 'split-down',
            label: t('terminal.panes.splitDown'),
            icon: <Rows2 className="h-4 w-4" />,
            hint: formatShortcut(PANE_SHORTCUTS.splitDown),
            disabled: !canSplit || noSessions,
            onSelect: () => split('column')
        },
        {
            id: 'close-pane',
            label: t('terminal.panes.closePane'),
            icon: <XSquare className="h-4 w-4" />,
            disabled: !multi || !activePaneId,
            onSelect: () => {
                if (activePaneId) closePane(serverId, activePaneId);
            }
        }
    ];

    // ---- Render ------------------------------------------------------------

    return (
        // Pane and broadcast keys bubble up here from the terminals (keyboard.ts paneKeyAction).
        // A container: in a narrow panel the header takes two rows, the tabs keeping one of their own.
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions
        <div className="flex h-full w-full flex-col bg-ink-900 [container-type:inline-size]" onKeyDown={onKeyDown}>
            <div className="flex h-10 shrink-0 items-center justify-between gap-x-3 gap-y-1 border-b border-white/5 bg-ink-850/80 px-2 backdrop-blur [@container(max-width:40rem)]:h-auto [@container(max-width:40rem)]:flex-wrap [@container(max-width:40rem)]:py-1">
                <SessionTabBar
                    sessions={sessions}
                    focusedId={focusedId}
                    newTabShortcut={newTabShortcut}
                    tabId={tabId}
                    panelId={panelId}
                    onFocus={(sessionId) => focusTerminalSession(serverId, sessionId)}
                    onNew={() => openTerminalSession(serverId)}
                    onClose={(sessionId) => closeTerminalSession(serverId, sessionId)}
                    onRename={(sessionId, title) => renameTerminalSession(serverId, sessionId, title)}
                    onDuplicate={(sessionId) => {
                        const source = sessions.find((session) => session.id === sessionId);
                        openTerminalSession(serverId, { title: source?.title ?? null, after: sessionId, attach: source?.attach });
                    }}
                    shownIds={new Set(paneOf.keys())}
                    broadcast={{ members: memberIds, active: broadcast.active }}
                    menuItems={tabMenuItems}
                    onDragStart={onTabDragStart}
                    onDragEnd={onDragEnd}
                    className="[@container(max-width:40rem)]:basis-full"
                />
                <div className="ml-auto flex shrink-0 items-center gap-0.5">
                    <Menu
                        label={t('terminal.panes.layout')}
                        items={layoutItems}
                        triggerClassName="inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100"
                    >
                        <LayoutPanelLeft className="h-4 w-4" aria-hidden="true" />
                    </Menu>
                    <BroadcastButton ref={broadcastButtonRef} open={pickerOpen} included={typingBroadcasts} onToggle={() => setPickerOpen((open) => !open)} />
                    <span className="mx-1 h-4 w-px bg-white/10" aria-hidden="true" />
                    <div ref={setToolbarSlot} className="flex shrink-0 items-center" />
                </div>
            </div>

            {broadcast.active && <BroadcastBar included={typingBroadcasts} onChoose={() => setPickerOpen(true)} />}
            {pickerOpen && (
                <BroadcastPicker
                    anchor={broadcastButtonRef}
                    serverId={serverId}
                    onScreen={onScreen}
                    leader={focusedKey}
                    onClose={() => {
                        setPickerOpen(false);
                        broadcastButtonRef.current?.focus();
                    }}
                    onStarted={() => {
                        setPickerOpen(false);
                        // Ready to type into the terminals right away.
                        if (focusedId) activate(focusedId);
                    }}
                />
            )}

            <div ref={gridRef} className={cn('relative min-h-0 flex-1', dragging && 'select-none')}>
                {sessions.map((session) => {
                    const rect = rectOf(session.id);
                    const pane = paneOf.get(session.id);
                    const focused = session.id === focusedId;
                    const key = broadcastKey(serverId, session.id);
                    const member = memberIds.has(session.id);
                    const receiving = broadcast.active && member;
                    const paused = receiving ? broadcast.paused[key] : undefined;
                    const active = pane?.id === activePaneId;
                    const name = nameOf(session);
                    const index = pane ? (paneIndex.get(pane.id) ?? 0) + 1 : 1;
                    const showHeader = multi || receiving;
                    const dropHere = dragging !== null && dragging !== session.id && Boolean(rect);
                    return (
                        <div
                            key={session.id}
                            id={panelId(session.id)}
                            role="tabpanel"
                            aria-labelledby={multi ? `${paneLabelId(session.id)} ${tabId(session.id)}` : tabId(session.id)}
                            hidden={!rect}
                            style={rect ? rectStyle(rect, multi ? PANE_GAP_PX : 0) : undefined}
                            className="absolute"
                            onFocusCapture={(event) => {
                                // The keys stay where they were while a pane's own buttons are used.
                                if (!(event.target as HTMLElement).closest('[data-pane-header]')) focusTerminalSession(serverId, session.id);
                            }}
                        >
                            {multi && <span id={paneLabelId(session.id)} hidden>{t('terminal.panes.label', { index, count: panes.length })}</span>}
                            <div
                                className={cn(
                                    'flex h-full w-full flex-col overflow-hidden',
                                    (multi || receiving) && 'rounded-md border',
                                    // Getting what is typed: amber; in the group but not getting it now: a dashed frame.
                                    !receiving ? multi && (active ? 'border-brand-500/60' : 'border-white/[0.07]')
                                        : !paused ? cn('border-amber-400/70', active && multi ? 'ring-2 ring-amber-300/60' : 'ring-1 ring-amber-400/30')
                                            : cn('border-dashed', paused === 'waiting' ? 'border-zinc-400/50' : 'border-rose-400/70')
                                )}
                            >
                                {showHeader && (
                                    <PaneHeader
                                        session={session}
                                        name={name}
                                        multi={multi}
                                        active={active}
                                        canSplit={canSplit}
                                        broadcast={{ member, receiving, paused }}
                                        onActivate={() => activate(session.id)}
                                        onSplit={(direction) => {
                                            focusTerminalSession(serverId, session.id);
                                            split(direction);
                                        }}
                                        onClose={() => {
                                            if (!pane || !closePane(serverId, pane.id)) return;
                                            // Its button is gone: the keys go to the terminal they were in.
                                            const now = useAppStore.getState().terminalSessions[serverId]?.focusedId;
                                            if (now) activate(now);
                                        }}
                                        onToggleBroadcast={() => void broadcastActions.setMembership([key], !member)}
                                        onIncludeAnyway={() => {
                                            includeAnyway(key);
                                            if (focusedId) activate(focusedId);
                                        }}
                                        onDragStart={(event) => onTabDragStart(session.id, event)}
                                        onDragEnd={onDragEnd}
                                    />
                                )}
                                <div className="relative min-h-0 flex-1">
                                    <TerminalSession
                                        server={server}
                                        sessionId={session.id}
                                        focused={focused}
                                        visible={Boolean(rect) && isActive}
                                        toolbarSlot={toolbarSlot}
                                        callbacks={callbacks}
                                        attach={session.attach}
                                    />
                                    {dropHere && pane && (
                                        <DropTargets
                                            canSplit={canSplit || (dragging !== null && paneOf.has(dragging))}
                                            onDrop={(edge) => dropOn(pane.id, edge)}
                                        />
                                    )}
                                </div>
                            </div>
                        </div>
                    );
                })}

                {dividers.map(({ split: node, rect }) => {
                    const [first, second] = [leaves(node.first)[0], leaves(node.second)[0]];
                    const label = (leaf: PaneLeaf) => {
                        const session = sessions.find((item) => item.id === leaf.sessionId);
                        return session ? nameOf(session) : t('terminal.panes.label', { index: (paneIndex.get(leaf.id) ?? 0) + 1, count: panes.length });
                    };
                    return (
                        <PaneDivider
                            key={node.id}
                            split={node}
                            rect={rect}
                            grid={gridRef}
                            label={t('terminal.panes.divider', { first: label(first), second: label(second) })}
                            controls={first.sessionId ? panelId(first.sessionId) : undefined}
                            onResize={(ratio, done) => resizePanes(serverId, node.id, ratio, done)}
                        />
                    );
                })}

                {noSessions && (
                    <div className="absolute inset-0 flex items-center justify-center">
                        <div className="text-center">
                            <div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-2xl border border-white/5 bg-white/[0.02] text-brand-400/70">
                                <TerminalSquare className="h-7 w-7" aria-hidden="true" />
                            </div>
                            <p className="text-sm font-medium text-zinc-300">{t('terminal.tabs.empty')}</p>
                            <p className="mt-1 text-xs text-zinc-400">{t('terminal.tabs.emptyHint')}</p>
                            <button
                                type="button"
                                onClick={() => openTerminalSession(serverId)}
                                className="mt-4 inline-flex items-center gap-2 rounded-lg bg-brand-500 px-3.5 py-2 text-sm font-semibold text-on-brand transition-colors hover:bg-brand-400 focus-ring"
                            >
                                <Plus className="h-4 w-4" aria-hidden="true" />
                                {t('terminal.tabs.newTab')}
                            </button>
                        </div>
                    </div>
                )}
            </div>

            <div aria-live="polite" className="sr-only">{announcement}</div>
        </div>
    );
}
