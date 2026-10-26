// The patch center (a global action): every SSH server's pending updates,
// security updates and pending reboot on one screen, scans on demand, the
// updates of one server beside the table, and patch runs on the servers
// picked (multi-exec jobs with batches, canary and failure limit).
import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { holdForCode } from '@shared/fleet';
import type { PatchMode } from '@shared/patch';
import { ArrowDown, ArrowLeft, ArrowUp, ArrowUpDown, PackageCheck, PlayCircle, RefreshCw, Search, X } from 'lucide-react';
import { Button, EmptyState, Input, Modal, Skeleton, Spinner } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useElementSize } from '@/lib/useElementSize';
import { ServerIcon, serverSubtitle } from '@/features/organization/serverVisuals';
import { useAppStore } from '@/store/appStore';
import { useServers } from '@/store/servers';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { ApplyDialog } from './ApplyDialog';
import { Age, Dash, ErrorBox, managerName, RebootFlag, scanErrorText, SecurityCount } from './bits';
import {
    countRows, DEFAULT_DIRECTION, filterRows, PATCH_FILTERS, patchRows, sortRows, totals,
    type PatchFilter, type PatchRowView, type SortDirection, type SortKey
} from './model';
import { PatchJob } from './PatchJob';
import { clearPatchHandoff, pendingFocusServer, pendingRunHandoff } from './public';
import ServerUpdates from './ServerUpdates';
import { usePatchStore } from './store';

const POLL_MS = 3000;
// Below this width the server's updates cover the table instead of sharing the screen.
const SPLIT_PX = 1180;
// Below this width the table leaves out its date columns.
const WIDE_TABLE_PX = 1100;

function useNow(intervalMs: number): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs]);
    return now;
}

function StatusCell({ row, onShowJob }: { row: PatchRowView; onShowJob: (jobId: string) => void }) {
    const t = useT();
    if (row.jobId) {
        return (
            <button type="button" onClick={() => onShowJob(row.jobId!)} className="inline-flex items-center gap-1.5 rounded text-amber-200 underline-offset-2 hover:underline focus-ring">
                <Spinner className="h-3 w-3" />{t('patch.status.running')}
            </button>
        );
    }
    if (row.scanning) return <span className="inline-flex items-center gap-1.5 text-sky-300"><Spinner className="h-3 w-3" />{t('patch.status.scanning')}</span>;
    if (row.error) return <span className="block truncate text-rose-300" title={row.error.message}>{scanErrorText(t, row.error)}</span>;
    if (row.scannedAt === null) return <span className="text-zinc-500">{t('patch.status.notScanned')}</span>;
    if (row.server.type === 'windows') return <span className="text-zinc-400">{t('patch.status.listOnly')}</span>;
    if (row.privilege === 'sudo-password') return <span className="text-amber-300">{t('patch.status.sudoPassword')}</span>;
    if (row.privilege === 'none') return <span className="text-amber-300">{t('patch.status.noPrivilege')}</span>;
    if (!row.pending && row.rebootRequired !== true) return <span className="text-emerald-300">{t('patch.status.upToDate')}</span>;
    return null;
}

type Column = { key: SortKey | null; label: string; className: string; align?: 'right' };

function SortHeader({ column, sort, direction, onSort }: { column: Column; sort: SortKey; direction: SortDirection; onSort: (key: SortKey) => void }) {
    const active = column.key !== null && column.key === sort;
    const Icon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown;
    return (
        <th scope="col" aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : undefined} className={cn('px-2 py-2 font-medium', column.className, column.align === 'right' && 'text-right')}>
            {column.key ? (
                <button type="button" onClick={() => onSort(column.key!)} className={cn('inline-flex items-center gap-1 rounded uppercase tracking-wider hover:text-zinc-100 focus-ring', active && 'text-zinc-100')}>
                    {column.label}
                    <Icon className={cn('h-3 w-3', !active && 'opacity-40')} aria-hidden="true" />
                </button>
            ) : column.label}
        </th>
    );
}

export default function PatchCenter({ onClose }: GlobalActionProps) {
    const t = useT();
    const id = useId();
    const { servers, status: serversStatus } = useServers();
    const rowsById = usePatchStore((state) => state.rows);
    const streaming = usePatchStore((state) => state.streaming);
    const fleetStatus = usePatchStore((state) => state.fleetStatus);
    const fleetError = usePatchStore((state) => state.fleetError);
    const scanFailure = usePatchStore((state) => state.scanFailure);
    const [filter, setFilter] = useState<PatchFilter>('all');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({ key: 'security', direction: 'desc' });
    const [selected, setSelected] = useState<Set<number>>(() => new Set());
    // Opened on a server's updates, or on a run to plan (a failed patch job's
    // servers, from multi-exec's job history).
    const [detailId, setDetailId] = useState<number | null>(pendingFocusServer);
    const [handoffRun] = useState(pendingRunHandoff);
    const [applyFor, setApplyFor] = useState<{ serverIds: number[]; mode?: PatchMode } | null>(null);
    // The run's dialog opens once the patch center is on screen: mounted with
    // it, the dialog would sit under it (and Escape and focus would go to the
    // patch center first).
    useEffect(() => {
        clearPatchHandoff();
        if (handoffRun) setApplyFor({ serverIds: handoffRun.serverIds, mode: handoffRun.mode ?? undefined });
    }, [handoffRun]);
    const [jobId, setJobId] = useState<string | null>(null);
    const [boxRef, box] = useElementSize<HTMLDivElement>();
    const searchRef = useRef<HTMLInputElement>(null);
    const selectAllRef = useRef<HTMLInputElement>(null);
    const paneRef = useRef<HTMLElement>(null);
    // Each row's button that opens its server's updates (focus goes back there).
    const rowButtons = useRef(new Map<number, HTMLButtonElement>());
    const returnFocusTo = useRef<number | null>(null);
    const now = useNow(30_000);

    useEffect(() => {
        void usePatchStore.getState().loadFleet();
    }, []);

    const rows = useMemo(() => patchRows(servers, rowsById, streaming), [servers, rowsById, streaming]);
    const counts = useMemo(() => countRows(rows), [rows]);
    const sum = useMemo(() => totals(rows), [rows]);
    const shown = useMemo(() => sortRows(filterRows(rows, filter, query), sort.key, sort.direction), [rows, filter, query, sort]);
    const runningJobs = [...new Set(rows.map((row) => row.jobId).filter((value): value is string => Boolean(value)))];
    const detail = detailId !== null ? rows.find((row) => row.server.id === detailId) ?? null : null;
    const split = box.width === 0 || box.width >= SPLIT_PX;
    // The server's updates cover the table (narrow windows).
    const covers = Boolean(detail) && !split;

    // Covered, the table cannot keep the focus: it goes to the pane's heading.
    useEffect(() => {
        if (!covers) return;
        const pane = paneRef.current;
        if (pane && !pane.contains(document.activeElement)) pane.querySelector<HTMLElement>('[data-pane-focus]')?.focus({ preventScroll: true });
    }, [covers, detailId]);

    // Closed, the pane gives the focus back to the row that opened it.
    useEffect(() => {
        if (detailId !== null || returnFocusTo.current === null) return;
        const row = rowButtons.current.get(returnFocusTo.current);
        returnFocusTo.current = null;
        (row ?? searchRef.current)?.focus({ preventScroll: true });
    }, [detailId]);

    const closeDetail = () => {
        returnFocusTo.current = detailId;
        setDetailId(null);
    };

    // A run or a scan going on: the table follows it.
    const following = rows.some((row) => row.jobId || row.scanning);
    useEffect(() => {
        if (!following) return;
        const timer = window.setInterval(() => void usePatchStore.getState().loadFleet(), POLL_MS);
        return () => window.clearInterval(timer);
    }, [following]);

    // Selected servers that are no longer shown are no longer selected.
    const visibleIds = useMemo(() => new Set(shown.map((row) => row.server.id)), [shown]);
    const picked = [...selected].filter((serverId) => visibleIds.has(serverId));
    const allPicked = shown.length > 0 && picked.length === shown.length;
    useEffect(() => {
        if (selectAllRef.current) selectAllRef.current.indeterminate = picked.length > 0 && !allPicked;
    }, [picked.length, allPicked]);

    // "/" filters, as in the fleet board.
    useEffect(() => {
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, select, [contenteditable="true"], [role="listbox"], [role="menu"]')) return;
            event.preventDefault();
            searchRef.current?.focus();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, []);

    const toggle = (serverId: number) => setSelected((current) => {
        const next = new Set(current);
        if (next.has(serverId)) next.delete(serverId);
        else next.add(serverId);
        return next;
    });
    const toggleAll = () => setSelected(allPicked ? new Set() : new Set(shown.map((row) => row.server.id)));
    // Scanning everything shown leaves out the servers whose login (or host
    // key) was just refused, as the fleet board's checks do: trying again
    // could lock the account. Picked servers, or one scanned on its own, are tried.
    const scan = () => void usePatchStore.getState().scanMany(picked.length ? picked : shown.filter((row) => !(row.error && holdForCode(row.error.code))).map((row) => row.server.id));
    const onSort = (key: SortKey) => setSort((current) => ({ key, direction: current.key === key ? (current.direction === 'asc' ? 'desc' : 'asc') : DEFAULT_DIRECTION[key] }));
    const names = useMemo(() => new Map(servers.map((server) => [server.id, server.name])), [servers]);
    const scanningAny = rows.some((row) => row.scanning);

    // Beside a server's updates the table keeps the columns that rank servers;
    // in a narrow window it leaves out the dates first (they are in the
    // server's updates), so the names keep their room.
    const narrow = Boolean(split && detail);
    const withoutDates = narrow || (box.width > 0 && box.width < WIDE_TABLE_PX);
    const columns: Column[] = [
        { key: 'name', label: t('patch.columns.server'), className: '' },
        ...(narrow ? [] : [{ key: null, label: t('patch.columns.manager'), className: 'w-[8.5rem]' } satisfies Column]),
        { key: 'pending', label: t('patch.columns.pending'), className: 'w-[6.5rem]', align: 'right' },
        { key: 'security', label: t('patch.columns.security'), className: 'w-[6.5rem]', align: 'right' },
        { key: 'reboot', label: t('patch.columns.reboot'), className: 'w-[7.5rem]' },
        ...(withoutDates ? [] : [
            { key: 'lastUpdate', label: t('patch.columns.lastUpdate'), className: 'w-[8.5rem]' },
            { key: null, label: t('patch.columns.lists'), className: 'w-[8.5rem]' }
        ] satisfies Column[]),
        { key: null, label: t('patch.columns.status'), className: 'w-[11rem]' }
    ];

    const description = [
        servers.length ? (rows.length === 1 ? t('patch.description.serversOne') : t('patch.description.servers', { count: rows.length })) : null,
        rows.some((row) => row.pending !== null) ? (sum.pending === 1 ? t('patch.description.pendingOne') : t('patch.description.pending', { count: sum.pending })) : null,
        sum.security ? t('patch.description.security', { count: sum.security }) : null,
        sum.reboot ? (sum.reboot === 1 ? t('patch.description.rebootOne') : t('patch.description.reboot', { count: sum.reboot })) : null
    ].filter(Boolean).join(' · ');

    const loading = (serversStatus === 'loading' && !servers.length) || fleetStatus === 'loading' || fleetStatus === 'idle';

    const chip = (value: PatchFilter) => {
        const active = filter === value;
        if (value !== 'all' && !counts[value] && !active) return null;
        return (
            <button
                key={value}
                type="button"
                aria-pressed={active}
                onClick={() => setFilter(active && value !== 'all' ? 'all' : value)}
                className={cn(
                    'inline-flex items-center gap-1.5 rounded-lg border px-2 py-1 text-xs font-medium transition-colors focus-ring',
                    active ? 'border-brand-500/40 bg-brand-500/15 text-brand-200' : 'border-white/10 bg-white/[0.02] text-zinc-300 hover:bg-white/[0.06]'
                )}
            >
                {t(`patch.filters.${value}`)}
                <span className={cn('font-mono tabular-nums', active ? 'text-brand-100' : 'text-zinc-400')}>{counts[value]}</span>
            </button>
        );
    };

    const table = (
        <table className={cn('w-full table-fixed border-collapse text-left text-xs', narrow ? 'min-w-[36rem]' : withoutDates ? 'min-w-[48rem]' : 'min-w-[66rem]')}>
            <caption className="sr-only">{t('patch.title')}</caption>
            <thead className="sticky top-0 z-10 bg-ink-750 text-[11px] uppercase tracking-wider text-zinc-400">
                <tr>
                    <th scope="col" className="w-10 px-3 py-2">
                        <input
                            ref={selectAllRef}
                            type="checkbox"
                            checked={allPicked}
                            onChange={toggleAll}
                            aria-label={t('patch.columns.selectAll')}
                            className="h-4 w-4 cursor-pointer rounded accent-brand-500 focus-ring"
                        />
                    </th>
                    {columns.map((column, index) => <SortHeader key={column.key ?? `static-${index}`} column={column} sort={sort.key} direction={sort.direction} onSort={onSort} />)}
                </tr>
            </thead>
            <tbody>
                {shown.map((row) => {
                    const active = row.server.id === detailId;
                    return (
                        <tr key={row.server.id} className={cn('border-t border-white/5 transition-colors', active ? 'bg-brand-500/[0.07]' : 'hover:bg-white/[0.02]')}>
                            <td className="px-3 py-2">
                                <input
                                    type="checkbox"
                                    checked={selected.has(row.server.id)}
                                    onChange={() => toggle(row.server.id)}
                                    aria-label={`${t('patch.columns.select')} ${row.server.name}`}
                                    className="h-4 w-4 cursor-pointer rounded accent-brand-500 focus-ring"
                                />
                            </td>
                            <td className="min-w-0 px-2 py-2">
                                <button
                                    ref={(element) => {
                                        if (element) rowButtons.current.set(row.server.id, element);
                                        else rowButtons.current.delete(row.server.id);
                                    }}
                                    type="button"
                                    onClick={() => setDetailId(active ? null : row.server.id)}
                                    aria-expanded={active}
                                    aria-controls={active ? `${id}-detail` : undefined}
                                    aria-label={t('patch.actions.openRow', { name: row.server.name })}
                                    className="flex w-full min-w-0 items-center gap-2 rounded text-left focus-ring"
                                >
                                    <ServerIcon server={row.server} className="h-4 w-4 shrink-0" />
                                    <span className="min-w-0">
                                        <span className="block truncate font-medium text-zinc-100">{row.server.name}</span>
                                        <span className="block truncate text-[11px] text-zinc-500">{serverSubtitle(row.server)}</span>
                                    </span>
                                </button>
                            </td>
                            {!narrow && <td className="truncate px-2 py-2 text-zinc-300">{row.manager ? managerName(t, row.manager) : <Dash label={t('patch.values.unknown')} />}</td>}
                            <td className="px-2 py-2 text-right tabular-nums">
                                {row.pending === null ? <Dash label={t('patch.values.unknown')} /> : (
                                    <span className={cn(row.pending > 0 ? 'font-medium text-zinc-100' : 'text-zinc-400', row.estimated && 'italic')} title={row.estimated ? t('patch.values.estimated') : undefined}>
                                        {row.estimated && '~'}{row.pending}
                                        {row.estimated && <span className="sr-only"> ({t('patch.values.estimated')})</span>}
                                    </span>
                                )}
                            </td>
                            <td className="px-2 py-2 text-right"><SecurityCount value={row.security} manager={row.manager} estimated={row.estimated} /></td>
                            <td className="px-2 py-2"><RebootFlag value={row.rebootRequired} /></td>
                            {!withoutDates && (
                                <>
                                    <td className="px-2 py-2">{row.scannedAt && row.lastUpdateAt === null ? <span className="text-zinc-400">{t('patch.values.never')}</span> : <Age at={row.lastUpdateAt} now={now} />}</td>
                                    <td className="px-2 py-2">{row.scannedAt && row.metadataAt === null ? <span className="text-amber-300">{t('patch.values.listsMissing')}</span> : <Age at={row.metadataAt} now={now} stale />}</td>
                                </>
                            )}
                            <td className="min-w-0 px-2 py-2"><StatusCell row={row} onShowJob={setJobId} /></td>
                        </tr>
                    );
                })}
            </tbody>
        </table>
    );

    return (
        <Modal
            open
            onClose={onClose}
            title={t('patch.title')}
            description={description}
            icon={<PackageCheck className="h-4 w-4" />}
            widthClass="max-w-[min(100rem,calc(100vw-2rem))]"
            className="h-[calc(100vh-2rem)]"
            bodyClassName="flex flex-col gap-3 overflow-hidden px-4 py-3"
            // Escape first closes the server's updates where they cover the table.
            onEscape={() => {
                if (!covers || jobId) return false;
                closeDetail();
                return true;
            }}
        >
            {jobId ? (
                <div className="flex min-h-0 flex-1 flex-col gap-3">
                    <div className="flex items-center gap-2">
                        <Button size="sm" variant="ghost" onClick={() => setJobId(null)}>
                            <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.actions.backToServers')}
                        </Button>
                        <Button size="sm" variant="ghost" className="ml-auto" onClick={() => useAppStore.getState().openAction('audit')}>{t('patch.actions.audit')}</Button>
                    </div>
                    <div className="flex min-h-0 flex-1 flex-col overflow-auto scrollbar-thin">
                        <PatchJob jobId={jobId} onOpenJob={setJobId} />
                    </div>
                </div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t('patch.filters.label')}>
                        {PATCH_FILTERS.map(chip)}
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                        <div className="relative w-full max-w-xs">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                            <Input
                                ref={searchRef}
                                type="search"
                                aria-label={t('patch.filters.search')}
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t('patch.filters.searchPlaceholder')}
                                className="h-8 pl-8 text-xs"
                                maxLength={200}
                            />
                        </div>
                        {(filter !== 'all' || query) && (
                            <Button size="sm" variant="ghost" onClick={() => { setFilter('all'); setQuery(''); }}>
                                <X className="h-3.5 w-3.5" aria-hidden="true" />{t('patch.filters.clear')}
                            </Button>
                        )}
                        <div className="ml-auto flex flex-wrap items-center gap-2">
                            {runningJobs.length > 0 && (
                                <Button size="sm" variant="subtle" onClick={() => setJobId(runningJobs[0])}>
                                    <PlayCircle className="h-3.5 w-3.5 text-amber-300" aria-hidden="true" />{t('patch.actions.showRun')}
                                </Button>
                            )}
                            <Button size="sm" variant="secondary" onClick={scan} disabled={!shown.length} loading={scanningAny && !picked.length} title={t('patch.actions.scanHint')}>
                                {!(scanningAny && !picked.length) && <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />}
                                {picked.length ? t('patch.actions.scanSelected', { count: picked.length }) : t('patch.actions.scanAll')}
                            </Button>
                            <Button
                                size="sm"
                                variant="primary"
                                disabled={!picked.length}
                                title={picked.length ? undefined : t('patch.actions.patchNone')}
                                onClick={() => setApplyFor({ serverIds: picked })}
                            >
                                <PackageCheck className="h-3.5 w-3.5" aria-hidden="true" />
                                {picked.length === 1 ? t('patch.actions.patchSelectedOne') : t('patch.actions.patchSelected', { count: picked.length })}
                            </Button>
                        </div>
                    </div>

                    {fleetError !== null && fleetStatus === 'error' && <ErrorBox error={fleetError} heading={t('patch.errors.loadFailed')} />}
                    {scanFailure !== null && <ErrorBox error={scanFailure} heading={t('patch.errors.scanFailed')} />}

                    <div ref={boxRef} className="relative flex min-h-0 flex-1 gap-3">
                        <div className={cn('min-h-0 flex-1 overflow-auto rounded-xl border border-white/5 scrollbar-thin', covers && 'invisible')} aria-hidden={covers ? true : undefined}>
                            {loading ? (
                                <div className="space-y-2 p-3" role="status" aria-busy="true">
                                    <span className="sr-only">{t('patch.status.scanning')}</span>
                                    {[0, 1, 2, 3, 4].map((key) => <Skeleton key={key} className="h-9 rounded-lg" />)}
                                </div>
                            ) : !rows.length ? (
                                <EmptyState icon={<PackageCheck className="h-5 w-5" />} title={t('patch.empty.noServers')} description={t('patch.empty.noServersText')} />
                            ) : !shown.length ? (
                                <EmptyState
                                    icon={<Search className="h-5 w-5" />}
                                    title={t('patch.empty.noMatch')}
                                    actions={<Button size="sm" onClick={() => { setFilter('all'); setQuery(''); }}>{t('patch.filters.clear')}</Button>}
                                />
                            ) : table}
                        </div>
                        {detail && (
                            <aside
                                ref={paneRef}
                                id={`${id}-detail`}
                                aria-label={t('patch.actions.open', { name: detail.server.name })}
                                className={cn('min-h-0 overflow-hidden rounded-xl border border-white/10 bg-ink-850', split ? 'w-[min(38rem,45%)] shrink-0' : 'absolute inset-0')}
                            >
                                <ServerUpdates key={detail.server.id} server={detail.server} layout="pane" onClose={closeDetail} />
                            </aside>
                        )}
                    </div>
                </>
            )}
            {applyFor && (
                <ApplyDialog
                    serverIds={applyFor.serverIds}
                    names={names}
                    initialMode={applyFor.mode}
                    onClose={() => setApplyFor(null)}
                    onStarted={(response) => {
                        setApplyFor(null);
                        setSelected(new Set());
                        setJobId(response.job.id);
                    }}
                />
            )}
        </Modal>
    );
}
