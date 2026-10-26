import { useId } from 'react';
import { AlertTriangle, ChevronRight, Copy } from 'lucide-react';
import type { MultiExecServerRun } from '@shared/multiexec';
import { IconButton, useToast } from '@/components/ui';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { copyText } from '@/lib/clipboard';
import { serverErrorText } from './errors';
import { formatDuration } from './export';
import { StatusBadge } from './status';
import { isFinalStatus } from './store';

export function OutputPane({ label, text, tone }: { label: string; text: string; tone: 'out' | 'err' }) {
    const id = useId();
    return (
        <div className="space-y-1">
            <div id={id} className="text-[10px] font-semibold uppercase tracking-wider text-zinc-500">{label}</div>
            <pre
                aria-labelledby={id}
                className={cn(
                    'max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-lg border bg-ink-900/80 px-3 py-2 font-mono text-[11px] leading-relaxed scrollbar-thin',
                    tone === 'err' ? 'border-rose-500/20 text-rose-100' : 'border-white/10 text-zinc-100'
                )}
            >
                {text}
            </pre>
        </div>
    );
}

// What a server printed, why it failed and whether output was dropped.
export function ServerOutput({ server, timeoutSec }: { server: MultiExecServerRun; timeoutSec: number }) {
    const t = useT();
    const failure = serverErrorText(server, timeoutSec, t);
    const hasDetails = Boolean(server.stdout || server.stderr || failure || server.truncated || server.outputTrimmed);
    return (
        <div className="space-y-2">
            {failure && (
                <div className="flex items-start gap-1.5 text-xs text-rose-200">
                    <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <div className="min-w-0 space-y-0.5">
                        <p className="break-words">{failure.message}</p>
                        {failure.detail && <p className="break-words font-mono text-[11px] text-rose-200/60">{failure.detail}</p>}
                    </div>
                </div>
            )}
            {server.stdout && <OutputPane label="stdout" text={server.stdout} tone="out" />}
            {server.stderr && <OutputPane label="stderr" text={server.stderr} tone="err" />}
            {server.truncated
                ? <p className="text-[11px] text-amber-200">{t('multiexec.results.truncated')}</p>
                : server.outputTrimmed && <p className="text-[11px] text-amber-200">{t('multiexec.results.trimmed')}</p>}
            {!hasDetails && (
                <p className="text-xs text-zinc-500">
                    {server.status === 'skipped'
                        ? t('multiexec.results.skipped')
                        : isFinalStatus(server.status) ? t('multiexec.results.noOutput') : t('multiexec.results.waiting')}
                </p>
            )}
        </div>
    );
}

type ServerRowProps = {
    server: MultiExecServerRun;
    timeoutSec: number;
    now: number;
    expanded: boolean;
    onToggle: () => void;
    batchLabel: string | null;
};

function ServerRow({ server, timeoutSec, now, expanded, onToggle, batchLabel }: ServerRowProps) {
    const t = useT();
    const toast = useToast();
    const panelId = useId();
    // Running servers tick in whole seconds (the clock only updates once a second).
    const elapsed = server.status === 'running' && server.startedAt !== null ? `${Math.floor(Math.max(0, now - server.startedAt) / 1000)} s` : null;

    const copyOutput = async () => {
        try {
            await copyText([server.stdout, server.stderr].filter(Boolean).join('\n'));
            toast.success(t('multiexec.results.outputCopied'));
        } catch {
            toast.error(t('multiexec.results.copyFailed'));
        }
    };

    return (
        <li className="rounded-xl border border-white/5 bg-white/[0.02]">
            <div className="flex items-center gap-2 pr-2">
                <button
                    type="button"
                    onClick={onToggle}
                    aria-expanded={expanded}
                    aria-controls={panelId}
                    className="flex min-w-0 flex-1 items-center gap-3 rounded-xl px-3 py-2.5 text-left focus-ring"
                >
                    <ChevronRight className={cn('h-4 w-4 shrink-0 text-zinc-500 transition-transform', expanded && 'rotate-90')} aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                        <span className="block truncate text-sm font-medium text-zinc-100">{server.name}</span>
                        <span className="block truncate font-mono text-[11px] text-zinc-500">{server.host}{batchLabel ? ` · ${batchLabel}` : ''}</span>
                    </span>
                    <StatusBadge status={server.status} />
                    <span className="w-16 shrink-0 text-right font-mono text-xs text-zinc-300" title={t('multiexec.results.exitCode')}>
                        {server.exitCode === null ? '—' : t('multiexec.results.exit', { code: server.exitCode })}
                    </span>
                    <span className="hidden w-20 shrink-0 text-right font-mono text-xs text-zinc-400 sm:inline" title={t('multiexec.results.duration')}>
                        {elapsed ?? formatDuration(server.durationMs)}
                    </span>
                </button>
                <IconButton size="sm" label={t('multiexec.results.copyOutput', { server: server.name })} onClick={copyOutput} disabled={!server.stdout && !server.stderr}>
                    <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                </IconButton>
            </div>
            {expanded && (
                <div id={panelId} className="border-t border-white/5 px-3 py-3">
                    <ServerOutput server={server} timeoutSec={timeoutSec} />
                </div>
            )}
        </li>
    );
}

interface ServerListProps {
    servers: readonly MultiExecServerRun[];
    timeoutSec: number;
    now: number;
    expanded: ReadonlySet<number>;
    onToggle: (serverId: number) => void;
    batchLabel: (batch: number) => string | null;
}

export function ServerList({ servers, timeoutSec, now, expanded, onToggle, batchLabel }: ServerListProps) {
    const t = useT();
    return (
        <ul className="min-h-0 flex-1 space-y-1.5 overflow-y-auto pr-1 scrollbar-thin" aria-label={t('multiexec.results.servers')}>
            {servers.map((server) => (
                <ServerRow
                    key={server.serverId}
                    server={server}
                    timeoutSec={timeoutSec}
                    now={now}
                    expanded={expanded.has(server.serverId)}
                    onToggle={() => onToggle(server.serverId)}
                    batchLabel={batchLabel(server.batch)}
                />
            ))}
            {servers.length === 0 && <li className="px-2 py-8 text-center text-xs text-zinc-500">{t('multiexec.results.noneMatch')}</li>}
        </ul>
    );
}
