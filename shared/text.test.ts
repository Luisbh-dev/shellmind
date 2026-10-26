import { describe, expect, it } from 'vitest';
import { trimTrailingNewlines } from './text';

describe('trimTrailingNewlines', () => {
    it('removes only the line breaks at the end', () => {
        expect(trimTrailingNewlines('a\nb\n\n')).toBe('a\nb');
        expect(trimTrailingNewlines('a \n')).toBe('a ');
        expect(trimTrailingNewlines('\n\n')).toBe('');
        expect(trimTrailingNewlines('a')).toBe('a');
    });

    // /\n+$/ took over a second on 40 000 line breaks followed by a character.
    it('stays linear on a long run that does not reach the end', () => {
        const text = `${'\n'.repeat(1_000_000)}x`;
        const started = performance.now();
        expect(trimTrailingNewlines(text)).toBe(text);
        expect(`${'a '.repeat(500_000)}x`.trimEnd()).toHaveLength(1_000_001);
        expect(performance.now() - started).toBeLessThan(500);
    });
});
