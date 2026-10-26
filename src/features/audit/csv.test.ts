import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '@shared/types';
import { auditToCsv, csvCell } from './csv';

const entry = (overrides: Partial<AuditEntry>): AuditEntry => ({
    id: 1,
    ts: Date.UTC(2026, 9, 23, 18, 30, 0),
    server_id: 4,
    server_name: 'web-1',
    source: 'multi-exec',
    command: 'uptime',
    exit_code: 0,
    meta: null,
    ...overrides,
});

describe('csvCell', () => {
    it('quotes cells with separators, quotes, newlines or edge spaces', () => {
        expect(csvCell('plain')).toBe('plain');
        expect(csvCell('a,b')).toBe('"a,b"');
        expect(csvCell('say "hi"')).toBe('"say ""hi"""');
        expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
        expect(csvCell(' padded')).toBe('" padded"');
        expect(csvCell(null)).toBe('');
        expect(csvCell(0)).toBe('0');
    });

    it('neutralizes spreadsheet formulas in text cells only', () => {
        expect(csvCell('=HYPERLINK("http://x")', true)).toBe(`"'=HYPERLINK(""http://x"")"`);
        expect(csvCell('+1', true)).toBe("'+1");
        expect(csvCell('-rf /tmp/x', true)).toBe("'-rf /tmp/x");
        expect(csvCell('@SUM(A1)', true)).toBe("'@SUM(A1)");
        expect(csvCell(-1)).toBe('-1');
    });
});

describe('auditToCsv', () => {
    it('writes a header, one CRLF row per entry and a BOM', () => {
        const csv = auditToCsv([
            entry({}),
            entry({ id: 2, server_id: null, server_name: null, source: 'ai-run', command: 'echo "a, b"\nls', exit_code: null, meta: { model: 'x' } }),
        ]);
        expect(csv.charCodeAt(0)).toBe(0xfeff);
        expect(csv.slice(1).split('\r\n')).toEqual([
            'id,time,server_id,server,source,exit_code,command,meta',
            '1,2026-10-23T18:30:00.000Z,4,web-1,multi-exec,0,uptime,',
            '2,2026-10-23T18:30:00.000Z,,,ai-run,,"echo ""a, b""\nls","{""model"":""x""}"',
            '',
        ]);
    });
});
