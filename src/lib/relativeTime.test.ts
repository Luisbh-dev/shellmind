import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from './relativeTime';

const NOW = Date.UTC(2026, 9, 24, 12, 0, 0);
const ago = (seconds: number) => NOW - seconds * 1000;

describe('formatRelativeTime', () => {
    it('says how long ago in English', () => {
        expect(formatRelativeTime(ago(20), NOW, 'en')).toBe('now');
        expect(formatRelativeTime(ago(5 * 60), NOW, 'en')).toBe('5 minutes ago');
        expect(formatRelativeTime(ago(3 * 3600), NOW, 'en')).toBe('3 hours ago');
        expect(formatRelativeTime(ago(26 * 3600), NOW, 'en')).toBe('yesterday');
        expect(formatRelativeTime(ago(15 * 24 * 3600), NOW, 'en')).toBe('2 weeks ago');
        expect(formatRelativeTime(ago(400 * 24 * 3600), NOW, 'en')).toBe('last year');
    });

    it('speaks Spanish and treats the future as now', () => {
        expect(formatRelativeTime(ago(2 * 3600), NOW, 'es')).toBe('hace 2 horas');
        expect(formatRelativeTime(NOW + 60_000, NOW, 'en')).toBe('now');
        expect(formatRelativeTime(ago(5), NOW, 'es')).toBe('ahora');
    });
});
