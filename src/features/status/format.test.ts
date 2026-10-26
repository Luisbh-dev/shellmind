import { describe, expect, it } from 'vitest';
import { translate } from '@/i18n/catalog';
import { formatBytes, formatPercent } from '@/lib/format';
import { formatAgo, formatClock, formatGB, formatLoad, formatMB, formatRate, formatRateTick, formatSeconds, formatUptime } from './format';

const t = (key: string, params?: Record<string, string | number>) => translate('en', key, params);

describe('status formatting', () => {
    it('formats sizes and rates in binary units', () => {
        expect(formatBytes(0)).toBe('0 B');
        expect(formatBytes(512, 'en')).toBe('512 B');
        expect(formatBytes(1536, 'en')).toBe('1.5 KB');
        expect(formatRate(1048576 * 12.25, 'en')).toBe('12.3 MB/s');
        expect(formatMB(2048, 'en')).toBe('2.0 GB');
        expect(formatGB(1382.8, 'en')).toBe('1.4 TB');
        expect(formatBytes(1536, 'es')).toBe('1,5 KB');
    });

    it('formats percentages, uptime and ages', () => {
        expect(formatPercent(42.25, 'en')).toBe('42.3%');
        expect(formatPercent(4.5, 'en')).toBe('4.5%');
        expect(formatPercent(100, 'en')).toBe('100%');
        expect(formatUptime(90061, t)).toBe('1 d 1 h');
        expect(formatUptime(3720, t)).toBe('1 h 2 min');
        expect(formatUptime(59, t)).toBe('0 min');
        expect(formatAgo(10_000, 12_000, t)).toBe('just now');
        expect(formatAgo(0, 30_000, t)).toBe('30 s ago');
        expect(formatAgo(0, 125_000, t)).toBe('2 min ago');
        expect(formatAgo(0, 7_200_000, t)).toBe('2 h ago');
    });

    it('formats axis ticks, load averages and sample times', () => {
        // Every tick of an axis in the same unit, without a trailing .0.
        expect(formatRateTick(0, 2, 'en')).toBe('0');
        expect(formatRateTick(512 * 1024, 2, 'en')).toBe('0.5 MB/s');
        expect(formatRateTick(1024 * 1024, 2, 'en')).toBe('1 MB/s');
        expect(formatRateTick(30 * 1024, 1, 'es')).toBe('30 KB/s');
        expect(formatRateTick(1536, 1, 'es')).toBe('1,5 KB/s');
        expect(formatRate(2048, 'en')).toBe('2.0 KB/s');
        expect(formatSeconds(1.03, 'es')).toBe('1');
        expect(formatSeconds(2.46, 'es')).toBe('2,5');
        expect(formatLoad(0.5, 'en')).toBe('0.50');
        expect(formatLoad(12.345, 'es')).toBe('12,35');
        const time = new Date(2026, 0, 2, 14, 5, 9).getTime();
        expect(formatClock(time, 'es')).toBe('14:05:09');
        expect(formatClock(time, 'es', false)).toBe('14:05');
    });
});
