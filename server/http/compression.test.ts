import { describe, expect, it } from 'vitest';
import { preferredEncoding } from './compression';

describe('preferredEncoding', () => {
    it('prefers Brotli, then gzip, as browsers list them', () => {
        expect(preferredEncoding('gzip, deflate, br, zstd')).toBe('br');
        expect(preferredEncoding('gzip, deflate')).toBe('gzip');
        expect(preferredEncoding('deflate')).toBeNull();
        expect(preferredEncoding(undefined)).toBeNull();
        expect(preferredEncoding('')).toBeNull();
    });

    it('honours q-values and the wildcard', () => {
        expect(preferredEncoding('br;q=0, gzip')).toBe('gzip');
        expect(preferredEncoding('br;q=0.2, gzip;q=0.8')).toBe('gzip');
        expect(preferredEncoding('gzip;q=0, br;q=0')).toBeNull();
        expect(preferredEncoding('*')).toBe('br');
        expect(preferredEncoding('*;q=0, gzip')).toBe('gzip');
        expect(preferredEncoding('identity')).toBeNull();
    });
});
