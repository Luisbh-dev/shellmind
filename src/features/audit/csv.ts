import type { AuditEntry } from '@shared/types';

// Audit entries as CSV (RFC 4180, CRLF rows, UTF-8 BOM so spreadsheet apps
// read accents correctly). Text cells that a spreadsheet would evaluate as a
// formula (= + - @, tab, CR) get a leading apostrophe: commands recorded
// here can come from AI answers and should never execute when opened.

const FORMULA_START = /^[=+\-@\t\r]/;
export const UTF8_BOM = String.fromCharCode(0xfeff);

export function csvCell(value: string | number | null | undefined, text = false): string {
    if (value === null || value === undefined) return '';
    let cell = String(value);
    if (text && FORMULA_START.test(cell)) cell = `'${cell}`;
    return /[",\r\n]/.test(cell) || /^\s|\s$/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

export const AUDIT_CSV_COLUMNS = ['id', 'time', 'server_id', 'server', 'source', 'exit_code', 'command', 'meta'] as const;

export function auditToCsv(entries: AuditEntry[]): string {
    const rows = entries.map((entry) => [
        csvCell(entry.id),
        csvCell(new Date(entry.ts).toISOString()),
        csvCell(entry.server_id),
        csvCell(entry.server_name, true),
        csvCell(entry.source),
        csvCell(entry.exit_code),
        csvCell(entry.command, true),
        csvCell(entry.meta ? JSON.stringify(entry.meta) : null, true)
    ].join(','));
    return `${UTF8_BOM}${[AUDIT_CSV_COLUMNS.join(','), ...rows].join('\r\n')}\r\n`;
}
