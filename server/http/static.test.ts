import { describe, expect, it } from 'vitest';
import { SAME_ORIGIN_MARKER, withSameOriginMarker } from './static';

describe('withSameOriginMarker', () => {
    it('adds the marker at the end of <head>', () => {
        expect(withSameOriginMarker('<!doctype html><html><HEAD><title>x</title></HEAD></html>'))
            .toBe(`<!doctype html><html><HEAD><title>x</title>${SAME_ORIGIN_MARKER}</HEAD></html>`);
    });

    it('keeps the doctype first when the page has no <head>', () => {
        expect(withSameOriginMarker('\n<!DOCTYPE html><title>x</title>'))
            .toBe(`\n<!DOCTYPE html>${SAME_ORIGIN_MARKER}<title>x</title>`);
        expect(withSameOriginMarker('<title>x</title>')).toBe(`${SAME_ORIGIN_MARKER}<title>x</title>`);
    });
});
