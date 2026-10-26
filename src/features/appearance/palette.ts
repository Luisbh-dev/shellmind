// The colour tokens of the dark and light themes and of the accent colours.
// tailwind.config.ts turns them into CSS custom properties ("r g b"
// triplets) behind the colour names the components already use (ink-*,
// brand-*, zinc-*, the status hues, white, black), so a component keeps its
// classes and follows the theme. Build-time data: the app never imports it
// (palette.test.ts checks the contrast of the main text/surface pairs).
import colors from 'tailwindcss/colors';
import { ACCENT_COLORS, CHROME_COLORS, type Accent, type ResolvedTheme } from './model';

export const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950] as const;
export type Shade = typeof SHADES[number];
export type Scale = Record<Shade, string>;

export const INK_SHADES = [900, 850, 800, 750, 700, 650, 600] as const;
export type InkShade = typeof INK_SHADES[number];

// Layered surfaces: 900 is the app background, 850 the title bar and side
// panels, 800 dialogs, 700 menus and popovers, 650/600 raised controls.
export const INK: Record<ResolvedTheme, Record<InkShade, string>> = {
    dark: { 900: '#08090c', 850: CHROME_COLORS.dark, 800: '#0f1115', 750: '#13161c', 700: '#181b22', 650: '#1d212a', 600: '#242935' },
    light: { 900: '#ffffff', 850: CHROME_COLORS.light, 800: '#ffffff', 750: '#f8f9fb', 700: '#ffffff', 650: '#eef0f3', 600: '#e2e5ea' }
};

const scaleOf = (source: Record<string, string>): Scale =>
    Object.fromEntries(SHADES.map((shade) => [shade, source[shade]])) as Scale;

// The greys of text, borders and wells. Dark: Tailwind's zinc, with 500
// lifted so muted text passes AA on every surface. Light: the scale turned
// around, so "zinc-100" (strong text on dark) is near-black on light.
export const ZINC: Record<ResolvedTheme, Scale> = {
    dark: { ...scaleOf(colors.zinc), 500: '#83838e' },
    light: {
        50: '#111113', 100: '#18181b', 200: '#27272a', 300: '#3f3f46', 400: '#52525b', 500: '#65656f',
        600: '#a1a1aa', 700: '#d4d4d8', 800: '#e4e4e7', 900: '#f4f4f5', 950: '#fafafa'
    }
};

// Status and decoration hues. On dark the components use their light shades
// (text-rose-300); on light those shades map to dark ones. Bright hues, whose
// 600 is still too light on white, go one step further.
export const THEMED_HUES = [
    'rose', 'red', 'pink', 'fuchsia', 'purple', 'violet', 'indigo', 'blue', 'sky', 'cyan', 'teal', 'emerald', 'green',
    'lime', 'yellow', 'amber', 'orange'
] as const;
export type ThemedHue = typeof THEMED_HUES[number];

const BRIGHT_HUES: ReadonlySet<string> = new Set(['sky', 'cyan', 'teal', 'emerald', 'green', 'lime', 'yellow', 'amber', 'orange']);
const LIGHT_SHADES: Partial<Record<Shade, Shade>> = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 600 };
const LIGHT_SHADES_BRIGHT: Partial<Record<Shade, Shade>> = { 50: 950, 100: 900, 200: 900, 300: 800, 400: 700 };

function remap(scale: Scale, map: Partial<Record<Shade, Shade>>): Scale {
    return Object.fromEntries(SHADES.map((shade) => [shade, scale[map[shade] ?? shade]])) as Scale;
}

export function hueScale(hue: ThemedHue, theme: ResolvedTheme): Scale {
    const scale = scaleOf(colors[hue]);
    if (theme === 'dark') return scale;
    return remap(scale, BRIGHT_HUES.has(hue) ? LIGHT_SHADES_BRIGHT : LIGHT_SHADES);
}

// The accent scales. Teal is ShellMind's own; the others are Tailwind's.
export const ACCENT_SCALES: Record<Accent, Scale> = {
    teal: {
        50: '#effdfb', 100: '#cffcf6', 200: '#9ff7ee', 300: '#5eeae0', 400: '#2dd4cb', 500: '#14b8b0',
        600: '#0b9390', 700: '#0e7472', 800: '#115d5d', 900: '#134d4e', 950: '#042f30'
    },
    blue: scaleOf(colors.blue),
    violet: scaleOf(colors.violet),
    amber: scaleOf(colors.amber),
    fuchsia: scaleOf(colors.fuchsia),
    emerald: scaleOf(colors.emerald)
};

const BRIGHT_ACCENTS: ReadonlySet<Accent> = new Set(['teal', 'amber', 'emerald']);

// What brand-N is in each theme. Dark: the scale as is; solid buttons
// (brand-500) carry dark text. Light: text shades turn dark and solid
// buttons dark enough for white text, hover (400) and pressed (600) darker
// still.
const BRAND_LIGHT: Record<Shade, Shade> = { 50: 950, 100: 900, 200: 800, 300: 700, 400: 700, 500: 600, 600: 800, 700: 300, 800: 200, 900: 100, 950: 50 };
const BRAND_LIGHT_BRIGHT: Record<Shade, Shade> = { ...BRAND_LIGHT, 400: 800, 500: 700, 600: 900 };

export function brandScale(accent: Accent, theme: ResolvedTheme): Scale {
    const scale = ACCENT_SCALES[accent];
    if (theme === 'dark') return scale;
    return remap(scale, BRIGHT_ACCENTS.has(accent) ? BRAND_LIGHT_BRIGHT : BRAND_LIGHT);
}

// Text on a solid brand-500 background.
export const ON_BRAND: Record<ResolvedTheme, string> = { dark: '#08090c', light: '#ffffff' };

// The keyboard focus indicator (rings, the bar of a focused menu item, a
// focused field's border): opaque, so it keeps at least 3:1 (WCAG 1.4.11)
// against every surface in both themes; palette.test.ts checks each accent.
export function focusRingColor(accent: Accent, theme: ResolvedTheme): string {
    return brandScale(accent, theme)[400];
}

// Plain values per theme: tints, shadows and browser chrome colours.
type ThemeValues = {
    // `white` in class names is the overlay tint (hover fills, hairlines,
    // strong text); `black` the sunken wells; `scrim` the dialog backdrop.
    // Each has a factor the alpha of the class is multiplied by.
    white: string;
    tintBoost: number;
    black: string;
    wellScale: number;
    scrim: string;
    scrimScale: number;
    shadowPanel: string;
    shadowSoft: string;
    scrollbar: string;
    scrollbarHover: string;
    selectionText: string;
};

export const THEME_VALUES: Record<ResolvedTheme, ThemeValues> = {
    dark: {
        white: '#ffffff',
        tintBoost: 1,
        black: '#000000',
        wellScale: 1,
        scrim: '#000000',
        scrimScale: 1,
        shadowPanel: '0 18px 48px -16px rgba(0, 0, 0, 0.65)',
        shadowSoft: '0 8px 24px -12px rgba(0, 0, 0, 0.5)',
        scrollbar: '#2a2f3a',
        scrollbarHover: '#3a4150',
        selectionText: '#ffffff'
    },
    light: {
        white: '#181b22',
        tintBoost: 1.25,
        black: '#181b22',
        wellScale: 0.1,
        scrim: '#0f172a',
        scrimScale: 0.6,
        shadowPanel: '0 20px 48px -18px rgba(15, 23, 42, 0.28), 0 2px 6px -2px rgba(15, 23, 42, 0.08)',
        shadowSoft: '0 6px 18px -10px rgba(15, 23, 42, 0.3)',
        scrollbar: '#cdd1d8',
        scrollbarHover: '#aeb4be',
        selectionText: '#18181b'
    }
};

export const COMPACT_DENSITY = 0.8;

export function rgbTriplet(hex: string): string {
    const value = hex.replace('#', '');
    if (!/^[0-9a-f]{6}$/i.test(value)) throw new Error(`Not a #rrggbb colour: ${hex}`);
    return [0, 2, 4].map((index) => parseInt(value.slice(index, index + 2), 16)).join(' ');
}

type Declarations = Record<string, string>;

function brandTokens(accent: Accent, theme: ResolvedTheme): Declarations {
    const scale = brandScale(accent, theme);
    return {
        ...Object.fromEntries(SHADES.map((shade) => [`--c-brand-${shade}`, rgbTriplet(scale[shade])])),
        '--c-focus-ring': rgbTriplet(focusRingColor(accent, theme))
    };
}

export function themeTokens(theme: ResolvedTheme): Declarations {
    const values = THEME_VALUES[theme];
    const tokens: Declarations = { 'color-scheme': theme };
    for (const shade of INK_SHADES) tokens[`--c-ink-${shade}`] = rgbTriplet(INK[theme][shade]);
    for (const shade of SHADES) tokens[`--c-zinc-${shade}`] = rgbTriplet(ZINC[theme][shade]);
    for (const hue of THEMED_HUES) {
        const scale = hueScale(hue, theme);
        for (const shade of SHADES) tokens[`--c-${hue}-${shade}`] = rgbTriplet(scale[shade]);
    }
    Object.assign(tokens, brandTokens('teal', theme), {
        '--c-on-brand': rgbTriplet(ON_BRAND[theme]),
        '--c-white': rgbTriplet(values.white),
        '--tint-boost': String(values.tintBoost),
        '--c-black': rgbTriplet(values.black),
        '--well-scale': String(values.wellScale),
        '--c-scrim': rgbTriplet(values.scrim),
        '--scrim-scale': String(values.scrimScale),
        '--shadow-panel': values.shadowPanel,
        '--shadow-soft': values.shadowSoft,
        '--scrollbar': values.scrollbar,
        '--scrollbar-hover': values.scrollbarHover,
        '--selection-text': values.selectionText,
        '--accent-color': ACCENT_COLORS.teal[theme]
    });
    return tokens;
}

// The base stylesheet: dark and teal unless the root element says otherwise
// (src/features/appearance/dom.ts sets data-theme, data-accent and
// data-density before the first paint).
export function themeStylesheet(): Record<string, Declarations> {
    const sheet: Record<string, Declarations> = {
        ':root': { ...themeTokens('dark'), '--density': '1' },
        ':root[data-theme="light"]': themeTokens('light'),
        ':root[data-density="compact"]': { '--density': String(COMPACT_DENSITY) }
    };
    for (const accent of Object.keys(ACCENT_SCALES) as Accent[]) {
        if (accent === 'teal') continue;
        sheet[`:root[data-accent="${accent}"]`] = { ...brandTokens(accent, 'dark'), '--accent-color': ACCENT_COLORS[accent].dark };
        sheet[`:root[data-theme="light"][data-accent="${accent}"]`] = { ...brandTokens(accent, 'light'), '--accent-color': ACCENT_COLORS[accent].light };
    }
    return sheet;
}
