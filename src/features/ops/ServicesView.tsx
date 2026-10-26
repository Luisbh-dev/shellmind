import { useMemo, useState } from 'react';
import { ChevronLeft, Cog, Play, RefreshCw, RotateCw, ScrollText, Square, ToggleLeft, ToggleRight, Wand2 } from 'lucide-react';
import { LINUX_SERVICE_ACTIONS, WINDOWS_SERVICE_ACTIONS, type LogSource, type OpsCapabilities, type ServiceAction, type ServiceInfo } from '@shared/ops';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { AskAiButton } from '@/components/AskAiButton';
import { useConfirm, useToast } from '@/components/ui';
import { describeError } from '@/lib/remoteErrors';
import { useElementWidth } from '@/lib/useElementWidth';
import { opsApi } from './api';
import { EmptyState, ErrorNotice, PropertyList, SearchField, Segmented, StateBadge, ToolButton, type BadgeTone } from './ui';
import { useListDetailFocus } from './useListDetailFocus';
import { useRemote } from './useRemote';

type Filter = 'all' | 'running' | 'failed' | 'stopped';

const RUNNING = new Set(['active', 'reloading', 'activating']);
const STOPPED = new Set(['inactive', 'deactivating']);

function serviceTone(service: Pick<ServiceInfo, 'active' | 'sub'>): BadgeTone {
    if (service.active === 'failed') return 'bad';
    if (service.active === 'activating' || service.active === 'deactivating' || service.active === 'reloading') return 'warn';
    if (service.active === 'active') return 'ok';
    return 'idle';
}

function matchesFilter(service: ServiceInfo, filter: Filter): boolean {
    if (filter === 'running') return RUNNING.has(service.active);
    if (filter === 'failed') return service.active === 'failed';
    if (filter === 'stopped') return STOPPED.has(service.active);
    return true;
}

const ACTION_ICONS: Record<ServiceAction, typeof Play> = {
    start: Play,
    stop: Square,
    restart: RotateCw,
    reload: Wand2,
    enable: ToggleRight,
    disable: ToggleLeft
};

// Actions whose effect is disruptive get a red confirmation.
const DISRUPTIVE = new Set<ServiceAction>(['stop', 'restart', 'disable']);

const JOURNAL_LINES = [100, 200, 500] as const;

type ServicesViewProps = {
    serverId: number;
    caps: OpsCapabilities;
    onFollowLogs: (source: LogSource) => void;
};

export function ServicesView({ serverId, caps, onFollowLogs }: ServicesViewProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const [filter, setFilter] = useState<Filter>('all');
    const [query, setQuery] = useState('');
    const [selected, setSelected] = useState<string | null>(null);
    const [running, setRunning] = useState<ServiceAction | null>(null);
    const [journalLines, setJournalLines] = useState<number | null>(null);
    const windows = caps.platform === 'windows';
    const unsupported = !windows && !caps.systemd;

    const list = useRemote((signal) => opsApi.services(serverId, signal), `services:${serverId}`, !unsupported);
    const detail = useRemote((signal) => opsApi.service(serverId, selected ?? '', signal), `service:${serverId}:${selected}`, Boolean(selected));
    const journal = useRemote(
        (signal) => opsApi.journal(serverId, selected ?? '', journalLines ?? 200, signal),
        `journal:${serverId}:${selected}:${journalLines}`,
        Boolean(selected && journalLines)
    );

    const services = useMemo(() => list.data?.services ?? [], [list.data]);
    const counts = useMemo(() => ({
        all: services.length,
        running: services.filter((service) => matchesFilter(service, 'running')).length,
        failed: services.filter((service) => matchesFilter(service, 'failed')).length,
        stopped: services.filter((service) => matchesFilter(service, 'stopped')).length
    }), [services]);
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return services
            .filter((service) => matchesFilter(service, filter))
            .filter((service) => !needle || service.name.toLowerCase().includes(needle) || service.description.toLowerCase().includes(needle))
            .sort((a, b) => Number(b.active === 'failed') - Number(a.active === 'failed') || a.name.localeCompare(b.name));
    }, [services, filter, query]);

    const current = services.find((service) => service.name === selected) ?? null;
    const wide = width >= 860;
    const focus = useListDetailFocus(selected, !wide);
    const actions: readonly ServiceAction[] = windows ? WINDOWS_SERVICE_ACTIONS : LINUX_SERVICE_ACTIONS;

    const stateLabel = (service: ServiceInfo) => (windows ? service.sub : `${service.active} (${service.sub})`);

    // Windows stops the running dependents of a service along with it.
    const dependentsNote = (action: ServiceAction): string | null => {
        if (!windows || (action !== 'stop' && action !== 'restart')) return null;
        const dependents = detail.data?.dependents;
        if (!dependents) return t('ops.services.confirm.dependents.unknown');
        return dependents.length ? t(`ops.services.confirm.dependents.${action}`, { names: dependents.join(', ') }) : null;
    };

    const runAction = async (name: string, action: ServiceAction) => {
        const note = dependentsNote(action);
        const message = t(`ops.services.confirm.${action}.message`, { name });
        const ok = await confirm({
            title: t(`ops.services.confirm.${action}.title`, { name }),
            message: note ? <><p>{message}</p><p className="mt-2 text-amber-200/90">{note}</p></> : message,
            confirmLabel: t(`ops.services.actions.${action}`),
            tone: DISRUPTIVE.has(action) ? 'danger' : 'default'
        });
        if (!ok) return;
        setRunning(action);
        try {
            await opsApi.serviceAction(serverId, name, action);
            toast.success(t(`ops.services.done.${action}`, { name }));
        } catch (error) {
            const { title, detail: reason } = describeError(error, t);
            toast.error(t('ops.services.failed', { name }), reason ? `${title} ${reason}` : title);
        } finally {
            setRunning(null);
            list.reload();
            detail.reload();
        }
    };

    if (unsupported) {
        return <EmptyState icon={<Cog className="h-5 w-5" />} title={t('ops.services.noSystemd')} detail={t('ops.services.noSystemdHint')} />;
    }

    const listPane = (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('ops.services.search')} className="w-full max-w-xs flex-1" inputRef={focus.fallback} />
                <Segmented<Filter>
                    label={t('ops.services.filterLabel')}
                    value={filter}
                    onChange={setFilter}
                    options={[
                        { value: 'all', label: t('ops.services.filter.all'), count: counts.all },
                        { value: 'running', label: t('ops.services.filter.running'), count: counts.running },
                        { value: 'failed', label: t('ops.services.filter.failed'), count: counts.failed },
                        { value: 'stopped', label: t('ops.services.filter.stopped'), count: counts.stopped }
                    ]}
                />
                <div className="ml-auto">
                    <ToolButton compact icon={<RefreshCw className="h-4 w-4" />} label={t('ops.refresh')} onClick={list.reload} busy={list.loading} />
                </div>
            </div>
            {list.data?.limited && <p className="border-b border-white/[0.06] px-4 py-2 text-[11px] text-amber-200/90">{t('ops.services.limitedWindows')}</p>}
            <div className="min-h-0 flex-1 overflow-auto">
                {list.error ? (
                    <ErrorNotice error={list.error} onRetry={list.reload} className="m-4" />
                ) : list.loading && !list.data ? (
                    <div className="space-y-2 p-4" aria-hidden="true">
                        {Array.from({ length: 8 }, (_, index) => <div key={index} className="h-9 animate-pulse rounded-lg bg-white/[0.03]" />)}
                    </div>
                ) : visible.length === 0 ? (
                    <EmptyState icon={<Cog className="h-5 w-5" />} title={t('ops.services.empty')} />
                ) : (
                    <table className="w-full table-fixed text-xs">
                        <caption className="sr-only">{t('ops.services.caption', { count: visible.length })}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <th scope="col" className="px-4 py-2 font-medium">{t('ops.services.columns.name')}</th>
                                <th scope="col" className="w-40 px-2 py-2 font-medium">{t('ops.services.columns.state')}</th>
                                {wide && <th scope="col" className="w-24 px-2 py-2 font-medium">{t('ops.services.columns.startup')}</th>}
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((service) => {
                                const isSelected = service.name === selected;
                                return (
                                    <tr
                                        key={service.name}
                                        className={cn('border-b border-white/[0.04] hover:bg-white/[0.03]', isSelected && 'bg-brand-500/[0.08] hover:bg-brand-500/[0.1]')}
                                    >
                                        <td className="px-4 py-1.5">
                                            <button
                                                ref={focus.rowRef(service.name)}
                                                type="button"
                                                onClick={() => {
                                                    focus.opening();
                                                    setSelected(service.name);
                                                }}
                                                aria-current={isSelected || undefined}
                                                className="block w-full min-w-0 rounded text-left focus-ring"
                                            >
                                                <span className="block truncate font-medium text-zinc-100">{service.name}</span>
                                                {service.description && <span className="block truncate text-[11px] text-zinc-500">{service.description}</span>}
                                            </button>
                                        </td>
                                        <td className="px-2 py-1.5"><StateBadge tone={serviceTone(service)} label={stateLabel(service)} /></td>
                                        {wide && <td className="truncate px-2 py-1.5 text-zinc-400">{service.startup ?? '—'}</td>}
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
            </div>
        </div>
    );

    const detailPane = selected && (
        <section
            aria-label={t('ops.services.detailLabel', { name: selected })}
            className={cn('flex min-h-0 min-w-0 flex-col overflow-auto', wide ? 'w-[26rem] shrink-0 border-l border-white/[0.06]' : 'flex-1')}
        >
            <div className="flex items-start gap-2 border-b border-white/[0.06] px-4 py-3">
                {!wide && (
                    <ToolButton
                        compact
                        icon={<ChevronLeft className="h-4 w-4" />}
                        label={t('ops.back')}
                        onClick={() => {
                            focus.closing(selected);
                            setSelected(null);
                        }}
                    />
                )}
                <div className="min-w-0 flex-1">
                    <h3 ref={focus.heading} tabIndex={-1} className="truncate text-sm font-semibold text-zinc-100 outline-none">{selected}</h3>
                    {current?.description && <p className="truncate text-xs text-zinc-400">{current.description}</p>}
                </div>
                {current && <StateBadge tone={serviceTone(current)} label={stateLabel(current)} />}
            </div>

            <div className="flex flex-wrap gap-1.5 px-4 py-3" role="group" aria-label={t('ops.services.actionsLabel')}>
                {actions.map((action) => {
                    const Icon = ACTION_ICONS[action];
                    return (
                        <ToolButton
                            key={action}
                            icon={<Icon className="h-3.5 w-3.5" />}
                            label={t(`ops.services.actions.${action}`)}
                            tone={action === 'stop' || action === 'disable' ? 'danger' : 'default'}
                            busy={running === action}
                            disabled={running !== null && running !== action}
                            onClick={() => void runAction(selected, action)}
                        />
                    );
                })}
                <AskAiButton serverId={serverId} attachment={{ kind: 'service', name: selected }} variant="button" className="ml-auto" />
            </div>

            <div className="space-y-4 px-4 pb-4">
                {detail.error ? (
                    <ErrorNotice error={detail.error} onRetry={detail.reload} />
                ) : detail.data ? (
                    <>
                        <PropertyList rows={Object.entries(detail.data.properties).filter(([, value]) => value !== '' && value !== '[not set]')} />
                        {detail.data.statusText && (
                            <pre className="max-h-64 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">{detail.data.statusText}</pre>
                        )}
                    </>
                ) : (
                    <div className="h-24 animate-pulse rounded-lg bg-white/[0.03]" aria-hidden="true" />
                )}

                {caps.journal && (
                    <section aria-label={t('ops.services.journal.title')} className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                            <h4 className="mr-auto text-xs font-semibold text-zinc-200">{t('ops.services.journal.title')}</h4>
                            <Segmented<string>
                                label={t('ops.services.journal.lines')}
                                value={String(journalLines ?? '')}
                                onChange={(value) => setJournalLines(Number(value))}
                                options={JOURNAL_LINES.map((lines) => ({ value: String(lines), label: String(lines) }))}
                            />
                            <ToolButton
                                icon={<ScrollText className="h-3.5 w-3.5" />}
                                label={t('ops.services.journal.follow')}
                                onClick={() => onFollowLogs({ kind: 'journal', unit: selected })}
                            />
                        </div>
                        {journalLines === null ? (
                            <p className="text-xs text-zinc-500">{t('ops.services.journal.hint')}</p>
                        ) : journal.error ? (
                            <ErrorNotice error={journal.error} onRetry={journal.reload} />
                        ) : (
                            <pre
                                aria-busy={journal.loading}
                                className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-300"
                            >
                                {journal.loading ? t('ops.loading') : journal.data?.trim() || t('ops.services.journal.empty')}
                            </pre>
                        )}
                    </section>
                )}
            </div>
        </section>
    );

    return (
        <div ref={rootRef} className="flex h-full min-h-0">
            {(wide || !selected) && listPane}
            {detailPane}
        </div>
    );
}
