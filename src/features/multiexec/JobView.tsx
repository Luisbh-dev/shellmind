import { useMemo, useState } from 'react';
import { Pause, Play, Square, AlertTriangle, Hourglass, ShieldCheck, Ban, Link2 } from 'lucide-react';
import { countStatuses, isFailureStatus, isJobFinal, planBatches, type MultiExecServerRun, type MultiExecStatus } from '@shared/multiexec';
import type { GroupMode } from '@shared/multiexecOutput';
import { Button, Checkbox, SegmentedControl, Spinner } from '@/components/ui';
import { useT, type TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { BatchStrip, type BatchState } from './BatchStrip';
import { formatDuration } from './export';
import { OutputGroups } from './OutputGroups';
import { ServerList } from './ServerList';
import { JobStatusBadge, STATUS_FILL, STATUS_ORDER, STATUS_STYLE, useNow } from './status';
import { summaryOf, type JobView as JobViewModel } from './store';
import { plural } from './strategy';

type Filter = 'all' | 'problems' | MultiExecStatus;
type Mode = 'grouped' | 'servers';

const isProblem = (status: MultiExecStatus) => status !== 'ok' && status !== 'queued' && status !== 'running';

function countdown(ms: number): string {
    const seconds = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function batchStates(servers: readonly MultiExecServerRun[], batches: number, current: number | null, final: boolean): BatchState[] {
    return Array.from({ length: batches }, (_, batch) => {
        const members = servers.filter((server) => server.batch === batch);
        if (members.length && members.every((server) => server.startedAt === null && (server.status === 'skipped' || server.status === 'cancelled'))) return 'skipped';
        if (members.some((server) => server.status === 'queued' || server.status === 'running')) return !final && batch === current ? 'current' : 'pending';
        return members.some((server) => isFailureStatus(server.status)) ? 'failed' : 'done';
    });
}

// The headline of a job: how far it got, or how it ended.
function progressText(view: JobViewModel, t: TranslateFn): string {
    const { info } = view;
    const counts = summaryOf(view).counts;
    const total = view.servers.length || info.total;
    const finished = total - counts.queued - counts.running;
    switch (info.status) {
        case 'running':
            return info.stopReason ? t('multiexec.job.stopping') : t('multiexec.results.progress', { done: finished, total });
        case 'paused':
            return t('multiexec.job.pausedProgress', { done: finished, total });
        case 'done':
            return counts.failed + counts.timeout > 0
                ? t('multiexec.job.doneWithFailures', { ok: counts.ok, failed: counts.failed + counts.timeout })
                : plural(t, 'multiexec.results.finished', total);
        case 'stopped':
            return info.stopReason === 'lifetime'
                ? t('multiexec.job.stopped.lifetime')
                : plural(t, `multiexec.job.stopped.${info.stopReason ?? 'failure-limit'}`, counts.skipped, { failed: counts.failed + counts.timeout });
        case 'cancelled':
            return t('multiexec.results.cancelledRun');
        default:
            return t('multiexec.job.interrupted');
    }
}

interface JobViewProps {
    view: JobViewModel;
    onPause: () => void;
    onResume: () => void;
    onCancel: () => void;
    busy: 'pause' | 'resume' | 'cancel' | null;
    onOpenJob: (id: string) => void;
}

export function JobView({ view, onPause, onResume, onCancel, busy, onOpenJob }: JobViewProps) {
    const t = useT();
    const { info, servers } = view;
    const final = isJobFinal(info.status);
    const now = useNow(!final);
    const [mode, setMode] = useState<Mode>(() => (servers.length === 1 || info.total === 1 ? 'servers' : 'grouped'));
    const [filter, setFilter] = useState<Filter>('all');
    const [groupMode, setGroupMode] = useState<GroupMode>('normalized');
    const [expanded, setExpanded] = useState<Set<number>>(() => new Set(info.total === 1 && servers[0] ? [servers[0].serverId] : []));

    const counts = useMemo(() => countStatuses(servers.map((server) => server.status)), [servers]);
    const total = servers.length;
    const visible = useMemo(() => servers.filter((server) => filter === 'all' || (filter === 'problems' ? isProblem(server.status) : server.status === filter)), [servers, filter]);
    const sizes = planBatches(total || info.total, info.strategy);
    const hasCanary = Boolean(info.strategy.canary) && sizes.length > 1;
    const states = batchStates(servers, info.batches, info.batch, final);
    const elapsed = (info.finishedAt ?? now) - info.createdAt;
    const problems = servers.filter((server) => isProblem(server.status)).length;

    const batchLabel = (batch: number) => {
        if (info.batches <= 1) return null;
        return hasCanary && batch === 0 ? t('multiexec.plan.canaryName') : t('multiexec.plan.batchName', { number: hasCanary ? batch : batch + 1 });
    };

    const canary = servers.filter((server) => server.batch === 0);
    const canaryOk = canary.filter((server) => server.status === 'ok').length;
    const allExpanded = visible.length > 0 && visible.every((server) => expanded.has(server.serverId));
    const toggle = (serverId: number) => setExpanded((current) => {
        const next = new Set(current);
        if (next.has(serverId)) next.delete(serverId);
        else next.add(serverId);
        return next;
    });

    const filters: Array<{ value: Filter; label: string; count: number; style?: string }> = [
        { value: 'all', label: t('multiexec.filter.all'), count: total },
        ...(problems > 0 && problems < total ? [{ value: 'problems' as const, label: t('multiexec.filter.problems'), count: problems }] : []),
        ...STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => ({ value: status, label: t(`multiexec.status.${status}`), count: counts[status], style: STATUS_STYLE[status] }))
    ];

    return (
        <section className="flex min-h-0 flex-1 flex-col gap-3" aria-label={t('multiexec.job.title')}>
            <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <JobStatusBadge status={info.status} failed={counts.failed + counts.timeout > 0} />
                    {/* Focused when the job shows (MultiExecModal). */}
                    <p role="status" tabIndex={-1} data-view-focus className="min-w-0 rounded text-sm text-zinc-100 focus-ring">{progressText(view, t)}</p>
                    <p className="text-xs text-zinc-500">
                        {[
                            info.batches > 1 && info.batch !== null && !final && (hasCanary && info.batch === 0
                                ? t('multiexec.job.canaryRunning')
                                : t('multiexec.job.batchOf', { number: hasCanary ? info.batch : info.batch + 1, total: hasCanary ? info.batches - 1 : info.batches })),
                            formatDuration(Math.max(0, elapsed))
                        ].filter(Boolean).join(' · ')}
                    </p>
                    {!final && (
                        <div className="ml-auto flex gap-2">
                            {/* While paused, the banner below offers to resume or continue. */}
                            {info.status !== 'paused' && (
                                <Button size="sm" variant="subtle" onClick={onPause} loading={busy === 'pause'} disabled={info.stopReason !== null}>
                                    <Pause className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.job.pause')}
                                </Button>
                            )}
                            <Button size="sm" variant="danger" onClick={onCancel} loading={busy === 'cancel'}>
                                <Square className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.job.cancel')}
                            </Button>
                        </div>
                    )}
                </div>
                <pre className="max-h-16 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-zinc-300 scrollbar-thin" aria-label={t('multiexec.confirm.command')}>{info.command}</pre>
                {info.rerunOf && (
                    <button type="button" onClick={() => onOpenJob(info.rerunOf!)} className="inline-flex items-center gap-1 rounded text-[11px] text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline focus-ring">
                        <Link2 className="h-3 w-3" aria-hidden="true" />{t('multiexec.job.rerunOf')}
                    </button>
                )}

                <div className="flex h-1.5 overflow-hidden rounded-full bg-white/5" role="img" aria-label={STATUS_ORDER.filter((status) => counts[status] > 0).map((status) => `${t(`multiexec.status.${status}`)}: ${counts[status]}`).join(', ')}>
                    {total > 0 && STATUS_ORDER.filter((status) => status !== 'queued' && counts[status] > 0).map((status) => (
                        <div key={status} className={cn('h-full transition-all', STATUS_FILL[status])} style={{ width: `${(counts[status] / total) * 100}%` }} />
                    ))}
                </div>
                {info.batches > 1 && <BatchStrip sizes={sizes} canary={hasCanary} states={states} />}
            </div>

            {info.status === 'paused' && info.pause && (
                <div
                    role="group"
                    aria-labelledby={`gate-${info.id}`}
                    className={cn(
                        'flex flex-wrap items-center gap-3 rounded-xl border px-4 py-3',
                        info.pause.reason === 'canary-failed' ? 'border-rose-500/40 bg-rose-500/[0.08]' : info.pause.reason === 'canary' ? 'border-emerald-500/30 bg-emerald-500/[0.07]' : 'border-sky-500/30 bg-sky-500/[0.07]'
                    )}
                >
                    {info.pause.reason === 'canary-failed'
                        ? <AlertTriangle className="h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
                        : info.pause.reason === 'canary' ? <ShieldCheck className="h-4 w-4 shrink-0 text-emerald-300" aria-hidden="true" /> : <Pause className="h-4 w-4 shrink-0 text-sky-300" aria-hidden="true" />}
                    <div className="min-w-0 flex-1 space-y-0.5">
                        {/* Announced once; the countdown below is not a live region. */}
                        <p id={`gate-${info.id}`} role="alert" className="text-sm font-medium text-zinc-100">
                            {info.pause.reason === 'canary'
                                ? plural(t, 'multiexec.gate.canaryOk', total - canary.length, { ok: canaryOk, total: canary.length })
                                : info.pause.reason === 'canary-failed'
                                    ? plural(t, 'multiexec.gate.canaryFailed', canary.length, { failed: canary.length - canaryOk })
                                    : t('multiexec.gate.paused')}
                        </p>
                        <p className="text-xs text-zinc-400">
                            {t('multiexec.gate.expires', { time: countdown(Math.min(info.pause.expiresAt - now, info.pause.expiresAt - info.pause.since)) })}
                        </p>
                    </div>
                    {info.pause.reason === 'user' ? (
                        <Button size="sm" variant="secondary" onClick={onResume} loading={busy === 'resume'}>
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.job.resume')}
                        </Button>
                    ) : (
                        <Button size="sm" variant={info.pause.reason === 'canary' ? 'primary' : 'secondary'} onClick={onResume} loading={busy === 'resume'}>
                            <Play className="h-3.5 w-3.5" aria-hidden="true" />{info.pause.reason === 'canary' ? t('multiexec.gate.continue') : t('multiexec.gate.continueAnyway')}
                        </Button>
                    )}
                </div>
            )}
            {info.status === 'running' && info.stopReason === 'failure-limit' && (
                <p role="alert" className="flex items-center gap-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-200">
                    <Ban className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('multiexec.gate.limitReached')}
                </p>
            )}
            {info.status === 'running' && info.nextBatchAt !== null && (
                <p className="flex items-center gap-2 text-xs text-zinc-400">
                    <Hourglass className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />{t('multiexec.gate.nextBatch', { time: countdown(info.nextBatchAt - now) })}
                </p>
            )}
            {view.streamError && !final && (
                <p className="flex items-center gap-2 text-xs text-amber-200"><Spinner className="h-3 w-3" />{t('multiexec.job.reconnecting')}</p>
            )}
            {view.missing && <p role="alert" className="text-xs text-rose-200">{t('multiexec.errors.notFound')}</p>}

            {!view.loaded && servers.length === 0 ? (
                <div className="flex flex-1 items-center justify-center text-zinc-400"><Spinner /><span className="sr-only">{t('multiexec.loading')}</span></div>
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                        <SegmentedControl
                            aria-label={t('multiexec.results.show')}
                            value={mode}
                            onChange={setMode}
                            className="shrink-0 [&_button]:whitespace-nowrap"
                            options={[
                                { value: 'grouped', label: t('multiexec.results.grouped') },
                                { value: 'servers', label: t('multiexec.results.byServer') }
                            ]}
                        />
                        <div role="group" aria-label={t('multiexec.filter.label')} className="flex flex-wrap gap-1">
                            {filters.map((item) => (
                                <button
                                    key={item.value}
                                    type="button"
                                    aria-pressed={filter === item.value}
                                    onClick={() => setFilter(filter === item.value ? 'all' : item.value)}
                                    className={cn(
                                        'rounded-md border px-1.5 py-0.5 text-[11px] transition-colors focus-ring',
                                        filter === item.value ? 'ring-1 ring-brand-500/60' : 'opacity-80 hover:opacity-100',
                                        item.style ?? 'border-white/10 text-zinc-300'
                                    )}
                                >
                                    {item.label} · {item.count}
                                </button>
                            ))}
                        </div>
                        <div className="ml-auto">
                            {mode === 'grouped' ? (
                                <Checkbox
                                    checked={groupMode === 'normalized'}
                                    onChange={(checked) => setGroupMode(checked ? 'normalized' : 'exact')}
                                    label={<span className="text-xs text-zinc-300">{t('multiexec.groups.normalize')}</span>}
                                    className="items-center"
                                />
                            ) : (
                                <button
                                    type="button"
                                    onClick={() => setExpanded(allExpanded ? new Set() : new Set(visible.map((server) => server.serverId)))}
                                    className="rounded text-xs text-zinc-400 underline-offset-2 hover:text-zinc-200 hover:underline focus-ring"
                                >
                                    {allExpanded ? t('multiexec.results.collapseAll') : t('multiexec.results.expandAll')}
                                </button>
                            )}
                        </div>
                    </div>

                    {mode === 'grouped'
                        ? <OutputGroups servers={visible} mode={groupMode} timeoutSec={info.timeoutSec} />
                        : <ServerList servers={visible} timeoutSec={info.timeoutSec} now={now} expanded={expanded} onToggle={toggle} batchLabel={batchLabel} />}
                </>
            )}
        </section>
    );
}
