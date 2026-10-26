import type { StatusSnapshot } from '@shared/status';

// The recent samples the charts draw (one per successful poll), and the
// shaping the charts need: series over a time window, unbroken runs, summary
// statistics and round ticks for the rate axis.

export const HISTORY_LENGTH = 60;

export type StatusSample = {
    time: number;
    cpu: number | null;
    memory: number | null;
    rx: number | null;
    tx: number | null;
};

export type SeriesKey = Exclude<keyof StatusSample, 'time'>;

export function appendSample(history: StatusSample[], snapshot: StatusSnapshot, limit = HISTORY_LENGTH): StatusSample[] {
    // The same report twice (a shared collection answered two polls) is one sample.
    if (history.length && history[history.length - 1].time === snapshot.collectedAt) return history;
    const sample: StatusSample = {
        time: snapshot.collectedAt,
        cpu: snapshot.cpu?.usagePercent ?? null,
        memory: snapshot.memory?.usagePercent ?? null,
        rx: snapshot.network?.rxBytesPerSec ?? null,
        tx: snapshot.network?.txBytesPerSec ?? null
    };
    const next = [...history, sample];
    return next.length > limit ? next.slice(next.length - limit) : next;
}

// The samples from `since` on, as parallel arrays (one per key). A sample
// without a value for a key keeps its place with null, so that line breaks
// there instead of joining its neighbours.
export function seriesOf(history: StatusSample[], keys: SeriesKey[], since = -Infinity): { times: number[]; values: Array<Array<number | null>> } {
    const rows = history.filter((sample) => sample.time >= since && keys.some((key) => sample[key] !== null));
    return {
        times: rows.map((sample) => sample.time),
        values: keys.map((key) => rows.map((sample) => sample[key]))
    };
}

export type Point = { time: number; value: number };

// The unbroken runs of a series. A missing value ends a run, and so does a
// gap longer than `maxGapMs` between two samples (polling was paused or kept
// failing): the chart leaves that stretch empty rather than drawing a
// straight line across it.
export function segmentsOf(times: number[], values: Array<number | null>, maxGapMs: number): Point[][] {
    const segments: Point[][] = [];
    let current: Point[] = [];
    times.forEach((time, index) => {
        const value = values[index];
        if (value === null || value === undefined || !Number.isFinite(value)) {
            if (current.length) segments.push(current);
            current = [];
            return;
        }
        const previous = current[current.length - 1];
        if (previous && time - previous.time > maxGapMs) {
            segments.push(current);
            current = [];
        }
        current.push({ time, value });
    });
    if (current.length) segments.push(current);
    return segments;
}

export type SeriesStats = { min: number; max: number; avg: number; last: number; count: number };

export function statsOf(values: Array<number | null>): SeriesStats | null {
    const present = values.filter((value): value is number => value !== null && Number.isFinite(value));
    if (!present.length) return null;
    return {
        min: Math.min(...present),
        max: Math.max(...present),
        avg: present.reduce((sum, value) => sum + value, 0) / present.length,
        last: present[present.length - 1],
        count: present.length
    };
}

// The sample closest to `time` (ties go to the earlier one); -1 without samples.
export function nearestIndex(times: number[], time: number): number {
    let best = -1;
    let bestDistance = Infinity;
    times.forEach((sampleTime, index) => {
        const distance = Math.abs(sampleTime - time);
        if (distance < bestDistance) {
            best = index;
            bestDistance = distance;
        }
    });
    return best;
}

// Tops of a rate axis in the binary unit of the peak, picked so that half of
// each is a round number of that unit too (0 / 0.5 / 1 MB/s, 0 / 30 / 60 KB/s).
const RATE_TOPS = [1, 2, 4, 6, 8, 10, 20, 40, 60, 80, 100, 200, 400, 600, 800];

export type RateAxis = {
    max: number;
    // 0, half and the top, in bytes per second.
    ticks: number[];
    // The tick labels are written in 1024 ** exponent (1 = KB/s, 2 = MB/s...).
    exponent: number;
};

// The scale of a byte-rate chart. Never below `floor`, so an idle link is not
// blown up to fill the chart.
export function rateAxis(peak: number, floor = 1024): RateAxis {
    const target = Number.isFinite(peak) ? Math.max(peak, floor) : floor;
    let exponent = Math.max(0, Math.floor(Math.log(target) / Math.log(1024)));
    // Float rounding at an exact power (log(1024 ** 2) / log(1024)) never leaves the peak below its unit.
    if (exponent > 0 && target / 1024 ** exponent < 1) exponent -= 1;
    let top = RATE_TOPS.find((candidate) => candidate >= target / 1024 ** exponent - 1e-9);
    // Past 800 of a unit, one of the next.
    if (top === undefined) {
        exponent += 1;
        top = 1;
    }
    const max = top * 1024 ** exponent;
    return { max, ticks: [0, max / 2, max], exponent };
}
