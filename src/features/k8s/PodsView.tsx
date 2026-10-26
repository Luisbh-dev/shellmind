import { useEffect, useMemo, useState } from 'react';
import { Boxes, ChevronLeft, X } from 'lucide-react';
import { K8S_MAX_PODS, type K8sPod, type K8sPodList, type K8sWorkload } from '@shared/k8s';
import { EmptyState, SearchField, Segmented, StateBadge, ToolButton } from '@/features/ops/ui';
import { useListDetailFocus } from '@/features/ops/useListDetailFocus';
import type { RemoteState } from '@/features/ops/useRemote';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useElementWidth } from '@/lib/useElementWidth';
import type { WorkspaceServer } from '@/workspace/types';
import { filterPods, formatAge, isAllNamespaces, podTone, sortPods, workloadPods, type PodFilter, type PodSortKey, type SortState } from './model';
import { ownerLabel, plural } from './labels';
import { PodDetail } from './PodDetail';
import { PodShellButton } from './shell';
import { K8sErrorNotice, SortHeader, TableSkeleton } from './ui';

type PodsViewProps = {
    server: WorkspaceServer;
    context: string;
    namespace: string;
    pods: RemoteState<K8sPodList>;
    onReload: () => void;
    // Only the pods of this workload (from the workloads view).
    workload: K8sWorkload | null;
    onClearWorkload: () => void;
    // A pod to open (from the events view).
    request: { name: string; namespace: string; nonce: number } | null;
    active: boolean;
};

const key = (pod: Pick<K8sPod, 'namespace' | 'name'>) => `${pod.namespace}/${pod.name}`;

export function PodsView({ server, context, namespace, pods, onReload, workload, onClearWorkload, request, active }: PodsViewProps) {
    const t = useT();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const [filter, setFilter] = useState<PodFilter>('all');
    const [query, setQuery] = useState('');
    const [sort, setSort] = useState<SortState<PodSortKey>>({ key: 'status', direction: 'asc' });
    const [selected, setSelected] = useState<string | null>(null);
    // The detail sits next to the list in a wide panel (38rem of it); the
    // list drops its less telling columns as it narrows.
    const wide = width >= 1100;
    const listWidth = wide && selected ? width - 608 : width;
    const showNode = listWidth >= 900;
    const compact = listWidth > 0 && listWidth < 600;
    const focus = useListDetailFocus(selected, !wide);
    const all = isAllNamespaces(namespace);
    const now = Date.now();

    // The view's selection belongs to its context and namespace.
    useEffect(() => {
        setSelected(null);
    }, [context, namespace]);

    useEffect(() => {
        if (!request) return;
        setFilter('all');
        setQuery('');
        setSelected(key(request));
    }, [request]);

    const list = useMemo(() => pods.data?.pods ?? [], [pods.data]);
    const scoped = useMemo(() => (workload ? workloadPods(workload, list) : list), [workload, list]);
    const counts = {
        all: scoped.length,
        problems: scoped.filter((pod) => pod.problem).length,
        running: scoped.filter((pod) => pod.phase === 'Running').length,
        completed: scoped.filter((pod) => pod.phase === 'Succeeded' || pod.phase === 'Failed').length
    };
    const visible = useMemo(() => sortPods(filterPods(scoped, filter, query), sort), [scoped, filter, query, sort]);
    const current = list.find((pod) => key(pod) === selected) ?? null;

    const select = (pod: K8sPod) => {
        focus.opening();
        setSelected(key(pod));
    };
    const close = () => {
        focus.closing(selected);
        setSelected(null);
    };

    const listPane = (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('k8s.pods.search')} className="w-full min-w-[10rem] max-w-xs flex-1" inputRef={focus.fallback} />
                <Segmented<PodFilter>
                    label={t('k8s.pods.filterLabel')}
                    value={filter}
                    onChange={setFilter}
                    options={(['all', 'problems', 'running', 'completed'] as const).map((value) => ({ value, label: t(`k8s.pods.filter.${value}`), count: counts[value] }))}
                />
                {workload && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-brand-500/40 bg-brand-500/10 py-0.5 pl-2.5 pr-1 text-[11px] text-brand-100">
                        {t('k8s.pods.ofWorkload', { kind: t(`k8s.kinds.${workload.kind}`), name: workload.name })}
                        <button type="button" onClick={onClearWorkload} aria-label={t('k8s.pods.clearWorkload')} className="rounded-full p-0.5 hover:bg-brand-500/20 focus-ring">
                            <X className="h-3 w-3" aria-hidden="true" />
                        </button>
                    </span>
                )}
            </div>
            {pods.data?.truncated && <p className="border-b border-white/[0.06] bg-amber-500/[0.06] px-4 py-1.5 text-[11px] text-amber-200" role="status">{t('k8s.pods.truncated', { count: K8S_MAX_PODS })}</p>}
            {pods.error && pods.data ? <K8sErrorNotice error={pods.error} title={t('k8s.refreshFailed')} onRetry={onReload} className="mx-4 mt-3" /> : null}
            <div className="min-h-0 flex-1 overflow-auto">
                {pods.error && !pods.data ? (
                    <K8sErrorNotice error={pods.error} onRetry={onReload} className="m-4" />
                ) : pods.loading && !pods.data ? (
                    <TableSkeleton />
                ) : visible.length === 0 ? (
                    <EmptyState
                        icon={<Boxes className="h-5 w-5" />}
                        title={scoped.length ? t('k8s.pods.noMatch') : t('k8s.pods.empty')}
                        detail={scoped.length ? undefined : all ? t('k8s.pods.emptyAll') : t('k8s.pods.emptyHint', { namespace })}
                    />
                ) : (
                    <table className="w-full min-w-[22rem] table-fixed text-xs">
                        <caption className="sr-only">{plural(t, 'k8s.pods.caption', visible.length)}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <SortHeader label={t('k8s.pods.columns.name')} sortKey="name" sort={sort} onSort={setSort} className="pl-4" />
                                <SortHeader label={t('k8s.pods.columns.status')} sortKey="status" sort={sort} onSort={setSort} className={compact ? 'w-36' : 'w-40'} />
                                {!compact && <th scope="col" className="w-14 px-2 py-2 font-medium">{t('k8s.pods.columns.ready')}</th>}
                                <SortHeader label={t('k8s.pods.columns.restarts')} sortKey="restarts" sort={sort} onSort={setSort} className={compact ? 'w-20' : 'w-28'} />
                                {showNode && <SortHeader label={t('k8s.pods.columns.node')} sortKey="node" sort={sort} onSort={setSort} className="w-32" />}
                                {!compact && <SortHeader label={t('k8s.pods.columns.age')} sortKey="age" sort={sort} onSort={setSort} className="w-16" />}
                                <th scope="col" className="w-12 px-2 py-2 pr-4"><span className="sr-only">{t('k8s.pods.columns.shell')}</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {visible.map((pod) => {
                                const isSelected = key(pod) === selected;
                                return (
                                    <tr
                                        key={key(pod)}
                                        data-problem={pod.problem ?? undefined}
                                        className={cn(
                                            'border-b border-white/[0.04]',
                                            isSelected ? 'bg-brand-500/[0.08]' : pod.problem && podTone(pod) === 'bad' && 'bg-rose-500/[0.04]'
                                        )}
                                    >
                                        <td className="py-1.5 pl-4 pr-2">
                                            <button
                                                ref={focus.rowRef(key(pod))}
                                                type="button"
                                                onClick={() => select(pod)}
                                                aria-current={isSelected || undefined}
                                                className="block w-full min-w-0 rounded text-left focus-ring"
                                            >
                                                <span className="block truncate font-medium text-zinc-100" title={pod.name}>{pod.name}</span>
                                                <span className="block truncate text-[11px] text-zinc-500">
                                                    {[all ? pod.namespace : null, pod.owner ? ownerLabel(t, pod.owner) : null].filter(Boolean).join(' · ') || '—'}
                                                </span>
                                            </button>
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <StateBadge tone={podTone(pod)} label={pod.status} />
                                        </td>
                                        {!compact && <td className={cn('px-2 py-1.5 tabular-nums', pod.ready < pod.total && pod.phase === 'Running' ? 'text-amber-200' : 'text-zinc-300')}>{pod.ready}/{pod.total}</td>}
                                        <td className="truncate px-2 py-1.5">
                                            <span className={cn('tabular-nums', pod.restarts > 0 ? 'text-amber-200' : 'text-zinc-300')}>{pod.restarts}</span>
                                            {pod.lastRestartAt && !compact && <span className="ml-1 text-[11px] text-zinc-500" title={pod.lastRestartAt}>({t('k8s.pods.ago', { age: formatAge(pod.lastRestartAt, now) })})</span>}
                                        </td>
                                        {showNode && <td className="truncate px-2 py-1.5 text-zinc-400" title={pod.node ?? undefined}>{pod.node ?? '—'}</td>}
                                        {!compact && <td className="px-2 py-1.5 tabular-nums text-zinc-400" title={pod.createdAt ?? undefined}>{formatAge(pod.createdAt, now)}</td>}
                                        <td className="px-2 py-1.5 pr-4 text-right">
                                            <PodShellButton compact serverId={server.id} context={context} pod={pod} />
                                        </td>
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
            aria-label={t('k8s.pod.detailLabel', { name: current?.name ?? selected })}
            className={cn('flex min-h-0 min-w-0 flex-col', wide ? 'w-[38rem] shrink-0 border-l border-white/[0.06]' : 'flex-1')}
        >
            {!wide && !current && (
                <div className="flex items-center gap-2 border-b border-white/[0.06] px-4 py-2">
                    <ToolButton icon={<ChevronLeft className="h-4 w-4" />} label={t('k8s.back')} onClick={close} />
                </div>
            )}
            {current ? (
                <PodDetail
                    key={key(current)}
                    server={server}
                    context={context}
                    pod={current}
                    headingRef={focus.heading}
                    onBack={wide ? undefined : close}
                    onClose={wide ? close : undefined}
                    onDeleted={() => {
                        focus.closing(null);
                        setSelected(null);
                        onReload();
                    }}
                    active={active}
                />
            ) : (
                <p className="px-4 py-3 text-xs text-zinc-400">{pods.loading ? t('k8s.loading') : t('k8s.pod.gone')}</p>
            )}
        </section>
    );

    return (
        <div ref={rootRef} className="flex h-full min-h-0">
            {(wide || !selected) && listPane}
            {detailPane}
        </div>
    );
}
