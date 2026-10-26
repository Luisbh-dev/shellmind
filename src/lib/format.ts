// Number and date formatting in the UI language (never the OS locale, so a
// Spanish UI on an English system still reads "1,5 MB"), shared by the file
// manager, the status dashboard, the operations panels and the known-hosts
// views.

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const;

const numberFormats = new Map<string, Intl.NumberFormat>();

function numberFormat(language: string | undefined, minimumFractionDigits: number, maximumFractionDigits: number): Intl.NumberFormat {
    const key = `${language ?? ''}:${minimumFractionDigits}:${maximumFractionDigits}`;
    let format = numberFormats.get(key);
    if (!format) {
        format = new Intl.NumberFormat(language, { minimumFractionDigits, maximumFractionDigits });
        numberFormats.set(key, format);
    }
    return format;
}

export type ByteFormatOptions = {
    // Always show the decimal below 100 ("1.0 GB"), so a column lines up.
    fixed?: boolean;
};

// 1536 -> "1.5 KB": binary steps, as the tools on a server print them; one
// decimal below 100 of a unit, none above or for plain bytes.
export function formatBytes(bytes: number, language?: string, options: ByteFormatOptions = {}): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return `${numberFormat(language, 0, 0).format(0)} B`;
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
        value /= 1024;
        unit += 1;
    }
    // Rounded first, so 1023.96 KB reads "1,024 KB" rather than "1,024.0 KB".
    const digits = unit === 0 || Math.round(value * 10) / 10 >= 100 ? 0 : 1;
    return `${numberFormat(language, options.fixed ? digits : 0, digits).format(value)} ${BYTE_UNITS[unit]}`;
}

// A value already in percent: 42.25 -> "42.3%", 4.5 -> "4.5%", 100 -> "100%".
export function formatPercent(value: number, language?: string): string {
    if (!Number.isFinite(value)) return '—';
    return `${value.toLocaleString(language, { maximumFractionDigits: 1, minimumFractionDigits: value < 10 && value % 1 !== 0 ? 1 : 0 })}%`;
}

// "23 Oct 2026, 20:15" in the UI language.
export function formatDateTime(epochMs: number, language?: string): string {
    if (!Number.isFinite(epochMs) || epochMs <= 0) return '—';
    return new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(epochMs);
}
