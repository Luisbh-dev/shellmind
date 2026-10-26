import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import { useElementWidth } from '@/lib/useElementWidth';
import { nearestIndex, segmentsOf, type Point } from './history';
import { viz } from './vizTheme';

// A time-series chart in plain SVG over a fixed time window: hairline grid
// with labelled ticks, the window's start and end times underneath, 2px
// lines (a soft wash under a single series), an end dot ringed with the card
// surface, and a crosshair that snaps to the nearest sample with every
// series' value in one tooltip. The plot is a keyboard control too (arrows,
// Home/End), announced as "time: values"; screen readers also get a one-line
// summary. Nothing in it animates.

export type ChartSeries = {
    id: string;
    label: string;
    // A CSS colour (theme variables included: it is set as a style).
    color: string;
    values: Array<number | null>;
};

type TimeSeriesChartProps = {
    series: ChartSeries[];
    // Sample times (epoch ms), aligned with each series' values, oldest first.
    times: number[];
    // The window shown (epoch ms).
    start: number;
    end: number;
    yMax: number;
    yTicks: number[];
    // Longer pauses between two samples leave a gap in the line.
    maxGapMs: number;
    formatValue: (value: number) => string;
    formatTick: (value: number) => string;
    formatTime: (time: number) => string;
    formatAxisTime: (time: number) => string;
    // Accessible name and summary.
    label: string;
    description: string;
    // Shown while no sample falls in the window.
    emptyText: string;
    // Height of the plot; the time axis band is added below it.
    height?: number;
    // Text for a sample without a value.
    missingText?: string;
};

const TOP = 6;
const RIGHT = 6;
const AXIS_BAND = 18;
const TICK_GAP = 8;
// Width of one 10px tabular character, to size the tick label gutter.
const CHAR_WIDTH = 6.2;

export function TimeSeriesChart({
    series, times, start, end, yMax, yTicks, maxGapMs, formatValue, formatTick, formatTime, formatAxisTime,
    label, description, emptyText, height = 104, missingText = '—'
}: TimeSeriesChartProps) {
    const [ref, width] = useElementWidth<HTMLDivElement>(320);
    const [activeTime, setActiveTime] = useState<number | null>(null);
    const descriptionId = useId();
    const gradientId = useId();

    const tickLabels = yTicks.map((tick) => formatTick(tick));
    const gutter = Math.ceil(Math.max(...tickLabels.map((text) => text.length), 1) * CHAR_WIDTH) + TICK_GAP;
    const plotLeft = gutter;
    const plotRight = Math.max(plotLeft + 1, width - RIGHT);
    const plotWidth = plotRight - plotLeft;
    const plotBottom = TOP + height;
    const span = Math.max(1, end - start);
    const x = (time: number) => plotLeft + ((time - start) / span) * plotWidth;
    const y = (value: number) => plotBottom - (Math.min(Math.max(value, 0), yMax) / Math.max(yMax, Number.EPSILON)) * height;
    const line = (points: Point[]) => points.map((point, index) => `${index ? 'L' : 'M'}${x(point.time).toFixed(1)},${y(point.value).toFixed(1)}`).join('');

    const count = times.length;
    const lastTime = count ? times[count - 1] : null;
    const activeIndex = activeTime === null || !count ? -1 : nearestIndex(times, activeTime);
    const single = series.length === 1;

    const readout = (index: number) => {
        const values = series.map((entry) => {
            const value = entry.values[index];
            return `${entry.label} ${value === null || value === undefined ? missingText : formatValue(value)}`;
        });
        return `${formatTime(times[index])}: ${values.join(', ')}`;
    };

    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!count) return;
        const box = event.currentTarget.getBoundingClientRect();
        const ratio = (event.clientX - box.left - plotLeft) / plotWidth;
        setActiveTime(times[nearestIndex(times, start + Math.min(1, Math.max(0, ratio)) * span)]);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        if (!count) return;
        const current = activeIndex < 0 ? count - 1 : activeIndex;
        const target = {
            ArrowLeft: current - 1,
            ArrowDown: current - 1,
            ArrowRight: current + 1,
            ArrowUp: current + 1,
            PageDown: current - 10,
            PageUp: current + 10,
            Home: 0,
            End: count - 1
        }[event.key];
        if (event.key === 'Escape') {
            setActiveTime(null);
            return;
        }
        if (target === undefined) return;
        event.preventDefault();
        setActiveTime(times[Math.min(count - 1, Math.max(0, target))]);
    };

    const activeX = activeIndex >= 0 ? x(times[activeIndex]) : 0;
    const svgHeight = plotBottom + AXIS_BAND;

    return (
        <div ref={ref} className="relative w-full" style={{ height: svgHeight }}>
            <p id={descriptionId} className="sr-only">{description}</p>
            {count === 0 ? (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-white/[0.08] text-xs text-zinc-500">
                    {emptyText}
                </div>
            ) : (
                <div
                    role="slider"
                    tabIndex={0}
                    aria-label={label}
                    aria-describedby={descriptionId}
                    aria-valuemin={1}
                    aria-valuemax={count}
                    aria-valuenow={(activeIndex < 0 ? count - 1 : activeIndex) + 1}
                    aria-valuetext={readout(activeIndex < 0 ? count - 1 : activeIndex)}
                    // Horizontal drags scrub the chart; vertical ones still scroll the page. The focus
                    // ring stands off the box, clear of the tick labels at its edges.
                    className="h-full w-full cursor-crosshair touch-pan-y rounded-md outline-none focus-visible:ring-2 focus-visible:ring-brand-400/55 focus-visible:ring-offset-[3px] focus-visible:ring-offset-ink-800"
                    onPointerMove={onPointerMove}
                    onPointerLeave={() => setActiveTime(null)}
                    onFocus={() => setActiveTime((current) => current ?? lastTime)}
                    onBlur={() => setActiveTime(null)}
                    onKeyDown={onKeyDown}
                >
                    {width > 0 && (
                        <svg width={width} height={svgHeight} aria-hidden="true" className="block overflow-visible">
                            {single && (
                                <defs>
                                    <linearGradient id={gradientId} x1="0" x2="0" y1="0" y2="1">
                                        <stop offset="0%" style={{ stopColor: series[0].color, stopOpacity: 0.18 }} />
                                        <stop offset="100%" style={{ stopColor: series[0].color, stopOpacity: 0.02 }} />
                                    </linearGradient>
                                </defs>
                            )}
                            {yTicks.map((tick, index) => (
                                <g key={tick}>
                                    <line
                                        x1={plotLeft}
                                        x2={plotRight}
                                        y1={Math.round(y(tick)) + 0.5}
                                        y2={Math.round(y(tick)) + 0.5}
                                        className={tick === 0 ? 'stroke-zinc-700' : 'stroke-zinc-800'}
                                        strokeWidth={1}
                                        shapeRendering="crispEdges"
                                    />
                                    <text
                                        x={plotLeft - TICK_GAP}
                                        y={y(tick)}
                                        textAnchor="end"
                                        dominantBaseline="middle"
                                        className="fill-zinc-500 text-[10px] tabular-nums"
                                    >
                                        {tickLabels[index]}
                                    </text>
                                </g>
                            ))}
                            <text x={plotLeft} y={plotBottom + 13} textAnchor="start" className="fill-zinc-500 text-[10px] tabular-nums">{formatAxisTime(start)}</text>
                            <text x={plotRight} y={plotBottom + 13} textAnchor="end" className="fill-zinc-500 text-[10px] tabular-nums">{formatAxisTime(end)}</text>

                            {series.map((entry) => {
                                const segments = segmentsOf(times, entry.values, maxGapMs);
                                return (
                                    <g key={entry.id} data-series={entry.id}>
                                        {segments.map((points) => points.length > 1 ? (
                                            <g key={points[0].time}>
                                                {single && (
                                                    <path
                                                        d={`${line(points)}L${x(points[points.length - 1].time).toFixed(1)},${plotBottom}L${x(points[0].time).toFixed(1)},${plotBottom}Z`}
                                                        fill={`url(#${gradientId})`}
                                                    />
                                                )}
                                                <path d={line(points)} fill="none" style={{ stroke: entry.color }} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
                                            </g>
                                        ) : (
                                            <circle key={points[0].time} cx={x(points[0].time)} cy={y(points[0].value)} r={2} style={{ fill: entry.color }} />
                                        ))}
                                    </g>
                                );
                            })}

                            {activeIndex >= 0 && (
                                <line x1={activeX} x2={activeX} y1={TOP} y2={plotBottom} className="stroke-zinc-500" strokeWidth={1} />
                            )}
                            {series.map((entry) => {
                                const index = activeIndex >= 0 ? activeIndex : count - 1;
                                const value = entry.values[index];
                                if (value === null || value === undefined) return null;
                                return (
                                    <circle
                                        key={entry.id}
                                        data-marker={entry.id}
                                        cx={x(times[index])}
                                        cy={y(value)}
                                        r={4}
                                        style={{ fill: entry.color, stroke: viz.surface }}
                                        strokeWidth={2}
                                    />
                                );
                            })}
                        </svg>
                    )}
                </div>
            )}
            {activeIndex >= 0 && (
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute top-0 z-10 min-w-[7rem] whitespace-nowrap rounded-lg border border-white/10 bg-ink-700 px-2.5 py-1.5 text-[11px] shadow-panel"
                    style={activeX > plotLeft + plotWidth / 2 ? { right: Math.max(0, width - activeX + 10) } : { left: activeX + 10 }}
                >
                    <div className="mb-0.5 tabular-nums text-zinc-400">{formatTime(times[activeIndex])}</div>
                    {series.map((entry) => {
                        const value = entry.values[activeIndex];
                        return (
                            <div key={entry.id} className="flex items-center gap-2">
                                <span className="inline-block h-0.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: entry.color }} />
                                <span className="font-semibold tabular-nums text-zinc-100">{value === null || value === undefined ? missingText : formatValue(value)}</span>
                                <span className="text-zinc-400">{entry.label}</span>
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
}
