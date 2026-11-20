import { CircuitBoard } from 'lucide-react';
import type { StatusGpuInfo } from '@shared/status';
import { useLanguage, useT } from '@/i18n';
import { formatPercent } from '@/lib/format';
import { Card } from './Card';
import { formatMB } from './format';
import { Meter } from './Meter';

// Each NVIDIA GPU with its utilization, temperature, power and memory, and
// the processes using them. A GPU that shares the system's memory (DGX Spark)
// says so instead of showing a made-up capacity; what its processes hold is
// system RAM.

export function GpuCard({ gpu }: { gpu: StatusGpuInfo }) {
    const t = useT();
    const language = useLanguage();

    return (
        <Card
            title={t('status.gpu.cardTitle')}
            icon={<CircuitBoard />}
            subtitle={gpu.unifiedMemory ? <span title={t('status.gpu.unifiedHint')}>{t('status.gpu.unified')}</span> : undefined}
        >
            <ul className="flex flex-col gap-3">
                {gpu.devices.map((device) => {
                    const utilization = device.utilizationPercent;
                    const facts = [
                        device.temperatureC !== null ? t('status.gpu.temperature', { value: device.temperatureC }) : null,
                        device.powerWatts !== null
                            ? (device.powerLimitWatts !== null
                                ? t('status.gpu.powerOf', { value: device.powerWatts.toLocaleString(language), limit: device.powerLimitWatts.toLocaleString(language) })
                                : t('status.gpu.power', { value: device.powerWatts.toLocaleString(language) }))
                            : null,
                        device.memory ? t('status.gpu.memory', { used: formatMB(device.memory.usedMB, language), total: formatMB(device.memory.totalMB, language) }) : null
                    ].filter(Boolean);
                    return (
                        <li key={device.index} className="flex min-w-0 flex-col gap-1.5">
                            <div className="flex min-w-0 items-baseline justify-between gap-3 text-xs">
                                <span className="min-w-0 truncate font-medium text-zinc-100" title={device.name}>{device.name}</span>
                                <span className="shrink-0 tabular-nums text-zinc-200">
                                    {utilization !== null ? formatPercent(utilization, language) : t('status.unavailable')}
                                </span>
                            </div>
                            {utilization !== null && (
                                <Meter
                                    size="sm"
                                    tone="ok"
                                    value={utilization}
                                    label={t('status.gpu.utilization', { name: device.name })}
                                    valueText={formatPercent(utilization, language)}
                                />
                            )}
                            {facts.length > 0 && <div className="text-[11px] text-zinc-500">{facts.join(' · ')}</div>}
                        </li>
                    );
                })}
            </ul>

            {gpu.processes.length > 0 && (
                <table className="w-full table-fixed text-xs">
                    <caption className="sr-only">{t('status.gpu.processesCaption')}</caption>
                    <thead>
                        <tr className="border-b border-white/[0.06] text-left text-zinc-500">
                            <th scope="col" className="pb-1.5 font-medium">{t('status.processes.name')}</th>
                            <th scope="col" className="hidden w-16 pb-1.5 pl-3 text-right font-medium [@container(min-width:26rem)]:table-cell">{t('status.processes.pid')}</th>
                            <th scope="col" className="w-24 pb-1.5 pl-3 text-right font-medium">{gpu.unifiedMemory ? t('status.gpu.sharedMemory') : t('status.gpu.processMemory')}</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/[0.04]">
                        {gpu.processes.map((process) => (
                            <tr key={process.pid}>
                                <td className="truncate py-1.5 font-medium text-zinc-100" title={process.name}>{process.name}</td>
                                <td className="hidden py-1.5 pl-3 text-right font-mono text-[11px] tabular-nums text-zinc-500 [@container(min-width:26rem)]:table-cell">{process.pid}</td>
                                <td className="py-1.5 pl-3 text-right tabular-nums text-zinc-200">
                                    {process.memoryMB !== null ? formatMB(process.memoryMB, language) : '—'}
                                </td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            )}
        </Card>
    );
}
