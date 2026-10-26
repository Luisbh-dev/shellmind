import { useState, type ComponentProps, type ReactNode } from 'react';
import { LineChart, Table2 } from 'lucide-react';
import { IconButton } from '@/components/ui';
import { useT } from '@/i18n';
import { Card } from './Card';
import { TimeSeriesChart } from './TimeSeriesChart';

// A history chart in a card, with its table twin one click away (every value
// readable without hovering). Two or more series get a legend: a line key,
// the current value and the series name; one series is named by the title.
// The legend or the stats sit under the title (the time axis says which
// window), and the plot keeps to the bottom of the card, so the plots of a
// row line up even when one header wraps.

type ChartProps = ComponentProps<typeof TimeSeriesChart>;

type ChartCardProps = Omit<ChartProps, 'label'> & {
    title: string;
    icon: ReactNode;
    // One series: its average and peak over the window.
    stats?: string;
    // Current value per series, for the legend.
    current?: Record<string, string>;
    className?: string;
};

const CHART_HEIGHT = 104;

export function ChartCard({ title, icon, stats, current, className, height = CHART_HEIGHT, ...chart }: ChartCardProps) {
    const t = useT();
    const [asTable, setAsTable] = useState(false);
    const multi = chart.series.length > 1;

    const legend = multi ? (
        <ul className="flex flex-wrap items-center gap-x-3 gap-y-0.5">
            {chart.series.map((entry) => (
                <li key={entry.id} className="inline-flex items-center gap-1.5">
                    <span className="inline-block h-0.5 w-3 rounded-full" style={{ backgroundColor: entry.color }} aria-hidden="true" />
                    {current?.[entry.id] && <span className="font-semibold tabular-nums text-zinc-100">{current[entry.id]}</span>}
                    <span className="text-zinc-400">{entry.label}</span>
                </li>
            ))}
        </ul>
    ) : null;

    return (
        <Card
            title={title}
            icon={icon}
            // A blank line while there are no stats keeps the header as tall as its neighbours.
            subtitle={legend ?? <span className="tabular-nums text-zinc-400">{stats ?? <>&nbsp;</>}</span>}
            className={className}
            actions={(
                <IconButton
                    size="sm"
                    variant="ghost"
                    active={asTable}
                    // Named after its chart: three of these sit in the tab order.
                    label={asTable ? t('status.chart.showChart', { label: title }) : t('status.chart.showTable', { label: title })}
                    onClick={() => setAsTable((value) => !value)}
                    className="-my-1 -mr-1.5 h-6 w-6"
                >
                    {asTable ? <LineChart className="h-3.5 w-3.5" aria-hidden="true" /> : <Table2 className="h-3.5 w-3.5" aria-hidden="true" />}
                </IconButton>
            )}
        >
            <div className="mt-auto">
                {asTable ? (
                    <ChartTable title={title} series={chart.series} times={chart.times} formatValue={chart.formatValue} formatTime={chart.formatTime} height={height + 24} missingText={chart.missingText} />
                ) : (
                    <TimeSeriesChart {...chart} label={title} height={height} />
                )}
            </div>
        </Card>
    );
}

type ChartTableProps = Pick<ChartProps, 'series' | 'times' | 'formatValue' | 'formatTime' | 'missingText'> & { title: string; height: number };

function ChartTable({ title, series, times, formatValue, formatTime, height, missingText = '—' }: ChartTableProps) {
    const t = useT();
    const rows = times.map((time, index) => ({ time, index })).reverse();
    return (
        // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- the samples scroll with the keyboard
        <div role="region" className="overflow-y-auto rounded-md scrollbar-thin focus-ring" style={{ height }} tabIndex={0} aria-label={t('status.chart.tableCaption', { label: title })}>
            <table className="w-full text-[11px]">
                <caption className="sr-only">{t('status.chart.tableCaption', { label: title })}</caption>
                <thead className="sticky top-0 bg-ink-800">
                    <tr className="text-left text-zinc-500">
                        <th scope="col" className="py-1 pr-2 font-medium">{t('status.chart.time')}</th>
                        {series.map((entry) => (
                            <th key={entry.id} scope="col" className="py-1 pl-2 text-right font-medium">{entry.label}</th>
                        ))}
                    </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                    {rows.map(({ time, index }) => (
                        <tr key={time}>
                            <th scope="row" className="py-1 pr-2 text-left font-normal tabular-nums text-zinc-400">{formatTime(time)}</th>
                            {series.map((entry) => {
                                const value = entry.values[index];
                                return (
                                    <td key={entry.id} className="py-1 pl-2 text-right tabular-nums text-zinc-200">
                                        {value === null || value === undefined ? missingText : formatValue(value)}
                                    </td>
                                );
                            })}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}
