import type { ReactNode } from 'react';
import { AlertTriangle, Info, RotateCw, ShieldAlert } from 'lucide-react';
import type { PatchManager, PatchScanError } from '@shared/patch';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';
import { cn } from '@/lib/cn';
import { describeConnectionError } from '@/lib/connectionErrors';
import { describeError } from '@/lib/remoteErrors';
import { formatRelativeTime } from '@/lib/relativeTime';
import { STALE_LISTS_MS } from './model';
import { localizePatchText } from './output';

// Small pieces the patch center's views share.

export function managerName(t: TranslateFn, manager: PatchManager | null): string {
    return manager ? t(`patch.managers.${manager}`) : t('patch.values.unknown');
}

export function Dash({ label }: { label: string }) {
    return <span className="text-zinc-500" title={label}><span aria-hidden="true">—</span><span className="sr-only">{label}</span></span>;
}

// A count of security updates: rose with a shield when there are any; a
// dash when the manager cannot tell, or when no manager is known yet (not
// scanned, or the scan failed): that is "unknown", not "cannot tell".
export function SecurityCount({ value, manager, estimated = false }: { value: number | null; manager: PatchManager | null; estimated?: boolean }) {
    const t = useT();
    if (value === null) return <Dash label={t(manager ? 'patch.values.noSecurityInfo' : 'patch.values.unknown')} />;
    if (value === 0) return <span className={cn('tabular-nums text-zinc-400', estimated && 'italic')}>0</span>;
    return (
        <span className={cn('inline-flex items-center gap-1 font-medium tabular-nums text-rose-300', estimated && 'italic')}>
            <ShieldAlert className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {value}
            <span className="sr-only"> {t('patch.updates.securityBadge')}</span>
        </span>
    );
}

export function RebootFlag({ value }: { value: boolean | null }) {
    const t = useT();
    if (value === null) return <Dash label={t('patch.values.unknown')} />;
    if (!value) return <span className="text-zinc-400">{t('patch.values.rebootNo')}</span>;
    return (
        <span className="inline-flex items-center gap-1 font-medium text-amber-300">
            <RotateCw className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            {t('patch.values.rebootRequired')}
        </span>
    );
}

// "3 days ago", or a dash; amber when the package lists are stale.
export function Age({ at, now, stale = false }: { at: number | null; now: number; stale?: boolean }) {
    const t = useT();
    const language = useLanguage();
    if (at === null) return <Dash label={t('patch.values.unknown')} />;
    const old = stale && now - at > STALE_LISTS_MS;
    return (
        <span className={cn(old ? 'inline-flex items-center gap-1 text-amber-300' : 'text-zinc-300')} title={old ? t('patch.values.stale') : new Date(at).toLocaleString(language)}>
            {old && <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />}
            {formatRelativeTime(at, now, language)}
            {old && <span className="sr-only"> ({t('patch.values.stale')})</span>}
        </span>
    );
}

// A note under a server's summary (privilege, Windows, jump host...).
export function Note({ tone, children }: { tone: 'info' | 'warn' | 'bad'; children: ReactNode }) {
    const Icon = tone === 'info' ? Info : AlertTriangle;
    return (
        <div
            className={cn(
                'flex items-start gap-2 rounded-lg border px-3 py-2 text-xs',
                tone === 'info' && 'border-sky-500/25 bg-sky-500/[0.06] text-sky-100',
                tone === 'warn' && 'border-amber-500/30 bg-amber-500/[0.07] text-amber-100',
                tone === 'bad' && 'border-rose-500/30 bg-rose-500/[0.07] text-rose-100'
            )}
        >
            <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1 space-y-1">{children}</div>
        </div>
    );
}

// A scan's failure in the user's language (worded like a terminal's for
// connection failures).
export function scanErrorText(t: TranslateFn, error: PatchScanError): string {
    if (error.code === 'PATCH_SCAN_FAILED') return t('patch.errors.PATCH_SCAN_FAILED');
    return describeConnectionError({ code: error.code, message: error.message }, t);
}

const PATCH_CODES = ['PATCH_PRIVILEGE', 'PATCH_REFRESH_FAILED', 'PATCH_BUSY', 'PATCH_CONFIRM_MISMATCH', 'PATCH_NOTHING_TO_RUN', 'PATCH_UNSUPPORTED', 'PATCH_SCAN_FAILED', 'MULTIEXEC_BUSY'];

// A failed request: its translated headline and the detail the backend gave
// (a command's output, the cause of a connection failure).
export function describePatchError(error: unknown, t: TranslateFn): { title: string; detail: string | null } {
    if (error instanceof ApiError && error.code && PATCH_CODES.includes(error.code)) {
        const output = typeof error.details?.output === 'string' ? error.details.output.trim() : '';
        const expected = typeof error.details?.expected === 'number' ? error.details.expected : 0;
        return { title: t(`patch.errors.${error.code}`, { expected }), detail: output ? localizePatchText(output.split('\n').slice(-12).join('\n'), t) : null };
    }
    const { title, detail } = describeError(error, t);
    return { title, detail };
}

export function ErrorBox({ error, heading, className }: { error: unknown; heading?: string; className?: string }) {
    const t = useT();
    const { title, detail } = describePatchError(error, t);
    return (
        <div role="alert" className={cn('flex items-start gap-2.5 rounded-xl border border-rose-500/25 bg-rose-500/[0.07] px-3 py-2.5 text-xs', className)}>
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-rose-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-rose-100">{heading ?? title}</p>
                {heading && <p className="mt-0.5 text-rose-200/90">{title}</p>}
                {detail && <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-rose-200/80 scrollbar-thin">{detail}</pre>}
            </div>
        </div>
    );
}
