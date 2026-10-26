import { useState } from 'react';
import { AlertTriangle, KeyRound, PlugZap, RefreshCw } from 'lucide-react';
import type { HostKeyMismatchPayload } from '@shared/protocol';
import type { TrustHostKeyResult } from '@shared/terminal';
import { Button, Skeleton, useConfirm, useToast } from '@/components/ui';
import { useT } from '@/i18n';

// Placeholder rows while the session opens.
export function ListSkeleton() {
    const t = useT();
    return (
        <div className="flex-1 overflow-hidden" role="status" aria-live="polite">
            <span className="sr-only">{t('files.connecting')}</span>
            {Array.from({ length: 9 }, (_, index) => (
                <div key={index} className="flex h-9 items-center gap-3 border-b border-white/[0.03] px-3" aria-hidden>
                    <Skeleton className="h-3.5 w-3.5 rounded" />
                    <Skeleton className="h-4 w-4 rounded" />
                    <Skeleton className={`h-3 rounded ${['w-[30%]', 'w-[67%]', 'w-[44%]', 'w-[61%]', 'w-[38%]'][index % 5]}`} />
                    <Skeleton className="ml-auto h-3 w-14 rounded" />
                </div>
            ))}
        </div>
    );
}

type PanelProps = {
    title: string;
    message?: string;
    icon?: React.ReactNode;
    children?: React.ReactNode;
};

export function MessagePanel({ title, message, icon, children }: PanelProps) {
    return (
        <div className="flex flex-1 items-center justify-center overflow-auto p-6">
            <div role="alert" className="w-full max-w-lg rounded-2xl border border-white/10 bg-ink-800/80 p-6 shadow-panel">
                <div className="flex items-start gap-3">
                    <span className="mt-0.5 shrink-0 text-rose-400">{icon ?? <PlugZap className="h-5 w-5" aria-hidden />}</span>
                    <div className="min-w-0 flex-1">
                        <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
                        {message && <p className="mt-1 break-words text-sm text-zinc-400">{message}</p>}
                        {children}
                    </div>
                </div>
            </div>
        </div>
    );
}

type HostKeyPanelProps = {
    mismatch: HostKeyMismatchPayload;
    onTrust: (mismatch: HostKeyMismatchPayload) => Promise<TrustHostKeyResult>;
    onReconnect: () => void;
};

// The pinned host key no longer matches: show both fingerprints and let the
// user trust the new key after confirming. Exactly the presented key is
// pinned (never whatever answers the reconnect), so a third key is refused.
export function HostKeyPanel({ mismatch, onTrust, onReconnect }: HostKeyPanelProps) {
    const t = useT();
    const confirm = useConfirm();
    const toast = useToast();
    const [busy, setBusy] = useState(false);
    const host = `${mismatch.host}:${mismatch.port}`;

    const trust = async () => {
        const ok = await confirm({
            title: t('files.hostKey.confirmTitle'),
            // Fingerprints are one long word: let them wrap anywhere.
            message: <span className="[overflow-wrap:anywhere]">{t('files.hostKey.confirmMessage', { host, fingerprint: mismatch.actual })}</span>,
            confirmLabel: t('files.hostKey.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        setBusy(true);
        const result = await onTrust(mismatch);
        setBusy(false);
        if (result.ok) {
            onReconnect();
        } else if (result.code === 'HOST_KEY_CHANGED') {
            // Show the keys as they are now.
            toast.error(t('files.hostKey.failed'), t('files.hostKey.changedAgain'));
            onReconnect();
        } else {
            toast.error(t('files.hostKey.failed'), result.error);
        }
    };

    return (
        <MessagePanel title={t('files.hostKey.title', { host })} message={t('files.hostKey.explanation')} icon={<KeyRound className="h-5 w-5 text-amber-400" aria-hidden />}>
            <dl className="mt-4 space-y-2 rounded-lg border border-white/5 bg-ink-900/60 p-3 text-xs">
                <div>
                    <dt className="text-zinc-500">{t('files.hostKey.keyType')}</dt>
                    <dd className="font-mono text-zinc-200">{mismatch.keyType}</dd>
                </div>
                <div>
                    <dt className="text-zinc-500">{t('files.hostKey.expected')}</dt>
                    <dd className="break-all font-mono text-zinc-200">{mismatch.expected}</dd>
                </div>
                <div>
                    <dt className="text-zinc-500">{t('files.hostKey.actual')}</dt>
                    <dd className="break-all font-mono text-amber-200">{mismatch.actual}</dd>
                </div>
            </dl>
            <div className="mt-4 flex flex-wrap gap-2">
                <Button variant="danger" size="sm" loading={busy} onClick={() => void trust()}>
                    <AlertTriangle className="h-3.5 w-3.5" aria-hidden />{t('files.hostKey.trust')}
                </Button>
                <Button variant="ghost" size="sm" onClick={onReconnect} disabled={busy}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden />{t('files.connection.retry')}
                </Button>
            </div>
        </MessagePanel>
    );
}
