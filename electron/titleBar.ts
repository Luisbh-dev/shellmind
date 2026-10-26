import fs from 'fs';

// The window controls overlay follows the UI theme: the renderer publishes
// its title bar colour as the page's theme-color (src/features/appearance),
// which Electron reports through `did-change-theme-color`. No preload or IPC:
// the page only ever says which colour it is, and anything but #rrggbb is
// ignored. The last colour is remembered, so the next launch opens the
// window, the splash and the overlay in that theme instead of flashing the
// dark one before a light UI.

export const TITLE_BAR_HEIGHT = 40;

// `color` and `symbolColor` paint the overlay; `background` is the page's
// own background (ink-900), for the window and the splash.
export type TitleBarColors = { color: string; symbolColor: string; background: string };

// The page backgrounds of the light and dark themes (palette.ts, ink-900).
const PAGE_BACKGROUND = { light: '#ffffff', dark: '#08090c' } as const;

// Matches the app's dark title bar (ink-850) until the page says otherwise.
export const DEFAULT_TITLE_BAR: TitleBarColors = { color: '#0b0d11', symbolColor: '#e4e4e7', background: PAGE_BACKGROUND.dark };

function luminance(hex: string): number {
    const channel = (offset: number) => {
        const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
        return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
}

// The overlay for a page theme colour: dark symbols on a light bar and the
// other way round, and the page background of that theme. Null for anything
// that is not a plain #rrggbb colour.
export function titleBarFor(themeColor: unknown): TitleBarColors | null {
    if (typeof themeColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(themeColor)) return null;
    const color = themeColor.toLowerCase();
    const light = luminance(color) > 0.4;
    return { color, symbolColor: light ? '#27272a' : '#e4e4e7', background: PAGE_BACKGROUND[light ? 'light' : 'dark'] };
}

// The colours of the last session (a small JSON file in userData); the
// default dark bar when there is none or it cannot be read.
export function loadTitleBar(file: string): TitleBarColors {
    try {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8')) as { color?: unknown } | null;
        return titleBarFor(saved?.color) ?? DEFAULT_TITLE_BAR;
    } catch {
        return DEFAULT_TITLE_BAR;
    }
}

// Best effort: a failed write only costs the next launch its colours.
export function saveTitleBar(file: string, colors: TitleBarColors): void {
    try {
        fs.writeFileSync(file, `${JSON.stringify({ color: colors.color })}\n`);
    } catch {
        // Ignored, see above.
    }
}
