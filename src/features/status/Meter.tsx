import { AlertOctagon, AlertTriangle } from 'lucide-react';
import { useT } from '@/i18n';
import { cn } from '@/lib/cn';
import type { Tone } from './thresholds';
import { toneColor, viz } from './vizTheme';

// A ratio against its limit. The fill carries the tone (series blue while
// fine, amber, red), the track is a lighter step of the same colour, and the
// warning and critical limits are notched into it with the card's own
// surface colour, so the reader sees how close the next band is. Screen
// readers hear the tone after the value. A plain magnitude bar is a meter
// that stays 'ok'.

const HEIGHTS = { lg: 'h-2', md: 'h-1.5', sm: 'h-1' } as const;

type MeterProps = {
    value: number;
    max?: number;
    tone: Tone;
    label: string;
    valueText?: string;
    // Limits to notch into the track, in the units of `value`.
    marks?: number[];
    size?: keyof typeof HEIGHTS;
    className?: string;
};

export function Meter({ value, max = 100, tone, label, valueText, marks = [], size = 'lg', className }: MeterProps) {
    const t = useT();
    const clamped = Math.min(max, Math.max(0, value));
    const reading = valueText ?? String(Math.round(clamped * 10) / 10);
    const percent = max > 0 ? (clamped / max) * 100 : 0;
    return (
        <div
            role="meter"
            aria-label={label}
            aria-valuemin={0}
            aria-valuemax={max}
            aria-valuenow={Math.round(clamped * 10) / 10}
            aria-valuetext={tone === 'ok' ? reading : `${reading} · ${t(`status.tone.${tone}`)}`}
            className={cn('relative w-full overflow-hidden rounded-full', HEIGHTS[size], className)}
            style={{ backgroundColor: toneColor(tone, size === 'sm' ? 0.12 : 0.18) }}
        >
            <div
                className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-500 motion-safe:ease-out"
                // Any non-zero reading stays visible.
                style={{ width: percent > 0 ? `max(2px, ${percent}%)` : 0, backgroundColor: toneColor(tone) }}
            />
            {marks.filter((mark) => mark > 0 && mark < max).map((mark) => (
                <span
                    key={mark}
                    aria-hidden="true"
                    className="absolute inset-y-0 w-0.5 -translate-x-1/2"
                    style={{ left: `${(mark / max) * 100}%`, backgroundColor: viz.surface }}
                />
            ))}
        </div>
    );
}

// "High" / "Critical" with its icon; nothing while the value is fine.
export function ToneBadge({ tone, className }: { tone: Tone; className?: string }) {
    const t = useT();
    if (tone === 'ok') return null;
    const Icon = tone === 'critical' ? AlertOctagon : AlertTriangle;
    return (
        <span
            className={cn('inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-px text-[11px] font-medium leading-4 text-zinc-100', className)}
            style={{ backgroundColor: toneColor(tone, 0.16) }}
        >
            <Icon className="h-3 w-3" style={{ color: toneColor(tone) }} aria-hidden="true" />
            {t(`status.tone.${tone}`)}
        </span>
    );
}
