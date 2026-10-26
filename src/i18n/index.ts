// Runtime language state. `t()` reads the current language (for code outside
// React render); components use `useT()` so they re-render when it changes.
import { useCallback } from 'react';
import { create } from 'zustand';
import {
    FALLBACK_LANGUAGE,
    isLanguage,
    isLanguageLoaded,
    languageFromLocale,
    loadLanguage,
    translate,
    type Language,
    type TranslationParams
} from './catalog';

export { LANGUAGES, type Language, type TranslationParams } from './catalog';

// "system" follows the OS/browser language; anything else is a user override.
export type LanguagePreference = Language | 'system';
export type TranslateFn = (key: string, params?: TranslationParams) => string;

const STORAGE_KEY = 'shellmind-language';

export function systemLanguage(): Language {
    return languageFromLocale(typeof navigator === 'undefined' ? undefined : navigator.language);
}

function readPreference(): LanguagePreference {
    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        return isLanguage(stored) ? stored : 'system';
    } catch {
        return 'system';
    }
}

function resolve(preference: LanguagePreference): Language {
    return preference === 'system' ? systemLanguage() : preference;
}

function applyDocumentLanguage(language: Language) {
    if (typeof document !== 'undefined') document.documentElement.lang = language;
}

// `language` is the language on screen: a choice whose strings are still
// loading shows once they arrive (English until then).
type LanguageState = { preference: LanguagePreference; language: Language };

const initialPreference = readPreference();
const initialLanguage = resolve(initialPreference);

const useLanguageStore = create<LanguageState>(() => ({
    preference: initialPreference,
    language: isLanguageLoaded(initialLanguage) ? initialLanguage : FALLBACK_LANGUAGE
}));

applyDocumentLanguage(useLanguageStore.getState().language);

// Shows `language` once its strings are there, unless the choice changed
// meanwhile.
function show(language: Language): Promise<void> {
    const apply = () => {
        if (resolve(useLanguageStore.getState().preference) !== language) return;
        useLanguageStore.setState({ language });
        applyDocumentLanguage(language);
    };
    if (isLanguageLoaded(language)) {
        apply();
        return Promise.resolve();
    }
    return loadLanguage(language).then(apply, () => undefined);
}

// Resolves once the chosen language can be shown (main.tsx waits for it
// before the first render, so a Spanish UI never flashes English).
export function languageReady(): Promise<void> {
    return show(resolve(useLanguageStore.getState().preference));
}

export function getLanguage(): Language {
    return useLanguageStore.getState().language;
}

export function getLanguagePreference(): LanguagePreference {
    return useLanguageStore.getState().preference;
}

export function setLanguage(preference: LanguagePreference) {
    try {
        if (preference === 'system') localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, preference);
    } catch {
        // Storage unavailable: the choice still applies to this session.
    }
    useLanguageStore.setState({ preference });
    void show(resolve(preference));
}

export function t(key: string, params?: TranslationParams): string {
    return translate(getLanguage(), key, params);
}

export function useLanguage(): Language {
    return useLanguageStore((state) => state.language);
}

export function useLanguagePreference(): LanguagePreference {
    return useLanguageStore((state) => state.preference);
}

export function useT(): TranslateFn {
    const language = useLanguage();
    return useCallback((key, params) => translate(language, key, params), [language]);
}
