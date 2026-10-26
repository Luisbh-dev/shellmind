// Applies appearance preferences to the document: the root element's
// data-theme / data-accent / data-density select the CSS tokens
// (palette.ts), and the theme-color meta is what the Electron title bar
// follows.
import { CHROME_COLORS, resolveTheme, type AppearancePrefs, type ResolvedTheme } from './model';

const DARK_QUERY = '(prefers-color-scheme: dark)';
const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
const TRANSITION_CLASS = 'theme-transition';
const TRANSITION_MS = 260;

function matches(query: string, fallback: boolean): boolean {
    try {
        return typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : fallback;
    } catch {
        return fallback;
    }
}

export function systemPrefersDark(): boolean {
    return matches(DARK_QUERY, true);
}

export function prefersReducedMotion(): boolean {
    return matches(REDUCED_MOTION_QUERY, false);
}

// Calls `listener` when the OS switches between light and dark.
export function onSystemThemeChange(listener: () => void): () => void {
    if (typeof window.matchMedia !== 'function') return () => undefined;
    const query = window.matchMedia(DARK_QUERY);
    query.addEventListener?.('change', listener);
    return () => query.removeEventListener?.('change', listener);
}

function setThemeColor(color: string) {
    let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
    if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'theme-color';
        document.head.appendChild(meta);
    }
    if (meta.content !== color) meta.content = color;
}

let transitionTimer: ReturnType<typeof setTimeout> | null = null;

// `animate`: cross-fade the change (a choice in Settings), unless the user
// asked the OS for less motion.
export function applyAppearance(prefs: AppearancePrefs, options: { animate?: boolean } = {}): ResolvedTheme {
    const root = document.documentElement;
    const theme = resolveTheme(prefs.theme, systemPrefersDark());
    if (options.animate && !prefersReducedMotion()) {
        root.classList.add(TRANSITION_CLASS);
        if (transitionTimer) clearTimeout(transitionTimer);
        transitionTimer = setTimeout(() => {
            transitionTimer = null;
            root.classList.remove(TRANSITION_CLASS);
        }, TRANSITION_MS);
    }
    root.dataset.theme = theme;
    root.dataset.accent = prefs.accent;
    root.dataset.density = prefs.density;
    root.style.colorScheme = theme;
    setThemeColor(CHROME_COLORS[theme]);
    return theme;
}
