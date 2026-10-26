import type { TranslateFn } from '@/i18n';
import { formatBytes } from '@/lib/format';

// Number formatting for the status dashboard (bytes and percentages are in
// src/lib/format.ts, shared with the operations panels).

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

export function formatRate(bytesPerSecond: number, language?: string): string {
    return `${formatBytes(bytesPerSecond, language, { fixed: true })}/s`;
}

// An axis tick in a fixed unit (1024 ** exponent), so every tick of an axis
// reads in the same one: "0.5 MB/s" next to "1 MB/s", not "512 KB/s".
export function formatRateTick(bytesPerSecond: number, exponent: number, language?: string): string {
    if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return '0';
    const unit = Math.min(UNITS.length - 1, Math.max(0, exponent));
    return `${(bytesPerSecond / 1024 ** unit).toLocaleString(language, { maximumFractionDigits: 1 })} ${UNITS[unit]}/s`;
}

// "1.03" seconds -> "1", "2.46" -> "2.5".
export function formatSeconds(seconds: number, language?: string): string {
    return seconds.toLocaleString(language, { maximumFractionDigits: 1 });
}

export function formatMB(megabytes: number, language?: string): string {
    return formatBytes(megabytes * 1024 * 1024, language, { fixed: true });
}

export function formatGB(gigabytes: number, language?: string): string {
    return formatBytes(gigabytes * 1024 ** 3, language, { fixed: true });
}

// Load averages always with two decimals, as uptime and top print them.
export function formatLoad(value: number, language?: string): string {
    return value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Wall-clock time of a sample: "14:05" on an axis, "14:05:30" in a tooltip.
export function formatClock(time: number, language?: string, withSeconds = true): string {
    return new Date(time).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit', ...(withSeconds ? { second: '2-digit' } : {}) });
}

export function formatUptime(seconds: number, t: TranslateFn): string {
    const total = Math.max(0, Math.floor(seconds));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    if (d > 0) return t('status.uptime.days', { d, h });
    if (h > 0) return t('status.uptime.hours', { h, m });
    return t('status.uptime.minutes', { m });
}

// "just now", "12 s ago", "3 min ago"...
export function formatAgo(timestamp: number, now: number, t: TranslateFn): string {
    const seconds = Math.max(0, Math.round((now - timestamp) / 1000));
    if (seconds < 5) return t('status.ago.now');
    if (seconds < 60) return t('status.ago.seconds', { count: seconds });
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('status.ago.minutes', { count: minutes });
    return t('status.ago.hours', { count: Math.floor(minutes / 60) });
}
