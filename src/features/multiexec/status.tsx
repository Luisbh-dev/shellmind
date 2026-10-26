import { useEffect, useState } from 'react';
import { Ban, CheckCircle2, Clock, MinusCircle, PauseCircle, Timer, XCircle } from 'lucide-react';
import type { MultiExecJobStatus, MultiExecStatus } from '@shared/multiexec';
import { Spinner } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';

export const STATUS_STYLE: Record<MultiExecStatus, string> = {
    queued: 'border-white/10 text-zinc-400',
    running: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    failed: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    timeout: 'border-orange-500/30 bg-orange-500/10 text-orange-200',
    cancelled: 'border-white/10 bg-white/[0.04] text-zinc-400',
    skipped: 'border-white/10 border-dashed text-zinc-500'
};

// Solid colours of the progress bar.
export const STATUS_FILL: Record<MultiExecStatus, string> = {
    queued: 'bg-white/[0.06]',
    running: 'bg-amber-400/70',
    ok: 'bg-emerald-500',
    failed: 'bg-rose-500',
    timeout: 'bg-orange-500',
    cancelled: 'bg-zinc-500/60',
    skipped: 'bg-zinc-500/30'
};

export const STATUS_ORDER: readonly MultiExecStatus[] = ['ok', 'failed', 'timeout', 'cancelled', 'skipped', 'running', 'queued'];

export function StatusIcon({ status, className = 'h-3.5 w-3.5' }: { status: MultiExecStatus; className?: string }) {
    switch (status) {
        case 'running': return <Spinner className={className} />;
        case 'ok': return <CheckCircle2 className={className} aria-hidden="true" />;
        case 'failed': return <XCircle className={className} aria-hidden="true" />;
        case 'timeout': return <Timer className={className} aria-hidden="true" />;
        case 'cancelled': return <MinusCircle className={className} aria-hidden="true" />;
        case 'skipped': return <Ban className={className} aria-hidden="true" />;
        default: return <Clock className={className} aria-hidden="true" />;
    }
}

export function StatusBadge({ status }: { status: MultiExecStatus }) {
    const t = useT();
    return (
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', STATUS_STYLE[status])}>
            <StatusIcon status={status} />
            {t(`multiexec.status.${status}`)}
        </span>
    );
}

const JOB_STYLE: Record<MultiExecJobStatus, string> = {
    running: 'border-amber-500/30 bg-amber-500/10 text-amber-200',
    paused: 'border-sky-500/30 bg-sky-500/10 text-sky-200',
    done: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200',
    stopped: 'border-rose-500/30 bg-rose-500/10 text-rose-200',
    cancelled: 'border-white/10 bg-white/[0.04] text-zinc-300',
    interrupted: 'border-orange-500/30 bg-orange-500/10 text-orange-200'
};

export function JobStatusIcon({ status, failed, className = 'h-3.5 w-3.5' }: { status: MultiExecJobStatus; failed?: boolean; className?: string }) {
    switch (status) {
        case 'running': return <Spinner className={className} />;
        case 'paused': return <PauseCircle className={className} aria-hidden="true" />;
        case 'done': return failed ? <XCircle className={className} aria-hidden="true" /> : <CheckCircle2 className={className} aria-hidden="true" />;
        case 'stopped': return <Ban className={className} aria-hidden="true" />;
        case 'cancelled': return <MinusCircle className={className} aria-hidden="true" />;
        default: return <Timer className={className} aria-hidden="true" />;
    }
}

// The job's state; a finished job with failures reads "Done with failures".
export function JobStatusBadge({ status, failed = false }: { status: MultiExecJobStatus; failed?: boolean }) {
    const t = useT();
    const style = status === 'done' && failed ? 'border-rose-500/30 bg-rose-500/10 text-rose-200' : JOB_STYLE[status];
    return (
        <span className={cn('inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[11px] font-medium', style)}>
            <JobStatusIcon status={status} failed={failed} />
            {status === 'done' && failed ? t('multiexec.jobStatus.doneWithFailures') : t(`multiexec.jobStatus.${status}`)}
        </span>
    );
}

// Re-renders every second while `active` (elapsed times, countdowns).
export function useNow(active: boolean): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [active]);
    return now;
}
