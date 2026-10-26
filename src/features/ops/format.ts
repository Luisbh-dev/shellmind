import { formatDateTime } from '@/lib/format';

// Engine timestamps ("2026-10-24T15:50:04.803046928Z", or Docker's list
// format "2026-10-24 15:50:04 +0000 UTC") in the UI language; text that does
// not read as a date is shown as it is.
export function formatTimestamp(value: string | null | undefined, language: string): string {
    const time = parseTimestamp(value);
    return time === null ? value || '—' : formatDateTime(time, language);
}

// The time of day with seconds (checks a few seconds apart).
export function formatClock(value: string | null | undefined, language: string): string {
    const time = parseTimestamp(value);
    return time === null ? value || '—' : new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(time);
}

function parseTimestamp(value: string | null | undefined): number | null {
    if (!value) return null;
    const iso = value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})(?:\.\d+)? ([+-]\d{2})(\d{2}).*$/, '$1T$2$3:$4');
    const time = Date.parse(iso);
    return Number.isFinite(time) ? time : null;
}

// --- what the engines print in English ----------------------------------------

type DurationUnit = 'second' | 'minute' | 'hour' | 'day' | 'week' | 'month' | 'year';

// Docker's and Podman's human durations (go-units HumanDuration): "Less
// than a second", "1 second", "About a minute", "9 minutes", "About an
// hour", "3 days", "5 weeks"...
function engineDuration(text: string): { value: number; unit: DurationUnit } | null {
    const trimmed = text.trim();
    if (/^less than a second$/i.test(trimmed)) return { value: 1, unit: 'second' };
    const about = /^about an? (minute|hour)$/i.exec(trimmed);
    if (about) return { value: 1, unit: about[1].toLowerCase() as DurationUnit };
    const counted = /^(\d+) (second|minute|hour|day|week|month|year)s?$/i.exec(trimmed);
    return counted ? { value: Number(counted[1]), unit: counted[2].toLowerCase() as DurationUnit } : null;
}

const durationText = ({ value, unit }: { value: number; unit: DurationUnit }, language: string) =>
    new Intl.NumberFormat(language, { style: 'unit', unit, unitDisplay: 'long' }).format(value);

const agoText = ({ value, unit }: { value: number; unit: DurationUnit }, language: string) =>
    new Intl.RelativeTimeFormat(language, { numeric: 'auto' }).format(-value, unit);

const HEALTH: Record<string, string> = { healthy: 'healthy', unhealthy: 'unhealthy', 'health: starting': 'starting', paused: 'paused' };

// A container's status ("Up 9 minutes (healthy)", "Exited (0) 3 days ago",
// "Created") in the UI language, or null when it is in another form (then it
// is shown as the engine says it).
export function containerStatusText(status: string, t: (key: string, params?: Record<string, string | number>) => string, language: string): string | null {
    const up = /^Up (.+?)(?: \((healthy|unhealthy|health: starting|paused)\))?$/i.exec(status.trim());
    if (up) {
        const duration = engineDuration(up[1]);
        if (!duration) return null;
        const text = t('ops.containers.statusText.up', { duration: durationText(duration, language) });
        return up[2] ? `${text} · ${t(`ops.containers.statusText.health.${HEALTH[up[2].toLowerCase()]}`)}` : text;
    }
    const ended = /^(Exited|Restarting) \((-?\d+)\) (.+) ago$/i.exec(status.trim());
    if (ended) {
        const duration = engineDuration(ended[3]);
        if (!duration) return null;
        return t(`ops.containers.statusText.${ended[1].toLowerCase()}`, { code: ended[2], ago: agoText(duration, language) });
    }
    if (/^created$/i.test(status.trim())) return t('ops.containers.statusText.created');
    return null;
}

// "1.53kB / 126B" (network and block I/O, memory "12.5MiB / 1.94GiB", as the
// engines print them) with the numbers in the UI language ("1,53 kB / 126 B"),
// in the engine's own units; the text as it is when it does not read that way.
export function formatEngineSizes(text: string | undefined, language: string): string | undefined {
    if (!text) return text;
    const parts = text.split('/').map((part) => /^\s*(\d+(?:\.\d+)?)\s*([kKMGTPE]?i?B)\s*$/.exec(part));
    if (parts.some((part) => !part)) return text;
    const number = new Intl.NumberFormat(language, { maximumFractionDigits: 2 });
    return parts.map((part) => `${number.format(Number(part![1]))} ${part![2]}`).join(' / ');
}
