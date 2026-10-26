import { useCallback, useEffect, useId, useState } from 'react';
import { ChevronDown, Fingerprint, RotateCcw } from 'lucide-react';
import type { AgentStatus } from '@shared/identities';
import { IconButton, Spinner } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { identitiesApi } from './api';
import { keyTypeLabel } from './describe';

// Whether ShellMind can reach an SSH agent (ssh-agent, Pageant, the Windows
// OpenSSH agent) and which keys it offers.
export function AgentStatusCard() {
    const t = useT();
    const id = useId();
    const [status, setStatus] = useState<AgentStatus | null>(null);
    const [failed, setFailed] = useState(false);
    const [loading, setLoading] = useState(true);
    const [expanded, setExpanded] = useState(false);

    const refresh = useCallback(async (signal?: AbortSignal) => {
        setLoading(true);
        try {
            setStatus(await identitiesApi.agent({ signal }));
            setFailed(false);
        } catch {
            if (!signal?.aborted) setFailed(true);
        } finally {
            if (!signal?.aborted) setLoading(false);
        }
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        void refresh(controller.signal);
        return () => controller.abort();
    }, [refresh]);

    const tone = status?.available ? 'bg-emerald-400' : status && status.source !== null ? 'bg-amber-400' : 'bg-zinc-500';
    let title: string;
    let detail: string | null = null;
    if (failed) title = t('identities.agent.unknown');
    else if (!status) title = t('identities.agent.checking');
    else if (status.available) {
        title = t('identities.agent.available');
        detail = `${t(status.keys.length === 1 ? 'identities.agent.keys.one' : 'identities.agent.keys.other', { count: status.keys.length })} · ${t('identities.agent.via', { source: t(`identities.agent.sources.${status.source}`) })}`;
    } else if (status.source !== null) {
        title = t('identities.agent.unreachable', { source: t(`identities.agent.sources.${status.source}`) });
        detail = `${status.errorCode ? t(`identities.agent.errors.${status.errorCode}`) : status.error} ${t(`identities.agent.fix.${status.source}`)}`;
    } else {
        title = t('identities.agent.none');
        detail = t(`identities.agent.reasons.${status.reason}`);
    }
    const keys = status?.available ? status.keys : [];

    return (
        <section aria-labelledby={`${id}-title`} className="rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-3">
            <div className="flex items-start gap-3">
                <span className={cn('mt-1.5 h-2 w-2 shrink-0 rounded-full', tone)} aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h4 id={`${id}-title`} className="text-sm font-medium text-zinc-100">{title}</h4>
                    {detail && <p className="mt-0.5 break-words text-xs text-zinc-400">{detail}</p>}
                </div>
                {keys.length > 0 && (
                    <button
                        type="button"
                        onClick={() => setExpanded((open) => !open)}
                        aria-expanded={expanded}
                        aria-controls={`${id}-keys`}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-1 text-xs text-zinc-300 hover:bg-white/5 hover:text-zinc-100 focus-ring"
                    >
                        {t('identities.agent.showKeys')}
                        <ChevronDown className={cn('h-3.5 w-3.5 transition-transform', expanded && 'rotate-180')} aria-hidden="true" />
                    </button>
                )}
                <IconButton size="sm" variant="ghost" label={t('identities.agent.refresh')} aria-busy={loading} onClick={() => { if (!loading) void refresh(); }}>
                    {loading ? <Spinner className="h-3.5 w-3.5" /> : <RotateCcw className="h-3.5 w-3.5" />}
                </IconButton>
            </div>
            {expanded && keys.length > 0 && (
                <ul id={`${id}-keys`} className="mt-2.5 space-y-1 border-t border-white/[0.05] pt-2.5">
                    {keys.map((key) => (
                        <li key={key.fingerprint} className="flex items-center gap-2 text-xs">
                            <Fingerprint className="h-3.5 w-3.5 shrink-0 text-zinc-500" aria-hidden="true" />
                            <span className="shrink-0 text-zinc-400">{keyTypeLabel(key.type)}</span>
                            <code className="min-w-0 truncate font-mono text-zinc-300" title={key.fingerprint}>{key.fingerprint}</code>
                            {key.comment && <span className="min-w-0 truncate text-zinc-500">{key.comment}</span>}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
