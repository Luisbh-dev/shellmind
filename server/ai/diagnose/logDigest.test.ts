import { describe, expect, it } from 'vitest';
import { digestLog, lineTemplate } from './logDigest';

describe('lineTemplate', () => {
    it('masks what changes between repetitions of a message', () => {
        expect(lineTemplate('2024-05-06T10:00:01+0000 web nginx[1234]: upstream timed out (110) from 10.0.0.7:5544 req 6f1c2a9b-0f3e-4c4e-9a1d-3b2f6c7d8e9f'))
            .toBe('<ts> web nginx[<n>]: upstream timed out (<n>) from <ip> req <uuid>');
        expect(lineTemplate('Oct 24 10:00:01 host kernel: eth0 link up, id deadbeef01')).toBe('<ts> host kernel: eth0 link up, id <n>');
        // Short words with digits are not ids.
        expect(lineTemplate('sha256 eth0 x86')).toBe('sha256 eth0 x86');
    });
});

describe('digestLog', () => {
    it('folds a run of the same message into its first and last line and a count, keeping the order', () => {
        const lines = [
            '2024-05-06T10:00:00Z app: starting',
            ...Array.from({ length: 40 }, (_, i) => `2024-05-06T10:00:${String(i + 1).padStart(2, '0')}Z app: upstream timed out after ${3000 + i} ms`),
            '2024-05-06T10:01:00Z app: giving up'
        ];
        const digest = digestLog(`${lines.join('\n')}\n\n`, 10_000);
        expect(digest).toMatchObject({ lines: 42, truncated: false });
        expect(digest.text.split('\n')).toEqual([
            '2024-05-06T10:00:00Z app: starting',
            '2024-05-06T10:00:01Z app: upstream timed out after 3000 ms',
            '  [... 38 similar lines]',
            '2024-05-06T10:00:40Z app: upstream timed out after 3039 ms',
            '2024-05-06T10:01:00Z app: giving up'
        ]);
    });

    it('leaves two similar lines as they are', () => {
        expect(digestLog('app line 1\napp line 2\napp line 3', 1000).text).toBe('app line 1\n  [... 1 similar line]\napp line 3');
        expect(digestLog('app line 1\napp line 2', 1000).text).toBe('app line 1\napp line 2');
    });

    it('keeps the latest lines when it is still too long, and summarizes the frequent patterns of the rest', () => {
        const lines = Array.from({ length: 400 }, (_, i) => (i % 2 ? `GET /api/items/${i} 200` : `worker ${i} heartbeat ok`));
        lines.push('FATAL: database connection refused');
        const digest = digestLog(lines.join('\n'), 2000);
        expect(digest.truncated).toBe(true);
        expect(digest.text.length).toBeLessThanOrEqual(2000);
        expect(digest.text).toMatch(/^\[\.\.\. \d+ earlier lines left out; the most frequent of them:\]/);
        expect(digest.text).toMatch(/\d+x GET \/api\/items\/\d+ 200/);
        expect(digest.text.endsWith('FATAL: database connection refused')).toBe(true);
    });

    it('keeps the end of a single huge line', () => {
        const digest = digestLog(`${'x'.repeat(5000)}END`, 1000);
        expect(digest.truncated).toBe(true);
        expect(digest.text.length).toBeLessThanOrEqual(1000);
        expect(digest.text.endsWith('END')).toBe(true);
    });
});
