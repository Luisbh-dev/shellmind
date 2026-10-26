import type { ReactNode } from 'react';
import { AlertTriangle, Info, ShieldAlert } from 'lucide-react';
import type { CleanupEstimate } from '@shared/disk';
import type { OpsPlatform } from '@shared/ops';
import type { TranslateFn } from '@/i18n';
import { cn } from '@/lib/cn';
import { formatBytes, formatPercent } from '@/lib/format';
import { toneColor, viz } from '@/features/status/vizTheme';

// Building blocks of the disk view.

// A size against its folder: one hue (it is a magnitude, not a state), a
// rounded end, and any non-zero share visible. The figure next to it is the
// reading; the bar only helps the eye compare rows.
export function SizeBar({ share, className }: { share: number; className?: string }) {
    const percent = Math.max(0, Math.min(100, share * 100));
    return (
        <div aria-hidden="true" className={cn('h-1.5 w-full overflow-hidden rounded-full', className)} style={{ backgroundColor: toneColor('ok', 0.12) }}>
            <div className="h-full rounded-full motion-safe:transition-[width] motion-safe:duration-300" style={{ width: percent > 0 ? `max(2px, ${percent}%)` : 0, backgroundColor: viz.series1() }} />
        </div>
    );
}

type NoticeTone = 'info' | 'warn' | 'locked';

const NOTICE: Record<NoticeTone, { icon: typeof Info; box: string; iconClass: string }> = {
    info: { icon: Info, box: 'border-white/[0.08] bg-white/[0.025] text-zinc-300', iconClass: 'text-zinc-400' },
    warn: { icon: AlertTriangle, box: 'border-amber-500/30 bg-amber-500/[0.07] text-amber-100', iconClass: 'text-amber-300' },
    locked: { icon: ShieldAlert, box: 'border-amber-500/30 bg-amber-500/[0.06] text-zinc-200', iconClass: 'text-amber-300' }
};

// A remark about a result (a scan that stopped early, folders it could not
// read): a status line, not an alert.
export function Notice({ tone = 'info', children, action, className }: { tone?: NoticeTone; children: ReactNode; action?: ReactNode; className?: string }) {
    const { icon: Icon, box, iconClass } = NOTICE[tone];
    return (
        <div role="status" className={cn('flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2 text-xs', box, className)}>
            <Icon className={cn('h-3.5 w-3.5 shrink-0', iconClass)} aria-hidden="true" />
            <div className="min-w-0 flex-1 basis-48">{children}</div>
            {action}
        </div>
    );
}

export const bytes = (value: number | null | undefined, language: string) => (value === null || value === undefined ? '—' : formatBytes(value, language));

// "12.5%" of `total`, "<0.1%" for a sliver, "" without a total.
export function shareText(part: number | null, total: number | null, language: string): string {
    if (part === null || !total) return '';
    const value = (part / total) * 100;
    if (value > 0 && value < 0.1) return `<${formatPercent(0.1, language)}`;
    return formatPercent(Math.round(value * 10) / 10, language);
}

// How to get the rights the scans and cleanups lack, in the platform's terms.
export const limitedHintKey = (platform: OpsPlatform) => (platform === 'windows' ? 'disk.access.limitedHintWindows' : 'disk.access.limitedHint');

// "about 1.2 GB", "up to 300 MB"...
export function estimateText(t: TranslateFn, language: string, value: number | null, estimate: CleanupEstimate): string {
    if (value === null) return t('disk.cleanup.estimate.unknown');
    return t(`disk.cleanup.estimate.${estimate}`, { size: formatBytes(value, language) });
}

// The epoch ms date of a file in the UI language.
export function fileDate(value: number | null | undefined, language: string): string {
    if (!value) return '—';
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(value);
}
