import { useId, useState } from 'react';
import { Copy, ShieldAlert, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import { formatRdpAddress, type PinnedRdpCertificate, type RdpCertificate } from '@shared/rdp';
import { Button, IconButton, Spinner, useConfirm, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { ApiError } from '@/lib/api';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { formatDateTime } from '@/lib/format';
import { rdpApi } from './api';
import { failureMessage } from './errors';

const formatDay = (epochMs: number | null, language: string) =>
    epochMs ? new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(epochMs) : '—';

// A failed request of the RDP API in the user's language (a lost backend
// says so in its own translated words).
export function apiErrorText(t: ReturnType<typeof useT>, error: unknown): string {
    if (error instanceof ApiError && !error.isNetworkError) return failureMessage(t, error.code ?? '');
    return error instanceof Error ? error.message : String(error);
}

// The fingerprint, broken into groups a person can compare.
function Fingerprint({ value, className }: { value: string; className?: string }) {
    return <code className={cn('break-all font-mono text-[11px] leading-relaxed text-zinc-200', className)}>{value}</code>;
}

function CopyFingerprint({ value }: { value: string }) {
    const t = useT();
    const toast = useToast();
    return (
        <IconButton
            size="sm"
            variant="ghost"
            label={t('rdp.certificate.copy')}
            onClick={() => copyText(value).then(() => toast.success(t('rdp.certificate.copied')), () => toast.error(t('rdp.certificate.copyFailed')))}
        >
            <Copy className="h-3.5 w-3.5" aria-hidden="true" />
        </IconButton>
    );
}

// The details of one certificate as a definition list.
export function CertificateDetails({ certificate, compact = false }: { certificate: RdpCertificate; compact?: boolean }) {
    const t = useT();
    const language = useLanguage();
    return (
        <dl className={cn('grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-1.5 text-xs', compact && 'gap-y-1')}>
            <dt className="text-zinc-500">{t('rdp.certificate.subject')}</dt>
            <dd className="break-words text-zinc-200">{certificate.subject || '—'}</dd>
            {!compact && (
                <>
                    <dt className="text-zinc-500">{t('rdp.certificate.issuer')}</dt>
                    <dd className="break-words text-zinc-300">{certificate.issuer || '—'}</dd>
                </>
            )}
            <dt className="text-zinc-500">{t('rdp.certificate.validity')}</dt>
            <dd className="text-zinc-300">
                {t('rdp.certificate.validRange', { from: formatDay(certificate.validFrom, language), to: formatDay(certificate.validTo, language) })}
            </dd>
            <dt className="pt-0.5 text-zinc-500">{t('rdp.certificate.fingerprint')}</dt>
            <dd className="flex min-w-0 items-start gap-1">
                <Fingerprint value={certificate.fingerprint} />
                <CopyFingerprint value={certificate.fingerprint} />
            </dd>
            <dt className="text-zinc-500">{t('rdp.certificate.thumbprint')}</dt>
            <dd><Fingerprint value={certificate.thumbprint} className="text-zinc-300" /></dd>
        </dl>
    );
}

// The certificate pinned for the server (or that none is yet), with "Forget".
export function CertificateCard({ pinned, host, port, onForgotten }: {
    pinned: PinnedRdpCertificate | null;
    host: string;
    port: number;
    onForgotten: () => void;
}) {
    const t = useT();
    const language = useLanguage();
    const confirm = useConfirm();
    const toast = useToast();
    const titleId = useId();
    const [forgetting, setForgetting] = useState(false);
    const address = formatRdpAddress(host, port);

    const forget = async () => {
        if (!pinned) return;
        const ok = await confirm({
            title: t('rdp.certificate.forgetTitle'),
            message: t('rdp.certificate.forgetMessage', { host: address }),
            confirmLabel: t('rdp.certificate.forget'),
            tone: 'danger'
        });
        if (!ok) return;
        setForgetting(true);
        try {
            await rdpApi.forgetCertificate(pinned.id);
            toast.success(t('rdp.certificate.forgotten', { host: address }));
            onForgotten();
        } catch (error) {
            toast.error(t('rdp.certificate.forgetFailed'), apiErrorText(t, error));
        } finally {
            setForgetting(false);
        }
    };

    return (
        <section aria-labelledby={titleId} className="space-y-3">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                    <span aria-hidden="true" className={cn('mt-0.5 rounded-lg p-1.5', pinned ? 'bg-emerald-500/10 text-emerald-300' : 'bg-white/[0.04] text-zinc-400')}>
                        {pinned ? <ShieldCheck className="h-4 w-4" /> : <ShieldQuestion className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0">
                        <h3 id={titleId} className="text-sm font-semibold text-zinc-100">{t('rdp.certificate.title')}</h3>
                        <p className="mt-0.5 text-xs text-zinc-400">
                            {pinned ? t('rdp.certificate.pinned', { date: formatDateTime(pinned.createdAt, language) }) : t('rdp.certificate.notPinned')}
                        </p>
                    </div>
                </div>
                {pinned && (
                    <Button
                        size="sm"
                        variant="ghost"
                        loading={forgetting}
                        aria-label={t('rdp.certificate.forgetLabel', { host: address })}
                        className="shrink-0 text-rose-300 hover:text-rose-200"
                        onClick={() => void forget()}
                    >
                        {!forgetting && <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('rdp.certificate.forget')}
                    </Button>
                )}
            </div>
            {pinned && <CertificateDetails certificate={pinned} compact />}
        </section>
    );
}

// The certificate section while the pin is being read, or when it cannot be
// (`error`: why, translated).
export function CertificatePending({ error }: { error: string | null }) {
    const t = useT();
    const titleId = useId();
    return (
        <section aria-labelledby={titleId} aria-busy={error === null || undefined} className="flex min-w-0 items-start gap-2.5">
            <span aria-hidden="true" className="mt-0.5 rounded-lg bg-white/[0.04] p-1.5 text-zinc-400">
                {error === null ? <Spinner className="h-4 w-4" /> : <ShieldQuestion className="h-4 w-4" />}
            </span>
            <div className="min-w-0">
                <h3 id={titleId} className="text-sm font-semibold text-zinc-100">{t('rdp.certificate.title')}</h3>
                <p role={error === null ? undefined : 'status'} className="mt-0.5 text-xs text-zinc-400">
                    {error === null ? t('rdp.certificate.loading') : t('rdp.certificate.loadFailed', { reason: error })}
                </p>
            </div>
        </section>
    );
}

// A changed certificate: both side by side and the way to trust the new one.
export function CertificateMismatch({ expected, actual, trusting, onTrust, onCancel }: {
    expected: PinnedRdpCertificate;
    actual: RdpCertificate;
    trusting: boolean;
    onTrust: () => void;
    onCancel: () => void;
}) {
    const t = useT();
    const titleId = useId();
    return (
        <section role="alert" aria-labelledby={titleId} className="space-y-4 rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-4">
            <div className="flex items-start gap-3">
                <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-300" aria-hidden="true" />
                <div className="min-w-0 space-y-1.5">
                    <h3 id={titleId} className="text-sm font-semibold text-amber-100">{t('rdp.mismatch.title')}</h3>
                    <p className="text-xs leading-relaxed text-zinc-300">{t('rdp.mismatch.message')}</p>
                    <p className="text-xs text-zinc-400">{t('rdp.mismatch.howTo')}</p>
                </div>
            </div>
            <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-white/[0.06] bg-ink-900/60 p-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{t('rdp.mismatch.pinned')}</p>
                    <CertificateDetails certificate={expected} />
                </div>
                <div className="rounded-lg border border-amber-500/25 bg-ink-900/60 p-3">
                    <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-300">{t('rdp.mismatch.presented')}</p>
                    <CertificateDetails certificate={actual} />
                </div>
            </div>
            <div className="flex flex-wrap justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={onCancel}>{t('rdp.mismatch.cancel')}</Button>
                <Button size="sm" variant="secondary" loading={trusting} onClick={onTrust} className="border-amber-500/40 text-amber-100 hover:border-amber-400/60">
                    {!trusting && <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />}
                    {t(trusting ? 'rdp.mismatch.trusting' : 'rdp.mismatch.trust')}
                </Button>
            </div>
        </section>
    );
}
