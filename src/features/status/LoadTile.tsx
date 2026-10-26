import { AlertOctagon, AlertTriangle, Gauge } from 'lucide-react';
import type { StatusSnapshot } from '@shared/status';
import { useLanguage, useT } from '@/i18n';
import { StatTile } from './Card';
import { formatLoad } from './format';
import { Meter } from './Meter';
import { loadTone, THRESHOLDS } from './thresholds';
import { toneColor } from './vizTheme';

// Load average over 1, 5 and 15 minutes against the core count. Each meter
// spans up to the critical load (two runnable processes per core) and is
// notched at one per core, where the machine is saturated; the small print
// says so. A window over a limit shows its icon too, not only its colour.

const WINDOWS = ['one', 'five', 'fifteen'] as const;

export function LoadTile({ load, cores }: { load: NonNullable<StatusSnapshot['load']>; cores: number | null }) {
    const t = useT();
    const language = useLanguage();
    const capacity = Math.max(1, cores ?? 1);
    const max = capacity * THRESHOLDS.loadPerCore.critical;
    const saturated = capacity * THRESHOLDS.loadPerCore.warn;
    const coresText = cores ? (cores === 1 ? t('status.cpu.coresOne') : t('status.cpu.cores', { count: cores })) : null;
    const notch = formatLoad(saturated, language);

    return (
        <StatTile
            icon={<Gauge />}
            label={t('status.load.title')}
            hint={t('status.load.hint')}
            tone={loadTone(load.one, cores)}
            footer={coresText ? t('status.load.notch', { cores: coresText, value: notch }) : t('status.load.coresUnknown', { value: notch })}
        >
            <div className="grid grid-cols-3 gap-2 [@container(min-width:13rem)]:gap-3">
                {WINDOWS.map((key) => {
                    const value = load[key];
                    const window = t(`status.load.${key}`);
                    const tone = loadTone(value, cores);
                    const Icon = tone === 'critical' ? AlertOctagon : AlertTriangle;
                    return (
                        <div key={key} className="flex min-w-0 flex-col gap-1.5">
                            <span className="text-lg font-semibold leading-none tracking-tight text-zinc-50 [@container(min-width:13rem)]:text-xl">{formatLoad(value, language)}</span>
                            <Meter
                                size="md"
                                value={value}
                                max={max}
                                tone={tone}
                                marks={[saturated]}
                                label={t('status.load.meter', { window })}
                                valueText={coresText ? t('status.load.value', { value: formatLoad(value, language), cores: coresText }) : formatLoad(value, language)}
                            />
                            <span className="inline-flex min-w-0 items-center gap-1 text-[11px] text-zinc-500">
                                {tone !== 'ok' && <Icon className="h-3 w-3 shrink-0" style={{ color: toneColor(tone) }} aria-hidden="true" />}
                                <span className="truncate">{window}</span>
                            </span>
                        </div>
                    );
                })}
            </div>
        </StatTile>
    );
}
