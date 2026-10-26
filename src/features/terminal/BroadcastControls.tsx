import { forwardRef, useCallback, useEffect, useId, useRef, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Radio, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { Button } from '@/components/ui/Button';
import { Checkbox } from '@/components/ui/Checkbox';
import { useConfirm } from '@/components/ui/Confirm';
import { useOverlay } from '@/components/ui/overlayStack';
import { usePopoverStyle } from '@/components/ui/popover';
import { StatusDot } from '@/components/ui/StatusDot';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useAppStore } from '@/store/appStore';
import { formatShortcut } from '@/workspace/actions/registry';
import {
    broadcastKey, parseBroadcastKey, serversOf, setMembers, startBroadcast, stopBroadcast, useBroadcast
} from './broadcast';
import { PANE_SHORTCUTS } from './keyboard';
import { serverName } from './names';
import { sessionName } from './SessionTabBar';

const PICKER_WIDTH = 352;
const quickClass = 'inline-flex h-7 items-center rounded-md px-2 text-[11px] font-semibold text-zinc-300 transition-colors hover:bg-white/[0.06] hover:text-zinc-100 focus-ring disabled:pointer-events-none disabled:opacity-40';

// Starting broadcast input, and adding a terminal of another server to it,
// ask first when more than one server would get the keys.
export function useBroadcastActions() {
    const t = useT();
    const confirm = useConfirm();

    const askServers = useCallback(async (keys: readonly string[]): Promise<boolean> => {
        const servers = serversOf(keys);
        if (servers.length < 2) return true;
        const list = servers
            .map((serverId) => `${serverName(serverId)} (${keys.filter((key) => parseBroadcastKey(key)?.serverId === serverId).length})`)
            .join(', ');
        return confirm({
            title: t('terminal.broadcast.serversTitle', { count: servers.length }),
            message: t('terminal.broadcast.serversText', { count: keys.length, list }),
            confirmLabel: t('terminal.broadcast.serversConfirm')
        });
    }, [confirm, t]);

    const start = useCallback(async (keys: readonly string[], leader: string | null): Promise<boolean> => {
        if (new Set(keys).size < 2 || !(await askServers(keys))) return false;
        return startBroadcast(keys, leader);
    }, [askServers]);

    // Adding terminals of a server not typed into yet asks once, about the
    // whole group they make.
    const setMembership = useCallback(async (keys: readonly string[], member: boolean): Promise<void> => {
        const state = useBroadcast.getState();
        const added = member ? keys.filter((key) => !state.members.includes(key)) : [];
        if (state.active && serversOf(added).some((serverId) => !state.servers.includes(serverId))) {
            if (!(await askServers([...state.members, ...new Set(added)]))) return;
        }
        setMembers(keys, member);
    }, [askServers]);

    return { start, setMembership, stop: () => stopBroadcast() };
}

// The header button: opens the picker; shows how many terminals get the
// keys while broadcasting (amber only where what is typed is broadcast:
// `included`).
export const BroadcastButton = forwardRef<HTMLButtonElement, { open: boolean; included: boolean; onToggle: () => void }>(function BroadcastButton({ open, included, onToggle }, ref) {
    const t = useT();
    const { active, count } = useBroadcast(useShallow((state) => ({ active: state.active, count: state.members.length })));
    const label = !active ? t('terminal.broadcast.button')
        : included ? t('terminal.broadcast.buttonActive', { count }) : t('terminal.broadcast.buttonElsewhere', { count });
    return (
        <button
            ref={ref}
            type="button"
            onClick={onToggle}
            aria-haspopup="dialog"
            aria-expanded={open}
            aria-label={label}
            title={`${label} (${formatShortcut(PANE_SHORTCUTS.broadcast)})`}
            className={cn(
                'relative inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-lg px-1.5 text-xs font-bold transition-colors focus-ring',
                active && included
                    ? 'bg-amber-500/20 text-amber-200 ring-1 ring-inset ring-amber-400/50 hover:bg-amber-500/30'
                    : active ? 'text-zinc-300 ring-1 ring-inset ring-white/15 hover:bg-white/[0.06] hover:text-zinc-100'
                        : open ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100'
            )}
        >
            <Radio className="h-4 w-4" aria-hidden="true" />
            {active && <span aria-hidden="true" className="tabular-nums">{count}</span>}
        </button>
    );
});

// Picks the terminals of the group, from every open server (the one on
// screen first), and starts or stops broadcasting.
export function BroadcastPicker({ anchor, serverId, onScreen, leader, onClose, onStarted }: {
    anchor: RefObject<HTMLElement | null>;
    serverId: number;
    // The tabs shown in the panes of this server, in order.
    onScreen: readonly string[];
    // The focused terminal (the others are compared with it).
    leader: string | null;
    onClose: () => void;
    // Broadcasting started from here (the picker is closed by then).
    onStarted: () => void;
}) {
    const t = useT();
    const titleId = useId();
    const textId = useId();
    const rootRef = useRef<HTMLDivElement>(null);
    const style = usePopoverStyle(anchor, true, { minWidth: PICKER_WIDTH, maxHeight: 480, align: 'end' });
    const terminalSessions = useAppStore((state) => state.terminalSessions);
    const openServerIds = useAppStore((state) => state.openServerIds);
    const { active, members, paused } = useBroadcast(useShallow((state) => ({ active: state.active, members: state.members, paused: state.paused })));
    const actions = useBroadcastActions();
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useOverlay(true, () => onCloseRef.current());

    useEffect(() => {
        const onPointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (rootRef.current?.contains(target) || anchor.current?.contains(target)) return;
            // A confirmation the picker asked for sits on top of it.
            if ((target as Element).closest?.('[role="alertdialog"]')) return;
            onCloseRef.current();
        };
        window.addEventListener('mousedown', onPointerDown);
        return () => window.removeEventListener('mousedown', onPointerDown);
    }, [anchor]);

    const placed = style !== null;
    useEffect(() => {
        if (placed) rootRef.current?.querySelector<HTMLElement>('input, button')?.focus();
    }, [placed]);

    const order = [serverId, ...openServerIds.filter((id) => id !== serverId)];
    for (const key of Object.keys(terminalSessions).map(Number)) if (!order.includes(key)) order.push(key);
    const groups = order
        .map((id) => ({ id, sessions: terminalSessions[id]?.sessions ?? [] }))
        .filter((group) => group.sessions.length > 0);
    const total = groups.reduce((sum, group) => sum + group.sessions.length, 0);
    const canStart = members.length >= 2;

    const start = async () => {
        if (await actions.start(members, leader)) onStarted();
    };

    return createPortal(
        <div
            ref={rootRef}
            role="dialog"
            aria-labelledby={titleId}
            aria-describedby={textId}
            style={{ position: 'fixed', ...(style ?? {}), visibility: style ? 'visible' : 'hidden' }}
            className="z-50 flex flex-col overflow-hidden rounded-xl border border-white/10 bg-ink-800 shadow-panel animate-slide-up"
        >
            <header className="flex items-start gap-2.5 border-b border-white/5 bg-white/[0.02] px-3 py-2.5">
                <span className={cn('mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg', active ? 'bg-amber-500/20 text-amber-300' : 'bg-white/[0.05] text-zinc-300')}>
                    <Radio className="h-4 w-4" aria-hidden="true" />
                </span>
                <div className="min-w-0 flex-1">
                    <h2 id={titleId} className="text-sm font-semibold text-zinc-100">{t('terminal.broadcast.title')}</h2>
                    <p className="text-[11px] text-zinc-400">{t('terminal.broadcast.subtitle')}</p>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('terminal.broadcast.close')}
                    title={t('terminal.broadcast.close')}
                    className="rounded-md p-1 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100 focus-ring"
                >
                    <X className="h-4 w-4" />
                </button>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3 pt-2">
                <p id={textId} className="text-[11px] leading-relaxed text-zinc-400">{t('terminal.broadcast.explain')}</p>
                {groups.map((group) => (
                    <fieldset key={group.id} className="mt-3">
                        <legend className="mb-1.5 text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                            {group.id === serverId ? t('terminal.broadcast.onScreen', { name: serverName(group.id) }) : serverName(group.id)}
                        </legend>
                        <div className="space-y-1.5">
                            {group.sessions.map((session) => {
                                const key = broadcastKey(group.id, session.id);
                                const reason = active ? paused[key] : undefined;
                                return (
                                    <Checkbox
                                        key={session.id}
                                        checked={members.includes(key)}
                                        onChange={(checked) => void actions.setMembership([key], checked)}
                                        label={(
                                            <span className="inline-flex items-center gap-1.5">
                                                <StatusDot state={session.state} />
                                                {sessionName(session, t)}
                                            </span>
                                        )}
                                        description={reason ? t(`terminal.broadcast.paused.${reason}`) : undefined}
                                    />
                                );
                            })}
                        </div>
                    </fieldset>
                ))}
                {total < 2 && <p className="mt-3 rounded-lg bg-white/[0.03] px-2.5 py-2 text-xs text-zinc-300">{t('terminal.broadcast.nothingElse')}</p>}
                <div className="mt-3 flex items-center gap-1 border-t border-white/5 pt-2">
                    <button
                        type="button"
                        disabled={onScreen.length < 2}
                        onClick={() => void actions.setMembership(onScreen, true)}
                        className={quickClass}
                    >
                        {t('terminal.broadcast.selectPanes')}
                    </button>
                    <button
                        type="button"
                        disabled={!members.length}
                        onClick={() => {
                            // Clearing the group is stopping it: no "fewer than two left" notice.
                            actions.stop();
                            setMembers(members, false);
                        }}
                        className={quickClass}
                    >
                        {t('terminal.broadcast.clear')}
                    </button>
                    <span className="ml-auto whitespace-nowrap text-[11px] tabular-nums text-zinc-400">{t('terminal.broadcast.selected', { count: members.length })}</span>
                </div>
            </div>

            <footer className="flex items-center gap-3 border-t border-white/5 px-3 py-2.5">
                <p className="min-w-0 flex-1 text-[11px] text-zinc-400" aria-live="polite">{canStart ? '' : t('terminal.broadcast.pickTwo')}</p>
                {active ? (
                    <Button variant="secondary" size="sm" onClick={() => actions.stop()}>{t('terminal.broadcast.stop')}</Button>
                ) : (
                    <Button variant="primary" size="sm" disabled={!canStart} onClick={() => void start()}>{t('terminal.broadcast.start')}</Button>
                )}
            </footer>
        </div>,
        document.body
    );
}

// Across the top of every terminal panel while broadcasting: amber where
// what is typed is broadcast (`included`), a plain note elsewhere saying
// where it happens.
export function BroadcastBar({ included, onChoose }: { included: boolean; onChoose: () => void }) {
    const t = useT();
    const members = useBroadcast((state) => state.members);
    const count = members.length;
    const servers = serversOf(members);
    const shortcut = formatShortcut(PANE_SHORTCUTS.broadcast);
    const title = !included
        ? t('terminal.broadcast.barElsewhere', { count, servers: servers.map(serverName).join(', ') })
        : servers.length > 1 ? t('terminal.broadcast.barServers', { count, servers: servers.length }) : t('terminal.broadcast.bar', { count });
    return (
        <div
            role="status"
            className={cn(
                'flex shrink-0 items-center gap-2.5 border-b px-3 py-1.5 text-xs animate-fade-in',
                included ? 'border-amber-400/30 bg-amber-500/[0.14] text-amber-50' : 'border-white/5 bg-white/[0.03] text-zinc-300'
            )}
        >
            <span className={cn('relative flex h-5 w-5 shrink-0 items-center justify-center rounded-md', included ? 'bg-amber-400/25 text-amber-200' : 'bg-white/[0.06] text-zinc-400')}>
                <Radio className="h-3.5 w-3.5" aria-hidden="true" />
            </span>
            {/* The terminal panel is a container: a narrow one keeps the
                essentials, on two lines rather than cut, and the whole
                sentence is the tooltip. */}
            <p className="min-w-0 flex-1 break-words leading-snug" title={`${title}. ${t(included ? 'terminal.broadcast.barHint' : 'terminal.broadcast.barElsewhereHint')}`}>
                <span className="font-semibold">{title}</span>
                <span className={cn('ml-2 hidden [@container(min-width:48rem)]:inline', included ? 'text-amber-100/80' : 'text-zinc-400')}>
                    {included ? t('terminal.broadcast.barHint') : t('terminal.broadcast.barElsewhereHint')}
                </span>
            </p>
            <button
                type="button"
                onClick={onChoose}
                className={cn(
                    'inline-flex h-6 shrink-0 items-center rounded-md px-2 text-[11px] font-semibold transition-colors hover:bg-white/10 focus-ring',
                    included ? 'text-amber-100' : 'text-zinc-300 hover:text-zinc-100'
                )}
            >
                {t('terminal.broadcast.choose')}
            </button>
            <button
                type="button"
                onClick={() => stopBroadcast()}
                title={`${t('terminal.broadcast.stop')} (${shortcut})`}
                className={cn(
                    'inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] font-semibold transition-colors focus-ring',
                    included ? 'border-amber-400/40 text-amber-100 hover:bg-amber-500/20' : 'border-white/10 text-zinc-300 hover:bg-white/[0.06] hover:text-zinc-100'
                )}
            >
                {t('terminal.broadcast.stop')}
                <kbd className={cn('hidden font-sans text-[10px] font-medium [@container(min-width:36rem)]:inline', included ? 'text-amber-200/80' : 'text-zinc-400')}>{shortcut}</kbd>
            </button>
        </div>
    );
}
