// Appearance preferences of this device (localStorage), applied to the
// document as they change, and the theme they resolve to now. The OS
// switching between light and dark re-resolves "system"; another window of
// the app changing them is picked up through the storage event.
import { create } from 'zustand';
import { applyAppearance, onSystemThemeChange } from './dom';
import {
    APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, parseAppearance, readStoredAppearance, resolveTheme,
    type AppearancePrefs, type ResolvedTheme
} from './model';

type AppearanceState = {
    prefs: AppearancePrefs;
    resolvedTheme: ResolvedTheme;
    setAppearance: (patch: Partial<AppearancePrefs>) => void;
    resetAppearance: () => void;
};

function storage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.localStorage;
    } catch {
        return null;
    }
}

function save(prefs: AppearancePrefs) {
    try {
        storage()?.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(prefs));
    } catch {
        // Not remembered on this device; it still applies until reload.
    }
}

const hasDocument = typeof document !== 'undefined';
const initial = readStoredAppearance(storage());
// The boot script already did this before the first paint; again here in
// case it could not run, and for the title bar colour.
const initialTheme = hasDocument ? applyAppearance(initial) : resolveTheme(initial.theme, true);

export const useAppearance = create<AppearanceState>()((set, get) => {
    const commit = (prefs: AppearancePrefs, persist: boolean) => {
        const before = get().prefs;
        if (persist) save(prefs);
        const animate = before.theme !== prefs.theme || before.accent !== prefs.accent;
        const resolvedTheme = hasDocument ? applyAppearance(prefs, { animate }) : resolveTheme(prefs.theme, true);
        set({ prefs, resolvedTheme });
    };
    return {
        prefs: initial,
        resolvedTheme: initialTheme,
        setAppearance: (patch) => commit(parseAppearance({ ...get().prefs, ...patch }), true),
        resetAppearance: () => commit({ ...DEFAULT_APPEARANCE }, true)
    };
});

if (typeof window !== 'undefined') {
    onSystemThemeChange(() => {
        const { prefs } = useAppearance.getState();
        if (prefs.theme !== 'system') return;
        useAppearance.setState({ resolvedTheme: applyAppearance(prefs, { animate: true }) });
    });
    window.addEventListener('storage', (event) => {
        if (event.key !== null && event.key !== APPEARANCE_STORAGE_KEY) return;
        const prefs = readStoredAppearance(storage());
        useAppearance.setState({ prefs, resolvedTheme: applyAppearance(prefs) });
    });
}

export const useAppearancePrefs = () => useAppearance((state) => state.prefs);
export const useResolvedTheme = () => useAppearance((state) => state.resolvedTheme);
