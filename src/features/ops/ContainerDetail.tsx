import { useMemo, useState } from 'react';
import { Copy, Eye, EyeOff, RefreshCw, ScrollText } from 'lucide-react';
import type { ContainerInfo, ContainerInspectSummary, LogStreamSource, OpsCapabilities } from '@shared/ops';
import { useToast } from '@/components/ui';
import { useLanguage, useT } from '@/i18n';
import { copyText } from '@/lib/clipboard';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import { opsApi, type ContainerDetail as Detail } from './api';
import { containerStatusText, formatClock, formatEngineSizes, formatTimestamp } from './format';
import { maskInspect } from './inspectMask';
import { ErrorNotice, PropertyList, Section, Segmented, StateBadge, StatTile, ToolButton, countKey, type BadgeTone } from './ui';
import { useRemote, type RemoteState } from './useRemote';

// The sections of a container's detail pane: what it runs and how it is
// set up (from `inspect`), a usage snapshot, recent logs and the raw inspect
// output. Environment values are masked until revealed, in the raw output too.

const LOG_LINES = [100, 500, 2000] as const;
const MASK = '••••••••';

type ContainerSectionsProps = {
    serverId: number;
    caps: OpsCapabilities;
    container: ContainerInfo;
    detail: RemoteState<Detail>;
    onFollowLogs: (source: LogStreamSource) => void;
};

const HEALTH_TONE: Record<string, BadgeTone> = { healthy: 'ok', starting: 'warn', unhealthy: 'bad' };

function Timestamp({ value, language }: { value: string | null | undefined; language: string }) {
    return <span title={value ?? undefined}>{formatTimestamp(value, language)}</span>;
}

function Mono({ children, className }: { children: React.ReactNode; className?: string }) {
    return <code className={cn('break-all font-mono text-[11px] text-zinc-200', className)}>{children}</code>;
}

function Environment({ summary }: { summary: ContainerInspectSummary }) {
    const t = useT();
    const toast = useToast();
    const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
    const all = summary.env.length > 0 && summary.env.every((entry) => revealed.has(entry.name));
    const toggle = (name: string) => setRevealed((previous) => {
        const next = new Set(previous);
        if (next.has(name)) next.delete(name);
        else next.add(name);
        return next;
    });
    const copy = async (name: string, value: string) => {
        try {
            await copyText(value);
            toast.success(t('ops.containers.env.copied', { name }));
        } catch {
            toast.error(t('ops.containers.env.copyFailed'));
        }
    };
    if (!summary.env.length) return <p className="text-xs text-zinc-500">{t('ops.containers.env.empty')}</p>;
    return (
        <>
            <div className="flex items-center gap-2">
                <p className="mr-auto text-[11px] text-zinc-500">{t('ops.containers.env.hint')}</p>
                <ToolButton
                    icon={all ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                    label={all ? t('ops.containers.env.hideAll') : t('ops.containers.env.showAll')}
                    onClick={() => setRevealed(all ? new Set() : new Set(summary.env.map((entry) => entry.name)))}
                />
            </div>
            <ul className="divide-y divide-white/[0.05] text-xs">
                {summary.env.map(({ name, value }) => {
                    const shown = revealed.has(name);
                    return (
                        <li key={name} className="flex items-start gap-2 py-1.5">
                            <div className="min-w-0 flex-1">
                                <div className="truncate font-mono text-[11px] font-medium text-zinc-300" title={name}>{name}</div>
                                <Mono className={cn(!shown && 'select-none text-zinc-500')}>
                                    {shown ? value || '""' : <><span aria-hidden="true">{MASK}</span><span className="sr-only">{t('ops.containers.env.masked')}</span></>}
                                </Mono>
                            </div>
                            <button
                                type="button"
                                onClick={() => toggle(name)}
                                aria-pressed={shown}
                                aria-label={shown ? t('ops.containers.env.hide', { name }) : t('ops.containers.env.show', { name })}
                                title={shown ? t('ops.containers.env.hide', { name }) : t('ops.containers.env.show', { name })}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100 focus-ring"
                            >
                                {shown ? <EyeOff className="h-3.5 w-3.5" aria-hidden="true" /> : <Eye className="h-3.5 w-3.5" aria-hidden="true" />}
                            </button>
                            <button
                                type="button"
                                onClick={() => void copy(name, value)}
                                aria-label={t('ops.containers.env.copy', { name })}
                                title={t('ops.containers.env.copy', { name })}
                                className="flex h-6 w-6 shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-white/10 hover:text-zinc-100 focus-ring"
                            >
                                <Copy className="h-3.5 w-3.5" aria-hidden="true" />
                            </button>
                        </li>
                    );
                })}
            </ul>
        </>
    );
}

function Usage({ serverId, container }: { serverId: number; container: ContainerInfo }) {
    const t = useT();
    const language = useLanguage();
    const running = container.state === 'running';
    const usage = useRemote((signal) => opsApi.containerUsage(serverId, container.name, signal), `usage:${serverId}:${container.name}`, running);
    if (!running) return <p className="text-xs text-zinc-500">{t('ops.containers.usage.stopped')}</p>;
    const stats = usage.data;
    const value = (text: string | undefined) => (usage.loading && !stats ? '…' : text || '—');
    return (
        <>
            {usage.error ? <ErrorNotice error={usage.error} onRetry={usage.reload} /> : null}
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3" aria-busy={usage.loading}>
                <StatTile label={t('ops.containers.usage.cpu')} value={value(stats?.cpuPercent != null ? formatPercent(stats.cpuPercent, language) : undefined)} />
                <StatTile
                    label={t('ops.containers.usage.memory')}
                    value={value(stats?.memoryPercent != null ? formatPercent(stats.memoryPercent, language) : undefined)}
                    hint={formatEngineSizes(stats?.memoryUsage, language) || undefined}
                />
                <StatTile label={t('ops.containers.usage.pids')} value={value(stats?.pids != null ? String(stats.pids) : undefined)} />
                <StatTile label={t('ops.containers.usage.net')} value={value(formatEngineSizes(stats?.netIO, language))} />
                <StatTile label={t('ops.containers.usage.block')} value={value(formatEngineSizes(stats?.blockIO, language))} />
            </div>
            <div className="flex justify-end">
                <ToolButton icon={<RefreshCw className="h-3.5 w-3.5" />} label={t('ops.containers.usage.measure')} busy={usage.loading} onClick={usage.reload} />
            </div>
        </>
    );
}

export function ContainerSections({ serverId, caps, container, detail, onFollowLogs }: ContainerSectionsProps) {
    const t = useT();
    const language = useLanguage();
    const [logLines, setLogLines] = useState<number | null>(null);
    const [revealRaw, setRevealRaw] = useState(false);
    const logs = useRemote(
        (signal) => opsApi.containerLogs(serverId, container.name, logLines ?? 100, signal),
        `logs:${serverId}:${container.name}:${logLines}`,
        Boolean(logLines)
    );
    const summary = detail.data?.summary ?? null;
    const raw = useMemo(() => (revealRaw ? detail.data?.inspect : maskInspect(detail.data?.inspect, MASK)), [detail.data, revealRaw]);
    const none = <span className="text-zinc-500">—</span>;
    const when = (value: string | null) => <Timestamp value={value} language={language} />;

    const overview: Array<[string, React.ReactNode]> = [
        [t('ops.containers.fields.status'), container.status ? <span key="status" title={container.status}>{containerStatusText(container.status, t, language) ?? container.status}</span> : summary?.state.status || '—'],
        [t('ops.containers.fields.id'), <Mono key="id">{container.id.slice(0, 12)}</Mono>],
        [t('ops.containers.fields.created'), when(summary?.created ?? container.createdAt)],
        ...(summary?.state.startedAt ? [[t('ops.containers.fields.started'), when(summary.state.startedAt)] as [string, React.ReactNode]] : []),
        ...(summary && !summary.state.running && summary.state.finishedAt
            ? [[t('ops.containers.fields.finished'), t('ops.containers.fields.finishedValue', {
                time: formatTimestamp(summary.state.finishedAt, language),
                code: summary.state.exitCode ?? '?'
            })] as [string, string]]
            : []),
        ...(summary?.state.oomKilled ? [[t('ops.containers.fields.oom'), <span key="oom" className="text-rose-200">{t('ops.containers.fields.oomValue')}</span>] as [string, React.ReactNode]] : []),
        ...(summary?.state.error ? [[t('ops.containers.fields.error'), <span key="error" className="text-rose-200">{summary.state.error}</span>] as [string, React.ReactNode]] : []),
        ...(summary ? [[t('ops.containers.fields.command'), summary.command ? <Mono key="cmd">{summary.command}</Mono> : none] as [string, React.ReactNode]] : []),
        ...(summary ? [[t('ops.containers.fields.restart'), !summary.restartPolicy
            ? none
            : summary.restartCount
                ? t(countKey('ops.containers.fields.restartValue', summary.restartCount), { policy: summary.restartPolicy, count: summary.restartCount })
                : summary.restartPolicy] as [string, React.ReactNode]] : []),
        ...(summary?.user ? [[t('ops.containers.fields.user'), <Mono key="user">{summary.user}</Mono>] as [string, React.ReactNode]] : []),
        ...(summary?.workingDir ? [[t('ops.containers.fields.workdir'), <Mono key="wd">{summary.workingDir}</Mono>] as [string, React.ReactNode]] : []),
        ...(container.composeProject ? [[t('ops.containers.fields.compose'), `${container.composeProject} / ${container.composeService ?? '—'}`] as [string, string]] : [])
    ];

    return (
        <div className="space-y-2 px-4 pb-4">
            {detail.error ? <ErrorNotice error={detail.error} onRetry={detail.reload} /> : null}
            <Section title={t('ops.containers.sections.overview')} defaultOpen>
                <PropertyList rows={overview} />
            </Section>

            {summary?.health && (
                <Section title={t('ops.containers.sections.health')} defaultOpen={summary.health.status !== 'healthy'}>
                    <div className="flex flex-wrap items-center gap-2">
                        <StateBadge tone={HEALTH_TONE[summary.health.status] ?? 'idle'} label={t(`ops.containers.health.${summary.health.status in HEALTH_TONE ? summary.health.status : 'unknown'}`)} />
                        {summary.health.failingStreak > 0 && <span className="text-[11px] text-amber-200">{t(countKey('ops.containers.health.streak', summary.health.failingStreak), { count: summary.health.failingStreak })}</span>}
                    </div>
                    {summary.health.log.length > 0 && (
                        <ul className="space-y-1 text-[11px]">
                            {[...summary.health.log].reverse().map((check, index) => (
                                <li key={`${check.start}-${index}`} className="rounded border border-white/[0.05] px-2 py-1">
                                    <div className="flex gap-2 text-zinc-500">
                                        <span className="truncate" title={formatTimestamp(check.start, language)}>{formatClock(check.start, language)}</span>
                                        <span className={cn('ml-auto shrink-0 tabular-nums', check.exitCode === 0 ? 'text-emerald-300' : 'text-rose-300')}>
                                            {t('ops.containers.health.exit', { code: check.exitCode ?? '?' })}
                                        </span>
                                    </div>
                                    {check.output && <pre className="mt-0.5 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-zinc-300">{check.output}</pre>}
                                </li>
                            ))}
                        </ul>
                    )}
                </Section>
            )}

            <Section title={t('ops.containers.sections.usage')} defaultOpen={container.state === 'running'}>
                <Usage serverId={serverId} container={container} />
            </Section>

            <Section title={t('ops.containers.sections.ports')} count={summary?.ports.length} defaultOpen={Boolean(summary?.ports.length)}>
                {!summary ? <DetailPlaceholder detail={detail} /> : summary.ports.length === 0 ? (
                    <p className="text-xs text-zinc-500">{t('ops.containers.ports.none')}</p>
                ) : (
                    <ul className="space-y-1 text-xs">
                        {summary.ports.map((port) => (
                            <li key={`${port.port}-${port.hostIp}-${port.hostPort}`} className="flex items-center gap-2">
                                <Mono>{port.hostPort ? `${port.hostIp && port.hostIp !== '0.0.0.0' ? port.hostIp : '*'}:${port.hostPort}` : t('ops.containers.ports.notPublished')}</Mono>
                                <span className="text-zinc-500" aria-hidden="true">→</span>
                                <span className="sr-only">{t('ops.containers.ports.to')}</span>
                                <Mono>{port.port}</Mono>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title={t('ops.containers.sections.env')} count={summary?.env.length}>
                {summary ? <Environment summary={summary} /> : <DetailPlaceholder detail={detail} />}
            </Section>

            <Section title={t('ops.containers.sections.mounts')} count={summary?.mounts.length}>
                {!summary ? <DetailPlaceholder detail={detail} /> : summary.mounts.length === 0 ? (
                    <p className="text-xs text-zinc-500">{t('ops.containers.mounts.none')}</p>
                ) : (
                    <ul className="space-y-1.5 text-xs">
                        {summary.mounts.map((mount) => (
                            <li key={`${mount.destination}-${mount.source}`} className="rounded border border-white/[0.05] px-2 py-1.5">
                                <div className="flex items-center gap-2">
                                    <Mono className="font-medium">{mount.destination}</Mono>
                                    <span className="ml-auto shrink-0 rounded bg-white/[0.06] px-1.5 text-[10px] uppercase tracking-wide text-zinc-400">{mount.type}</span>
                                    <span className={cn('shrink-0 rounded px-1.5 text-[10px] font-medium', mount.readOnly ? 'bg-white/[0.06] text-zinc-400' : 'bg-amber-500/10 text-amber-200')}>
                                        {mount.readOnly ? t('ops.containers.mounts.readOnly') : t('ops.containers.mounts.readWrite')}
                                    </span>
                                </div>
                                <div className="mt-0.5 text-[11px] text-zinc-500">
                                    {mount.name ? t('ops.containers.mounts.volume', { name: mount.name }) : <Mono className="text-zinc-400">{mount.source}</Mono>}
                                </div>
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title={t('ops.containers.sections.networks')} count={summary?.networks.length}>
                {!summary ? <DetailPlaceholder detail={detail} /> : summary.networks.length === 0 ? (
                    <p className="text-xs text-zinc-500">{summary.networkMode ? t('ops.containers.networks.mode', { mode: summary.networkMode }) : t('ops.containers.networks.none')}</p>
                ) : (
                    <ul className="space-y-1.5 text-xs">
                        {summary.networks.map((network) => (
                            <li key={network.name} className="rounded border border-white/[0.05] px-2 py-1.5">
                                <div className="font-medium text-zinc-200">{network.name}</div>
                                <PropertyList rows={[
                                    [t('ops.containers.networks.ip'), network.ipAddress ? <Mono key="ip">{network.ipAddress}</Mono> : none],
                                    [t('ops.containers.networks.gateway'), network.gateway ? <Mono key="gw">{network.gateway}</Mono> : none],
                                    ...(network.aliases.length ? [[t('ops.containers.networks.aliases'), network.aliases.join(', ')] as [string, string]] : [])
                                ]} />
                            </li>
                        ))}
                    </ul>
                )}
            </Section>

            <Section title={t('ops.containers.logs.title')}>
                <div className="flex flex-wrap items-center gap-2">
                    <Segmented<string>
                        label={t('ops.containers.logs.lines')}
                        value={String(logLines ?? '')}
                        onChange={(value) => setLogLines(Number(value))}
                        options={LOG_LINES.map((lines) => ({ value: String(lines), label: String(lines) }))}
                    />
                    <div className="ml-auto">
                        <ToolButton icon={<ScrollText className="h-3.5 w-3.5" />} label={t('ops.containers.logs.follow')} onClick={() => onFollowLogs({ kind: 'container', container: container.name })} />
                    </div>
                </div>
                {logLines === null ? (
                    <p className="text-xs text-zinc-500">{t('ops.containers.logs.hint')}</p>
                ) : logs.error ? (
                    <ErrorNotice error={logs.error} onRetry={logs.reload} />
                ) : (
                    <pre aria-busy={logs.loading} className="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                        {logs.loading ? t('ops.loading') : logs.data?.trim() || t('ops.containers.logs.empty')}
                    </pre>
                )}
            </Section>

            <Section title={t('ops.containers.inspect.title')}>
                <div className="flex items-center gap-2">
                    <p className="mr-auto text-[11px] text-zinc-500">{revealRaw ? t('ops.containers.inspect.revealed') : t('ops.containers.inspect.masked')}</p>
                    <ToolButton
                        icon={revealRaw ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                        label={revealRaw ? t('ops.containers.inspect.mask') : t('ops.containers.inspect.reveal')}
                        pressed={revealRaw}
                        onClick={() => setRevealRaw((value) => !value)}
                    />
                </div>
                {detail.data ? (
                    <pre className="max-h-96 overflow-auto rounded-lg border border-white/[0.06] bg-black/30 p-3 font-mono text-[11px] leading-relaxed text-zinc-300">
                        {JSON.stringify(raw, null, 2)}
                    </pre>
                ) : <DetailPlaceholder detail={detail} />}
            </Section>
            {caps.containers.sudo && <p className="px-1 text-[11px] text-zinc-500">{t('ops.containers.viaSudo')}</p>}
        </div>
    );
}

function DetailPlaceholder({ detail }: { detail: RemoteState<Detail> }) {
    const t = useT();
    if (detail.error) return <p className="text-xs text-zinc-500">{t('ops.containers.detailUnavailable')}</p>;
    return <div className="h-10 animate-pulse rounded-lg bg-white/[0.03]" aria-label={t('ops.loading')} role="status" />;
}
