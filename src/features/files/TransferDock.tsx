import { useState } from 'react';
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, ChevronUp, FolderDown, RotateCcw, X } from 'lucide-react';
import { cn } from '@/lib/cn';
import { useLanguage, useT } from '@/i18n';
import { formatBytes } from './listing';
import type { TransferError, TransferJob } from './useTransfers';

export type TransferDockProps = {
    jobs: TransferJob[];
    onCancel: (id: string) => void;
    onRetry: (id: string, options?: { inPlace?: boolean }) => void;
    // A large download of a batch waits for the user to pick its file.
    onChooseTarget: (id: string) => void;
    onDismiss: (id: string) => void;
    onClearFinished: () => void;
};

const percentOf = (job: TransferJob) => (job.size ? Math.min(100, Math.round((job.loaded / job.size) * 100)) : job.status === 'done' ? 100 : 0);

// "Permission denied: /srv/x: permission denied" — the translated kind of
// failure, then the details (in the UI language when the client wrote them).
// NOT_ATOMIC is explained by the dock itself, in the UI language.
function errorText(t: (key: string) => string, error: TransferError): string {
    const label = t(`files.errors.${error.code}`);
    return !error.message || error.message === label || error.code === 'NOT_ATOMIC' ? label : `${label}: ${error.message}`;
}

export function TransferDock({ jobs, onCancel, onRetry, onChooseTarget, onDismiss, onClearFinished }: TransferDockProps) {
    const t = useT();
    const language = useLanguage();
    const [collapsed, setCollapsed] = useState(false);
    if (!jobs.length) return null;

    const pending = (job: TransferJob) => job.status === 'running' || job.status === 'queued' || job.status === 'waiting';
    const active = jobs.filter(pending).length;
    const finished = jobs.length - active;

    return (
        <section
            aria-label={t('files.transfers.title')}
            className="absolute bottom-12 right-3 z-30 w-80 max-w-[calc(100%-1.5rem)] overflow-hidden rounded-xl border border-white/10 bg-ink-700/95 shadow-panel backdrop-blur animate-slide-up"
        >
            <header className="flex items-center gap-2 border-b border-white/5 px-3 py-2 text-xs">
                <span className="font-semibold text-zinc-200">{t('files.transfers.title')}</span>
                {active > 0 && <span className="text-zinc-400">· {t('files.transfers.active', { count: active })}</span>}
                <span className="flex-1" />
                {finished > 0 && (
                    <button type="button" onClick={onClearFinished} className="focus-ring rounded px-1.5 py-0.5 text-zinc-400 hover:bg-white/5 hover:text-zinc-100">
                        {t('files.transfers.clearFinished')}
                    </button>
                )}
                <button
                    type="button"
                    onClick={() => setCollapsed((value) => !value)}
                    aria-expanded={!collapsed}
                    aria-label={collapsed ? t('files.transfers.expand') : t('files.transfers.collapse')}
                    className="focus-ring rounded p-1 text-zinc-400 hover:bg-white/5 hover:text-zinc-100"
                >
                    {collapsed ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                </button>
            </header>
            {!collapsed && (
                <ul className="max-h-56 space-y-2 overflow-y-auto p-2.5 scrollbar-thin">
                    {jobs.map((job) => {
                        const percent = percentOf(job);
                        const Icon = job.kind === 'upload' ? ArrowUpFromLine : ArrowDownToLine;
                        const needsTarget = job.status === 'queued' && job.target?.kind === 'ask';
                        const status = needsTarget ? t('files.transfers.needsTarget')
                            : job.status === 'queued' ? t('files.transfers.queued')
                            : job.status === 'waiting' ? t('files.transfers.waiting')
                                : job.status === 'done' ? t('files.transfers.done')
                                    : job.status === 'error' ? t('files.transfers.failed')
                                        : job.status === 'cancelled' ? t('files.transfers.cancelled')
                                            : `${percent}%`;
                        return (
                            <li key={job.id} className="space-y-1">
                                <div className="flex items-center gap-2 text-xs">
                                    <Icon className={cn('h-3.5 w-3.5 shrink-0', job.status === 'error' ? 'text-rose-400' : 'text-brand-400')} aria-label={job.kind === 'upload' ? t('files.transfers.upload') : t('files.transfers.download')} />
                                    <span className="min-w-0 flex-1 truncate text-zinc-200" title={job.path}>{job.name}</span>
                                    <span className={cn('shrink-0 font-mono text-[10px]', job.status === 'error' ? 'text-rose-300' : job.status === 'done' ? 'text-emerald-300' : 'text-zinc-400')}>
                                        {status}
                                    </span>
                                    {pending(job) && (
                                        <button type="button" onClick={() => onCancel(job.id)} aria-label={t('files.transfers.cancel', { name: job.name })} className="focus-ring rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100">
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                    {(job.status === 'error' || job.status === 'cancelled') && (
                                        <button type="button" onClick={() => onRetry(job.id)} aria-label={t('files.transfers.retry', { name: job.name })} className="focus-ring rounded p-0.5 text-zinc-400 hover:bg-white/10 hover:text-zinc-100">
                                            <RotateCcw className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                    {!pending(job) && (
                                        <button type="button" onClick={() => onDismiss(job.id)} aria-label={t('files.transfers.dismiss', { name: job.name })} className="focus-ring rounded p-0.5 text-zinc-500 hover:bg-white/10 hover:text-zinc-100">
                                            <X className="h-3.5 w-3.5" />
                                        </button>
                                    )}
                                </div>
                                {pending(job) && (
                                    <div
                                        role="progressbar"
                                        aria-label={t('files.transfers.progress', { name: job.name, percent })}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-valuenow={percent}
                                        className="h-1 overflow-hidden rounded-full bg-white/10"
                                    >
                                        <div className="h-full rounded-full bg-brand-500 transition-[width] duration-200" style={{ width: `${percent}%` }} />
                                    </div>
                                )}
                                {needsTarget && (
                                    <button
                                        type="button"
                                        onClick={() => onChooseTarget(job.id)}
                                        className="focus-ring inline-flex items-center gap-1.5 rounded-md border border-brand-500/30 bg-brand-500/10 px-2 py-1 text-[11px] font-medium text-brand-200 hover:bg-brand-500/20"
                                    >
                                        <FolderDown className="h-3.5 w-3.5" aria-hidden />{t('files.transfers.chooseTarget', { name: job.name })}
                                    </button>
                                )}
                                {job.status === 'running' && job.size !== null && (
                                    <div className="text-right font-mono text-[10px] text-zinc-500">
                                        {formatBytes(job.loaded, language)} / {formatBytes(job.size, language)}
                                    </div>
                                )}
                                {job.status === 'error' && job.error && (
                                    <div className="space-y-1.5">
                                        <p className="break-words text-[11px] text-rose-300/90">{errorText(t, job.error)}</p>
                                        {job.error.code === 'NOT_ATOMIC' && (
                                            <>
                                                <p className="text-[11px] text-zinc-400">{t('files.transfers.inPlaceHint')}</p>
                                                <button
                                                    type="button"
                                                    onClick={() => onRetry(job.id, { inPlace: true })}
                                                    className="focus-ring rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1 text-[11px] font-medium text-amber-200 hover:bg-amber-500/20"
                                                >
                                                    {t('files.transfers.inPlace', { name: job.name })}
                                                </button>
                                            </>
                                        )}
                                    </div>
                                )}
                            </li>
                        );
                    })}
                </ul>
            )}
        </section>
    );
}
