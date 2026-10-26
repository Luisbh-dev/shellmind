import { AlertOctagon, AlertTriangle } from 'lucide-react';
import type { StatusDisk } from '@shared/status';
import { useLanguage, useT } from '@/i18n';
import { formatPercent } from '@/lib/format';
import { formatGB } from './format';
import { Meter } from './Meter';
import { classify, THRESHOLDS, type Tone } from './thresholds';
import { toneColor } from './vizTheme';
// W8-T4: a row opens the disk toolkit on that filesystem.
import { DiskRowEntry } from './DiskRowEntry';

// Local filesystems as compact rows: mount, type and device, used / total,
// and a bar coloured by the disk thresholds. On a wide card the row is one
// line; on a narrow one the bar goes underneath.

function ToneIcon({ tone }: { tone: Tone }) {
    const t = useT();
    if (tone === 'ok') return null;
    const Icon = tone === 'critical' ? AlertOctagon : AlertTriangle;
    return (
        <span title={t(`status.tone.${tone}`)} className="inline-flex">
            <Icon className="h-3.5 w-3.5" style={{ color: toneColor(tone) }} aria-hidden="true" />
            <span className="sr-only">{t(`status.tone.${tone}`)}</span>
        </span>
    );
}

export function DiskList({ disks, serverId }: { disks: StatusDisk[]; serverId?: number }) {
    const t = useT();
    const language = useLanguage();
    const marks = [THRESHOLDS.disk.warn, THRESHOLDS.disk.critical];
    const limits = t('status.limits', { warn: formatPercent(THRESHOLDS.disk.warn, language), critical: formatPercent(THRESHOLDS.disk.critical, language) });

    if (!disks.length) return <p className="text-xs text-zinc-400">{t('status.storage.none')}</p>;

    return (
        <ul aria-label={t('status.storage.caption')} className="flex flex-col gap-3 [container-type:inline-size]">
            {disks.map((disk) => {
                const tone = classify(disk.usagePercent, THRESHOLDS.disk);
                // The device only when it says something the mount and the type do not.
                const device = disk.name !== disk.mount && disk.name !== disk.fsType ? disk.name : null;
                const usage = t('status.storage.used', { used: formatGB(disk.usedGB, language), total: formatGB(disk.totalGB, language) });
                const percent = formatPercent(disk.usagePercent, language);
                return (
                    <li
                        key={`${disk.name}-${disk.mount}`}
                        className="relative grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 text-xs [@container(min-width:30rem)]:grid-cols-[minmax(7rem,1.1fr)_minmax(5rem,1fr)_auto]"
                    >
                        <div className="flex min-w-0 items-baseline gap-1.5">
                            <span className="truncate font-mono text-[12px] font-medium text-zinc-100" title={disk.mount}>{disk.mount}</span>
                            {disk.fsType && (
                                <span className="shrink-0 rounded bg-white/[0.06] px-1 py-px text-[10px] font-medium leading-3 text-zinc-400">{disk.fsType}</span>
                            )}
                            {device && <span className="min-w-0 truncate text-[11px] text-zinc-500" title={device}>{device}</span>}
                            {serverId !== undefined && <DiskRowEntry serverId={serverId} mount={disk.mount} tone={tone} />}
                        </div>
                        <div className="flex items-center justify-end gap-2 tabular-nums [@container(min-width:30rem)]:order-last">
                            <span className="text-zinc-400">{usage}</span>
                            <span className="inline-flex w-14 items-center justify-end gap-1 font-semibold text-zinc-100">
                                <ToneIcon tone={tone} />
                                {percent}
                            </span>
                        </div>
                        <Meter
                            size="md"
                            value={disk.usagePercent}
                            tone={tone}
                            marks={marks}
                            label={disk.mount}
                            valueText={`${percent} · ${usage} (${limits})`}
                            className="col-span-2 [@container(min-width:30rem)]:col-span-1"
                        />
                    </li>
                );
            })}
        </ul>
    );
}
