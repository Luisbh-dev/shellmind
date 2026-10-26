import { describe, expect, it } from 'vitest';
import { EMPTY_BUFFER, allLines, appendChunk, compileFilter, trimTo } from './logBuffer';

describe('log buffer', () => {
    it('joins lines cut across chunks and strips CR and colour codes', () => {
        let buffer = appendChunk(EMPTY_BUFFER, 'first li', 10);
        expect(buffer).toEqual({ lines: [], partial: 'first li', discarded: 0 });
        buffer = appendChunk(buffer, 'ne\r\n\x1b[1;31merror\x1b[0m: boom\nthird', 10);
        expect(buffer.lines).toEqual(['first line', 'error: boom']);
        expect(allLines(buffer)).toEqual(['first line', 'error: boom', 'third']);
        expect(appendChunk(buffer, '', 10)).toBe(buffer);
    });

    it('drops the oldest lines beyond the limit and counts them', () => {
        const buffer = appendChunk(EMPTY_BUFFER, 'a\nb\nc\nd\n', 3);
        expect(buffer).toEqual({ lines: ['b', 'c', 'd'], partial: '', discarded: 1 });
        expect(trimTo(buffer, 1)).toEqual({ lines: ['d'], partial: '', discarded: 3 });
        expect(trimTo(buffer, 5)).toBe(buffer);
    });
});

describe('line filter', () => {
    it('matches plain text case-insensitively', () => {
        const filter = compileFilter(' ERROR ', false);
        expect(filter.test('an error here')).toBe(true);
        expect(filter.test('all good')).toBe(false);
        expect(compileFilter('   ', true).test('anything')).toBe(true);
    });

    it('uses regular expressions on request and falls back on invalid ones', () => {
        expect(compileFilter('^5\\d\\d ', true).test('502 Bad Gateway')).toBe(true);
        const broken = compileFilter('([', true);
        expect(broken.error).toBe(true);
        expect(broken.test('x ([ y')).toBe(true);
    });
});
