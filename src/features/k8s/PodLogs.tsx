import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Clock, Download, Eraser, History, Pause, Play, Radio, Square } from 'lucide-react';
import { pickPodContainer, POD_LOG_TAIL_OPTIONS, type K8sPod, type K8sPodDetail, type PodLogSource } from '@shared/k8s';
import { AskAiButton } from '@/components/AskAiButton';
import { Select } from '@/components/ui';
import { allLines, compileFilter } from '@/features/ops/logBuffer';
import { SearchField, Segmented, StateBadge, ToolButton, type BadgeTone } from '@/features/ops/ui';
import { useLogStream, type StreamStatus } from '@/features/ops/useLogStream';
import { useLanguage, useT } from '@/i18n';
import { saveText } from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { describeK8sCode } from './errors';
import { plural } from './labels';
import { defaultLogContainer } from './model';

// A pod container's logs over the live log socket (kubectl logs): the
// container, the previous instance (after a crash), how much backlog, and
// whether to keep following. Any change starts the stream again.

const LINE_HEIGHT = 18;
const MAX_LINES = 20_000;
const STATUS_TONE: Record<StreamStatus, BadgeTone> = { idle: 'idle', connecting: 'warn', streaming: 'ok', ended: 'idle', error: 'bad' };

type PodLogsProps = {
    serverId: number;
    serverName: string;
    context: string;
    pod: K8sPod;
    detail: K8sPodDetail | null;
    active: boolean;
};

export function PodLogs({ serverId, serverName, context, pod, detail, active }: PodLogsProps) {
    const t = useT();
    const language = useLanguage();
    const containers = useMemo(() => [...(detail?.containers ?? []), ...(detail?.initContainers ?? [])], [detail]);
    const names = containers.length ? containers.map((container) => container.name) : pod.containers;
    // The container in trouble first, like the AI evidence (while the pod
    // initializes: the init container it waits for). Once the detail is
    // known the choice stays, until the user picks another one.
    const [picked, setPicked] = useState<string | null>(() => (detail ? pickPodContainer(detail)?.name ?? null : null));
    const suggested = (detail ? pickPodContainer(detail)?.name : null) ?? defaultLogContainer(pod);
    const container = picked ?? suggested ?? '';
    useEffect(() => {
        if (detail && !picked && suggested) setPicked(suggested);
    }, [detail, picked, suggested]);
    const [previous, setPrevious] = useState(false);
    const [tail, setTail] = useState<number>(POD_LOG_TAIL_OPTIONS[1]);
    const [follow, setFollow] = useState(true);
    const [timestamps, setTimestamps] = useState(true);
    const [filterText, setFilterText] = useState('');
    const [stick, setStick] = useState(true);
    const stream = useLogStream(serverId, MAX_LINES);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const { start } = stream;
    const current = containers.find((entry) => entry.name === container);
    const hasPrevious = Boolean(current?.lastState) || (current?.restarts ?? pod.restarts) > 0;

    const source: PodLogSource | null = container
        ? { kind: 'pod', context, namespace: pod.namespace, pod: pod.name, container, previous: previous && hasPrevious, tail, follow: follow && !previous, timestamps }
        : null;
    const sourceKey = JSON.stringify(source);

    // Starts once the tab is first shown, and again when an option changes.
    const [opened, setOpened] = useState(active);
    useEffect(() => {
        if (active) setOpened(true);
    }, [active]);
    useEffect(() => {
        if (!opened || !sourceKey || sourceKey === 'null') return;
        start(JSON.parse(sourceKey) as PodLogSource);
        setStick(true);
    }, [opened, sourceKey, start]);

    const lines = useMemo(() => allLines(stream.buffer), [stream.buffer]);
    const filter = useMemo(() => compileFilter(filterText, false), [filterText]);
    const shown = useMemo(() => (filterText.trim() ? lines.filter(filter.test) : lines), [lines, filter, filterText]);
    const virtualizer = useVirtualizer({ count: shown.length, getScrollElement: () => scrollRef.current, estimateSize: () => LINE_HEIGHT, overscan: 20 });

    useEffect(() => {
        if (stick && shown.length) virtualizer.scrollToIndex(shown.length - 1, { align: 'end' });
    }, [stick, shown.length, virtualizer]);

    const onScroll = () => {
        const element = scrollRef.current;
        if (!element) return;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < LINE_HEIGHT * 2;
        if (!atBottom && stick) setStick(false);
    };

    const download = () => {
        const name = `${serverName}-${pod.name}-${container}${previous ? '-previous' : ''}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`.replace(/[^\w.-]+/g, '_');
        saveText(name, `${lines.join('\n')}\n`, 'text/plain;charset=utf-8');
    };

    const running = stream.status === 'connecting' || stream.status === 'streaming';
    const streamError = stream.error && describeK8sCode(stream.error.code === 'BACKEND' ? null : stream.error.code, stream.error.message || t('k8s.logs.backendLost'), t);
    const statusLabel = stream.status === 'ended' && stream.exitCode !== null && stream.exitCode !== 0
        ? t('k8s.logs.status.endedCode', { code: stream.exitCode })
        : t(`k8s.logs.status.${stream.status}`);

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2">
                {names.length > 1 && (
                    <div className="w-40 min-w-0">
                        <Select
                            aria-label={t('k8s.logs.container')}
                            value={container}
                            onChange={setPicked}
                            options={names.map((name) => ({ value: name, label: name }))}
                            className="h-8 py-0 font-mono text-xs"
                        />
                    </div>
                )}
                <Segmented<string>
                    label={t('k8s.logs.tail')}
                    value={String(tail)}
                    onChange={(value) => setTail(Number(value))}
                    options={POD_LOG_TAIL_OPTIONS.map((option) => ({ value: String(option), label: option >= 1000 ? `${option / 1000}k` : String(option) }))}
                />
                <ToolButton
                    icon={<History className="h-3.5 w-3.5" />}
                    label={t('k8s.logs.previous')}
                    pressed={previous}
                    disabled={!hasPrevious}
                    disabledReason={t('k8s.logs.noPrevious')}
                    onClick={() => setPrevious((on) => !on)}
                />
                <ToolButton
                    icon={<Radio className="h-3.5 w-3.5" />}
                    label={t('k8s.logs.follow')}
                    pressed={follow && !previous}
                    disabled={previous}
                    disabledReason={t('k8s.logs.followPrevious')}
                    onClick={() => setFollow((on) => !on)}
                />
                <ToolButton compact icon={<Clock className="h-4 w-4" />} label={t('k8s.logs.timestamps')} pressed={timestamps} onClick={() => setTimestamps((on) => !on)} />
                <div className="ml-auto flex items-center gap-1.5">
                    {running ? (
                        <ToolButton icon={<Square className="h-3.5 w-3.5" />} label={t('k8s.logs.stop')} tone="danger" onClick={stream.stop} />
                    ) : (
                        <ToolButton icon={<Play className="h-3.5 w-3.5" />} label={t('k8s.logs.start')} tone="primary" disabled={!source} onClick={() => source && start(source)} />
                    )}
                </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2">
                <StateBadge tone={STATUS_TONE[stream.status]} label={statusLabel} />
                <span className="text-[11px] tabular-nums text-zinc-500">
                    {filterText.trim() ? t('k8s.logs.countFiltered', { shown: shown.length, total: lines.length }) : plural(t, 'k8s.logs.count', lines.length)}
                </span>
                <SearchField value={filterText} onChange={setFilterText} label={t('k8s.logs.filter')} className="w-full min-w-[9rem] max-w-[14rem] flex-1" />
                <div className="ml-auto flex flex-wrap items-center gap-1.5">
                    <ToolButton
                        compact
                        icon={stream.paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
                        label={stream.paused ? t('k8s.logs.resume') : t('k8s.logs.pause')}
                        pressed={stream.paused}
                        onClick={() => stream.setPaused(!stream.paused)}
                    />
                    <ToolButton compact icon={<ArrowDownToLine className="h-4 w-4" />} label={t('k8s.logs.stick')} pressed={stick} onClick={() => setStick((on) => !on)} />
                    <ToolButton compact icon={<Eraser className="h-4 w-4" />} label={t('k8s.logs.clear')} onClick={stream.clear} />
                    <ToolButton compact icon={<Download className="h-4 w-4" />} label={t('k8s.logs.download')} onClick={download} disabled={lines.length === 0} />
                    <AskAiButton
                        serverId={serverId}
                        attachment={{ kind: 'pod', context, namespace: pod.namespace, pod: pod.name, ...(container ? { container } : {}) }}
                        label={t('k8s.logs.askAi', { name: container })}
                        size="md"
                        className="border border-white/10 bg-white/[0.03] text-brand-200"
                    />
                </div>
            </div>
            {(stream.paused || stream.droppedBytes > 0 || stream.buffer.discarded > 0) && (
                <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-white/[0.06] bg-white/[0.02] px-4 py-1.5 text-[11px] text-zinc-400" role="status">
                    {stream.paused && <span>{t('k8s.logs.pausedCount', { count: stream.pending })}</span>}
                    {stream.buffer.discarded > 0 && <span>{t('k8s.logs.discarded', { count: stream.buffer.discarded })}</span>}
                    {stream.droppedBytes > 0 && <span className="text-amber-300">{t('k8s.logs.dropped', { size: formatBytes(stream.droppedBytes, language) })}</span>}
                </div>
            )}
            {streamError && (
                <div role="alert" className="border-b border-rose-500/20 bg-rose-500/[0.07] px-4 py-2 text-xs text-rose-100">
                    <span className="font-medium">{streamError.title}</span>
                    {streamError.detail && <span className="ml-2 text-rose-200/80">{streamError.detail}</span>}
                </div>
            )}
            <div
                ref={scrollRef}
                onScroll={onScroll}
                role="log"
                aria-live="off"
                aria-label={t('k8s.logs.outputLabel', { name: container })}
                // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the output scrolls with the keyboard
                tabIndex={0}
                className="min-h-0 flex-1 overflow-auto bg-black/30 font-mono text-[12px] leading-[18px] text-zinc-300 focus-ring"
            >
                {shown.length === 0 ? (
                    <p className="px-4 py-3 font-sans text-xs text-zinc-500">
                        {running ? t('k8s.logs.waiting') : stream.status === 'idle' ? t('k8s.logs.idle') : t('k8s.logs.noLines')}
                    </p>
                ) : (
                    <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
                        {virtualizer.getVirtualItems().map((item) => (
                            <div key={item.key} data-excerpt-line="" className="absolute left-0 top-0 whitespace-pre px-4" style={{ height: LINE_HEIGHT, transform: `translateY(${item.start}px)` }}>
                                {shown[item.index] || ' '}
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}
