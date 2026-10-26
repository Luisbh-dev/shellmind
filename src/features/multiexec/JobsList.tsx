import { ChevronsDown, History, Trash2 } from 'lucide-react';
import { isJobFinal, type MultiExecJobInfo } from '@shared/multiexec';
import { Button, EmptyState, IconButton, Spinner } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/relativeTime';
import { formatDuration } from './export';
import { JobStatusBadge, STATUS_FILL, useNow } from './status';

interface JobsListProps {
    jobs: MultiExecJobInfo[] | null;
    error: string | null;
    onOpen: (id: string) => void;
    onDelete: (job: MultiExecJobInfo) => void;
    // The history goes on beyond what is shown (loaded a page at a time).
    more: { available: boolean; loading: boolean; error: string | null; load: () => void };
}

function JobRow({ job, now, onOpen, onDelete }: { job: MultiExecJobInfo; now: number; onOpen: () => void; onDelete: () => void }) {
    const t = useT();
    const language = useLanguage();
    const final = isJobFinal(job.status);
    const { counts } = job;
    const failed = counts.failed + counts.timeout;
    const finished = job.total - counts.queued - counts.running;
    const firstLine = job.command.split('\n')[0];
    const duration = (job.finishedAt ?? now) - job.createdAt;

    return (
        <li className="group flex items-center gap-2 rounded-xl border border-white/5 bg-white/[0.02] pr-2 transition-colors hover:bg-white/[0.04]">
            <button type="button" onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-ring">
                <span className="w-36 shrink-0">
                    <JobStatusBadge status={job.status} failed={failed > 0} />
                </span>
                <span className="min-w-0 flex-1 space-y-1">
                    <span className="block truncate font-mono text-xs text-zinc-100" title={job.command}>
                        {firstLine}{job.command.includes('\n') ? ' …' : ''}
                    </span>
                    <span className="flex flex-wrap items-center gap-x-2 text-[11px] text-zinc-500">
                        {job.snippet && <span className="truncate text-zinc-400">{job.snippet.name}</span>}
                        <span>{t(job.total === 1 ? 'multiexec.jobs.servers.one' : 'multiexec.jobs.servers.other', { count: job.total })}</span>
                        <span>{formatRelativeTime(job.createdAt, now, language)}</span>
                        <span>{formatDuration(Math.max(0, duration))}</span>
                    </span>
                    <span className="flex h-1 overflow-hidden rounded-full bg-white/5" aria-hidden="true">
                        {(['ok', 'failed', 'timeout', 'cancelled', 'skipped', 'running'] as const).map((status) => counts[status] > 0 && (
                            <span key={status} className={cn('h-full', STATUS_FILL[status])} style={{ width: `${(counts[status] / Math.max(1, job.total)) * 100}%` }} />
                        ))}
                    </span>
                </span>
                <span className="w-32 shrink-0 text-right text-[11px] text-zinc-400">
                    {final
                        ? t('multiexec.jobs.outcome', { ok: counts.ok, failed })
                        : t('multiexec.jobs.progress', { done: finished, total: job.total })}
                </span>
            </button>
            <IconButton
                size="sm"
                variant="ghost"
                label={t('multiexec.jobs.delete')}
                onClick={onDelete}
                disabledReason={final ? undefined : t('multiexec.jobs.deleteRunning')}
                className="opacity-60 group-hover:opacity-100 focus-visible:opacity-100"
            >
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
            </IconButton>
        </li>
    );
}

// The job history: running jobs first, then the finished ones (newest first).
export function JobsList({ jobs, error, onOpen, onDelete, more }: JobsListProps) {
    const t = useT();
    const running = jobs?.filter((job) => !isJobFinal(job.status)) ?? [];
    const finished = jobs?.filter((job) => isJobFinal(job.status)) ?? [];
    const now = useNow(running.length > 0);

    if (jobs === null) {
        return error
            ? <p role="alert" className="text-sm text-rose-200">{t('multiexec.jobs.loadFailed', { error })}</p>
            : <div className="flex flex-1 items-center justify-center text-zinc-400"><Spinner /><span className="sr-only">{t('multiexec.loading')}</span></div>;
    }
    if (jobs.length === 0) {
        return <EmptyState icon={<History className="h-5 w-5" />} title={t('multiexec.jobs.empty')} description={t('multiexec.jobs.emptyHint')} />;
    }

    const section = (title: string, list: MultiExecJobInfo[]) => list.length > 0 && (
        <section className="space-y-1.5" aria-label={title}>
            {/* The first is focused when the list shows (MultiExecModal). */}
            <h3 tabIndex={-1} data-view-focus className="w-fit rounded text-xs font-semibold uppercase tracking-wider text-zinc-400 focus-ring">{title} · {list.length}</h3>
            <ul className="space-y-1.5">
                {list.map((job) => <JobRow key={job.id} job={job} now={now} onOpen={() => onOpen(job.id)} onDelete={() => onDelete(job)} />)}
            </ul>
        </section>
    );

    return (
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 scrollbar-thin">
            {error && <p role="alert" className="text-xs text-rose-200">{t('multiexec.jobs.loadFailed', { error })}</p>}
            {section(t('multiexec.jobs.running'), running)}
            {section(t('multiexec.jobs.finished'), finished)}
            {(more.available || more.error) && (
                <div className="flex flex-col items-center gap-1.5 pb-1">
                    {more.error && <p role="alert" className="text-xs text-rose-200">{t('multiexec.jobs.loadMoreFailed', { error: more.error })}</p>}
                    <Button size="sm" variant="subtle" onClick={more.load} loading={more.loading}>
                        <ChevronsDown className="h-3.5 w-3.5" aria-hidden="true" />{t('multiexec.jobs.loadMore')}
                    </Button>
                </div>
            )}
        </div>
    );
}
