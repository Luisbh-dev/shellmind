import { useState } from 'react';
import { Ban, CheckCircle, Server } from 'lucide-react';
import type { K8sNode, K8sPod } from '@shared/k8s';
import { useConfirm, useToast } from '@/components/ui';
import { EmptyState, StateBadge, ToolButton, type BadgeTone } from '@/features/ops/ui';
import { useRemote } from '@/features/ops/useRemote';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { useElementWidth } from '@/lib/useElementWidth';
import { k8sApi } from './api';
import { k8sErrorText } from './errors';
import { plural } from './labels';
import { formatAge } from './model';
import { K8sErrorNotice, TableSkeleton, useViewRefresh, type RefreshSignal } from './ui';

type NodesViewProps = {
    serverId: number;
    context: string;
    refresh: RefreshSignal;
    active: boolean;
    // The listed pods (of the chosen namespace), counted per node.
    pods: K8sPod[];
};

function nodeTone(node: K8sNode): BadgeTone {
    if (node.ready === false) return 'bad';
    if (node.pressures.length || node.unschedulable) return 'warn';
    return node.ready ? 'ok' : 'idle';
}

export function NodesView({ serverId, context, refresh, active, pods }: NodesViewProps) {
    const t = useT();
    const toast = useToast();
    const confirm = useConfirm();
    const [rootRef, width] = useElementWidth<HTMLDivElement>();
    const [busy, setBusy] = useState<string | null>(null);
    const nodes = useRemote((signal) => k8sApi.nodes(serverId, context, signal), `nodes:${serverId}:${context}`);
    useViewRefresh(nodes, refresh, active);
    const wide = width >= 900;
    const compact = width > 0 && width < 560;
    const now = Date.now();

    const toggle = async (node: K8sNode) => {
        const action = node.unschedulable ? 'uncordon' : 'cordon';
        const ok = await confirm({
            title: t(`k8s.nodes.${action}.title`, { name: node.name }),
            message: t(`k8s.nodes.${action}.message`, { name: node.name }),
            confirmLabel: t(`k8s.nodes.${action}.confirm`),
            tone: action === 'cordon' ? 'danger' : 'default'
        });
        if (!ok) return;
        setBusy(node.name);
        try {
            await k8sApi.cordon(serverId, context, node.name, action);
            toast.success(t(`k8s.nodes.${action}.done`, { name: node.name }));
        } catch (error) {
            toast.error(t(`k8s.nodes.${action}.failed`, { name: node.name }), k8sErrorText(error, t));
        } finally {
            setBusy(null);
            nodes.reload();
        }
    };

    const status = (node: K8sNode) => [
        node.ready === null ? t('k8s.nodes.unknown') : node.ready ? t('k8s.nodes.ready') : t('k8s.nodes.notReady'),
        ...(node.unschedulable ? [t('k8s.nodes.cordoned')] : [])
    ].join(', ');

    return (
        <div ref={rootRef} className="flex h-full min-h-0 flex-col">
            {nodes.error && nodes.data ? <K8sErrorNotice error={nodes.error} title={t('k8s.refreshFailed')} onRetry={nodes.reload} className="mx-4 mt-3" /> : null}
            <div className="min-h-0 flex-1 overflow-auto">
                {nodes.error && !nodes.data ? (
                    <K8sErrorNotice error={nodes.error} onRetry={nodes.reload} className="m-4" />
                ) : nodes.loading && !nodes.data ? (
                    <TableSkeleton rows={3} />
                ) : !nodes.data?.length ? (
                    <EmptyState icon={<Server className="h-5 w-5" />} title={t('k8s.nodes.empty')} />
                ) : (
                    <table className="w-full min-w-[22rem] table-fixed text-xs">
                        <caption className="sr-only">{plural(t, 'k8s.nodes.caption', nodes.data.length)}</caption>
                        <thead className="sticky top-0 z-[1] bg-ink-850/95 backdrop-blur">
                            <tr className="text-left text-[11px] text-zinc-400">
                                <th scope="col" className="py-2 pl-4 pr-2 font-medium">{t('k8s.nodes.columns.name')}</th>
                                <th scope="col" className="w-44 px-2 py-2 font-medium">{t('k8s.nodes.columns.status')}</th>
                                {wide && <th scope="col" className="w-36 px-2 py-2 font-medium">{t('k8s.nodes.columns.version')}</th>}
                                {wide && <th scope="col" className="w-32 px-2 py-2 font-medium">{t('k8s.nodes.columns.capacity')}</th>}
                                {!compact && <th scope="col" className="w-16 px-2 py-2 font-medium">{t('k8s.nodes.columns.age')}</th>}
                                <th scope="col" className={compact ? 'w-14 px-2 py-2 pr-4' : 'w-32 px-2 py-2 pr-4'}><span className="sr-only">{t('k8s.nodes.columns.actions')}</span></th>
                            </tr>
                        </thead>
                        <tbody>
                            {nodes.data.map((node) => {
                                const count = pods.filter((pod) => pod.node === node.name).length;
                                return (
                                    <tr key={node.name} className={cn('border-b border-white/[0.04]', node.ready === false && 'bg-rose-500/[0.04]')}>
                                        <td className="py-1.5 pl-4 pr-2">
                                            <span className="block truncate font-medium text-zinc-100" title={node.name}>{node.name}</span>
                                            <span className="block truncate text-[11px] text-zinc-500">
                                                {[node.roles.join(', ') || t('k8s.nodes.worker'), node.internalIp, plural(t, 'k8s.nodes.pods', count)].filter(Boolean).join(' · ')}
                                            </span>
                                        </td>
                                        <td className="px-2 py-1.5">
                                            <StateBadge tone={nodeTone(node)} label={status(node)} />
                                            {node.pressures.length > 0 && <div className="mt-0.5 truncate text-[11px] text-amber-200">{node.pressures.join(', ')}</div>}
                                        </td>
                                        {wide && (
                                            <td className="px-2 py-1.5 text-zinc-400">
                                                <span className="block truncate">{node.version ?? '—'}</span>
                                                <span className="block truncate text-[11px] text-zinc-500" title={[node.osImage, node.kernel].filter(Boolean).join(' · ')}>{node.runtime ?? ''}</span>
                                            </td>
                                        )}
                                        {wide && (
                                            <td className="px-2 py-1.5 text-[11px] text-zinc-400">
                                                {t('k8s.nodes.capacity', { cpu: node.capacity.cpu ?? '—', memory: node.capacity.memory ?? '—' })}
                                            </td>
                                        )}
                                        {!compact && <td className="px-2 py-1.5 tabular-nums text-zinc-400" title={node.createdAt ?? undefined}>{formatAge(node.createdAt, now)}</td>}
                                        <td className="px-2 py-1.5 pr-4 text-right">
                                            <ToolButton
                                                icon={node.unschedulable ? <CheckCircle className="h-3.5 w-3.5" /> : <Ban className="h-3.5 w-3.5" />}
                                                compact={compact}
                                                label={node.unschedulable ? t('k8s.nodes.uncordon.action') : t('k8s.nodes.cordon.action')}
                                                tone={node.unschedulable ? 'default' : 'danger'}
                                                busy={busy === node.name}
                                                onClick={() => void toggle(node)}
                                            />
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
}
