import { describe, expect, it } from 'vitest';
import { ftpModifiedTime } from './ftpTime';

const NOW = new Date(Date.UTC(2026, 9, 23, 12, 0));
const utc = (...parts: [number, number, number, number?, number?]) => Date.UTC(parts[0], parts[1], parts[2], parts[3] ?? 0, parts[4] ?? 0) / 1000;

describe('ftpModifiedTime', () => {
    it('uses the exact MLSD time when there is one', () => {
        expect(ftpModifiedTime({ modifiedAt: new Date(Date.UTC(2023, 0, 12, 10, 0, 5)), rawModifiedAt: '2023-01-12T10:00:05.000Z' }, NOW))
            .toBe(utc(2023, 0, 12, 10, 0) + 5);
    });

    it('reads recent Unix listings as this year (not 2001)', () => {
        expect(ftpModifiedTime({ rawModifiedAt: 'Jan 12 10:00' }, NOW)).toBe(utc(2026, 0, 12, 10, 0));
        expect(ftpModifiedTime({ rawModifiedAt: 'Oct 23 11:30' }, NOW)).toBe(utc(2026, 9, 23, 11, 30));
    });

    it('moves a date that would be in the future to last year', () => {
        expect(ftpModifiedTime({ rawModifiedAt: 'Dec 30 08:15' }, NOW)).toBe(utc(2025, 11, 30, 8, 15));
    });

    it('reads Unix listings with a year, day-first and numeric dates', () => {
        expect(ftpModifiedTime({ rawModifiedAt: 'Mar  5 2019' }, NOW)).toBe(utc(2019, 2, 5));
        expect(ftpModifiedTime({ rawModifiedAt: '12 Jan 10:00' }, NOW)).toBe(utc(2026, 0, 12, 10, 0));
        expect(ftpModifiedTime({ rawModifiedAt: '2023-01-12 10:00' }, NOW)).toBe(utc(2023, 0, 12, 10, 0));
    });

    it('reads DOS / IIS listings', () => {
        expect(ftpModifiedTime({ rawModifiedAt: '01-12-23  10:00AM' }, NOW)).toBe(utc(2023, 0, 12, 10, 0));
        expect(ftpModifiedTime({ rawModifiedAt: '12-05-96  05:03PM' }, NOW)).toBe(utc(1996, 11, 5, 17, 3));
        expect(ftpModifiedTime({ rawModifiedAt: '01-12-23 12:15AM' }, NOW)).toBe(utc(2023, 0, 12, 0, 15));
        expect(ftpModifiedTime({ rawModifiedAt: '07-04-2024 22:00' }, NOW)).toBe(utc(2024, 6, 4, 22, 0));
    });

    it('returns 0 for anything unusable', () => {
        for (const raw of ['', 'yesterday', 'Foo 12 10:00', '13-45-23 10:00AM', 'Jan 12 25:99', '1月 12日 10:00']) {
            expect(ftpModifiedTime({ rawModifiedAt: raw }, NOW)).toBe(0);
        }
        expect(ftpModifiedTime({ modifiedAt: new Date(NaN), rawModifiedAt: '' }, NOW)).toBe(0);
    });
});
