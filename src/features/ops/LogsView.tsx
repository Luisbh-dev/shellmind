import { useCallback, useEffect, useId, useMemo, useRef, useState, type FormEvent } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDownToLine, Download, Eraser, Pause, Play, Regex, ScrollText, Square } from 'lucide-react';
import {
    isValidComposeName,
    isValidContainerRef,
    isValidLogPath,
    isValidServiceName,
    normalizeUnitName,
    type LogStreamSource,
    type OpsCapabilities
} from '@shared/ops';
import { AskAiButton } from '@/components/AskAiButton';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { saveText } from '@/lib/download';
import { formatBytes } from '@/lib/format';
import { describeCode } from '@/lib/remoteErrors';
import { allLines, compileFilter } from './logBuffer';
import { EmptyState, SearchField, Segmented, StateBadge, ToolButton, type BadgeTone } from './ui';
import { useLogStream, type StreamStatus } from './useLogStream';
import type { LogRequest } from './viewTypes';

type Kind = LogStreamSource['kind'];

const MAX_LINE_OPTIONS = [1000, 5000, 20000] as const;
const LINE_HEIGHT = 18;

// "project" or "project/service" (a Compose source as typed).
const COMPOSE_INPUT = /^([^/\s]+)(?:\/([^/\s]+))?$/;

type LogsViewProps = {
    serverId: number;
    serverName: string;
    caps: OpsCapabilities;
    // A stream asked for by the services or containers view.
    request: LogRequest | null;
};

const STATUS_TONE: Record<StreamStatus, BadgeTone> = { idle: 'idle', connecting: 'warn', streaming: 'ok', ended: 'idle', error: 'bad' };

function sourceValue(source: LogStreamSource): string {
    if (source.kind === 'journal') return source.unit ?? '';
    if (source.kind === 'file') return source.path;
    if (source.kind === 'compose') return source.service ? `${source.project}/${source.service}` : source.project;
    return source.container;
}

export function LogsView({ serverId, serverName, caps, request }: LogsViewProps) {
    const t = useT();
    const language = useLanguage();
    const windows = caps.platform === 'windows';
    const engine = Boolean(caps.containers.engine);
    const kinds: Kind[] = [
        ...(caps.journal ? ['journal' as const] : []),
        'file',
        ...(engine ? ['container' as const] : []),
        ...(engine && !windows ? ['compose' as const] : [])
    ];
    const [kind, setKind] = useState<Kind>(kinds[0]);
    const [value, setValue] = useState('');
    const [invalid, setInvalid] = useState<string | null>(null);
    const [maxLines, setMaxLines] = useState<number>(5000);
    const [filterText, setFilterText] = useState('');
    const [regex, setRegex] = useState(false);
    const [follow, setFollow] = useState(true);
    const stream = useLogStream(serverId, maxLines);
    const inputId = useId();
    const errorId = useId();
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const lastSourceRef = useRef<string | null>(null);
    const { start } = stream;

    // A filter typed for one log rarely fits another: it is cleared when the source changes.
    const begin = useCallback((source: LogStreamSource) => {
        const key = JSON.stringify(source);
        if (key !== lastSourceRef.current) setFilterText('');
        lastSourceRef.current = key;
        setInvalid(null);
        setFollow(true);
        start(source);
    }, [start]);

    useEffect(() => {
        if (!request) return;
        setKind(request.source.kind);
        setValue(sourceValue(request.source));
        begin(request.source);
    }, [request, begin]);

    const lines = useMemo(() => allLines(stream.buffer), [stream.buffer]);
    const filter = useMemo(() => compileFilter(filterText, regex), [filterText, regex]);
    const shown = useMemo(() => (filterText.trim() ? lines.filter(filter.test) : lines), [lines, filter, filterText]);

    const virtualizer = useVirtualizer({
        count: shown.length,
        getScrollElement: () => scrollRef.current,
        estimateSize: () => LINE_HEIGHT,
        overscan: 20
    });

    useEffect(() => {
        if (follow && shown.length) virtualizer.scrollToIndex(shown.length - 1, { align: 'end' });
    }, [follow, shown.length, virtualizer]);

    const onScroll = () => {
        const element = scrollRef.current;
        if (!element) return;
        const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < LINE_HEIGHT * 2;
        if (!atBottom && follow) setFollow(false);
    };

    const placeholder = kind === 'file'
        ? (windows ? t('ops.logs.placeholder.fileWindows') : t('ops.logs.placeholder.file'))
        : t(`ops.logs.placeholder.${kind}`);

    const buildSource = (): LogStreamSource | null => {
        const text = value.trim();
        if (kind === 'journal') {
            if (!text) return { kind: 'journal' };
            const unit = normalizeUnitName(text);
            return isValidServiceName('linux', unit) ? { kind: 'journal', unit } : null;
        }
        if (kind === 'file') return isValidLogPath(caps.platform, text) ? { kind: 'file', path: text } : null;
        if (kind === 'compose') {
            const match = COMPOSE_INPUT.exec(text);
            if (!match || !isValidComposeName(match[1]) || (match[2] && !isValidComposeName(match[2]))) return null;
            return match[2] ? { kind: 'compose', project: match[1], service: match[2] } : { kind: 'compose', project: match[1] };
        }
        return isValidContainerRef(text) ? { kind: 'container', container: text } : null;
    };

    const onSubmit = (event: FormEvent) => {
        event.preventDefault();
        const source = buildSource();
        if (!source) {
            setInvalid(t(kind === 'file' && windows ? 'ops.logs.invalid.fileWindows' : `ops.logs.invalid.${kind}`));
            return;
        }
        begin(source);
    };

    const download = () => {
        const label = stream.source ? sourceValue(stream.source) || stream.source.kind : 'logs';
        const name = `${serverName}-${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.log`.replace(/[^\w.-]+/g, '_');
        saveText(name, `${lines.join('\n')}\n`, 'text/plain;charset=utf-8');
    };

    const running = stream.status === 'connecting' || stream.status === 'streaming';
    const streamError = stream.error && describeCode(stream.error.code === 'BACKEND' ? null : stream.error.code, stream.error.message || t('ops.logs.backendLost'), t, stream.error.connection);
    const statusLabel = stream.status === 'ended' && stream.exitCode !== null
        ? t('ops.logs.status.endedCode', { code: stream.exitCode })
        : t(`ops.logs.status.${stream.status}`);

    return (
        <div className="flex h-full min-h-0 flex-col">
            <form onSubmit={onSubmit} className="flex flex-wrap items-start gap-2 border-b border-white/[0.06] px-4 py-2.5" aria-label={t('ops.logs.formLabel')}>
                <Segmented<Kind>
                    label={t('ops.logs.kindLabel')}
                    value={kind}
                    onChange={(next) => {
                        setKind(next);
                        setInvalid(null);
                    }}
                    options={kinds.map((option) => ({ value: option, label: t(`ops.logs.kind.${option}`) }))}
                />
                <div className="min-w-[12rem] flex-1">
                    <label htmlFor={inputId} className="sr-only">{t(`ops.logs.inputLabel.${kind}`)}</label>
                    <input
                        id={inputId}
                        value={value}
                        onChange={(event) => setValue(event.target.value)}
                        placeholder={placeholder}
                        spellCheck={false}
                        autoComplete="off"
                        aria-invalid={invalid ? true : undefined}
                        aria-describedby={invalid ? errorId : undefined}
                        className={cn(
                            'h-8 w-full rounded-lg border bg-ink-900/70 px-3 font-mono text-xs text-zinc-100 placeholder:text-zinc-500 outline-none focus:border-brand-500/70',
                            invalid ? 'border-rose-500/60' : 'border-white/10'
                        )}
                    />
                    {invalid && <p id={errorId} className="mt-1 text-[11px] text-rose-300">{invalid}</p>}
                </div>
                <button
                    type="submit"
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-brand-500/40 bg-brand-500/15 px-3 text-xs font-medium text-brand-100 hover:bg-brand-500/25 focus-ring"
                >
                    <Play className="h-3.5 w-3.5" aria-hidden="true" />
                    {running ? t('ops.logs.restart') : t('ops.logs.start')}
                </button>
                {running && (
                    <ToolButton icon={<Square className="h-3.5 w-3.5" />} label={t('ops.logs.stop')} tone="danger" onClick={stream.stop} />
                )}
            </form>

            {stream.status === 'idle' ? (
                <EmptyState icon={<ScrollText className="h-5 w-5" />} title={t('ops.logs.emptyTitle')} detail={t('ops.logs.emptyHint')} />
            ) : (
                <>
                    <div className="flex flex-wrap items-center gap-2 border-b border-white/[0.06] px-4 py-2">
                        <StateBadge tone={STATUS_TONE[stream.status]} label={statusLabel} />
                        <span className="text-[11px] tabular-nums text-zinc-500" aria-live="off">
                            {filterText.trim()
                                ? t('ops.logs.countFiltered', { shown: shown.length, total: lines.length })
                                : lines.length === 1 ? t('ops.logs.countOne') : t('ops.logs.count', { count: lines.length })}
                        </span>
                        {/* The minimum width makes the toolbar wrap before the filter becomes too narrow to use. */}
                        <SearchField value={filterText} onChange={setFilterText} label={t('ops.logs.filter')} className="w-full min-w-[10rem] max-w-[16rem] flex-1" />
                        <ToolButton compact icon={<Regex className="h-4 w-4" />} label={t('ops.logs.regex')} pressed={regex} onClick={() => setRegex((on) => !on)} />
                        <div className="ml-auto flex flex-wrap items-center gap-1.5">
                            <ToolButton
                                icon={stream.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
                                label={stream.paused ? t('ops.logs.resume') : t('ops.logs.pause')}
                                pressed={stream.paused}
                                onClick={() => stream.setPaused(!stream.paused)}
                            />
                            <ToolButton
                                compact
                                icon={<ArrowDownToLine className="h-4 w-4" />}
                                label={t('ops.logs.follow')}
                                pressed={follow}
                                onClick={() => setFollow((on) => !on)}
                            />
                            <ToolButton compact icon={<Eraser className="h-4 w-4" />} label={t('ops.logs.clear')} onClick={stream.clear} />
                            <ToolButton compact icon={<Download className="h-4 w-4" />} label={t('ops.logs.download')} onClick={download} disabled={lines.length === 0} />
                            {/* A Compose project's logs have no diagnose evidence of their own: ask from its containers. */}
                            {stream.source && stream.source.kind !== 'compose' && stream.source.kind !== 'pod' && (
                                <AskAiButton serverId={serverId} attachment={{ kind: 'logs', source: stream.source }} size="md" excerptFrom={() => scrollRef.current} className="border border-white/10 bg-white/[0.03] text-brand-200" />
                            )}
                            <Segmented<string>
                                label={t('ops.logs.maxLines')}
                                value={String(maxLines)}
                                onChange={(next) => setMaxLines(Number(next))}
                                options={MAX_LINE_OPTIONS.map((option) => ({ value: String(option), label: t('ops.logs.maxLinesOption', { count: option / 1000 }) }))}
                            />
                        </div>
                    </div>

                    {(filter.error || stream.paused || stream.droppedBytes > 0 || stream.buffer.discarded > 0) && (
                        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b border-white/[0.06] bg-white/[0.02] px-4 py-1.5 text-[11px] text-zinc-400" role="status">
                            {filter.error && <span className="text-amber-300">{t('ops.logs.badRegex')}</span>}
                            {stream.paused && <span>{t('ops.logs.pausedCount', { count: stream.pending })}</span>}
                            {stream.buffer.discarded > 0 && <span>{t('ops.logs.discarded', { count: stream.buffer.discarded })}</span>}
                            {stream.droppedBytes > 0 && <span className="text-amber-300">{t('ops.logs.dropped', { size: formatBytes(stream.droppedBytes, language) })}</span>}
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
                        aria-label={t('ops.logs.outputLabel')}
                        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the output scrolls with the keyboard
                        tabIndex={0}
                        className="min-h-0 flex-1 overflow-auto bg-black/30 font-mono text-[12px] leading-[18px] text-zinc-300 focus-ring"
                    >
                        {shown.length === 0 ? (
                            <p className="px-4 py-3 font-sans text-xs text-zinc-500">
                                {running ? t('ops.logs.waiting') : t('ops.logs.noLines')}
                            </p>
                        ) : (
                            <div className="relative w-max min-w-full" style={{ height: virtualizer.getTotalSize() }}>
                                {virtualizer.getVirtualItems().map((item) => (
                                    <div
                                        key={item.key}
                                        data-excerpt-line=""
                                        className="absolute left-0 top-0 whitespace-pre px-4"
                                        style={{ height: LINE_HEIGHT, transform: `translateY(${item.start}px)` }}
                                    >
                                        {shown[item.index] || ' '}
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
