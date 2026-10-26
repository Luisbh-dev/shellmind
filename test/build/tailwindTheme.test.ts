import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import tailwind from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import config from '../../tailwind.config';
import { THEMED_HUES } from '../../src/features/appearance/palette';

// What tailwind.config.ts generates for a few classes: colours behind theme
// tokens, and spacing that follows the density only where it should.
async function utilities(classes: string): Promise<string> {
    const result = await postcss([
        tailwind({ ...config, content: [{ raw: `<div class="${classes}"></div>`, extension: 'html' }] })
    ]).process('@tailwind utilities;', { from: undefined });
    return result.css.replace(/\s+/g, ' ');
}

const DENSE = (rem: string) => `calc(${rem} * var(--density, 1))`;

describe('density', () => {
    it('scales vertical paddings and keeps horizontal ones', async () => {
        const css = await utilities('p-4 px-2 py-1.5 pl-8 pt-3');
        expect(css).toContain(`.p-4 { padding-top: ${DENSE('1rem')}; padding-right: 1rem; padding-bottom: ${DENSE('1rem')}; padding-left: 1rem }`);
        expect(css).toContain('.px-2 { padding-left: 0.5rem; padding-right: 0.5rem }');
        expect(css).toContain(`.py-1\\.5 { padding-top: ${DENSE('0.375rem')}; padding-bottom: ${DENSE('0.375rem')} }`);
        expect(css).toContain('.pl-8 { padding-left: 2rem }');
        expect(css).toContain(`.pt-3 { padding-top: ${DENSE('0.75rem')} }`);
    });

    it('scales vertical margins, negative ones included, and leaves auto and pixels alone', async () => {
        const css = await utilities('-mt-2 mx-auto ml-3 my-px mb-0');
        expect(css).toContain(`.-mt-2 { margin-top: ${DENSE('-0.5rem')} }`);
        expect(css).toContain('.mx-auto { margin-left: auto; margin-right: auto }');
        expect(css).toContain('.ml-3 { margin-left: 0.75rem }');
        expect(css).toContain('.my-px { margin-top: 1px; margin-bottom: 1px }');
        expect(css).toContain('.mb-0 { margin-bottom: 0px }');
    });

    it('scales gaps and stacks, and keeps more specific sides after the shorthands', async () => {
        const css = await utilities('gap-2 space-y-1 p-4 pt-1 px-3 m-2 mt-0');
        expect(css).toContain(`.gap-2 { gap: ${DENSE('0.5rem')} }`);
        expect(css).toContain(DENSE('0.25rem'));
        expect(css.indexOf('.p-4 {')).toBeLessThan(css.indexOf('.px-3 {'));
        expect(css.indexOf('.px-3 {')).toBeLessThan(css.indexOf('.pt-1 {'));
        expect(css.indexOf('.m-2 {')).toBeLessThan(css.indexOf('.mt-0 {'));
    });
});

describe('theme colours', () => {
    it('reads colours from the theme tokens, with the alpha of the class', async () => {
        const css = await utilities('bg-ink-900 text-zinc-100 border-brand-500/40 bg-white/5 bg-black/30 bg-scrim/70 text-on-brand text-fixed-white');
        expect(css).toContain('background-color: rgb(var(--c-ink-900) / var(--tw-bg-opacity, 1))');
        expect(css).toContain('color: rgb(var(--c-zinc-100) / var(--tw-text-opacity, 1))');
        expect(css).toContain('border-color: rgb(var(--c-brand-500) / 0.4)');
        expect(css).toContain('background-color: rgb(var(--c-white) / calc(0.05 * var(--tint-boost, 1)))');
        expect(css).toContain('background-color: rgb(var(--c-black) / calc(0.3 * var(--well-scale, 1)))');
        expect(css).toContain('background-color: rgb(var(--c-scrim) / calc(0.7 * var(--scrim-scale, 1)))');
        expect(css).toContain('color: rgb(var(--c-on-brand) / var(--tw-text-opacity, 1))');
        expect(css).toContain('color: rgb(255 255 255 / var(--tw-text-opacity, 1))');
    });

    // The light theme turns only the light shades (50–400) of the status hues
    // around, so a see-through 800–950 tint stays dark and turns muddy on
    // white. Tints use the 500 shade (bg-amber-500/10); solid dark shades,
    // like a pressed danger button, are fine.
    it('has no see-through tints of the dark hue shades in the components', () => {
        const root = path.resolve(__dirname, '../../src');
        const tint = new RegExp(`\\b(?:bg|border|ring|outline|divide|from|via|to)-(?:${THEMED_HUES.join('|')})-(?:800|900|950)/`, 'g');
        const found = fs.readdirSync(root, { recursive: true, encoding: 'utf8' })
            .filter((file) => /\.tsx?$/.test(file) && !/\.test\.tsx?$/.test(file))
            .flatMap((file) => (fs.readFileSync(path.join(root, file), 'utf8').match(tint) ?? []).map((match) => `${file}: ${match}`));
        expect(found).toEqual([]);
    });
});
