// "5 minutes ago" / "hace 5 minutos" for a past moment, in the UI language.

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ['year', 365 * 24 * 3600],
    ['month', 30 * 24 * 3600],
    ['week', 7 * 24 * 3600],
    ['day', 24 * 3600],
    ['hour', 3600],
    ['minute', 60]
];

export function formatRelativeTime(at: number, now: number, language: string): string {
    const seconds = Math.max(0, Math.round((now - at) / 1000));
    const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
    for (const [unit, size] of UNITS) {
        if (seconds >= size) return format.format(-Math.floor(seconds / size), unit);
    }
    // Under a minute: "now" ("this minute" reads oddly after "Opened").
    return format.format(0, 'second');
}
