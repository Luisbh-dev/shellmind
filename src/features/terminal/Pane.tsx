import { useState, type DragEvent, type MouseEvent } from 'react';
import { Columns2, Container, Hourglass, Keyboard, PauseCircle, Radio, RotateCw, Rows2, ShipWheel, X } from 'lucide-react';
import { StatusDot } from '@/components/ui/StatusDot';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import type { TerminalSessionInfo } from '@/store/appStore';
import type { PauseReason } from './broadcast';
import type { DropEdge } from './layout';

// What a dragged terminal tab carries (only within the server's panel).
export const SESSION_DRAG_TYPE = 'application/x-shellmind-terminal-tab';

export type PaneBroadcast = {
    // In the broadcast group.
    member: boolean;
    // Broadcasting now, and this pane gets what is typed.
    receiving: boolean;
    paused?: PauseReason;
};

// 24 px targets (WCAG 2.5.8).
const buttonClass = 'flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-100 focus-ring';

// A click on a pane's button leaves the keys in the terminal they were in
// (the panel also ignores focus inside a pane's strip: see TerminalPanel).
const keepFocus = (event: MouseEvent) => event.preventDefault();

// The strip above a pane (several panes, or one that broadcasts): its tab's
// name and state, whether it takes part in broadcast input, and the pane's
// own buttons. Dragging it moves the tab to another pane, like dragging the tab.
export function PaneHeader({
    session,
    name,
    multi,
    active,
    canSplit,
    broadcast,
    onActivate,
    onSplit,
    onClose,
    onToggleBroadcast,
    onIncludeAnyway,
    onDragStart,
    onDragEnd
}: {
    session: TerminalSessionInfo;
    name: string;
    multi: boolean;
    active: boolean;
    canSplit: boolean;
    broadcast: PaneBroadcast;
    onActivate: () => void;
    onSplit: (direction: 'row' | 'column') => void;
    onClose: () => void;
    onToggleBroadcast: () => void;
    onIncludeAnyway: () => void;
    onDragStart: (event: DragEvent<HTMLElement>) => void;
    onDragEnd: () => void;
}) {
    const t = useT();
    const { member, receiving, paused } = broadcast;
    const fullScreenPause = paused === 'full-screen' || paused === 'not-full-screen';
    // Paused for a reason that needs the user's eye (not just "on hold" for a moment).
    const attention = paused !== undefined && paused !== 'waiting';
    const pauseText = paused ? t(`terminal.broadcast.paused.${paused}`) : '';
    // Clicks on the strip itself (not its buttons) go to the terminal; a
    // press that turns into a drag moves the tab instead.
    const onStripClick = (event: MouseEvent<HTMLDivElement>) => {
        if ((event.target as HTMLElement).closest('button')) return;
        onActivate();
    };

    return (
        // A container: in a narrow pane the strip keeps the name and drops what the Layout menu also offers.
        <div data-pane-header="" className="shrink-0 [container-type:inline-size]">
            {/* The strip is a mouse convenience (activate, drag); its buttons carry the keyboard actions. */}
            {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
            <div
                draggable
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                onClick={onStripClick}
                title={t('terminal.panes.dragHint')}
                className={cn(
                    'flex h-7 cursor-grab items-center gap-1 border-b pl-2 pr-0.5 text-[11px] active:cursor-grabbing',
                    !receiving
                        ? active && multi ? 'border-white/[0.06] bg-white/[0.05] text-zinc-100' : 'border-white/[0.04] bg-ink-850/60 text-zinc-400'
                        : !paused ? 'border-amber-400/30 bg-amber-500/[0.14] text-amber-50'
                            : attention ? 'border-rose-400/25 bg-rose-500/[0.10] text-zinc-100' : 'border-white/[0.06] bg-white/[0.04] text-zinc-300'
                )}
            >
                <span className="flex h-3 w-3 shrink-0 items-center justify-center">
                    {session.state === 'connecting'
                        ? <RotateCw className="h-3 w-3 animate-spin text-amber-300" aria-hidden="true" />
                        : <StatusDot state={session.state} />}
                </span>
                {session.attach?.kind === 'pod' && <ShipWheel className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />}
                {session.attach?.kind === 'container' && <Container className="h-3.5 w-3.5 shrink-0 text-sky-300" aria-hidden="true" />}
                {/* The name gives way first: a paused pane keeps saying why (a narrow one drops the name, which its tooltip keeps). */}
                <span className={cn('min-w-0 shrink-[10] truncate font-medium', active && multi && !receiving && 'text-zinc-100', paused && '[@container(max-width:15rem)]:hidden')}>{name}</span>

                {receiving && !paused && (
                    <span className="ml-1 inline-flex h-5 shrink-0 items-center gap-1 rounded bg-amber-400/25 px-1.5 text-[10px] font-bold uppercase tracking-wide text-amber-200">
                        <Radio className="h-3 w-3" aria-hidden="true" />
                        <span className="sr-only [@container(min-width:15rem)]:not-sr-only">{t('terminal.broadcast.receiving')}</span>
                    </span>
                )}
                {receiving && paused && (
                    <span
                        title={`${name}: ${pauseText}. ${t('terminal.broadcast.notReceiving')}`}
                        className={cn(
                            'ml-1 inline-flex h-5 min-w-0 shrink items-center gap-1 rounded px-1.5 text-[10px] font-semibold',
                            attention ? 'bg-rose-500/20 text-rose-200' : 'bg-white/[0.08] text-zinc-300'
                        )}
                    >
                        {attention
                            ? <PauseCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                            : <Hourglass className="h-3 w-3 shrink-0" aria-hidden="true" />}
                        <span aria-hidden="true" className="truncate">{t(`terminal.broadcast.pausedShort.${paused}`)}</span>
                        <span className="sr-only">{pauseText}</span>
                    </span>
                )}
                {receiving && fullScreenPause && (
                    <button
                        type="button"
                        onMouseDown={keepFocus}
                        onClick={onIncludeAnyway}
                        aria-label={t('terminal.broadcast.includeAnywayOf', { name })}
                        title={t('terminal.broadcast.includeAnywayOf', { name })}
                        className="ml-0.5 inline-flex h-6 min-w-6 shrink-0 items-center justify-center gap-1 rounded px-1 text-[10px] font-semibold text-rose-100 underline-offset-2 hover:bg-white/10 hover:underline focus-ring"
                    >
                        <Keyboard className="h-3.5 w-3.5 [@container(min-width:20rem)]:hidden" aria-hidden="true" />
                        <span className="hidden whitespace-nowrap [@container(min-width:20rem)]:inline">{t('terminal.broadcast.includeAnyway')}</span>
                    </button>
                )}

                <span className="min-w-0 flex-1" />

                <button
                    type="button"
                    onMouseDown={keepFocus}
                    onClick={onToggleBroadcast}
                    aria-pressed={member}
                    aria-label={member ? t('terminal.broadcast.exclude', { name }) : t('terminal.broadcast.include', { name })}
                    title={member ? t('terminal.broadcast.exclude', { name }) : t('terminal.broadcast.include', { name })}
                    className={cn(buttonClass, member && (receiving ? 'text-amber-300 hover:text-amber-200' : 'text-brand-300'))}
                >
                    <Radio className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
                {multi && (
                    <>
                        {canSplit && (
                            // A paused pane keeps room for why it is paused.
                            <span className={cn('hidden items-center gap-1', paused ? '[@container(min-width:26rem)]:flex' : '[@container(min-width:16rem)]:flex')}>
                                <button type="button" onMouseDown={keepFocus} onClick={() => onSplit('row')} aria-label={t('terminal.panes.splitRightOf', { name })} title={t('terminal.panes.splitRightOf', { name })} className={buttonClass}>
                                    <Columns2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                                <button type="button" onMouseDown={keepFocus} onClick={() => onSplit('column')} aria-label={t('terminal.panes.splitDownOf', { name })} title={t('terminal.panes.splitDownOf', { name })} className={buttonClass}>
                                    <Rows2 className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            </span>
                        )}
                        <button
                            type="button"
                            onMouseDown={keepFocus}
                            onClick={onClose}
                            aria-label={t('terminal.panes.closePaneOf', { name })}
                            title={t('terminal.panes.closePaneOf', { name })}
                            className={cn(buttonClass, paused && '[@container(max-width:15rem)]:hidden')}
                        >
                            <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}

// Within this fraction of a side, a drop opens a new pane on that side.
const EDGE = 0.25;

function edgeAt(event: DragEvent<HTMLElement>): DropEdge | null {
    const box = event.currentTarget.getBoundingClientRect();
    if (!box.width || !box.height) return null;
    const x = (event.clientX - box.left) / box.width;
    const y = (event.clientY - box.top) / box.height;
    const distances: Array<[DropEdge, number]> = [['left', x], ['right', 1 - x], ['top', y], ['bottom', 1 - y]];
    const [edge, distance] = distances.reduce((best, item) => (item[1] < best[1] ? item : best));
    return distance < EDGE ? edge : null;
}

const ZONE_CLASS: Record<DropEdge | 'center', string> = {
    center: 'inset-2',
    left: 'inset-y-2 left-2 w-[calc(50%-0.75rem)]',
    right: 'inset-y-2 right-2 w-[calc(50%-0.75rem)]',
    top: 'inset-x-2 top-2 h-[calc(50%-0.75rem)]',
    bottom: 'inset-x-2 bottom-2 h-[calc(50%-0.75rem)]'
};

// Over a pane while a tab is dragged: the middle shows the tab here, a side
// opens a new pane there (`canSplit`: a pane can still be added).
export function DropTargets({ canSplit, onDrop }: { canSplit: boolean; onDrop: (edge: DropEdge | null) => void }) {
    const t = useT();
    const [zone, setZone] = useState<DropEdge | 'center' | null>(null);
    const accepts = (event: DragEvent<HTMLElement>) => event.dataTransfer.types.includes(SESSION_DRAG_TYPE);

    return (
        <div
            aria-hidden="true"
            data-drop-target=""
            className="absolute inset-0 z-30"
            onDragOver={(event) => {
                if (!accepts(event)) return;
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                const edge = canSplit ? edgeAt(event) : null;
                setZone(edge ?? 'center');
            }}
            onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setZone(null);
            }}
            onDrop={(event) => {
                if (!accepts(event)) return;
                event.preventDefault();
                setZone(null);
                onDrop(canSplit ? edgeAt(event) : null);
            }}
        >
            {zone && (
                <div className={cn('pointer-events-none absolute flex items-center justify-center rounded-lg border-2 border-dashed border-brand-400/80 bg-brand-500/15 animate-fade-in', ZONE_CLASS[zone])}>
                    <span className="rounded-md bg-ink-800/95 px-2 py-1 text-xs font-semibold text-zinc-100 shadow-soft">
                        {t(`terminal.panes.drop.${zone}`)}
                    </span>
                </div>
            )}
        </div>
    );
}
