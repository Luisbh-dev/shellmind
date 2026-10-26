import { useMemo, useState } from 'react';
import { Boxes, Layers, MoreHorizontal, RotateCw, Scaling, ShieldAlert } from 'lucide-react';
import { K8S_RESTARTABLE_KINDS, K8S_SCALABLE_KINDS, K8S_WORKLOAD_KINDS, type K8sPod, type K8sWorkload, type K8sWorkloadKind } from '@shared/k8s';
import { Menu, useConfirm, useToast } from '@/components/ui';
import { EmptyState, SearchField, StateBadge } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useElementWidth } from '@/lib/useElementWidth';
import { k8sApi } from './api';
import { k8sErrorText } from './errors';
import { plural } from './labels';
import { formatAge, HEALTH_TONE, isAllNamespaces, workloadPods } from './model';
import { ScaleDialog } from './ScaleDialog';
import { K8sErrorNotice, TableSkeleton, useViewRefresh, type RefreshSignal } from './ui';

type WorkloadsViewProps = {
    serverId: number;
    context: string;
    namespace: string;
    refresh: RefreshSignal;
    active: boolean;
    pods: K8sPod[];
    onShowPods: (workload: K8sWorkload) => void;
};

const key = (workload: K8sWorkload) => `${workload.kind}/${workload.namespace}/${workload.name}`;

// "2/3 ready", "1/1 succeeded", "1 active job".
function readiness(workload: K8sWorkload, t: ReturnType<typeof useT>): string {
    if (workload.kind === 'cronjob') return plural(t, 'k8s.workloads.activeJobs', workload.ready ?? 0);
    if (workload.kind === 'job') return t('k8s.workloads.succeeded', { done: workload.ready ?? 0, total: workload.desired ?? '—' });
    return `${workload.ready ?? 0}/${workload.desired ?? 0}`;
}

// A job (or a cronjob's run) completes or runs rather than being healthy.
function healthLabel(workload: K8sWorkload, t: ReturnType<typeof useT>): string {
    const batch = workload.kind === 'job' || workload.kind === 'cronjob';
    if (batch && workload.health === 'ok') return t('k8s.health.complete');
    if (batch && workload.health === 'progressing') return t('k8s.health.running');
    return t(`k8s.health.${workload.health}`);
}

export function WorkloadsView({ serverId, context, namespace, refresh, active, pods, onShowPods }: WorkloadsViewProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const [query, setQuery] = useState('');
    const [scaling, setScaling] = useState<K8sWorkload | null>(null);
    const [busy, setBusy] = useState<string | null>(null);
    const workloads = useRemote((signal) => k8sApi.workloads(serverId, context, namespace, signal), `workloads:${serverId}:${context}:${namespace}`);
    useViewRefresh(workloads, refresh, active);
    const wide = width >= 860;
    const compact = width > 0 && width < 560;
    const columns = 4 + (wide ? 1 : 0) + (compact ? 0 : 1);
    const all = isAllNamespaces(namespace);
    const now = Date.now();

    const list = useMemo(() => workloads.data?.workloads ?? [], [workloads.data]);
    const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return list.filter((workload) => !needle || [workload.name, workload.namespace, ...workload.images].some((value) => value.toLowerCase().includes(needle)));
    }, [list, query]);
    const groups = K8S_WORKLOAD_KINDS.map((kind) => ({ kind, items: visible.filter((workload) => workload.kind === kind) })).filter((group) => group.items.length);

    const restart = async (workload: K8sWorkload) => {
        const ok = await confirm({
            title: t('k8s.workloads.restart.title', { kind: t(`k8s.kinds.${workload.kind}`), name: workload.name }),
            message: t('k8s.workloads.restart.message', { name: workload.name }),
            confirmLabel: t('k8s.workloads.restart.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        setBusy(key(workload));
        try {
            await k8sApi.restart(serverId, context, workload.namespace, workload.kind, workload.name);
            toast.success(t('k8s.workloads.restart.done', { name: workload.name }));
        } catch (error) {
            toast.error(t('k8s.workloads.restart.failed', { name: workload.name }), k8sErrorText(error, t));
        } finally {
            setBusy(null);
            workloads.reload();
        }
    };

    const scale = async (workload: K8sWorkload, replicas: number) => {
        setBusy(key(workload));
        try {
            await k8sApi.scale(serverId, context, workload.namespace, workload.kind, workload.name, replicas);
            toast.success(plural(t, 'k8s.scale.done', replicas, { name: workload.name }));
            setScaling(null);
        } catch (error) {
            toast.error(t('k8s.scale.failed', { name: workload.name }), k8sErrorText(error, t));
        } finally {
            setBusy(null);
            workloads.reload();
        }
    };

    const actions = (workload: K8sWorkload) => [
        { id: 'pods', label: plural(t, 'k8s.workloads.showPods', workloadPods(workload, pods).length), icon: <Boxes className="h-3.5 w-3.5" />, onSelect: () => onShowPods(workload) },
        ...(K8S_RESTARTABLE_KINDS.includes(workload.kind) ? [{ id: 'restart', label: t('k8s.workloads.restart.action'), icon: <RotateCw className="h-3.5 w-3.5" />, onSelect: () => void restart(workload) }] : []),
        ...(K8S_SCALABLE_KINDS.includes(workload.kind) ? [{ id: 'scale', label: t('k8s.scale.action'), icon: <Scaling className="h-3.5 w-3.5" />, onSelect: () => setScaling(workload) }] : [])
    ];

    return (
        <div ref={rootRef} className="flex h-full min-h-0 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2.5">
                <SearchField value={query} onChange={setQuery} label={t('k8s.workloads.search')} className="w-full min-w-[10rem] max-w-xs flex-1" />
                {workloads.data?.warnings.length ? (
                    <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-amber-200" title={workloads.data.warnings.join('\n')}>
                        <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                        <span className="truncate">{t('k8s.workloads.partial')}</span>
                    </span>
                ) : null}
            </div>
            {workloads.error && workloads.data ? <K8sErrorNotice error={workloads.error} title={t('k8s.refreshFailed')} onRetry={workloads.reload} className="mx-4 mt-3" /> : null}
            <div className="min-h-0 flex-1 overflow-auto">
                {workloads.error && !workloads.data ? (
                    <K8sErrorNotice error={workloads.error} onRetry={workloads.reload} className="m-4" />
                ) : workloads.loading && !workloads.data ? (
                    <TableSkeleton />
                ) : groups.length === 0 ? (
                    <EmptyState icon={<Layers className="h-5 w-5" />} title={list.length ? t('k8s.workloads.noMatch') : t('k8s.workloads.empty')} />
                ) : (
                    <table className="w-full min-w-[22rem] table-fixed text-xs">
                        <caption className="sr-only">{plural(t, 'k8s.workloads.caption', visible.length)}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <th scope="col" className="py-2 pl-4 pr-2 font-medium">{t('k8s.workloads.columns.name')}</th>
                                <th scope="col" className={cn('px-2 py-2 font-medium', compact ? 'w-20' : 'w-28')}>{t('k8s.workloads.columns.ready')}</th>
                                {wide && <th scope="col" className="w-32 px-2 py-2 font-medium">{t('k8s.workloads.columns.upToDate')}</th>}
                                <th scope="col" className="w-32 px-2 py-2 font-medium">{t('k8s.workloads.columns.status')}</th>
                                {!compact && <th scope="col" className="w-16 px-2 py-2 font-medium">{t('k8s.workloads.columns.age')}</th>}
                                <th scope="col" className="w-12 px-2 py-2 pr-4"><span className="sr-only">{t('k8s.workloads.columns.actions')}</span></th>
                            </tr>
                        </thead>
                        {groups.map((group) => (
                            <tbody key={group.kind}>
                                <tr>
                                    <th scope="rowgroup" colSpan={columns} className="bg-white/[0.02] px-4 py-1.5 text-left text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                                        {t(`k8s.kindsPlural.${group.kind as K8sWorkloadKind}`)} <span className="ml-1 font-normal tabular-nums text-zinc-500">{group.items.length}</span>
                                    </th>
                                </tr>
                                {group.items.map((workload) => {
                                    const tone = HEALTH_TONE[workload.health];
                                    return (
                                        <tr key={key(workload)} className={cn('border-b border-white/[0.04]', (workload.health === 'degraded' || workload.health === 'failed') && 'bg-rose-500/[0.04]')}>
                                            <td className="py-1.5 pl-4 pr-2">
                                                <button
                                                    type="button"
                                                    onClick={() => onShowPods(workload)}
                                                    title={plural(t, 'k8s.workloads.showPods', workloadPods(workload, pods).length)}
                                                    className="block w-full min-w-0 rounded text-left focus-ring"
                                                >
                                                    <span className="block truncate font-medium text-zinc-100">{workload.name}</span>
                                                    <span className="block truncate font-mono text-[11px] text-zinc-500" title={workload.images.join(', ')}>
                                                        {[all ? workload.namespace : null, workload.schedule, workload.images.join(', ')].filter(Boolean).join(' · ')}
                                                    </span>
                                                </button>
                                            </td>
                                            <td className={cn('px-2 py-1.5 tabular-nums', tone === 'bad' ? 'text-rose-200' : tone === 'warn' ? 'text-amber-200' : 'text-zinc-300')}>{readiness(workload, t)}</td>
                                            {wide && <td className="px-2 py-1.5 tabular-nums text-zinc-400">{workload.upToDate ?? '—'}{workload.available !== null ? ` · ${t('k8s.workloads.available', { count: workload.available })}` : ''}</td>}
                                            <td className="px-2 py-1.5" title={workload.condition?.message ?? undefined}>
                                                <StateBadge tone={tone} label={healthLabel(workload, t)} />
                                                {workload.condition?.reason && <div className="mt-0.5 truncate text-[11px] text-zinc-500">{workload.condition.reason}</div>}
                                            </td>
                                            {!compact && <td className="px-2 py-1.5 tabular-nums text-zinc-400" title={workload.createdAt ?? undefined}>{formatAge(workload.createdAt, now)}</td>}
                                            <td className="px-2 py-1.5 pr-4 text-right">
                                                <Menu
                                                    label={t('k8s.workloads.actionsFor', { name: workload.name })}
                                                    triggerClassName={cn('inline-flex h-7 w-7 items-center justify-center rounded-lg text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-100 focus-ring', busy === key(workload) && 'animate-pulse')}
                                                    items={actions(workload)}
                                                >
                                                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                                </Menu>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        ))}
                    </table>
                )}
            </div>
            {scaling && (
                <ScaleDialog
                    workload={scaling}
                    busy={busy === key(scaling)}
                    onCancel={() => setScaling(null)}
                    onScale={(replicas) => void scale(scaling, replicas)}
                />
            )}
        </div>
    );
}
