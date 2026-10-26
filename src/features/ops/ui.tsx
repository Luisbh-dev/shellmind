import { useId, useRef, type KeyboardEvent, type ReactNode, type Ref } from 'react';
import { AlertTriangle, ChevronRight, Search, X } from 'lucide-react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeOpsError } from './errors';

// Building blocks shared by the services, containers and logs views.

export type BadgeTone = 'ok' | 'warn' | 'bad' | 'idle';

// The key of a count's text: `<key>One` for exactly one ("1 container").
export const countKey = (key: string, count: number) => (count === 1 ? `${key}One` : key);

const BADGE: Record<BadgeTone, { dot: string; text: string }> = {
    ok: { dot: 'bg-emerald-400', text: 'text-emerald-200 border-emerald-500/30 bg-emerald-500/[0.08]' },
    warn: { dot: 'bg-amber-400', text: 'text-amber-200 border-amber-500/30 bg-amber-500/[0.08]' },
    bad: { dot: 'bg-rose-500', text: 'text-rose-200 border-rose-500/30 bg-rose-500/[0.08]' },
    idle: { dot: 'bg-zinc-500', text: 'text-zinc-300 border-white/10 bg-white/[0.03]' }
};

// A state shown as a dot plus its name (never colour alone).
export function StateBadge({ tone, label, className }: { tone: BadgeTone; label: string; className?: string }) {
    return (
        <span className={cn('inline-flex max-w-full items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium', BADGE[tone].text, className)}>
            <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', BADGE[tone].dot)} aria-hidden="true" />
            <span className="truncate">{label}</span>
        </span>
    );
}

// `title` replaces the headline (the error itself then becomes the detail).
export function ErrorNotice({ error, title: heading, onRetry, className }: { error: unknown; title?: string; onRetry?: () => void; className?: string }) {
    const t = useT();
    const described = describeOpsError(error, t);
    const title = heading ?? described.title;
    const detail = heading ? [described.title, described.detail].filter(Boolean).join('\n') : described.detail;
    return (
        <div role="alert" className={cn('flex items-start gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3.5 py-3 text-sm', className)}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <div className="font-medium text-rose-100">{title}</div>
                {detail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-rose-200/80">{detail}</pre>}
            </div>
            {onRetry && (
                <button type="button" onClick={onRetry} className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-200 hover:bg-white/5 focus-ring">
                    {t('ops.retry')}
                </button>
            )}
        </div>
    );
}

export function EmptyState({ icon, title, detail, children }: { icon: ReactNode; title: string; detail?: ReactNode; children?: ReactNode }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-12 text-center">
            <div className="mb-1 rounded-2xl border border-white/[0.07] bg-ink-800 p-3 text-zinc-400" aria-hidden="true">{icon}</div>
            <div className="text-sm font-medium text-zinc-200">{title}</div>
            {detail && <div className="max-w-md text-xs text-zinc-400">{detail}</div>}
            {children}
        </div>
    );
}

export type SegmentOption<V extends string> = { value: V; label: string; count?: number };

// A radio group drawn as segmented buttons (arrow keys move the choice).
// With nothing chosen yet, the first option takes the tab stop so the group
// can still be reached from the keyboard.
export function Segmented<V extends string>({ label, options, value, onChange }: { label: string; options: SegmentOption<V>[]; value: V; onChange: (value: V) => void }) {
    const refs = useRef<Array<HTMLButtonElement | null>>([]);
    const tabStop = Math.max(0, options.findIndex((option) => option.value === value));
    const onKeyDown = (event: KeyboardEvent, index: number) => {
        const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = (index + step + options.length) % options.length;
        onChange(options[next].value);
        refs.current[next]?.focus();
    };
    return (
        <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 rounded-lg border border-white/10 bg-ink-900/60 p-0.5">
            {options.map((option, index) => {
                const checked = option.value === value;
                return (
                    <button
                        key={option.value}
                        ref={(element) => { refs.current[index] = element; }}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        tabIndex={index === tabStop ? 0 : -1}
                        onClick={() => onChange(option.value)}
                        onKeyDown={(event) => onKeyDown(event, index)}
                        className={cn(
                            'rounded-md px-2.5 py-1 text-xs font-medium transition-colors focus-ring',
                            checked ? 'bg-white/[0.08] text-zinc-100' : 'text-zinc-400 hover:text-zinc-200'
                        )}
                    >
                        {option.label}
                        {option.count !== undefined && <span className="ml-1.5 tabular-nums text-zinc-500">{option.count}</span>}
                    </button>
                );
            })}
        </div>
    );
}

type SearchFieldProps = {
    value: string;
    onChange: (value: string) => void;
    label: string;
    placeholder?: string;
    className?: string;
    inputRef?: Ref<HTMLInputElement>;
};

export function SearchField({ value, onChange, label, placeholder, className, inputRef }: SearchFieldProps) {
    const t = useT();
    const id = useId();
    return (
        <div className={cn('relative min-w-0', className)}>
            <label htmlFor={id} className="sr-only">{label}</label>
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
            <input
                ref={inputRef}
                id={id}
                type="search"
                value={value}
                onChange={(event) => onChange(event.target.value)}
                placeholder={placeholder ?? label}
                className="h-8 w-full rounded-lg border border-white/10 bg-ink-900/70 pl-8 pr-7 text-xs text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-brand-500/70"
            />
            {value && (
                <button
                    type="button"
                    onClick={() => onChange('')}
                    aria-label={t('ops.clearSearch')}
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-zinc-500 hover:text-zinc-200 focus-ring"
                >
                    <X className="h-3.5 w-3.5" aria-hidden="true" />
                </button>
            )}
        </div>
    );
}

type ToolButtonProps = {
    icon: ReactNode;
    label: string;
    onClick: () => void;
    disabled?: boolean;
    busy?: boolean;
    tone?: 'default' | 'danger' | 'primary';
    // Icon only (the label becomes the accessible name and tooltip).
    compact?: boolean;
    pressed?: boolean;
    // Why it is disabled (tooltip and description).
    disabledReason?: string;
};

// A disabled or busy button ignores clicks but stays focusable
// (aria-disabled): a native `disabled` would drop the keyboard focus to the
// page whenever the button it sits on becomes unavailable (a refresh starts,
// the container it stopped is no longer running...).
export function ToolButton({ icon, label, onClick, disabled, busy, tone = 'default', compact, pressed, disabledReason }: ToolButtonProps) {
    const inert = Boolean(disabled || busy);
    const reasonId = useId();
    const reason = disabled && !busy ? disabledReason : undefined;
    return (
        <button
            type="button"
            onClick={() => {
                if (!inert) onClick();
            }}
            aria-disabled={inert || undefined}
            aria-label={compact ? label : undefined}
            aria-pressed={pressed}
            aria-busy={busy || undefined}
            aria-describedby={reason ? reasonId : undefined}
            title={reason ?? label}
            className={cn(
                'inline-flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-lg border text-xs font-medium transition-colors focus-ring',
                compact ? 'w-8' : 'px-2.5',
                tone === 'danger' && 'border-rose-500/30 text-rose-200',
                tone === 'primary' && 'border-brand-500/40 bg-brand-500/15 text-brand-100',
                tone === 'default' && (pressed ? 'border-brand-500/40 bg-brand-500/10 text-brand-100' : 'border-white/10 bg-white/[0.03] text-zinc-200'),
                !inert && tone === 'danger' && 'hover:bg-rose-500/10',
                !inert && tone === 'primary' && 'hover:bg-brand-500/25',
                !inert && tone === 'default' && !pressed && 'hover:bg-white/[0.08]',
                busy ? 'cursor-wait opacity-70' : disabled && 'cursor-not-allowed opacity-40'
            )}
        >
            <span className={cn('inline-flex', busy && 'animate-spin')} aria-hidden="true">{icon}</span>
            {!compact && <span>{label}</span>}
            {reason && <span id={reasonId} hidden>{reason}</span>}
        </button>
    );
}

// A collapsible part of a detail pane (a native disclosure: Enter/Space
// toggle it, screen readers announce it expanded or collapsed).
export function Section({ title, count, defaultOpen = false, children }: { title: string; count?: number; defaultOpen?: boolean; children: ReactNode }) {
    return (
        <details open={defaultOpen} className="group rounded-lg border border-white/[0.06] bg-white/[0.015]">
            <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-zinc-200 hover:bg-white/[0.03] focus-ring [&::-webkit-details-marker]:hidden">
                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform group-open:rotate-90" aria-hidden="true" />
                <span className="min-w-0 flex-1 truncate">{title}</span>
                {count !== undefined && <span className="tabular-nums font-normal text-zinc-500">{count}</span>}
            </summary>
            <div className="space-y-2 border-t border-white/[0.06] px-3 py-2.5">{children}</div>
        </details>
    );
}

// A labelled figure (usage snapshots, disk space).
export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'warn' }) {
    return (
        <div className="min-w-0 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
            <div className="truncate text-[11px] text-zinc-500" title={label}>{label}</div>
            <div className={cn('truncate text-sm font-semibold tabular-nums', tone === 'warn' ? 'text-amber-200' : 'text-zinc-100')}>{value}</div>
            {hint && <div className="truncate text-[11px] text-zinc-500">{hint}</div>}
        </div>
    );
}

// Key/value rows (service properties and the like).
export function PropertyList({ rows }: { rows: Array<[string, ReactNode]> }) {
    return (
        <dl className="grid grid-cols-[minmax(0,35%)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            {rows.map(([name, value]) => (
                <div key={name} className="contents">
                    <dt className="truncate text-zinc-500" title={name}>{name}</dt>
                    <dd className="min-w-0 break-words text-zinc-200">{value}</dd>
                </div>
            ))}
        </dl>
    );
}
