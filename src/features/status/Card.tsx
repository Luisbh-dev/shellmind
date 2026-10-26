import { useId, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { TILE_PADDING } from './layout';
import { ToneBadge } from './Meter';
import type { Tone } from './thresholds';

// The cards of the status dashboard: a solid ink-800 surface (the colour the
// chart rings and meter notches are cut with) and a hairline border.

export const CARD = 'min-w-0 rounded-xl border border-white/[0.07] bg-ink-800';

type CardProps = {
    title: string;
    icon?: ReactNode;
    // Under the title (a window, a hint).
    subtitle?: ReactNode;
    // Right of the title (legend, stats, toggles).
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
};

export function Card({ title, icon, subtitle, actions, children, className }: CardProps) {
    const titleId = useId();
    return (
        <section aria-labelledby={titleId} className={cn(CARD, 'flex flex-col gap-3 p-4', className)}>
            <div className="flex items-start justify-between gap-x-3">
                <div className="min-w-0 flex-1">
                    <h3 id={titleId} className="flex min-w-0 items-center gap-1.5 text-[13px] font-semibold text-zinc-100">
                        {icon && <span className="shrink-0 text-zinc-500 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">{icon}</span>}
                        <span className="truncate">{title}</span>
                    </h3>
                    {subtitle && <div className="mt-0.5 text-[11px] text-zinc-500">{subtitle}</div>}
                </div>
                {actions && <div className="flex shrink-0 items-center gap-x-2">{actions}</div>}
            </div>
            {children}
        </section>
    );
}

type StatTileProps = {
    icon: ReactNode;
    label: string;
    tone?: Tone;
    // Tooltip of the label.
    hint?: string;
    // The headline figure and its unit ("42.5" + "%").
    value?: ReactNode;
    unit?: string;
    // Next to the figure (used / total).
    aside?: ReactNode;
    // The meter(s).
    children?: ReactNode;
    // Small print at the bottom.
    footer?: ReactNode;
    className?: string;
};

// A KPI: label, figure (proportional digits, sans), meter and small print.
// The tile is a query container too, so what is inside can tighten when two
// tiles share a narrow row.
export function StatTile({ icon, label, hint, tone = 'ok', value, unit, aside, children, footer, className }: StatTileProps) {
    const titleId = useId();
    return (
        <section aria-labelledby={titleId} className={cn(CARD, 'flex flex-col gap-2.5 [container-type:inline-size]', TILE_PADDING, className)}>
            {/* In a narrow tile the badge wraps under the label rather than cutting it short. */}
            <div className="flex min-h-5 flex-wrap items-center justify-between gap-x-2 gap-y-1">
                <h3 id={titleId} title={hint} className="flex min-w-0 max-w-full items-center gap-1.5 text-xs font-medium text-zinc-400">
                    <span className="shrink-0 text-zinc-500 [&>svg]:h-3.5 [&>svg]:w-3.5" aria-hidden="true">{icon}</span>
                    <span className="min-w-0 truncate">{label}</span>
                </h3>
                <ToneBadge tone={tone} />
            </div>
            {value !== undefined && (
                <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
                    <span className="shrink-0 text-2xl font-semibold leading-none tracking-tight text-zinc-50">
                        {value}
                        {unit && <span className="ml-0.5 text-base font-medium text-zinc-400">{unit}</span>}
                    </span>
                    {aside && <span className="min-w-0 max-w-full truncate text-xs text-zinc-400">{aside}</span>}
                </div>
            )}
            {children}
            {footer && <div className="mt-auto text-[11px] leading-4 text-zinc-500">{footer}</div>}
        </section>
    );
}
