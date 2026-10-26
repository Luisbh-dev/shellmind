import { useEffect, useId, useState } from 'react';
import { Copy, KeyRound, ShieldCheck, ShieldQuestion, Trash2 } from 'lucide-react';
import { formatHostPort, type ServerHostKey } from '@shared/tunnels';
import { Button, IconButton, Spinner, useConfirm, useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import { copyText } from '@/lib/clipboard';
import { formatDateTime } from '@/lib/format';
import { knownHostsApi } from './api';

export const KNOWN_HOSTS_ACTION_ID = 'known-hosts';

// The host key pinned for one server (trust on first use), with "Forget" and
// a way to the list of every known host.
export function HostKeyCard({ server, isActive, refreshToken = 0 }: {
    server: WorkspaceServer;
    isActive: boolean;
    // Bumped by the caller when a connection may just have pinned the key.
    refreshToken?: number;
}) {
    const t = useT();
    const language = useLanguage();
    const toast = useToast();
    const confirm = useConfirm();
    const titleId = useId();
    const openAction = useAppStore((state) => state.openAction);
    // The known hosts dialog may forget this key: read it again when it closes.
    const dialogOpen = useAppStore((state) => state.activeActionId === KNOWN_HOSTS_ACTION_ID);
    const [hostKey, setHostKey] = useState<ServerHostKey | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [forgetting, setForgetting] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);

    useEffect(() => {
        if (!isActive || dialogOpen) return;
        const controller = new AbortController();
        knownHostsApi.forServer(server.id, { signal: controller.signal }).then(
            (data) => {
                setHostKey(data);
                setError(null);
            },
            (err: unknown) => {
                if (!controller.signal.aborted) setError(err instanceof Error ? err.message : String(err));
            }
        );
        return () => controller.abort();
    }, [server.id, isActive, dialogOpen, refreshToken, reloadToken]);

    const known = hostKey?.knownHost ?? null;
    const address = hostKey ? formatHostPort(hostKey.host, hostKey.port) : server.ip;

    const forget = async () => {
        if (!known) return;
        const ok = await confirm({
            title: t('knownHosts.confirmForget.title'),
            message: t('knownHosts.confirmForget.message', { host: address }),
            confirmLabel: t('knownHosts.confirmForget.confirm'),
            tone: 'danger'
        });
        if (!ok) return;
        setForgetting(true);
        try {
            await knownHostsApi.forget(known.id);
            toast.success(t('knownHosts.forgotten', { host: address }));
        } catch (err) {
            toast.error(t('knownHosts.forgetFailed'), err instanceof Error ? err.message : String(err));
        } finally {
            setForgetting(false);
            setReloadToken((token) => token + 1);
        }
    };

    const copyFingerprint = async () => {
        if (!known) return;
        try {
            await copyText(known.fingerprint);
            toast.success(t('knownHosts.copied'));
        } catch {
            toast.error(t('knownHosts.copyFailed'));
        }
    };

    return (
        <section aria-labelledby={titleId} className="rounded-xl border border-white/[0.06] bg-ink-850/60 p-4">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 flex-1 items-start gap-3">
                    <span
                        aria-hidden="true"
                        className={known ? 'rounded-lg bg-emerald-500/10 p-2 text-emerald-300' : 'rounded-lg bg-white/[0.04] p-2 text-zinc-400'}
                    >
                        {known ? <ShieldCheck className="h-4 w-4" /> : <ShieldQuestion className="h-4 w-4" />}
                    </span>
                    <div className="min-w-0">
                        <h3 id={titleId} className="text-sm font-semibold text-zinc-100">{t('knownHosts.card.title')}</h3>
                        <p className="mt-0.5 text-xs text-zinc-400">
                            {known ? t('knownHosts.card.description', { address }) : hostKey ? t('knownHosts.card.pending', { address }) : null}
                        </p>
                    </div>
                </div>
                <Button size="sm" variant="ghost" className="shrink-0 whitespace-nowrap" onClick={() => openAction(KNOWN_HOSTS_ACTION_ID)}>
                    <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('knownHosts.card.all')}
                </Button>
            </div>

            {!hostKey && !error && <Spinner className="mt-3 h-4 w-4 text-zinc-500" />}
            {error && <p role="alert" className="mt-3 text-xs text-rose-300">{error}</p>}

            {known && (
                <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
                    <dl className="grid min-w-0 grid-cols-[auto_1fr] items-center gap-x-4 gap-y-1.5 text-xs">
                        <dt className="text-zinc-500">{t('knownHosts.card.type')}</dt>
                        <dd className="font-mono text-zinc-200">{known.key_type}</dd>
                        <dt className="text-zinc-500">{t('knownHosts.card.fingerprint')}</dt>
                        <dd className="flex min-w-0 items-center gap-2">
                            <code className="break-all font-mono text-zinc-200">{known.fingerprint}</code>
                            <IconButton size="sm" label={t('knownHosts.copyFingerprint', { host: address })} onClick={() => void copyFingerprint()}>
                                <Copy className="h-3.5 w-3.5" />
                            </IconButton>
                        </dd>
                        <dt className="text-zinc-500">{t('knownHosts.card.firstSeen')}</dt>
                        <dd className="text-zinc-300">{formatDateTime(known.created_at, language)}</dd>
                    </dl>
                    <Button
                        size="sm"
                        variant="subtle"
                        loading={forgetting}
                        aria-label={t('knownHosts.forgetLabel', { host: address })}
                        className="text-rose-300 hover:text-rose-200"
                        onClick={() => void forget()}
                    >
                        {!forgetting && <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                        {t('knownHosts.forget')}
                    </Button>
                </div>
            )}
        </section>
    );
}
