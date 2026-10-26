import { useEffect, useRef, type ReactNode } from 'react';
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown } from 'lucide-react';
import type { RemoteState } from '@/features/ops/useRemote';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeK8sError } from './errors';
import type { SortState } from './model';

// Building blocks of the Kubernetes views (the operations panels' own
// primitives, src/features/ops/ui.tsx, cover the rest).

export function K8sErrorNotice({ error, title: heading, onRetry, className }: { error: unknown; title?: string; onRetry?: () => void; className?: string }) {
    const t = useT();
    const described = describeK8sError(error, t);
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
                    {t('k8s.retry')}
                </button>
            )}
        </div>
    );
}

type SortHeaderProps<K extends string> = {
    label: string;
    sortKey: K;
    sort: SortState<K>;
    onSort: (sort: SortState<K>) => void;
    className?: string;
    align?: 'left' | 'right';
};

// A column header that sorts the table (aria-sort on the header cell; the
// button toggles the direction of the column already sorted by).
export function SortHeader<K extends string>({ label, sortKey, sort, onSort, className, align = 'left' }: SortHeaderProps<K>) {
    const t = useT();
    const active = sort.key === sortKey;
    const Icon = !active ? ArrowUpDown : sort.direction === 'asc' ? ArrowUp : ArrowDown;
    return (
        <th scope="col" aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'} className={cn('px-2 py-2 font-medium', className)}>
            <button
                type="button"
                onClick={() => onSort({ key: sortKey, direction: active && sort.direction === 'asc' ? 'desc' : 'asc' })}
                title={t('k8s.sortBy', { column: label })}
                className={cn('inline-flex items-center gap-1 rounded hover:text-zinc-200 focus-ring', align === 'right' && 'flex-row-reverse', active && 'text-zinc-200')}
            >
                {label}
                <Icon className={cn('h-3 w-3', !active && 'opacity-40')} aria-hidden="true" />
            </button>
        </th>
    );
}

// Rows of a loading table.
export function TableSkeleton({ rows = 6 }: { rows?: number }) {
    return (
        <div className="space-y-2 p-4" aria-hidden="true">
            {Array.from({ length: rows }, (_, index) => <div key={index} className="h-10 animate-pulse rounded-lg bg-white/[0.03]" />)}
        </div>
    );
}

// A small labelled count in a view tab ("3 problems").
export function CountPill({ count, tone = 'idle', label }: { count: number; tone?: 'idle' | 'bad' | 'warn'; label: string }) {
    if (count <= 0) return null;
    return (
        <span
            className={cn(
                'rounded-full px-1.5 text-[10px] font-semibold tabular-nums',
                tone === 'bad' ? 'bg-rose-500/20 text-rose-200' : tone === 'warn' ? 'bg-amber-500/20 text-amber-200' : 'bg-white/[0.08] text-zinc-300'
            )}
            title={label}
        >
            {count}
            <span className="sr-only"> {label}</span>
        </span>
    );
}

export const AUTO_REFRESH_MS = 10_000;

// The panel's refresh: a count the Refresh button moves on, and whether
// auto-refresh is on.
export type RefreshSignal = { nonce: number; auto: boolean };

type Reloadable = Pick<RemoteState<unknown>, 'data' | 'error' | 'loading' | 'reload'>;

// Reloads `intervalMs` after the last load ended, while `enabled` and the
// page is visible: a load slower than the interval (a big namespace, a
// remote cluster, a credential plugin that takes seconds) is never cut short
// by the next one. A view shown again after a while reloads at once.
export function useAutoRefresh(remote: Reloadable, enabled: boolean, intervalMs = AUTO_REFRESH_MS): void {
    const { data, error, loading, reload } = remote;
    const settledAt = useRef(Date.now());
    // data/error: a new answer even when the loading flag never showed.
    useEffect(() => {
        if (!loading) settledAt.current = Date.now();
    }, [loading, data, error]);
    useEffect(() => {
        if (!enabled || loading) return undefined;
        let timer = 0;
        const tick = () => {
            if (document.visibilityState === 'hidden') timer = window.setTimeout(tick, intervalMs);
            else reload();
        };
        timer = window.setTimeout(tick, Math.max(0, intervalMs - (Date.now() - settledAt.current)));
        return () => window.clearTimeout(timer);
    }, [enabled, loading, data, error, intervalMs, reload]);
}

// Reloads a view when the panel's refresh count moved on: at once when it is
// on screen, else the next time it shows (hidden views run no kubectl). A
// load already running is left to finish: its answer is as fresh.
export function useRefreshOn(nonce: number, active: boolean, remote: Pick<Reloadable, 'loading' | 'reload'>): void {
    const seen = useRef(nonce);
    const { loading, reload } = remote;
    useEffect(() => {
        if (!active || seen.current === nonce) return;
        seen.current = nonce;
        if (!loading) reload();
    }, [nonce, active, loading, reload]);
}

// Both, for a view of the panel.
export function useViewRefresh(remote: Reloadable, refresh: RefreshSignal, active: boolean): void {
    useRefreshOn(refresh.nonce, active, remote);
    useAutoRefresh(remote, active && refresh.auto);
}

// A key/value list in a detail pane (the label column stays narrow).
export function DetailRows({ rows }: { rows: Array<[string, ReactNode]> }) {
    return (
        <dl className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-xs">
            {rows.map(([name, value]) => (
                <div key={name} className="contents">
                    <dt className="truncate text-zinc-500" title={name}>{name}</dt>
                    <dd className="min-w-0 break-words text-zinc-200">{value}</dd>
                </div>
            ))}
        </dl>
    );
}
