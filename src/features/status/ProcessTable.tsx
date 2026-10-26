import { useMemo, useState } from 'react';
import { ArrowUpDown, ChevronDown, ChevronUp } from 'lucide-react';
import type { StatusProcess } from '@shared/status';
import { useLanguage, useT } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatPercent } from '@/lib/format';
import { formatMB } from './format';
import { Meter } from './Meter';
import { DEFAULT_PROCESS_SORT, nextSort, sortProcesses, type ProcessSort, type ProcessSortKey } from './processes';

// The processes that used the most CPU during the sample, as a compact
// sortable table. CPU reads as a share of the whole machine, the bar and the
// number alike (one scale per cell, the same as the CPU tile); the per-core
// figure that top prints is in the cell's tooltip. Memory bars are a share
// of the total, so a busy process on a big host does not look like it fills it.

type Column = { key: ProcessSortKey; label: string; className: string; align: 'left' | 'right' };

export function ProcessTable({ processes, cores }: { processes: StatusProcess[]; cores: number | null }) {
    const t = useT();
    const language = useLanguage();
    const [sort, setSort] = useState<ProcessSort>(DEFAULT_PROCESS_SORT);
    const rows = useMemo(() => sortProcesses(processes, sort, language), [processes, sort, language]);
    const cpuCapacity = Math.max(1, cores ?? 1) * 100;

    if (!processes.length) return <p className="text-xs text-zinc-400">{t('status.processes.none')}</p>;

    const columns: Column[] = [
        { key: 'name', label: t('status.processes.name'), className: 'w-auto', align: 'left' },
        { key: 'pid', label: t('status.processes.pid'), className: 'hidden w-16 [@container(min-width:26rem)]:table-cell', align: 'right' },
        { key: 'cpu', label: t('status.processes.cpu'), className: 'w-[28%]', align: 'right' },
        { key: 'memory', label: t('status.processes.memory'), className: 'w-[28%]', align: 'right' }
    ];

    return (
        <div className="[container-type:inline-size]">
            <table className="w-full table-fixed text-xs">
                <caption className="sr-only">{t('status.processes.caption')}</caption>
                <thead>
                    <tr className="border-b border-white/[0.06]">
                        {columns.map((column) => {
                            const active = sort.key === column.key;
                            const SortIcon = !active ? ArrowUpDown : sort.direction === 'asc' ? ChevronUp : ChevronDown;
                            return (
                                <th
                                    key={column.key}
                                    scope="col"
                                    aria-sort={active ? (sort.direction === 'asc' ? 'ascending' : 'descending') : 'none'}
                                    className={cn('pb-1.5 font-medium', column.className, column.align === 'right' ? 'pl-3 text-right' : 'text-left')}
                                >
                                    <button
                                        type="button"
                                        onClick={() => setSort((current) => nextSort(current, column.key))}
                                        title={t('status.processes.sortBy', { column: column.label })}
                                        className={cn(
                                            'group inline-flex items-center gap-1 rounded px-1 py-0.5 -mx-1 transition-colors focus-ring',
                                            active ? 'text-zinc-200' : 'text-zinc-500 hover:text-zinc-300',
                                            column.align === 'right' && 'flex-row-reverse'
                                        )}
                                    >
                                        {column.label}
                                        <SortIcon className={cn('h-3 w-3', !active && 'opacity-50 group-hover:opacity-100')} aria-hidden="true" />
                                    </button>
                                </th>
                            );
                        })}
                    </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                    {rows.map((process) => {
                        const cpuShare = (process.cpuPercent / cpuCapacity) * 100;
                        const share = formatPercent(cpuShare, language);
                        return (
                            <tr key={`${process.pid}-${process.name}`} className="transition-colors hover:bg-white/[0.02]">
                                <td className="py-1.5 pr-2">
                                    <div className="truncate font-medium text-zinc-100" title={process.name}>{process.name}</div>
                                </td>
                                <td className="hidden py-1.5 pl-3 text-right font-mono text-[11px] tabular-nums text-zinc-500 [@container(min-width:26rem)]:table-cell">{process.pid}</td>
                                <td className="py-1.5 pl-3" title={t('status.processes.cpuPerCore', { value: formatPercent(process.cpuPercent, language) })}>
                                    <div className="flex items-center justify-end gap-2">
                                        <Meter
                                            size="sm"
                                            tone="ok"
                                            value={cpuShare}
                                            label={t('status.processes.cpu')}
                                            valueText={t('status.processes.cpuShare', { value: share })}
                                            className="hidden max-w-[6rem] [@container(min-width:22rem)]:block"
                                        />
                                        <span className="w-11 shrink-0 text-right tabular-nums text-zinc-200">{share}</span>
                                    </div>
                                </td>
                                <td className="py-1.5 pl-3">
                                    <div className="flex items-center justify-end gap-2">
                                        {process.memoryPercent !== null && (
                                            <Meter
                                                size="sm"
                                                tone="ok"
                                                value={process.memoryPercent}
                                                label={t('status.processes.memory')}
                                                valueText={t('status.processes.memoryShare', { value: formatPercent(process.memoryPercent, language) })}
                                                className="hidden max-w-[6rem] [@container(min-width:22rem)]:block"
                                            />
                                        )}
                                        <span className="w-14 shrink-0 text-right tabular-nums text-zinc-200">
                                            {process.memoryMB !== null ? formatMB(process.memoryMB, language) : '—'}
                                        </span>
                                    </div>
                                </td>
                            </tr>
                        );
                    })}
                </tbody>
            </table>
        </div>
    );
}
