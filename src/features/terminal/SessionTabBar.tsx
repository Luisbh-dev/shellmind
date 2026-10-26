import { useEffect, useId, useRef, useState, type DragEvent, type KeyboardEvent, type MouseEvent } from 'react';
import { Container, CopyPlus, MoreHorizontal, Pencil, Plus, Radio, RotateCw, ShipWheel, X } from 'lucide-react';
import { useConfirm } from '@/components/ui/Confirm';
import { ContextMenu } from '@/components/ui/ContextMenu';
import type { MenuItem } from '@/components/ui/Menu';
import { StatusDot } from '@/components/ui/StatusDot';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import type { TerminalSessionInfo } from '@/store/appStore';

// The user's name for the tab; else "container: <name>" for a shell inside a
// container, "Terminal <n>" otherwise.
export function sessionName(session: TerminalSessionInfo, t: ReturnType<typeof useT>): string {
    if (session.title) return session.title;
    // W8-T2: a shell inside a Kubernetes pod (the k8s area words it).
    if (session.attach?.kind === 'pod') return t('k8s.terminal.tabName', { pod: session.attach.pod, container: session.attach.container });
    if (session.attach) return t('terminal.tabs.containerName', { name: session.attach.container });
    return t('terminal.tabs.defaultName', { number: session.number });
}

// 24 px targets (WCAG 2.5.8), apart from each other.
const tabButtonClass = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100';

// The mouse-only buttons of a tab do not take the focus: it stays on the tab
// (or the terminal), where the menu also gives it back.
const keepFocus = (event: MouseEvent) => event.preventDefault();

// The terminal tabs of a server (ARIA tabs): arrows move between them, F2
// renames, Delete closes, Shift+F10 opens the tab's menu; double-click
// renames. The tab list holds only the tabs: their options and close buttons
// are for the mouse, the keyboard and screen readers use those keys (named
// in each tab's description). A tab can be dragged onto a pane (W8-T1).
export function SessionTabBar({
    sessions,
    focusedId,
    newTabShortcut,
    tabId,
    panelId,
    onFocus,
    onNew,
    onClose,
    onRename,
    onDuplicate,
    shownIds,
    broadcast,
    menuItems,
    onDragStart,
    onDragEnd,
    className
}: {
    sessions: TerminalSessionInfo[];
    focusedId: string | null;
    // Shown in the "+" tooltip (the desktop app only has it).
    newTabShortcut?: string;
    tabId: (sessionId: string) => string;
    panelId: (sessionId: string) => string;
    onFocus: (sessionId: string) => void;
    onNew: () => void;
    onClose: (sessionId: string) => void;
    onRename: (sessionId: string, title: string | null) => void;
    onDuplicate: (sessionId: string) => void;
    // --- W8-T1 split panes and broadcast input ---
    // Tabs shown in a pane (besides the focused one).
    shownIds?: ReadonlySet<string>;
    // Tabs in the broadcast group, and whether it is broadcasting.
    broadcast?: { members: ReadonlySet<string>; active: boolean };
    // More items for a tab's menu (panes, broadcast), above "Close".
    menuItems?: (session: TerminalSessionInfo) => Array<MenuItem | 'separator'>;
    onDragStart?: (sessionId: string, event: DragEvent<HTMLElement>) => void;
    onDragEnd?: () => void;
    // Layout classes from the panel (a row of their own in a narrow panel).
    className?: string;
}) {
    const t = useT();
    const confirm = useConfirm();
    const [editing, setEditing] = useState<string | null>(null);
    const [draft, setDraft] = useState('');
    const [menu, setMenu] = useState<{ sessionId: string; x: number; y: number } | null>(null);
    const inputRef = useRef<HTMLInputElement>(null);
    const helpId = useId();

    useEffect(() => {
        if (editing) {
            inputRef.current?.focus();
            inputRef.current?.select();
        }
    }, [editing]);

    const focusTab = (sessionId: string) => {
        onFocus(sessionId);
        requestAnimationFrame(() => document.getElementById(tabId(sessionId))?.focus());
    };

    const startRename = (session: TerminalSessionInfo) => {
        setMenu(null);
        setDraft(sessionName(session, t));
        setEditing(session.id);
    };

    const finishRename = (commit: boolean) => {
        if (editing && commit) onRename(editing, draft);
        const sessionId = editing;
        setEditing(null);
        if (sessionId) requestAnimationFrame(() => document.getElementById(tabId(sessionId))?.focus());
    };

    const openMenu = (sessionId: string, anchor: HTMLElement) => {
        const rect = anchor.getBoundingClientRect();
        setMenu({ sessionId, x: rect.left, y: rect.bottom + 4 });
    };

    // A key press is easier to make by mistake than a click on ×: a live
    // session closed from the keyboard asks first.
    const closeFromKeyboard = async (session: TerminalSessionInfo) => {
        if (session.state === 'connected') {
            const name = sessionName(session, t);
            const ok = await confirm({
                title: t('terminal.tabs.closeConfirmTitle', { name }),
                message: t('terminal.tabs.closeConfirmText'),
                confirmLabel: t('terminal.tabs.closeConfirm'),
                tone: 'danger'
            });
            if (!ok) {
                requestAnimationFrame(() => document.getElementById(tabId(session.id))?.focus());
                return;
            }
        }
        onClose(session.id);
    };

    const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, session: TerminalSessionInfo, index: number) => {
        const move = (target: TerminalSessionInfo | undefined) => {
            if (!target) return;
            event.preventDefault();
            focusTab(target.id);
        };
        if (event.key === 'ArrowRight') move(sessions[(index + 1) % sessions.length]);
        else if (event.key === 'ArrowLeft') move(sessions[(index - 1 + sessions.length) % sessions.length]);
        else if (event.key === 'Home') move(sessions[0]);
        else if (event.key === 'End') move(sessions[sessions.length - 1]);
        else if (event.key === 'F2') {
            event.preventDefault();
            startRename(session);
        } else if (event.key === 'Delete') {
            event.preventDefault();
            void closeFromKeyboard(session);
        } else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
            event.preventDefault();
            openMenu(session.id, event.currentTarget);
        }
    };

    // The tab may have been closed meanwhile (Mod+Shift+W): then no menu.
    const menuSession = menu ? sessions.find((item) => item.id === menu.sessionId) : undefined;

    return (
        <div className={cn('flex min-w-0 items-center gap-1', className)}>
            <span id={helpId} hidden>{t('terminal.tabs.keyHelp')}</span>
            <div role="tablist" aria-label={t('terminal.tabs.label')} className="flex min-w-0 items-center gap-0.5 overflow-x-auto scrollbar-thin">
                {sessions.map((session, index) => {
                    const name = sessionName(session, t);
                    const selected = session.id === focusedId;
                    const shown = !selected && Boolean(shownIds?.has(session.id));
                    const member = Boolean(broadcast?.members.has(session.id));
                    return (
                        <div
                            key={session.id}
                            className={cn(
                                'flex h-7 shrink-0 items-center gap-0.5 rounded-md border pl-1 pr-0.5 transition-colors',
                                selected ? 'border-white/10 bg-white/[0.07] text-zinc-100'
                                    : shown ? 'border-white/[0.06] text-zinc-300 hover:bg-white/[0.04] hover:text-zinc-100'
                                        : 'border-transparent text-zinc-400 hover:bg-white/[0.04] hover:text-zinc-200'
                            )}
                        >
                            {editing === session.id ? (
                                <input
                                    ref={inputRef}
                                    value={draft}
                                    aria-label={t('terminal.tabs.renameLabel')}
                                    onChange={(event) => setDraft(event.target.value)}
                                    onBlur={() => finishRename(true)}
                                    onKeyDown={(event) => {
                                        if (event.key === 'Enter') finishRename(true);
                                        else if (event.key === 'Escape') finishRename(false);
                                    }}
                                    maxLength={40}
                                    className="h-6 w-32 rounded bg-ink-900 px-1.5 text-xs text-zinc-100 outline-none ring-1 ring-brand-500/60"
                                />
                            ) : (
                                <button
                                    type="button"
                                    role="tab"
                                    id={tabId(session.id)}
                                    aria-selected={selected}
                                    aria-controls={panelId(session.id)}
                                    aria-describedby={helpId}
                                    aria-keyshortcuts="Delete F2 Shift+F10"
                                    tabIndex={selected ? 0 : -1}
                                    onClick={() => onFocus(session.id)}
                                    onDoubleClick={() => startRename(session)}
                                    onKeyDown={(event) => onTabKeyDown(event, session, index)}
                                    onContextMenu={(event: MouseEvent<HTMLButtonElement>) => {
                                        // Not selected: picking a tab shows it in the active pane.
                                        event.preventDefault();
                                        setMenu({ sessionId: session.id, x: event.clientX, y: event.clientY });
                                    }}
                                    draggable={Boolean(onDragStart)}
                                    onDragStart={onDragStart ? (event) => onDragStart(session.id, event) : undefined}
                                    onDragEnd={onDragEnd}
                                    className="flex h-6 max-w-[11rem] items-center gap-1.5 rounded px-1.5 text-xs font-medium outline-none focus-visible:ring-1 focus-visible:ring-brand-500/70"
                                >
                                    {/* While connecting a spinner, in the tab rather than over the terminal's first rows. */}
                                    <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                                        {session.state === 'connecting'
                                            ? <RotateCw className="h-3 w-3 animate-spin text-amber-300" aria-hidden="true" />
                                            : <StatusDot state={session.state} />}
                                    </span>
                                    {session.attach?.kind === 'pod' && <ShipWheel className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />}
                                    {session.attach?.kind === 'container' && <Container className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />}
                                    <span className="truncate">{name}</span>
                                    {member && (
                                        <>
                                            <Radio className={cn('h-3 w-3 shrink-0', broadcast?.active ? 'text-amber-300' : 'text-zinc-500')} aria-hidden="true" />
                                            <span className="sr-only">{`, ${broadcast?.active ? t('terminal.broadcast.receiving') : t('terminal.broadcast.inGroup')}`}</span>
                                        </>
                                    )}
                                </button>
                            )}
                            {selected && editing !== session.id && (
                                <button
                                    type="button"
                                    tabIndex={-1}
                                    aria-hidden="true"
                                    onMouseDown={keepFocus}
                                    onClick={(event) => openMenu(session.id, event.currentTarget)}
                                    title={t('terminal.tabs.options', { name })}
                                    className={tabButtonClass}
                                >
                                    <MoreHorizontal className="h-3.5 w-3.5" />
                                </button>
                            )}
                            <button
                                type="button"
                                tabIndex={-1}
                                aria-hidden="true"
                                onMouseDown={keepFocus}
                                onClick={() => onClose(session.id)}
                                title={t('terminal.tabs.close', { name })}
                                className={tabButtonClass}
                            >
                                <X className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    );
                })}
            </div>
            <button
                type="button"
                onClick={onNew}
                aria-label={t('terminal.tabs.newTab')}
                title={newTabShortcut ? `${t('terminal.tabs.newTab')} (${newTabShortcut})` : t('terminal.tabs.newTab')}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-ring"
            >
                <Plus className="h-4 w-4" />
            </button>

            {menuSession && menu && (
                <ContextMenu
                    x={menu.x}
                    y={menu.y}
                    label={t('terminal.tabs.options', { name: sessionName(menuSession, t) })}
                    items={[
                        { id: 'rename', label: t('terminal.tabs.rename'), icon: <Pencil className="h-4 w-4" />, hint: 'F2', onSelect: () => startRename(menuSession) },
                        { id: 'duplicate', label: t('terminal.tabs.duplicate'), icon: <CopyPlus className="h-4 w-4" />, onSelect: () => onDuplicate(menuSession.id) },
                        ...(menuItems?.(menuSession) ?? []),
                        'separator',
                        { id: 'close', label: t('terminal.tabs.closeTab'), icon: <X className="h-4 w-4" />, hint: 'Del', onSelect: () => onClose(menuSession.id) }
                    ]}
                    onClose={() => setMenu(null)}
                />
            )}
        </div>
    );
}
