// Appearance preferences (theme, accent, density, terminal look): their
// values, defaults, validation and how "system" resolves. Pure: no DOM.

export const THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export type ThemePreference = typeof THEME_PREFERENCES[number];
export type ResolvedTheme = 'light' | 'dark';

export const ACCENTS = ['teal', 'blue', 'violet', 'amber', 'fuchsia', 'emerald'] as const;
export type Accent = typeof ACCENTS[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = typeof DENSITIES[number];

// "auto" is ShellMind dark or light, following the app theme.
export const TERMINAL_THEME_IDS = [
    'auto', 'shellmind-dark', 'shellmind-light', 'dracula', 'one-dark', 'solarized-dark', 'solarized-light', 'nord'
] as const;
export type TerminalThemeId = typeof TERMINAL_THEME_IDS[number];
export type ConcreteTerminalThemeId = Exclude<TerminalThemeId, 'auto'>;

export const CURSOR_STYLES = ['block', 'bar', 'underline'] as const;
export type CursorStyle = typeof CURSOR_STYLES[number];

export const TERMINAL_FONT_SIZE = { min: 10, max: 24, default: 14 } as const;

export type AppearancePrefs = {
    theme: ThemePreference;
    accent: Accent;
    density: Density;
    terminalTheme: TerminalThemeId;
    terminalFontSize: number;
    cursorStyle: CursorStyle;
    cursorBlink: boolean;
};

export const DEFAULT_APPEARANCE: AppearancePrefs = {
    theme: 'dark',
    accent: 'teal',
    density: 'comfortable',
    terminalTheme: 'auto',
    terminalFontSize: TERMINAL_FONT_SIZE.default,
    cursorStyle: 'block',
    cursorBlink: true
};

export const APPEARANCE_STORAGE_KEY = 'shellmind.appearance';

// The title bar colour per theme (ink-850). The renderer publishes it as the
// page's theme-color, which the Electron window controls follow.
export const CHROME_COLORS: Record<ResolvedTheme, string> = { dark: '#0b0d11', light: '#f4f5f7' };

// Accent colours as the terminal cursor and the settings swatches show them:
// brand-400 in the dark theme, brand-500 in the light one (palette.ts keeps
// its tokens in step, palette.test.ts checks it).
export const ACCENT_COLORS: Record<Accent, Record<ResolvedTheme, string>> = {
    teal: { dark: '#2dd4cb', light: '#0e7472' },
    blue: { dark: '#60a5fa', light: '#2563eb' },
    violet: { dark: '#a78bfa', light: '#7c3aed' },
    amber: { dark: '#fbbf24', light: '#b45309' },
    fuchsia: { dark: '#e879f9', light: '#c026d3' },
    emerald: { dark: '#34d399', light: '#047857' }
};

const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
    typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T : fallback;

export function clampFontSize(value: unknown): number {
    const size = typeof value === 'number' ? value : Number.NaN;
    if (!Number.isFinite(size)) return TERMINAL_FONT_SIZE.default;
    return Math.min(TERMINAL_FONT_SIZE.max, Math.max(TERMINAL_FONT_SIZE.min, Math.round(size)));
}

// Whatever was stored (another version, a hand edit, nothing) as valid prefs.
export function parseAppearance(raw: unknown): AppearancePrefs {
    const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
        theme: oneOf(THEME_PREFERENCES, value.theme, DEFAULT_APPEARANCE.theme),
        accent: oneOf(ACCENTS, value.accent, DEFAULT_APPEARANCE.accent),
        density: oneOf(DENSITIES, value.density, DEFAULT_APPEARANCE.density),
        terminalTheme: oneOf(TERMINAL_THEME_IDS, value.terminalTheme, DEFAULT_APPEARANCE.terminalTheme),
        terminalFontSize: clampFontSize(value.terminalFontSize),
        cursorStyle: oneOf(CURSOR_STYLES, value.cursorStyle, DEFAULT_APPEARANCE.cursorStyle),
        cursorBlink: typeof value.cursorBlink === 'boolean' ? value.cursorBlink : DEFAULT_APPEARANCE.cursorBlink
    };
}

export function readStoredAppearance(storage: { getItem(key: string): string | null } | null | undefined): AppearancePrefs {
    try {
        const raw = storage?.getItem(APPEARANCE_STORAGE_KEY);
        return parseAppearance(raw ? JSON.parse(raw) : null);
    } catch {
        return { ...DEFAULT_APPEARANCE };
    }
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
    if (preference === 'system') return systemPrefersDark ? 'dark' : 'light';
    return preference;
}

export function resolveTerminalTheme(id: TerminalThemeId, theme: ResolvedTheme): ConcreteTerminalThemeId {
    if (id === 'auto') return theme === 'light' ? 'shellmind-light' : 'shellmind-dark';
    return id;
}
