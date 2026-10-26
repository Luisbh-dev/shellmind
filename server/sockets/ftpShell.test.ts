import { describe, expect, it } from 'vitest';
import { shellWords } from './ftpShell';

describe('shellWords', () => {
    it('splits on whitespace and keeps quoted names together', () => {
        expect(shellWords('cd  "my folder"')).toEqual(['cd', 'my folder']);
        expect(shellWords("cat 'file one.txt' extra")).toEqual(['cat', 'file one.txt', 'extra']);
        expect(shellWords('ls')).toEqual(['ls']);
        expect(shellWords('   ')).toEqual([]);
    });
});
