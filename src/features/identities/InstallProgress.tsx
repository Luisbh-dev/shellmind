import { AlertTriangle, Check, CircleDashed, Ban, X } from 'lucide-react';
import type { InstallResult, RemoveResult } from '@shared/identities';
import { Spinner } from '@/components/ui';
import { useT, type TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeConnectionError, hasConnectionErrorText } from '@/lib/connectionErrors';
import { describeCode } from '@/lib/remoteErrors';
import { rowOutcome, summarize, type InstallRow, type InstallRun, type RowOutcome } from './progress';

// Why a server failed or did not sign in with the key, in the user's
// language: connection failures in the terminal's words, remote command
// failures with the server's own output; the backend's English text otherwise.
function failureText(t: TranslateFn, result: InstallResult): string | null {
    const code = result.errorCode ?? null;
    if (!result.error || code === 'CANCELLED') return null;
    if (result.verified === false && code === 'AUTH_FAILED') return t('identities.install.notAccepted');
    const error = { code: code ?? 'SSH_FAILED', message: result.error };
    if (hasConnectionErrorText(error)) return describeConnectionError(error, t);
    const { title, detail } = describeCode(code, result.error, t);
    return detail ? `${title} ${detail}` : title;
}

const OUTCOME_STYLE: Record<RowOutcome, { icon: React.ReactNode; tone: string }> = {
    installed: { icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, tone: 'text-emerald-300' },
    present: { icon: <Check className="h-3.5 w-3.5" aria-hidden="true" />, tone: 'text-emerald-300' },
    unverified: { icon: <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />, tone: 'text-amber-300' },
    failed: { icon: <X className="h-3.5 w-3.5" aria-hidden="true" />, tone: 'text-rose-300' },
    cancelled: { icon: <Ban className="h-3.5 w-3.5" aria-hidden="true" />, tone: 'text-zinc-400' }
};

function Row({ row }: { row: InstallRow }) {
    const t = useT();
    const outcome = row.result ? rowOutcome(row.result) : null;
    const style = outcome ? OUTCOME_STYLE[outcome] : null;
    const status = outcome
        ? t(`identities.install.outcome.${outcome}`)
        : row.phase === 'waiting' ? t('identities.install.phase.waiting') : t(`identities.install.phase.${row.phase}`);
    const detail = row.result ? failureText(t, row.result) : null;
    const warnings = row.result?.warnings ?? [];

    return (
        <li className="flex items-start gap-2.5 px-3 py-2">
            <span className={cn('mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center', style?.tone ?? 'text-zinc-500')}>
                {style ? style.icon : row.phase === 'waiting' ? <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" /> : <Spinner className="h-3.5 w-3.5" />}
            </span>
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="truncate text-sm text-zinc-100">{row.name}</span>
                    <span className={cn('text-xs', style?.tone ?? 'text-zinc-400')}>{status}</span>
                </div>
                {row.result?.file && outcome !== 'failed' && <p className="truncate font-mono text-[11px] text-zinc-500">{row.result.file}</p>}
                {detail && <p className="mt-0.5 break-words text-xs text-zinc-400">{detail}</p>}
                {warnings.map((warning) => (
                    <p key={warning} className="mt-0.5 flex items-start gap-1 text-xs text-amber-200">
                        <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                        {t(`identities.install.warnings.${warning === 'home-writable' ? 'homeWritable' : 'other'}`)}
                    </p>
                ))}
                {row.removal && <Removal removal={row.removal} />}
            </div>
        </li>
    );
}

// Rotate only: what happened to the previous key on the server.
function Removal({ removal }: { removal: RemoveResult }) {
    const t = useT();
    if (removal.status !== 'failed') {
        return <p className="mt-0.5 text-xs text-zinc-400">{t(removal.status === 'removed' ? 'identities.rotate.removal.removed' : 'identities.rotate.removal.absent')}</p>;
    }
    const detail = removal.errorCode === 'CANCELLED' || !removal.error ? null : failureText(t, { serverId: removal.serverId, name: '', status: 'failed', error: removal.error, errorCode: removal.errorCode });
    return (
        <p className="mt-0.5 flex items-start gap-1 text-xs text-amber-200">
            <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
            <span>{t('identities.rotate.removal.failed')}{detail ? ` ${detail}` : ''}</span>
        </p>
    );
}

// Per-server progress of an install or rotation, with a running summary.
export function InstallProgress({ run, label }: { run: InstallRun; label: string }) {
    const t = useT();
    const counts = summarize(run);
    const parts = (['installed', 'present', 'unverified', 'failed', 'cancelled'] as const)
        .filter((outcome) => counts[outcome] > 0)
        .map((outcome) => t(`identities.install.summary.${outcome}`, { count: counts[outcome] }));

    return (
        <div className="space-y-2">
            <p role="status" aria-live="polite" className="text-xs text-zinc-400">
                {run.done
                    ? parts.join(' · ') || t('identities.install.summary.nothing')
                    : t('identities.install.summary.running', { done: run.rows.length - counts.pending, total: run.rows.length })}
            </p>
            <ul aria-label={label} className="max-h-72 divide-y divide-white/[0.05] overflow-y-auto rounded-lg border border-white/[0.06] bg-black/10 scrollbar-thin">
                {run.rows.map((row) => <Row key={row.serverId} row={row} />)}
            </ul>
        </div>
    );
}
