import { describe, expect, it } from 'vitest';
import type { StatusSnapshot } from '@shared/status';
import { appendSample, nearestIndex, rateAxis, segmentsOf, seriesOf, statsOf, type StatusSample } from './history';

const report = (collectedAt: number, cpu: number | null): StatusSnapshot => ({
    platform: 'linux',
    collectedAt,
    hostname: 'h',
    os: 'Linux',
    kernel: null,
    uptimeSeconds: 1,
    cpu: cpu === null ? null : { usagePercent: cpu, cores: 1, iowaitPercent: null },
    memory: { totalMB: 100, usedMB: 50, availableMB: 50, usagePercent: 50 },
    swap: null,
    load: null,
    storage: null,
    disks: [],
    processes: [],
    network: { rxBytesPerSec: 10, txBytesPerSec: 20, interfaces: [] },
    failedUnits: null,
    loggedInUsers: null,
    sampleSeconds: 1,
    unavailable: [],
});

const sample = (time: number, cpu: number | null, rx: number | null = null): StatusSample => ({ time, cpu, memory: null, rx, tx: rx });

describe('status history', () => {
    it('keeps the last samples, once per report', () => {
        let history = appendSample([], report(1, 10), 3);
        history = appendSample(history, report(1, 10), 3);
        history = appendSample(history, report(2, null), 3);
        history = appendSample(history, report(3, 30), 3);
        history = appendSample(history, report(4, 40), 3);
        expect(history.map((entry) => entry.time)).toEqual([2, 3, 4]);
        expect(history[0]).toEqual({ time: 2, cpu: null, memory: 50, rx: 10, tx: 20 });
    });

    it('shapes series over a window, keeping missing values in place', () => {
        const history = [sample(1000, 5), sample(2000, null, 7), sample(3000, 30, 8), sample(4000, null)];
        // A sample with nothing for any of the keys is left out; one missing a single key keeps a null there.
        expect(seriesOf(history, ['cpu'])).toEqual({ times: [1000, 3000], values: [[5, 30]] });
        expect(seriesOf(history, ['cpu', 'rx'])).toEqual({ times: [1000, 2000, 3000], values: [[5, null, 30], [null, 7, 8]] });
        expect(seriesOf(history, ['cpu'], 2500)).toEqual({ times: [3000], values: [[30]] });
    });

    it('breaks a line at a missing value and at a long pause', () => {
        const times = [0, 5, 10, 15, 60, 65];
        expect(segmentsOf(times, [1, 2, null, 4, 5, 6], 20)).toEqual([
            [{ time: 0, value: 1 }, { time: 5, value: 2 }],
            [{ time: 15, value: 4 }],
            [{ time: 60, value: 5 }, { time: 65, value: 6 }],
        ]);
        expect(segmentsOf([], [], 20)).toEqual([]);
        expect(segmentsOf([0, 5], [null, null], 20)).toEqual([]);
    });

    it('summarises a series, ignoring missing values', () => {
        expect(statsOf([10, null, 30, 20])).toEqual({ min: 10, max: 30, avg: 20, last: 20, count: 3 });
        expect(statsOf([null, null])).toBeNull();
        expect(statsOf([])).toBeNull();
    });

    it('finds the sample nearest to a time', () => {
        expect(nearestIndex([0, 10, 20], 4)).toBe(0);
        expect(nearestIndex([0, 10, 20], 16)).toBe(2);
        // Halfway goes to the earlier sample.
        expect(nearestIndex([0, 10, 20], 5)).toBe(0);
        expect(nearestIndex([0, 10, 20], 999)).toBe(2);
        expect(nearestIndex([], 5)).toBe(-1);
    });

    it('scales a rate axis to ticks that are round in one unit', () => {
        const KB = 1024;
        const MB = 1024 * KB;
        // Never below 1 KB/s: an idle link stays flat.
        expect(rateAxis(0)).toEqual({ max: KB, ticks: [0, KB / 2, KB], exponent: 1 });
        expect(rateAxis(300).max).toBe(KB);
        expect(rateAxis(Number.NaN).max).toBe(KB);
        expect(rateAxis(1500)).toEqual({ max: 2 * KB, ticks: [0, KB, 2 * KB], exponent: 1 });
        expect(rateAxis(3 * KB).max).toBe(4 * KB);
        expect(rateAxis(50 * KB).ticks).toEqual([0, 30 * KB, 60 * KB]);
        expect(rateAxis(40 * MB)).toEqual({ max: 40 * MB, ticks: [0, 20 * MB, 40 * MB], exponent: 2 });
        // Past 800 of a unit, one of the next, written in that unit (0.5 MB/s, not 512 KB/s).
        expect(rateAxis(900 * KB)).toEqual({ max: MB, ticks: [0, MB / 2, MB], exponent: 2 });
        expect(rateAxis(MB)).toEqual({ max: MB, ticks: [0, MB / 2, MB], exponent: 2 });
        // Every half is a whole or half number of the unit.
        for (const peak of [1, 700, 2500, 9000, 70 * KB, 333 * KB, 5 * MB, 77 * MB, 3 * 1024 * MB]) {
            const { ticks, exponent, max } = rateAxis(peak);
            expect(max).toBeGreaterThanOrEqual(peak);
            expect(((ticks[1] / 1024 ** exponent) * 2) % 1).toBe(0);
        }
    });
});
