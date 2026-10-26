import { describe, expect, it } from 'vitest';
import { cn } from './cn';

describe('cn', () => {
    it('joins truthy class names and drops falsy ones', () => {
        expect(cn('a', false, undefined, null, '', 'c')).toBe('a c');
    });

    it('lets later Tailwind utilities win over conflicting earlier ones', () => {
        expect(cn('px-2 py-1', 'px-4')).toBe('py-1 px-4');
    });

    it('accepts object and array syntax', () => {
        expect(cn(['a', { b: true, c: false }])).toBe('a b');
    });
});
