import { describe, expect, it } from 'vitest';
import { AppError } from '../../errors';
import { ExecAbortedError, ExecTimeoutError } from '../../ssh/exec';
import { JOURNAL_DENIED_REASON, attempt, fitEvidence, logSection, readableJournal, sectionFailure, textSection } from './sections';

const base = { id: 'service' as const, title: 'Service status', source: 'systemctl status app.service' };

describe('evidence sections', () => {
    it('redacts secrets before capping, and says when text was left out', () => {
        const section = textSection(base, `ExecStart=/usr/bin/app --password=hunter22 --token ghp_abcdefghijklmnopqrstuvwxyz0123456789\n${'line\n'.repeat(4000)}`, 1000);
        expect(section.text).not.toContain('hunter22');
        expect(section.text).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
        expect(section.text).toContain('[REDACTED]');
        expect(section.truncated).toBe(true);
        expect(section.text).toContain('characters omitted');
    });

    it('turns a journal the login user may not read into a failed part', async () => {
        const notices = [
            'No journal files were opened due to insufficient permissions.\n',
            [
                'Hint: You are currently not seeing messages from other users and the system.',
                "      Users in groups 'adm', 'systemd-journal' can see all messages.",
                '      Pass -q to turn off this notice.',
                '-- No entries --'
            ].join('\n')
        ];
        for (const output of notices) {
            const section = await attempt({ ...base, id: 'journal' }, undefined, async () => logSection({ ...base, id: 'journal' }, readableJournal(output), 1000));
            expect(section).toMatchObject({ failed: true, text: `Could not be read (OPS_PERMISSION_DENIED): ${JOURNAL_DENIED_REASON}` });
        }
        expect(readableJournal('-- No entries --\n')).toBe('-- No entries --\n');
    });

    it('tells the code and reason of a failed part apart', async () => {
        const coded = await attempt(base, undefined, async () => { throw new AppError('OPS_COMMAND_FAILED', 'tail: cannot open x', 502); });
        expect(sectionFailure(coded)).toEqual({ code: 'OPS_COMMAND_FAILED', reason: 'tail: cannot open x' });
        expect(sectionFailure({ ...base, text: '(not reported: the script stopped before this part)', failed: true })).toEqual({ code: null, reason: '(not reported: the script stopped before this part)' });
    });

    it('says when there was no output', () => {
        expect(textSection(base, '\n\n', 100).text).toBe('(no output)');
        expect(logSection({ ...base, id: 'journal' }, '', 100).text).toBe('(no output)');
    });

    it('turns a failed command into a failed section, but lets cancellation and connection loss through', async () => {
        const timedOut = await attempt(base, undefined, async () => { throw new ExecTimeoutError('systemctl status', 30_000); });
        expect(timedOut).toMatchObject({ id: 'service', failed: true });
        expect(timedOut.text).toMatch(/^Could not be read \(EXEC_TIMEOUT\): The command did not finish within 30s/);

        const denied = await attempt(base, undefined, async () => { throw new AppError('OPS_PERMISSION_DENIED', 'journal: Permission denied (password=abc12345)', 403); });
        expect(denied.text).not.toContain('abc12345');

        await expect(attempt(base, undefined, async () => { throw new ExecAbortedError(); })).rejects.toBeInstanceOf(ExecAbortedError);
        await expect(attempt(base, undefined, async () => { throw new Error('Not connected'); })).rejects.toThrow('Not connected');
        const controller = new AbortController();
        controller.abort();
        await expect(attempt(base, controller.signal, async () => { throw new ExecTimeoutError('x', 1); })).rejects.toBeInstanceOf(ExecTimeoutError);
    });

    it('keeps the whole within the evidence limit, the largest sections giving up the most', () => {
        const sections = [
            { ...base, text: 'a'.repeat(20_000) },
            { ...base, id: 'journal' as const, text: 'b'.repeat(15_000) },
            { ...base, id: 'events' as const, text: 'small' }
        ];
        const fitted = fitEvidence(sections, 20_000);
        const total = fitted.reduce((sum, section) => sum + section.text.length, 0);
        expect(total).toBeLessThanOrEqual(20_000);
        expect(fitted[0]).toMatchObject({ truncated: true });
        expect(fitted[2]).toEqual(sections[2]);
        // Untouched when it fits.
        expect(fitEvidence(sections, 100_000)).toBe(sections);
    });
});

// SEC-1: evidence is read from logs anyone can write to (an access log's
// request line, container output). A long line of look-alike tokens in MBs of
// output must neither stall the backend nor slip a secret through.
describe('evidence sections of huge output', () => {
    it('reads the latest part of a 4 MB log in bounded time, masking it and counting what it left out', () => {
        const lines = [
            ...Array.from({ length: 30_000 }, (_, i) => `GET /static/${i}.js 200 ${'a.'.repeat(40)}`),
            `${'token.'.repeat(500_000)}`,
            'db: connect password=TailSecret77 failed',
            'FATAL: giving up'
        ];
        const raw = lines.join('\n');
        expect(raw.length).toBeGreaterThan(4_000_000);
        const started = performance.now();
        const section = logSection({ ...base, id: 'journal' }, raw, 16_000);
        expect(performance.now() - started).toBeLessThan(3000);
        expect(section.truncated).toBe(true);
        expect(section.text.length).toBeLessThanOrEqual(16_000);
        expect(section.text).not.toContain('TailSecret77');
        expect(section.text.endsWith('FATAL: giving up')).toBe(true);
        // Most of the 30 000 short lines are left out before the digest sees
        // them, and still counted; the line of tokens keeps no half word.
        const earlier = Number(/^\[\.\.\. (\d+) earlier lines left out/.exec(section.text)?.[1]);
        expect(earlier).toBeGreaterThan(28_000);
        expect(earlier).toBeLessThan(30_000);
        expect(section.text).toContain('\n[... 3000000 characters omitted ...]\n');
    });

    it('cuts a long line between words, so no half of a secret is left unmasked', () => {
        const line = `${'word '.repeat(240)}ghp_abcdefghijklmnopqrstuvwxyz0123456789 ${'x'.repeat(3000)} api_key=${'k'.repeat(40)} ${'tail '.repeat(600)}`;
        const section = logSection({ ...base, id: 'journal' }, line, 16_000);
        expect(section.truncated).toBe(true);
        expect(section.text).toContain('characters omitted ...]');
        expect(section.text).not.toMatch(/ghp_[a-z]/);
        expect(section.text).not.toMatch(/k{4}/);
    });

    it('masks and clips a huge text part in bounded time', () => {
        const raw = `ExecStart=/usr/bin/app --password=HeadSecret1\n${'a.'.repeat(2_000_000)}\n${'\n'.repeat(200_000)}x\nDB_PASSWORD=TailSecret2\n`;
        const started = performance.now();
        const section = textSection(base, raw, 16_000);
        expect(performance.now() - started).toBeLessThan(3000);
        expect(section.truncated).toBe(true);
        expect(section.text).not.toContain('HeadSecret1');
        expect(section.text).not.toContain('TailSecret2');
        expect(section.text.endsWith('DB_PASSWORD=[REDACTED]')).toBe(true);
    });
});
