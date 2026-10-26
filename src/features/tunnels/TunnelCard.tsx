import { AlertTriangle, ArrowDownToLine, ArrowRight, ArrowUpFromLine, Copy, ExternalLink, Globe, Pencil, Trash2 } from 'lucide-react';
import { formatHostPort, isLoopbackHost, tunnelConnectAddress, tunnelUrl, type TunnelState, type TunnelView } from '@shared/tunnels';
import { IconButton, StatusDot, type ConnState } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { describeLastError, formatTime, tunnelName } from './format';
import { formatBytes } from '@/lib/format';

export type TunnelAction = 'start' | 'stop';

const DOT: Record<TunnelState, ConnState> = {
    stopped: 'idle',
    starting: 'connecting',
    listening: 'connected',
    error: 'error'
};

const STATE_TEXT: Record<TunnelState, string> = {
    stopped: 'text-zinc-400',
    starting: 'text-amber-300',
    listening: 'text-emerald-300',
    error: 'text-rose-300'
};

// While `busy` it ignores clicks but stays focusable (a disabled button would
// drop the keyboard focus to the page).
export function Switch({ checked, label, busy, onChange }: {
    checked: boolean;
    label: string;
    busy?: boolean;
    onChange: (checked: boolean) => void;
}) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            aria-label={label}
            aria-busy={busy || undefined}
            aria-disabled={busy || undefined}
            onClick={() => {
                if (!busy) onChange(!checked);
            }}
            className={cn(
                // The shared teal focus glow vanishes on the green track: an offset outline instead.
                'relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors',
                'outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-300',
                'aria-disabled:cursor-wait aria-disabled:opacity-60',
                checked ? 'border-emerald-400/50 bg-emerald-500/70' : 'border-white/10 bg-white/10 hover:bg-white/15'
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'inline-block h-3.5 w-3.5 rounded-full bg-fixed-white shadow transition-transform',
                    checked ? 'translate-x-[18px]' : 'translate-x-[3px]',
                    busy && 'animate-pulse'
                )}
            />
        </button>
    );
}

function Badge({ children, title, tone = 'neutral' }: { children: React.ReactNode; title?: string; tone?: 'neutral' | 'warning' }) {
    return (
        <span
            title={title}
            className={cn(
                'inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
                tone === 'warning' ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-white/10 bg-white/[0.04] text-zinc-400'
            )}
        >
            {children}
        </span>
    );
}

export interface TunnelCardProps {
    tunnel: TunnelView;
    // The start or stop request in flight, if any.
    pending?: TunnelAction;
    onToggle: (tunnel: TunnelView, run: boolean) => void;
    onEdit: (tunnel: TunnelView) => void;
    onDelete: (tunnel: TunnelView) => void;
    onCopy: (address: string) => void;
    onOpen: (url: string) => void;
}

export function TunnelCard({ tunnel, pending, onToggle, onEdit, onDelete, onCopy, onOpen }: TunnelCardProps) {
    const t = useT();
    const language = useLanguage();
    const { status } = tunnel;
    const name = tunnelName(tunnel);
    const running = status.state === 'listening' || status.state === 'starting';
    // A start in flight shows as starting right away (the SSH handshake may take a while).
    const state: TunnelState = pending === 'start' ? 'starting' : status.state;
    const local = formatHostPort(tunnel.local_host, tunnel.local_port);
    const remote = formatHostPort(tunnel.remote_host, tunnel.remote_port);
    const connectAddress = tunnelConnectAddress(tunnel);
    const url = tunnelUrl(tunnel);
    const exposed = !isLoopbackHost(tunnel.local_host);
    const problem = status.lastError && state !== 'stopped' && pending !== 'start'
        ? describeLastError(t, status.lastError, tunnel)
        : null;

    return (
        <li
            className={cn(
                'rounded-xl border bg-ink-850/60 px-4 py-3 transition-colors',
                state === 'error' ? 'border-rose-500/25' : state === 'listening' || state === 'starting' ? 'border-emerald-500/20' : 'border-white/[0.06]'
            )}
        >
            <div className="flex items-start gap-4">
                <div className="min-w-0 flex-1 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
                        <h3 className="truncate text-sm font-semibold text-zinc-100">{name}</h3>
                        <span className={cn('inline-flex items-center gap-1.5 text-[11px] font-medium', STATE_TEXT[state])}>
                            <StatusDot state={DOT[state]} />
                            {t(`tunnels.state.${state}`)}
                        </span>
                        {tunnel.auto_start && <Badge title={t('tunnels.card.autoStartHint')}>{t('tunnels.card.autoStart')}</Badge>}
                        {exposed && (
                            <Badge tone="warning" title={t('tunnels.card.exposedHint', { address: local })}>
                                <Globe className="h-3 w-3" aria-hidden="true" />
                                {t('tunnels.card.exposed')}
                            </Badge>
                        )}
                    </div>

                    <p className="font-mono text-xs text-zinc-300">
                        <span className="sr-only">{t('tunnels.card.route', { local, remote })}</span>
                        <span aria-hidden="true" className="inline-flex flex-wrap items-center gap-2">
                            <span className="rounded bg-white/[0.05] px-1.5 py-0.5 text-zinc-100">{local}</span>
                            <ArrowRight className="h-3.5 w-3.5 text-zinc-500" />
                            <span className="rounded bg-white/[0.03] px-1.5 py-0.5">{remote}</span>
                        </span>
                    </p>

                    {running && (
                        <p className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-400">
                            <span>{t('tunnels.card.connections', { active: status.activeConnections, total: status.totalConnections })}</span>
                            <span className="inline-flex items-center gap-1">
                                <ArrowDownToLine className="h-3 w-3" aria-hidden="true" />
                                {t('tunnels.card.received', { bytes: formatBytes(status.bytesIn, language) })}
                            </span>
                            <span className="inline-flex items-center gap-1">
                                <ArrowUpFromLine className="h-3 w-3" aria-hidden="true" />
                                {t('tunnels.card.sent', { bytes: formatBytes(status.bytesOut, language) })}
                            </span>
                        </p>
                    )}

                    {problem && status.lastError && (
                        <div className="flex items-start gap-1.5 text-xs text-rose-300">
                            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                            <p className="min-w-0">
                                <span className="font-medium">{t('tunnels.card.lastError', { time: formatTime(status.lastError.at, language) })}: </span>
                                {problem.text}
                                {problem.detail && <span className="mt-0.5 block break-words text-rose-300/70">{problem.detail}</span>}
                            </p>
                        </div>
                    )}
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                    <IconButton size="sm" label={t('tunnels.actions.copy', { address: connectAddress })} onClick={() => onCopy(connectAddress)}>
                        <Copy className="h-3.5 w-3.5" />
                    </IconButton>
                    {url && (
                        <IconButton size="sm" label={t('tunnels.actions.open', { url })} disabled={status.state !== 'listening'} onClick={() => onOpen(url)}>
                            <ExternalLink className="h-3.5 w-3.5" />
                        </IconButton>
                    )}
                    <IconButton size="sm" label={t('tunnels.actions.edit', { name })} onClick={() => onEdit(tunnel)}>
                        <Pencil className="h-3.5 w-3.5" />
                    </IconButton>
                    <IconButton size="sm" label={t('tunnels.actions.delete', { name })} className="hover:text-rose-300" onClick={() => onDelete(tunnel)}>
                        <Trash2 className="h-3.5 w-3.5" />
                    </IconButton>
                    <span className="ml-1.5">
                        <Switch
                            checked={pending ? pending === 'start' : running}
                            busy={pending !== undefined}
                            label={t('tunnels.actions.toggle', { name })}
                            onChange={(run) => onToggle(tunnel, run)}
                        />
                    </span>
                </div>
            </div>
        </li>
    );
}
