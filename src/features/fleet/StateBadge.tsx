// How a fleet state looks: an icon (the shape tells the states apart without
// colour), a colour and a word. Shared by the board, the sidebar dot and the
// welcome card.
import { AlertCircle, AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, HelpCircle, Loader2, Server, ServerOff, type LucideIcon } from 'lucide-react';
import type { FleetSnapshot, FleetState } from '@shared/fleet';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { stateName } from './model';

type StateStyle = { icon: LucideIcon; text: string; tint: string; dot: string };

export const STATE_STYLE: Record<FleetState, StateStyle> = {
    critical: { icon: AlertOctagon, text: 'text-rose-300', tint: 'bg-rose-500/10 border-rose-500/30', dot: 'bg-rose-500' },
    unreachable: { icon: ServerOff, text: 'text-rose-300', tint: 'bg-rose-500/10 border-rose-500/30', dot: 'bg-rose-500' },
    error: { icon: AlertCircle, text: 'text-orange-300', tint: 'bg-orange-500/10 border-orange-500/30', dot: 'bg-orange-400' },
    warn: { icon: AlertTriangle, text: 'text-amber-300', tint: 'bg-amber-500/10 border-amber-500/30', dot: 'bg-amber-400' },
    ok: { icon: CheckCircle2, text: 'text-emerald-300', tint: 'bg-emerald-500/10 border-emerald-500/25', dot: 'bg-emerald-400' },
    // Answers, but no current health reading: neutral, not green.
    up: { icon: Server, text: 'text-sky-300', tint: 'bg-sky-500/10 border-sky-500/25', dot: 'bg-sky-400' },
    unknown: { icon: HelpCircle, text: 'text-zinc-400', tint: 'bg-white/[0.04] border-white/10', dot: 'bg-zinc-500' }
};

// Text colour of a reading of the given tone.
export const TONE_TEXT = { ok: 'text-zinc-200', warn: 'text-amber-300', critical: 'text-rose-300' } as const;

// The shape that tells a warning or critical reading apart without colour.
export const TONE_ICON = { warn: AlertTriangle, critical: AlertOctagon } as const;

export function stateIcon(state: FleetState, snapshot: FleetSnapshot | null): LucideIcon {
    return state === 'unknown' && !snapshot?.checkedAt ? CircleDashed : STATE_STYLE[state].icon;
}

// The state as a small pill (icon + word). `checking` shows a spinner in
// front of it; `stale` dims it (the reading is old).
export function StateBadge({ id, state, snapshot, checking, stale, className }: {
    id?: string;
    state: FleetState;
    snapshot: FleetSnapshot | null;
    checking?: boolean;
    stale?: boolean;
    className?: string;
}) {
    const t = useT();
    const style = STATE_STYLE[state];
    const Icon = stateIcon(state, snapshot);
    return (
        <span
            id={id}
            className={cn(
                'inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium leading-4',
                style.tint,
                style.text,
                stale && 'opacity-60',
                className
            )}
        >
            {checking
                ? <Loader2 className="h-3 w-3 shrink-0 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                : <Icon className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="truncate">{stateName(t, { state, snapshot })}</span>
            {checking && <span className="sr-only">{t('fleet.state.checking')}</span>}
        </span>
    );
}

// The sidebar's mark of a server that needs attention: a dot in the state's
// colour with its icon's shape cue (a ring for a stale reading).
export function HealthDot({ state, stale, label, className }: { state: FleetState; stale: boolean; label: string; className?: string }) {
    const style = STATE_STYLE[state];
    return (
        <span
            role="img"
            aria-label={label}
            title={label}
            data-fleet-state={state}
            className={cn(
                'inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full ring-2 ring-ink-850',
                stale ? 'border-[1.5px] border-current bg-ink-850' : style.dot,
                stale && style.text,
                className
            )}
        >
            {!stale && (state === 'critical' || state === 'unreachable' || state === 'error') && (
                <span aria-hidden="true" className="h-1 w-1 rounded-full bg-fixed-white/90" />
            )}
        </span>
    );
}
