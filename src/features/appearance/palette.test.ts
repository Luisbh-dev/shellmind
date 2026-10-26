import { describe, expect, it } from 'vitest';
import { ACCENTS, ACCENT_COLORS, DEFAULT_APPEARANCE, type ResolvedTheme } from './model';
import { INK, ON_BRAND, THEMED_HUES, ZINC, brandScale, focusRingColor, hueScale, rgbTriplet, themeStylesheet, themeTokens } from './palette';
import { TERMINAL_SCHEMES, terminalAppearance } from './terminalThemes';

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
    const [r, g, b] = rgbTriplet(hex).split(' ').map((value) => {
        const channel = Number(value) / 255;
        return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
    const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (light + 0.05) / (dark + 0.05);
}

// Degrees between the hues of two colours (0–180).
function hueDistance(a: string, b: string): number {
    const hue = (hex: string) => {
        const [r, g, b] = rgbTriplet(hex).split(' ').map((value) => Number(value) / 255);
        const max = Math.max(r, g, b);
        const delta = max - Math.min(r, g, b);
        if (delta === 0) return 0;
        const sector = max === r ? (g - b) / delta : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
        return (sector * 60 + 360) % 360;
    };
    const distance = Math.abs(hue(a) - hue(b));
    return Math.min(distance, 360 - distance);
}

const THEMES: ResolvedTheme[] = ['dark', 'light'];
// Where text sits: app background, side panels, dialogs, menus.
const SURFACES = [900, 850, 800, 700] as const;
const AA = 4.5;

describe.each(THEMES)('%s theme contrast (WCAG AA)', (theme) => {
    it.each([100, 200, 300, 400, 500] as const)('zinc-%s text on every surface', (shade) => {
        for (const surface of SURFACES) {
            expect(contrast(ZINC[theme][shade], INK[theme][surface]), `zinc-${shade} on ink-${surface}`).toBeGreaterThanOrEqual(AA);
        }
    });

    it('status text (300 shades, 400 for red and rose) on every surface', () => {
        for (const hue of ['rose', 'red', 'amber', 'emerald', 'sky', 'violet', 'orange', 'teal', 'blue'] as const) {
            for (const surface of SURFACES) {
                expect(contrast(hueScale(hue, theme)[300], INK[theme][surface]), `${hue}-300 on ink-${surface}`).toBeGreaterThanOrEqual(AA);
            }
        }
        for (const hue of ['rose', 'red'] as const) {
            expect(contrast(hueScale(hue, theme)[400], INK[theme][900]), `${hue}-400`).toBeGreaterThanOrEqual(AA);
        }
    });

    it.each(ACCENTS)('%s accent: link text and button labels', (accent) => {
        const brand = brandScale(accent, theme);
        for (const surface of SURFACES) {
            expect(contrast(brand[300], INK[theme][surface]), `brand-300 on ink-${surface}`).toBeGreaterThanOrEqual(AA);
            expect(contrast(brand[400], INK[theme][surface]), `brand-400 on ink-${surface}`).toBeGreaterThanOrEqual(AA);
        }
        // Primary buttons, at rest and hovered.
        expect(contrast(ON_BRAND[theme], brand[500])).toBeGreaterThanOrEqual(AA);
        expect(contrast(ON_BRAND[theme], brand[400])).toBeGreaterThanOrEqual(AA);
    });

    // WCAG 1.4.11: focus rings, the bar of a focused menu item and a focused
    // field's border need 3:1 against what surrounds them.
    it.each(ACCENTS)('%s accent: the focus indicator stands out on every surface', (accent) => {
        const ring = focusRingColor(accent, theme);
        for (const surface of SURFACES) {
            expect(contrast(ring, INK[theme][surface]), `focus ring on ink-${surface}`).toBeGreaterThanOrEqual(3);
        }
        const sheet = themeStylesheet();
        const selector = theme === 'dark'
            ? (accent === 'teal' ? ':root' : `:root[data-accent="${accent}"]`)
            : (accent === 'teal' ? ':root[data-theme="light"]' : `:root[data-theme="light"][data-accent="${accent}"]`);
        expect(sheet[selector]['--c-focus-ring'], selector).toBe(rgbTriplet(ring));
    });

    it('danger buttons keep white labels at rest and hovered', () => {
        expect(contrast('#ffffff', hueScale('rose', theme)[600])).toBeGreaterThanOrEqual(AA);
        expect(contrast('#ffffff', hueScale('rose', theme)[700])).toBeGreaterThanOrEqual(AA);
    });

    // Danger is rose (Delete buttons rose-600, error dots and tints rose-500):
    // a primary button never looks like a Delete button, and focus rings and
    // selections never look like errors. Pink (about 20° away) would not do.
    it.each(ACCENTS)('%s accent stays clear of the danger colour', (accent) => {
        const brand = brandScale(accent, theme);
        for (const danger of [hueScale('rose', theme)[600], hueScale('rose', theme)[500]]) {
            expect(hueDistance(brand[500], danger), `brand-500 against ${danger}`).toBeGreaterThanOrEqual(30);
        }
    });
});

describe('palette consistency', () => {
    it('keeps the accent colours used outside CSS in step with the brand tokens', () => {
        for (const accent of ACCENTS) {
            expect(ACCENT_COLORS[accent].dark).toBe(brandScale(accent, 'dark')[400]);
            expect(ACCENT_COLORS[accent].light).toBe(brandScale(accent, 'light')[500]);
        }
    });

    it('defines every token in both themes', () => {
        const dark = Object.keys(themeTokens('dark')).sort();
        expect(Object.keys(themeTokens('light')).sort()).toEqual(dark);
        for (const hue of THEMED_HUES) expect(dark).toContain(`--c-${hue}-300`);
    });

    it('is dark and teal by default and switches through attributes on <html>', () => {
        const sheet = themeStylesheet();
        expect(sheet[':root']['color-scheme']).toBe('dark');
        expect(sheet[':root']['--c-brand-500']).toBe(rgbTriplet('#14b8b0'));
        expect(sheet[':root']['--density']).toBe('1');
        expect(sheet[':root[data-theme="light"]']['color-scheme']).toBe('light');
        expect(sheet[':root[data-density="compact"]']['--density']).toBe('0.8');
        expect(sheet[':root[data-theme="light"][data-accent="violet"]']['--c-brand-500']).toBe(rgbTriplet(brandScale('violet', 'light')[500]));
    });

    it('gives the ShellMind terminal schemes readable text', () => {
        for (const id of ['shellmind-dark', 'shellmind-light'] as const) {
            const { background, foreground, white, black } = TERMINAL_SCHEMES[id].theme;
            expect(contrast(foreground, background)).toBeGreaterThanOrEqual(7);
            // "White" text on the light scheme and "black" on the dark one stay visible.
            expect(contrast(id === 'shellmind-light' ? white : black, background)).toBeGreaterThan(id === 'shellmind-light' ? AA : 1.15);
        }
    });

    it('has xterm lift low-contrast text to AA in the ShellMind schemes only', () => {
        // Bright white on the light scheme and bright black on the dark one are below AA as colours.
        expect(contrast(TERMINAL_SCHEMES['shellmind-light'].theme.brightWhite, '#ffffff')).toBeLessThan(AA);
        for (const theme of ['dark', 'light'] as const) {
            expect(terminalAppearance({ ...DEFAULT_APPEARANCE, terminalTheme: 'auto' }, theme).minimumContrastRatio).toBe(AA);
        }
        expect(terminalAppearance({ ...DEFAULT_APPEARANCE, terminalTheme: 'solarized-dark' }, 'dark').minimumContrastRatio).toBe(1);
    });

    it('describes every terminal scheme with valid colours', () => {
        for (const scheme of Object.values(TERMINAL_SCHEMES)) {
            for (const [key, value] of Object.entries(scheme.theme)) {
                expect(value, `${scheme.id}.${key}`).toMatch(/^(#[0-9a-f]{6}|rgba\(\d+, \d+, \d+, [\d.]+\))$/);
            }
            expect(luminance(scheme.theme.background) > 0.4).toBe(scheme.kind === 'light');
        }
    });
});

// UX-05: the selected option of a SegmentedControl is brand-200 text on a
// brand-500 tint: 15% over the group's ink-900 at 50% (pills), 10% right on
// the surface (cards). brand-300 there was 4.42:1 in the light theme.
describe.each(THEMES)('%s theme: the selected option of a segmented control', (theme) => {
    const blend = (top: string, bottom: string, alpha: number) => `#${rgbTriplet(top).split(' ').map((value, index) => {
        const under = Number(rgbTriplet(bottom).split(' ')[index]);
        return Math.round(Number(value) * alpha + under * (1 - alpha)).toString(16).padStart(2, '0');
    }).join('')}`;

    it.each(ACCENTS)('%s accent reads at AA on every surface', (accent) => {
        const brand = brandScale(accent, theme);
        for (const surface of SURFACES) {
            const group = blend(INK[theme][900], INK[theme][surface], 0.5);
            const pill = blend(brand[500], group, 0.15);
            const card = blend(brand[500], INK[theme][surface], 0.1);
            expect(contrast(brand[200], pill), `pill on ink-${surface}`).toBeGreaterThanOrEqual(AA);
            expect(contrast(brand[200], card), `card on ink-${surface}`).toBeGreaterThanOrEqual(AA);
        }
    });
});
