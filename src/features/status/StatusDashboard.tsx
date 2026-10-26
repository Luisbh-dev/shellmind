import { useCallback, useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Cpu, HardDrive, ListOrdered, MemoryStick, Network, RefreshCw, ServerCrash } from 'lucide-react';
import { holdForCode } from '@shared/fleet';
import type { StatusSnapshot } from '@shared/status';
import { Button } from '@/components/ui';
import { useResolvedTheme } from '@/features/appearance/store';
import { formatPercent } from '@/lib/format';
import { connectionCause, describeError, errorCode, type DescribedError } from '@/lib/remoteErrors';
import { useLanguage, useT, type TranslateFn } from '@/i18n';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import type { WorkspaceServer } from '@/workspace/types';
import { CARD, Card, StatTile } from './Card';
import { ChartCard } from './ChartCard';
import { DiskList } from './DiskList';
import { formatClock, formatGB, formatMB, formatRate, formatRateTick, formatSeconds } from './format';
import { appendSample, HISTORY_LENGTH, rateAxis, seriesOf, statsOf, type StatusSample } from './history';
import { useNow, usePageVisible, usePolling } from './hooks';
import { CHART_GRID, CHART_WIDE, DETAIL_GRID, KPI_GRID, KPI_GRID_THREE, KPI_WIDE, STALE_DIM } from './layout';
import { LoadTile } from './LoadTile';
import { Meter } from './Meter';
import { ProcessTable } from './ProcessTable';
import { HealthBadge, HealthIssues, HostFacts, LiveIndicator, StatusAiActions, type LiveState } from './StatusHeader';
import { StatusSkeleton } from './StatusSkeleton';
import { assessHealth, classify, storageReading, THRESHOLDS, type Threshold } from './thresholds';
import { toneColor, viz, vizStyle } from './vizTheme';

// Live metrics of a Linux/Windows server. One request at a time: the next
// poll starts POLL_INTERVAL_MS after the previous answer, failures back off,
// and nothing is requested while the tab or the window is hidden. The layout
// follows the panel's own width (container queries: the chat and the sidebar
// take part of the window).

const POLL_INTERVAL_MS = 5000;

// A failure no retry fixes by itself (see FleetHold): the cause of a failed
// connection (SSH_FAILED details), or the code of the answer itself.
const needsSomeone = (error: unknown) => holdForCode(connectionCause(error)?.code ?? errorCode(error)) !== null;
// Older than this (or after a failed poll), the values are flagged as stale.
const STALE_AFTER_MS = 20_000;
// The charts show the last five minutes.
const WINDOW_MS = 5 * 60_000;
// A pause this long between two samples (polling paused, failed polls) leaves a gap in the lines.
const MAX_GAP_MS = 3 * POLL_INTERVAL_MS;
const PERCENT_TICKS = [0, 50, 100];

interface StatusDashboardProps {
    server: WorkspaceServer;
    isActive: boolean;
}

// "42.5%" as figure and unit.
function percentParts(value: number, language: string): { value: string; unit: string } {
    return { value: formatPercent(value, language).replace(/\s?%$/, ''), unit: '%' };
}

function limitsText(threshold: Threshold, language: string, t: TranslateFn): string {
    return t('status.limits', { warn: formatPercent(threshold.warn, language), critical: formatPercent(threshold.critical, language) });
}

function chartDescription(label: string, values: Array<number | null>, format: (value: number) => string, t: TranslateFn): string {
    const stats = statsOf(values);
    if (!stats) return t('status.chart.noData', { label });
    return t('status.chart.summary', { label, count: stats.count, min: format(stats.min), max: format(stats.max), now: format(stats.last) });
}

// The alerts below hold only the failure itself: it is announced once, while
// the countdown next to it ticks outside any live region.

// A refresh that failed while older values are on screen. It floats at the
// bottom of the panel: in view wherever the page is scrolled, and nothing
// above it moves when it comes and goes (a flapping link would make the page
// jump).
function RefreshErrorBar({ failure, retryText, onRetry }: { failure: DescribedError; retryText: string | null; onRetry: () => void }) {
    const t = useT();
    return (
        <div className="pointer-events-none sticky bottom-3 z-20 flex justify-center">
            <div
                className="pointer-events-auto flex w-full max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border px-4 py-2.5 text-xs shadow-panel"
                // An opaque card under the tint: the values underneath must not show through.
                style={{ borderColor: toneColor('critical', 0.4), background: `linear-gradient(${toneColor('critical', 0.1)}, ${toneColor('critical', 0.1)}), rgb(var(--c-ink-800))` }}
            >
                <div role="alert" className="flex min-w-0 flex-1 basis-56 items-center gap-3">
                    <ServerCrash className="h-4 w-4 shrink-0" style={{ color: toneColor('critical') }} aria-hidden="true" />
                    <div className="min-w-0">
                        <div className="font-medium text-zinc-100">{t('status.errorTitle')}: {failure.title}</div>
                        {/* One line, so the bar stays low over the values; the whole text is the tooltip. */}
                        {failure.detail && <div className="mt-0.5 truncate text-zinc-400" title={failure.detail}>{failure.detail}</div>}
                    </div>
                </div>
                <div className="ml-auto flex shrink-0 items-center gap-3">
                    {retryText && <span className="tabular-nums text-zinc-400">{retryText}</span>}
                    <Button size="sm" variant="secondary" onClick={onRetry} className="h-7">
                        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('status.retry')}
                    </Button>
                </div>
            </div>
        </div>
    );
}

function LoadError({ failure, retryText, onRetry }: { failure: DescribedError; retryText: string | null; onRetry: () => void }) {
    const t = useT();
    return (
        <div className={cn(CARD, 'flex flex-col items-center px-6 py-12 text-center')}>
            <div role="alert" className="flex flex-col items-center">
                <div
                    className="mb-3 flex h-11 w-11 items-center justify-center rounded-2xl"
                    style={{ backgroundColor: toneColor('critical', 0.12), color: toneColor('critical') }}
                    aria-hidden="true"
                >
                    <ServerCrash className="h-5 w-5" />
                </div>
                <p className="text-sm font-semibold text-zinc-100">{t('status.loadErrorTitle')}</p>
                <p className="mt-1 text-xs text-zinc-300">{failure.title}</p>
                {failure.detail && <p className="mt-1.5 max-w-lg break-words font-mono text-[11px] text-zinc-500">{failure.detail}</p>}
            </div>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-3">
                <Button size="sm" variant="secondary" onClick={onRetry}>
                    <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                    {t('status.retry')}
                </Button>
                {retryText && <span className="text-[11px] tabular-nums text-zinc-500">{retryText}</span>}
            </div>
        </div>
    );
}

function Metrics({ snapshot, history, serverId }: { snapshot: StatusSnapshot; history: StatusSample[]; serverId: number }) {
    const t = useT();
    const language = useLanguage();
    const { cpu, memory, load, network } = snapshot;

    const percent = (value: number) => formatPercent(value, language);
    const percentTick = (value: number) => `${value}%`;
    const rate = (value: number) => formatRate(value, language);
    const clock = (time: number) => formatClock(time, language);
    const axisClock = (time: number) => formatClock(time, language, false);

    const end = history.length ? history[history.length - 1].time : snapshot.collectedAt;
    const start = end - WINDOW_MS;
    const cpuSeries = seriesOf(history, ['cpu'], start);
    const memorySeries = seriesOf(history, ['memory'], start);
    const networkSeries = seriesOf(history, ['rx', 'tx'], start);
    const rateScale = rateAxis(Math.max(0, ...networkSeries.values.flat().map((value) => value ?? 0)));
    const rateTick = (value: number) => formatRateTick(value, rateScale.exponent, language);
    const statsText = (values: Array<number | null>) => {
        const stats = statsOf(values);
        return stats ? t('status.chart.stats', { avg: percent(stats.avg), max: percent(stats.max) }) : undefined;
    };
    const chartTimes = { start, end, maxGapMs: MAX_GAP_MS, formatTime: clock, formatAxisTime: axisClock };

    const cpuTone = cpu ? classify(cpu.usagePercent, THRESHOLDS.cpu) : 'ok';
    const memoryTone = memory ? classify(memory.usagePercent, THRESHOLDS.memory) : 'ok';
    const coresText = cpu?.cores ? (cpu.cores === 1 ? t('status.cpu.coresOne') : t('status.cpu.cores', { count: cpu.cores })) : undefined;
    const unavailable = <span className="text-sm font-medium text-zinc-500">{t('status.unavailable')}</span>;
    const storageView = storageReading(snapshot);
    const storageTone = storageView ? classify(storageView.usagePercent, THRESHOLDS.disk) : 'ok';

    return (
        <>
            <div className={load ? KPI_GRID : KPI_GRID_THREE}>
                <StatTile
                    icon={<Cpu />}
                    label={t('status.cpu.title')}
                    tone={cpuTone}
                    value={cpu ? percentParts(cpu.usagePercent, language).value : unavailable}
                    unit={cpu ? '%' : undefined}
                    aside={coresText}
                    footer={cpu && cpu.iowaitPercent !== null ? t('status.cpu.iowait', { value: percent(cpu.iowaitPercent) }) : undefined}
                >
                    {cpu && (
                        <Meter
                            value={cpu.usagePercent}
                            tone={cpuTone}
                            marks={[THRESHOLDS.cpu.warn, THRESHOLDS.cpu.critical]}
                            label={t('status.cpu.title')}
                            valueText={`${percent(cpu.usagePercent)} (${limitsText(THRESHOLDS.cpu, language, t)})`}
                        />
                    )}
                </StatTile>

                <StatTile
                    icon={<MemoryStick />}
                    label={t('status.memory.title')}
                    tone={memoryTone}
                    value={memory ? percentParts(memory.usagePercent, language).value : unavailable}
                    unit={memory ? '%' : undefined}
                    aside={memory && t('status.memory.used', { used: formatMB(memory.usedMB, language), total: formatMB(memory.totalMB, language) })}
                    footer={memory && [
                        snapshot.swap && snapshot.swap.totalMB > 0
                            ? t('status.memory.swap', { used: formatMB(snapshot.swap.usedMB, language), total: formatMB(snapshot.swap.totalMB, language) })
                            : t('status.memory.noSwap'),
                        t('status.memory.available', { value: formatMB(memory.availableMB, language) })
                    ].join(' · ')}
                >
                    {memory && (
                        <Meter
                            value={memory.usagePercent}
                            tone={memoryTone}
                            marks={[THRESHOLDS.memory.warn, THRESHOLDS.memory.critical]}
                            label={t('status.memory.title')}
                            valueText={`${percent(memory.usagePercent)} (${limitsText(THRESHOLDS.memory, language, t)})`}
                        />
                    )}
                </StatTile>

                {/* The fullest filesystem leads (it is what fills up and what the health counts); the total is the small print. */}
                <StatTile
                    icon={<HardDrive />}
                    label={t('status.storage.title')}
                    hint={t('status.storage.hint')}
                    tone={storageTone}
                    value={storageView ? percentParts(storageView.usagePercent, language).value : unavailable}
                    unit={storageView ? '%' : undefined}
                    aside={storageView && (
                        <>
                            {/* A chip, so a bare "/" reads as the mount and not as a separator. */}
                            {storageView.mount !== null && (
                                <span className="mr-1.5 rounded bg-white/[0.06] px-1 py-px font-mono text-[11px] text-zinc-200">{storageView.mount}</span>
                            )}
                            {t('status.storage.used', { used: formatGB(storageView.usedGB, language), total: formatGB(storageView.totalGB, language) })}
                        </>
                    )}
                    footer={storageView && (storageView.total
                        ? t('status.storage.total', {
                            count: storageView.total.count,
                            used: formatGB(storageView.total.usedGB, language),
                            total: formatGB(storageView.total.totalGB, language)
                        })
                        : t('status.storage.free', { free: formatGB(storageView.freeGB, language) }))}
                    className={load ? undefined : KPI_WIDE}
                >
                    {storageView && (
                        <Meter
                            value={storageView.usagePercent}
                            tone={storageTone}
                            marks={[THRESHOLDS.disk.warn, THRESHOLDS.disk.critical]}
                            label={storageView.mount !== null ? t('status.storage.fullest', { mount: storageView.mount }) : t('status.storage.title')}
                            valueText={`${percent(storageView.usagePercent)} (${limitsText(THRESHOLDS.disk, language, t)})`}
                        />
                    )}
                </StatTile>

                {load && <LoadTile load={load} cores={cpu?.cores ?? null} />}
            </div>

            <div className={CHART_GRID}>
                <ChartCard
                    title={t('status.chart.cpu')}
                    icon={<Cpu />}
                    stats={statsText(cpuSeries.values[0])}
                    series={[{ id: 'cpu', label: t('status.cpu.title'), color: viz.series1(), values: cpuSeries.values[0] }]}
                    times={cpuSeries.times}
                    yMax={100}
                    yTicks={PERCENT_TICKS}
                    formatValue={percent}
                    formatTick={percentTick}
                    description={chartDescription(t('status.cpu.title'), cpuSeries.values[0], percent, t)}
                    emptyText={cpu ? t('status.chart.collecting') : t('status.unavailable')}
                    {...chartTimes}
                />
                <ChartCard
                    title={t('status.chart.memory')}
                    icon={<MemoryStick />}
                    stats={statsText(memorySeries.values[0])}
                    series={[{ id: 'memory', label: t('status.memory.title'), color: viz.series1(), values: memorySeries.values[0] }]}
                    times={memorySeries.times}
                    yMax={100}
                    yTicks={PERCENT_TICKS}
                    formatValue={percent}
                    formatTick={percentTick}
                    description={chartDescription(t('status.memory.title'), memorySeries.values[0], percent, t)}
                    emptyText={memory ? t('status.chart.collecting') : t('status.unavailable')}
                    {...chartTimes}
                />
                <ChartCard
                    className={CHART_WIDE}
                    title={t('status.chart.network')}
                    icon={<Network />}
                    current={network ? { rx: rate(network.rxBytesPerSec), tx: rate(network.txBytesPerSec) } : undefined}
                    series={[
                        { id: 'rx', label: t('status.network.rx'), color: viz.series1(), values: networkSeries.values[0] },
                        { id: 'tx', label: t('status.network.tx'), color: viz.series2(), values: networkSeries.values[1] }
                    ]}
                    times={networkSeries.times}
                    yMax={rateScale.max}
                    yTicks={rateScale.ticks}
                    formatValue={rate}
                    formatTick={rateTick}
                    description={[
                        chartDescription(t('status.network.rx'), networkSeries.values[0], rate, t),
                        chartDescription(t('status.network.tx'), networkSeries.values[1], rate, t)
                    ].join('. ')}
                    emptyText={network ? t('status.chart.collecting') : t('status.unavailable')}
                    {...chartTimes}
                />
            </div>

            <div className={DETAIL_GRID}>
                <Card
                    title={t('status.processes.title')}
                    icon={<ListOrdered />}
                    subtitle={cpu?.cores && cpu.cores > 1
                        ? t('status.processes.cpuHintShare', { seconds: formatSeconds(snapshot.sampleSeconds, language), count: cpu.cores })
                        : t('status.processes.cpuHint', { seconds: formatSeconds(snapshot.sampleSeconds, language) })}
                >
                    <ProcessTable processes={snapshot.processes} cores={cpu?.cores ?? null} />
                </Card>

                <div className="flex min-w-0 flex-col gap-3">
                    <Card title={t('status.storage.filesystems')} icon={<HardDrive />} subtitle={limitsText(THRESHOLDS.disk, language, t)}>
                        <DiskList disks={snapshot.disks} serverId={serverId} />
                    </Card>

                    {network && network.interfaces.length > 0 && (
                        <Card title={t('status.network.interfaces')} icon={<Network />}>
                            <table className="w-full table-fixed text-xs">
                                <caption className="sr-only">{t('status.network.interfaces')}</caption>
                                <thead>
                                    <tr className="border-b border-white/[0.06] text-left text-zinc-500">
                                        <th scope="col" className="pb-1.5 font-medium">{t('status.network.interface')}</th>
                                        <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                                            <span className="inline-flex items-center gap-1"><ArrowDown className="h-3 w-3" aria-hidden="true" />{t('status.network.rx')}</span>
                                        </th>
                                        <th scope="col" className="pb-1.5 pl-3 text-right font-medium">
                                            <span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3" aria-hidden="true" />{t('status.network.tx')}</span>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody className="divide-y divide-white/[0.04]">
                                    {network.interfaces.map((entry) => (
                                        <tr key={entry.name}>
                                            <td className="truncate py-1.5 font-mono text-[12px] text-zinc-200" title={entry.name}>{entry.name}</td>
                                            <td className="py-1.5 pl-3 text-right tabular-nums text-zinc-300">{rate(entry.rxBytesPerSec)}</td>
                                            <td className="py-1.5 pl-3 text-right tabular-nums text-zinc-300">{rate(entry.txBytesPerSec)}</td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </Card>
                    )}
                </div>
            </div>
        </>
    );
}

function Dashboard({ server, isActive }: StatusDashboardProps) {
    const t = useT();
    const language = useLanguage();
    const theme = useResolvedTheme();
    const pageVisible = usePageVisible();
    const polling = isActive && pageVisible;
    const now = useNow(1000, polling);

    const fetcher = useCallback(
        (signal: AbortSignal) => api.get<StatusSnapshot>(`/api/servers/${server.id}/status`, { signal }),
        [server.id]
    );
    // Rejected credentials, a changed host key or a connection that cannot be
    // used as saved are not retried by themselves (the fleet board holds on
    // them too): another attempt would only repeat them, and repeated failed
    // logins can lock the account or trip fail2ban. Retry asks again.
    const poll = usePolling({ fetcher, enabled: polling, intervalMs: POLL_INTERVAL_MS, stopOn: needsSomeone });
    const [history, setHistory] = useState<StatusSample[]>([]);
    const snapshot = poll.data;

    useEffect(() => {
        if (snapshot) setHistory((previous) => appendSample(previous, snapshot, HISTORY_LENGTH));
    }, [snapshot]);

    // A refresh the user asked for: only that one spins the button. It ends
    // with the request it started (or the one already running when clicked).
    const [manualRefresh, setManualRefresh] = useState(false);
    if (manualRefresh && !poll.loading) setManualRefresh(false);

    const stale = Boolean(poll.lastSuccess && (poll.error || now - poll.lastSuccess > STALE_AFTER_MS));
    const failure = poll.error ? describeError(poll.error, t) : null;
    // Against the clock of this render, not `now` (up to a second old, which read one second more than the delay scheduled).
    const retryText = failure && poll.nextAt && polling ? t('status.retryIn', { seconds: Math.max(1, Math.ceil((poll.nextAt - Date.now()) / 1000)) }) : null;
    const staleSince = poll.lastSuccess ? formatClock(poll.lastSuccess, language) : undefined;
    const staleHint = staleSince ? t('status.state.staleHint', { time: staleSince }) : undefined;

    let liveState: LiveState = 'live';
    if (!polling) liveState = 'paused';
    else if (stale) liveState = 'stale';
    else if (poll.error) liveState = 'error';

    const refresh = () => {
        if (!polling) return;
        setManualRefresh(true);
        poll.refresh();
    };
    const health = snapshot ? assessHealth(snapshot) : null;

    return (
        <div data-status-scroll className="absolute inset-0 overflow-y-auto bg-ink-900 [container-type:inline-size]" style={vizStyle(theme)}>
            <div className="mx-auto flex max-w-[96rem] flex-col gap-4 p-4 [@container(min-width:40rem)]:px-6 [@container(min-width:40rem)]:py-5">
                <header className="flex min-w-0 flex-col gap-2">
                    <div className="flex items-start justify-between gap-x-4">
                        {/* In a narrow panel the verdict wraps under the name instead of cutting both short. */}
                        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
                            <h2 className="min-w-0 max-w-full truncate text-lg font-semibold tracking-tight text-zinc-50">{server.name}</h2>
                            {health && <HealthBadge health={health} staleSince={stale ? staleSince : undefined} />}
                        </div>
                        <StatusAiActions serverId={server.id} />
                        <LiveIndicator
                            state={liveState}
                            hint={liveState === 'paused' ? t('status.state.pausedHint') : liveState === 'stale' ? staleHint : undefined}
                            lastSuccess={poll.lastSuccess}
                            now={now}
                            busy={manualRefresh && poll.loading}
                            canRefresh={polling}
                            onRefresh={refresh}
                        />
                    </div>
                    {snapshot ? (
                        // What the last answer said: dimmed with the values once it is out of date.
                        <div data-stale={stale || undefined} className={cn('flex min-w-0 flex-col gap-2 motion-safe:transition-opacity motion-safe:duration-300', stale && STALE_DIM)}>
                            {health && health.issues.length > 0 && <HealthIssues health={health} />}
                            <HostFacts snapshot={snapshot} />
                            {snapshot.limited && <p className="text-xs text-amber-200/90">{t('status.limitedWindows')}</p>}
                        </div>
                    ) : !failure && <p className="text-xs text-zinc-500">{t('status.loading')}</p>}
                </header>

                <div aria-live="polite" className="sr-only">
                    {stale ? staleHint : ''}
                </div>

                {!snapshot ? (
                    failure ? <LoadError failure={failure} retryText={retryText} onRetry={refresh} /> : <StatusSkeleton />
                ) : (
                    <>
                        <div data-stale={stale || undefined} className={cn('flex flex-col gap-4 motion-safe:transition-opacity motion-safe:duration-300', stale && STALE_DIM)}>
                            <Metrics snapshot={snapshot} history={history} serverId={server.id} />
                            <p className="text-[11px] text-zinc-500">
                                {t('status.footnote', { seconds: POLL_INTERVAL_MS / 1000 })}
                            </p>
                        </div>
                        {failure && <RefreshErrorBar failure={failure} retryText={retryText} onRetry={refresh} />}
                    </>
                )}
            </div>
        </div>
    );
}

// Keyed by server: nothing (data, history, a request in flight) carries over
// from one server to the next.
export default function StatusDashboard(props: StatusDashboardProps) {
    return <Dashboard key={props.server.id} {...props} />;
}
