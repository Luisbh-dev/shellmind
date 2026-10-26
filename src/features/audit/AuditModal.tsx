import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChevronRight, Copy, Download, RefreshCw, ScrollText, Search, X } from 'lucide-react';
import { AUDIT_SOURCES, CLIENT_REPORTED, type AuditEntry, type AuditSource, type ServerSummary } from '@shared/types';
import { Button, IconButton, Input, Modal, Select, Spinner, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import type { GlobalActionProps } from '@/workspace/actions/types';
import { copyText } from '@/lib/clipboard';
import { saveText, exportFileName } from '@/lib/download';
import { FieldGroup, FormField } from '@/features/snippets/public';
import { getServers } from '@/store/servers';
import { AUDIT_PAGE_SIZE, fetchAllAudit, fetchAuditPage, type AuditFilters } from './api';
import { auditToCsv } from './csv';
import { RetentionControl } from './RetentionControl';

export const AUDIT_EXPORT_MAX = 10_000;
const SEARCH_DEBOUNCE_MS = 300;

const SOURCE_STYLE: Record<AuditSource, string> = {
    'ai-run': 'bg-violet-500/10 text-violet-200 border-violet-500/30',
    'ai-autorun': 'bg-fuchsia-500/10 text-fuchsia-200 border-fuchsia-500/30',
    snippet: 'bg-brand-500/10 text-brand-200 border-brand-500/30',
    'multi-exec': 'bg-sky-500/10 text-sky-200 border-sky-500/30',
    ops: 'bg-amber-500/10 text-amber-200 border-amber-500/30',
    terminal: 'bg-white/[0.04] text-zinc-300 border-white/10',
    fleet: 'bg-emerald-500/10 text-emerald-200 border-emerald-500/30',
    identity: 'bg-rose-500/10 text-rose-200 border-rose-500/30',
    rdp: 'bg-indigo-500/10 text-indigo-200 border-indigo-500/30'
};

// "2026-10-23" (local day) -> epoch ms at its start or end.
export function dayBoundary(value: string, end: boolean): number | undefined {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return undefined;
    const [, year, month, day] = match.map(Number);
    return end
        ? new Date(year, month - 1, day, 23, 59, 59, 999).getTime()
        : new Date(year, month - 1, day, 0, 0, 0, 0).getTime();
}

function useDebounced<T>(value: T, delayMs: number): T {
    const [debounced, setDebounced] = useState(value);
    useEffect(() => {
        const timer = window.setTimeout(() => setDebounced(value), delayMs);
        return () => window.clearTimeout(timer);
    }, [value, delayMs]);
    return debounced;
}

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export default function AuditModal({ onClose }: GlobalActionProps) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const id = useId();
    const searchRef = useRef<HTMLInputElement>(null);

    const [search, setSearch] = useState('');
    const [serverFilter, setServerFilter] = useState('');
    const [sourceFilter, setSourceFilter] = useState('');
    const [fromDate, setFromDate] = useState('');
    const [toDate, setToDate] = useState('');
    const [servers, setServers] = useState<ServerSummary[]>([]);
    const [entries, setEntries] = useState<AuditEntry[]>([]);
    const [hasMore, setHasMore] = useState(false);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [exporting, setExporting] = useState(false);
    const [expanded, setExpanded] = useState<Set<number>>(new Set());
    const [reloadKey, setReloadKey] = useState(0);
    const debouncedSearch = useDebounced(search, SEARCH_DEBOUNCE_MS);
    // The "load older" request in flight. A new query (filters, refresh)
    // aborts it, so a page of the previous query is never appended.
    const olderRequest = useRef<AbortController | null>(null);

    const filters = useMemo<AuditFilters>(() => ({
        serverId: serverFilter ? Number(serverFilter) : undefined,
        source: (sourceFilter || undefined) as AuditSource | undefined,
        q: debouncedSearch.trim() || undefined,
        from: dayBoundary(fromDate, false),
        to: dayBoundary(toDate, true)
    }), [serverFilter, sourceFilter, debouncedSearch, fromDate, toDate]);
    const filtered = Boolean(search || serverFilter || sourceFilter || fromDate || toDate);

    const timeFormat = useMemo(() => new Intl.DateTimeFormat(language, { dateStyle: 'short', timeStyle: 'medium' }), [language]);

    useEffect(() => {
        searchRef.current?.focus();
        let current = true;
        // Only names servers in the filter: a failure leaves the list empty.
        getServers().then((list) => {
            if (current) setServers(list);
        }, () => undefined);
        return () => {
            current = false;
        };
    }, []);

    useEffect(() => {
        olderRequest.current?.abort();
        olderRequest.current = null;
        setLoadingMore(false);
        const controller = new AbortController();
        setLoading(true);
        setError(null);
        fetchAuditPage(filters, { limit: AUDIT_PAGE_SIZE }, controller.signal)
            .then((page) => {
                setEntries(page);
                setHasMore(page.length === AUDIT_PAGE_SIZE);
                setExpanded(new Set());
            })
            .catch((err: unknown) => {
                if (!controller.signal.aborted) setError(errorText(err));
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [filters, reloadKey]);

    useEffect(() => () => olderRequest.current?.abort(), []);

    const loadOlder = useCallback(async () => {
        const last = entries[entries.length - 1];
        if (!last || loading || olderRequest.current) return;
        const controller = new AbortController();
        olderRequest.current = controller;
        setLoadingMore(true);
        try {
            const page = await fetchAuditPage(filters, { limit: AUDIT_PAGE_SIZE, before: last.id }, controller.signal);
            if (controller.signal.aborted) return;
            setEntries((current) => [...current, ...page]);
            setHasMore(page.length === AUDIT_PAGE_SIZE);
        } catch (err) {
            if (!controller.signal.aborted) toast.error(t('audit.loadFailed'), errorText(err));
        } finally {
            if (olderRequest.current === controller) {
                olderRequest.current = null;
                setLoadingMore(false);
            }
        }
    }, [entries, filters, loading, toast, t]);

    const exportCsv = async () => {
        setExporting(true);
        try {
            const { entries: all, truncated } = await fetchAllAudit(filters, AUDIT_EXPORT_MAX);
            saveText(`${exportFileName('shellmind-audit', Date.now())}.csv`, auditToCsv(all), 'text/csv;charset=utf-8');
            if (truncated) toast.warning(t('audit.export.truncated', { max: AUDIT_EXPORT_MAX }));
            else toast.success(t('audit.export.done', { count: all.length }));
        } catch (err) {
            toast.error(t('audit.export.failed'), errorText(err));
        } finally {
            setExporting(false);
        }
    };

    const copyCommand = async (command: string) => {
        try {
            await copyText(command);
            toast.success(t('audit.copied'));
        } catch {
            toast.error(t('audit.copyFailed'));
        }
    };

    const clearFilters = () => {
        setSearch('');
        setServerFilter('');
        setSourceFilter('');
        setFromDate('');
        setToDate('');
    };

    const toggle = (entryId: number) => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(entryId)) next.delete(entryId);
        else next.add(entryId);
        return next;
    });

    const serverOptions = [{ value: '', label: t('audit.filters.allServers') }, ...servers.map((server) => ({ value: String(server.id), label: server.name }))];
    const sourceOptions = [{ value: '', label: t('audit.filters.allSources') }, ...AUDIT_SOURCES.map((source) => ({ value: source, label: t(`audit.sources.${source}`) }))];

    return (
        <Modal
            open
            onClose={onClose}
            title={t('audit.title')}
            description={t('audit.subtitle')}
            icon={<ScrollText className="h-4 w-4" />}
            widthClass="max-w-6xl"
        >
            <div className="flex h-[min(74vh,720px)] min-h-[420px] flex-col gap-3">
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-[minmax(0,1.4fr)_repeat(4,minmax(0,1fr))_auto]">
                    <FormField id={`${id}-search`} label={t('audit.filters.search')} className="col-span-2 lg:col-span-1">
                        <div className="relative">
                            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-zinc-500" aria-hidden="true" />
                            <Input
                                id={`${id}-search`}
                                ref={searchRef}
                                type="search"
                                value={search}
                                onChange={(event) => setSearch(event.target.value)}
                                placeholder={t('audit.filters.searchPlaceholder')}
                                className="h-9 pl-8 text-xs"
                                maxLength={200}
                            />
                        </div>
                    </FormField>
                    <FieldGroup labelId={`${id}-server`} label={t('audit.filters.server')}>
                        <Select value={serverFilter} onChange={setServerFilter} options={serverOptions} className="text-xs" />
                    </FieldGroup>
                    <FieldGroup labelId={`${id}-source`} label={t('audit.filters.source')}>
                        <Select value={sourceFilter} onChange={setSourceFilter} options={sourceOptions} className="text-xs" />
                    </FieldGroup>
                    <FormField id={`${id}-from`} label={t('audit.filters.from')}>
                        <Input id={`${id}-from`} type="date" value={fromDate} max={toDate || undefined} onChange={(event) => setFromDate(event.target.value)} className="h-9 text-xs [color-scheme:dark]" />
                    </FormField>
                    <FormField id={`${id}-to`} label={t('audit.filters.to')}>
                        <Input id={`${id}-to`} type="date" value={toDate} min={fromDate || undefined} onChange={(event) => setToDate(event.target.value)} className="h-9 text-xs [color-scheme:dark]" />
                    </FormField>
                    <div className="col-span-2 flex items-end gap-2 lg:col-span-1">
                        <Button size="sm" variant="ghost" onClick={clearFilters} disabled={!filtered} className="h-9">
                            <X className="h-3.5 w-3.5" aria-hidden="true" />{t('audit.filters.clear')}
                        </Button>
                    </div>
                </div>

                <div className="flex items-center gap-2">
                    <p className="text-xs text-zinc-400" role="status">
                        {loading ? t('audit.loading') : t(hasMore ? 'audit.countMore' : 'audit.count', { count: entries.length })}
                    </p>
                    <div className="ml-auto flex items-center gap-2">
                        <RetentionControl onPruned={() => setReloadKey((key) => key + 1)} />
                        <IconButton label={t('audit.refresh')} onClick={() => setReloadKey((key) => key + 1)} disabled={loading}>
                            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} aria-hidden="true" />
                        </IconButton>
                        <Button size="sm" variant="subtle" onClick={exportCsv} loading={exporting} disabled={loading || entries.length === 0}>
                            {!exporting && <Download className="h-3.5 w-3.5" aria-hidden="true" />}{t('audit.export.csv')}
                        </Button>
                    </div>
                </div>

                <div className="min-h-0 flex-1 overflow-auto rounded-xl border border-white/5 scrollbar-thin">
                    {error ? (
                        <div role="alert" className="space-y-2 p-6 text-sm text-rose-200">
                            <p>{t('audit.loadFailed')}</p>
                            <p className="text-xs text-rose-300/80">{error}</p>
                            <Button size="sm" onClick={() => setReloadKey((key) => key + 1)}>{t('audit.retry')}</Button>
                        </div>
                    ) : loading && entries.length === 0 ? (
                        <div className="flex h-full items-center justify-center text-zinc-400"><Spinner /></div>
                    ) : entries.length === 0 ? (
                        <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
                            <ScrollText className="h-8 w-8 text-zinc-500" aria-hidden="true" />
                            <p className="text-sm text-zinc-400">{filtered ? t('audit.empty.filtered') : t('audit.empty.none')}</p>
                        </div>
                    ) : (
                        <table className="w-full table-fixed border-collapse text-left text-xs">
                            <caption className="sr-only">{t('audit.title')}</caption>
                            <thead className="sticky top-0 z-10 bg-ink-750 text-[11px] uppercase tracking-wider text-zinc-400">
                                <tr>
                                    <th scope="col" className="w-8 px-2 py-2"><span className="sr-only">{t('audit.columns.details')}</span></th>
                                    <th scope="col" className="w-40 px-2 py-2 font-semibold">{t('audit.columns.time')}</th>
                                    <th scope="col" className="w-36 px-2 py-2 font-semibold">{t('audit.columns.server')}</th>
                                    <th scope="col" className="w-36 px-2 py-2 font-semibold">{t('audit.columns.source')}</th>
                                    <th scope="col" className="px-2 py-2 font-semibold">{t('audit.columns.command')}</th>
                                    <th scope="col" className="w-16 px-2 py-2 text-right font-semibold">{t('audit.columns.exit')}</th>
                                    <th scope="col" className="w-12 px-2 py-2"><span className="sr-only">{t('audit.columns.actions')}</span></th>
                                </tr>
                            </thead>
                            <tbody>
                                {entries.map((entry) => {
                                    const open = expanded.has(entry.id);
                                    const detailsId = `${id}-details-${entry.id}`;
                                    return (
                                        <Fragment key={entry.id}>
                                            <tr className={cn('border-t border-white/5 align-middle', open ? 'bg-white/[0.03]' : 'hover:bg-white/[0.02]')}>
                                                <td className="px-2 py-1.5">
                                                    <button
                                                        type="button"
                                                        onClick={() => toggle(entry.id)}
                                                        aria-expanded={open}
                                                        aria-controls={open ? detailsId : undefined}
                                                        aria-label={t('audit.toggleDetails')}
                                                        className="rounded p-0.5 text-zinc-500 hover:text-zinc-200 focus-ring"
                                                    >
                                                        <ChevronRight className={cn('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} aria-hidden="true" />
                                                    </button>
                                                </td>
                                                <td className="whitespace-nowrap px-2 py-1.5 font-mono text-[11px] text-zinc-300">
                                                    <time dateTime={new Date(entry.ts).toISOString()}>{timeFormat.format(entry.ts)}</time>
                                                </td>
                                                <td className="truncate px-2 py-1.5 text-zinc-200" title={entry.server_name ?? undefined}>
                                                    {entry.server_name ?? <span className="text-zinc-500">{entry.server_id === null ? t('audit.noServer') : `#${entry.server_id}`}</span>}
                                                </td>
                                                <td className="px-2 py-1.5">
                                                    <span className={cn('inline-block max-w-full truncate whitespace-nowrap rounded-md border px-1.5 py-0.5 align-middle text-[10px] font-medium', SOURCE_STYLE[entry.source] ?? SOURCE_STYLE.terminal)}>
                                                        {t(`audit.sources.${entry.source}`)}
                                                    </span>
                                                    {entry.meta?.reportedBy === CLIENT_REPORTED && (
                                                        <span className="ml-1 align-middle text-[10px] text-zinc-500" title={t('audit.reportedByClientHint')}><span className="sr-only">, </span>{t('audit.reportedByClient')}</span>
                                                    )}
                                                </td>
                                                <td className="px-2 py-1.5">
                                                    <code className="block truncate font-mono text-[11px] text-zinc-100" title={entry.command}>{entry.command.split('\n')[0]}</code>
                                                </td>
                                                <td className="px-2 py-1.5 text-right font-mono text-[11px]">
                                                    {entry.exit_code === null
                                                        ? <span className="text-zinc-500">—</span>
                                                        : <span className={entry.exit_code === 0 ? 'text-emerald-300' : 'text-rose-300'}>{entry.exit_code}</span>}
                                                </td>
                                                <td className="px-2 py-1">
                                                    <IconButton size="sm" label={t('audit.copyCommand')} onClick={() => copyCommand(entry.command)}>
                                                        <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                                                    </IconButton>
                                                </td>
                                            </tr>
                                            {open && (
                                                <tr id={detailsId} className="bg-white/[0.03]">
                                                    <td />
                                                    <td colSpan={6} className="space-y-2 px-2 pb-3">
                                                        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg border border-white/10 bg-ink-900/80 px-3 py-2 font-mono text-[11px] text-zinc-100 scrollbar-thin">{entry.command}</pre>
                                                        {entry.meta && (
                                                            <dl className="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-[11px]">
                                                                {Object.entries(entry.meta).map(([key, value]) => (
                                                                    <Fragment key={key}>
                                                                        <dt className="font-mono text-zinc-500">{key}</dt>
                                                                        <dd className="break-all font-mono text-zinc-300">{typeof value === 'string' ? value : JSON.stringify(value)}</dd>
                                                                    </Fragment>
                                                                ))}
                                                            </dl>
                                                        )}
                                                    </td>
                                                </tr>
                                            )}
                                        </Fragment>
                                    );
                                })}
                            </tbody>
                        </table>
                    )}
                </div>

                {hasMore && !error && (
                    <div className="flex justify-center">
                        <Button size="sm" variant="subtle" onClick={loadOlder} loading={loadingMore} disabled={loading}>{t('audit.loadOlder')}</Button>
                    </div>
                )}
            </div>
        </Modal>
    );
}
