import { describe, expect, it } from 'vitest';
import { diffHunks, diffLines, splitLines } from './diff';

const signs = (oldText: string, newText: string) => diffLines(oldText, newText).ops.map((op) => `${op.type === 'add' ? '+' : op.type === 'remove' ? '-' : ' '}${op.text}`);

describe('diffLines', () => {
    it('splits lines without a phantom last line, CRLF as LF', () => {
        expect(splitLines('')).toEqual([]);
        expect(splitLines('a\nb\n')).toEqual(['a', 'b']);
        expect(splitLines('a\r\nb')).toEqual(['a', 'b']);
        expect(splitLines('a\n\n')).toEqual(['a', '']);
    });

    it('finds the lines added, removed and kept, with their line numbers', () => {
        expect(signs('a\nb\nc\nd\n', 'a\nB\nc\nd\ne\n')).toEqual([' a', '-b', '+B', ' c', ' d', '+e']);
        const diff = diffLines('one\ntwo\nthree', 'zero\none\nthree');
        expect(diff).toMatchObject({ added: 1, removed: 1, coarse: false });
        expect(diff.ops).toEqual([
            { type: 'add', text: 'zero', oldLine: null, newLine: 1 },
            { type: 'equal', text: 'one', oldLine: 1, newLine: 2 },
            { type: 'remove', text: 'two', oldLine: 2, newLine: null },
            { type: 'equal', text: 'three', oldLine: 3, newLine: 3 },
        ]);
    });

    it('handles empty sides and identical texts', () => {
        expect(signs('', 'x\ny')).toEqual(['+x', '+y']);
        expect(signs('x\ny', '')).toEqual(['-x', '-y']);
        expect(diffLines('same\n', 'same')).toMatchObject({ added: 0, removed: 0, ops: [{ type: 'equal', text: 'same' }] });
    });

    it('finds a minimal edit script', () => {
        // Myers' classic example: ABCABBA -> CBABAC takes 5 edits.
        const diff = diffLines('A\nB\nC\nA\nB\nB\nA', 'C\nB\nA\nB\nA\nC');
        expect(diff.added + diff.removed).toBe(5);
        const rebuilt = diff.ops.filter((op) => op.type !== 'remove').map((op) => op.text);
        expect(rebuilt).toEqual(['C', 'B', 'A', 'B', 'A', 'C']);
        const original = diff.ops.filter((op) => op.type !== 'add').map((op) => op.text);
        expect(original).toEqual(['A', 'B', 'C', 'A', 'B', 'B', 'A']);
    });

    it('falls back to replacing the middle wholesale when the texts differ too much', () => {
        const a = Array.from({ length: 50 }, (_, i) => `a${i}`).join('\n');
        const b = Array.from({ length: 50 }, (_, i) => `b${i}`).join('\n');
        const diff = diffLines(`head\n${a}\ntail`, `head\n${b}\ntail`, { maxEdits: 10 });
        expect(diff).toMatchObject({ coarse: true, added: 50, removed: 50 });
        expect(diff.ops[0]).toMatchObject({ type: 'equal', text: 'head' });
        expect(diff.ops.at(-1)).toMatchObject({ type: 'equal', text: 'tail' });
    });

    it('stays fast on large outputs with a few changes', () => {
        const lines = Array.from({ length: 20_000 }, (_, i) => `line ${i}`);
        const changed = [...lines];
        changed[100] = 'changed';
        changed.splice(15_000, 0, 'inserted');
        const started = Date.now();
        const diff = diffLines(lines.join('\n'), changed.join('\n'));
        expect(Date.now() - started).toBeLessThan(2000);
        expect(diff).toMatchObject({ added: 2, removed: 1, coarse: false });
    });
});

describe('diffHunks', () => {
    it('keeps context around the changes and merges close ones', () => {
        const old = Array.from({ length: 20 }, (_, i) => `l${i + 1}`).join('\n');
        const next = old.replace('l5', 'L5').replace('l7', 'L7').replace('l18', 'L18');
        const hunks = diffHunks(diffLines(old, next).ops, 2);
        expect(hunks).toHaveLength(2);
        expect(hunks[0]).toMatchObject({ oldStart: 3, oldLines: 7, newStart: 3, newLines: 7 });
        expect(hunks[0].ops.map((op) => op.text)).toEqual(['l3', 'l4', 'l5', 'L5', 'l6', 'l7', 'L7', 'l8', 'l9']);
        expect(hunks[1]).toMatchObject({ oldStart: 16, oldLines: 5, newStart: 16, newLines: 5 });
        expect(diffHunks(diffLines('a', 'a').ops)).toEqual([]);
    });

    it('numbers a hunk that only adds lines after the line before it', () => {
        const [hunk] = diffHunks(diffLines('a\nb', 'a\nb\nc').ops, 0);
        expect(hunk).toMatchObject({ oldStart: 2, oldLines: 0, newStart: 3, newLines: 1 });
    });
});
