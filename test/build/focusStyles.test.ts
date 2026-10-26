import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

// The focus indicators of src/index.css (WCAG 1.4.11 and Windows contrast
// themes); the colour itself is checked in src/features/appearance/palette.test.ts.
const css = fs.readFileSync(path.resolve(__dirname, '../../src/index.css'), 'utf8');

const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    if (start < 0) throw new Error(`no rule for ${selector}`);
    return css.slice(start, css.indexOf('}', start));
};

describe('focus styles', () => {
    it('draws an opaque ring in the focus colour, with an outline for forced colours', () => {
        const ring = rule('.focus-ring:focus-visible');
        expect(ring).toContain('box-shadow: 0 0 0 2px rgb(var(--c-focus-ring));');
        expect(ring).not.toMatch(/outline:\s*none/);
        expect(ring).toContain('outline: 2px solid transparent;');
    });

    it('marks focused menu and list items with more than a faint tint', () => {
        expect(css).toMatch(/\.focus-item:focus,\s*\.focus-item\[data-active="true"\] \{\s*box-shadow: inset 2px 0 0 rgb\(var\(--c-focus-ring\)\);/);
    });

    it('turns every focus indicator into a system-coloured outline in Windows contrast themes', () => {
        const start = css.indexOf('@media (forced-colors: active)');
        expect(start).toBeGreaterThan(-1);
        const block = css.slice(start);
        for (const selector of ['.focus-ring:focus-visible', '[role="tab"]:focus-visible', '[role="option"][aria-selected="true"]', '[role^="menuitem"]:focus', '.focus-item:focus']) {
            expect(block, selector).toContain(selector);
        }
        expect(block.match(/outline: 2px solid Highlight;/g)).toHaveLength(2);
    });
});
