// Modification times of FTP listings. MLSD gives an exact UTC timestamp
// (basic-ftp's `modifiedAt`); LIST output only has the raw text of `ls -l` or
// of a DOS/IIS listing, in the server's (unknown) time zone, read here as UTC.

const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11
};

const DAY_MS = 24 * 60 * 60 * 1000;

function utcSeconds(year: number, month: number, day: number, hours = 0, minutes = 0): number {
    if (month < 0 || month > 11 || day < 1 || day > 31 || hours > 23 || minutes > 59) return 0;
    return Math.floor(Date.UTC(year, month, day, hours, minutes) / 1000);
}

function parseClock(value: string): [number, number] | null {
    const match = /^(\d{1,2}):(\d{2})$/.exec(value);
    return match ? [Number(match[1]), Number(match[2])] : null;
}

// "Jan 12 10:00" (within the last year), "Jan 12 2023", "12 Jan 10:00",
// "2023-01-12 10:00".
function parseUnix(raw: string, now: Date): number {
    const parts = raw.trim().split(/\s+/);
    const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(parts[0]);
    if (iso && parts.length === 2) {
        const clock = parseClock(parts[1]);
        return clock ? utcSeconds(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]), ...clock) : 0;
    }
    if (parts.length !== 3) return 0;

    let monthName = parts[0];
    let day = parts[1];
    if (/^\d{1,2}$/.test(monthName)) [monthName, day] = [parts[1], parts[0]];
    const month = MONTHS[monthName.slice(0, 3).toLowerCase()];
    if (month === undefined || !/^\d{1,2}$/.test(day)) return 0;

    if (/^\d{4}$/.test(parts[2])) return utcSeconds(Number(parts[2]), month, Number(day));
    const clock = parseClock(parts[2]);
    if (!clock) return 0;
    // No year: the most recent such date that is not in the future (ls shows
    // the time only for dates within the last six months).
    let year = now.getUTCFullYear();
    if (Date.UTC(year, month, Number(day), ...clock) > now.getTime() + DAY_MS) year -= 1;
    return utcSeconds(year, month, Number(day), ...clock);
}

// "01-12-23 10:00AM", "12-05-1996 05:03PM", "01-12-23 22:00" (month first).
function parseDos(raw: string): number {
    const match = /^(\d{1,2})-(\d{1,2})-(\d{2}|\d{4})\s+(\d{1,2}):(\d{2})\s*([AaPp][Mm])?$/.exec(raw.trim());
    if (!match) return 0;
    const [, month, day, yearText, hourText, minutes, meridiem] = match;
    let year = Number(yearText);
    if (yearText.length === 2) year += year < 70 ? 2000 : 1900;
    let hours = Number(hourText);
    if (meridiem) {
        if (hours > 12) return 0;
        hours = hours % 12 + (meridiem.toLowerCase() === "pm" ? 12 : 0);
    }
    return utcSeconds(year, Number(month) - 1, Number(day), hours, Number(minutes));
}

// Seconds since the epoch, or 0 when the listing gives nothing usable.
export function ftpModifiedTime(info: { modifiedAt?: Date; rawModifiedAt?: string }, now = new Date()): number {
    if (info.modifiedAt && !Number.isNaN(info.modifiedAt.getTime())) return Math.floor(info.modifiedAt.getTime() / 1000);
    const raw = info.rawModifiedAt?.trim();
    if (!raw) return 0;
    return /^\d{1,2}-\d{1,2}-\d{2,4}\s/.test(raw) ? parseDos(raw) : parseUnix(raw, now);
}
