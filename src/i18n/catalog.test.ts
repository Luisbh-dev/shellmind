import { describe, expect, it, vi } from 'vitest';
import { interpolate, isLanguage, languageFromLocale, translate, translateFrom } from './catalog';

describe('interpolate', () => {
    it('replaces {name} placeholders', () => {
        expect(interpolate('Remove {name} from {list}?', { name: 'db-1', list: 'connections' }))
            .toBe('Remove db-1 from connections?');
    });

    it('formats numbers and leaves unknown placeholders untouched', () => {
        expect(interpolate('{count} of {total}', { count: 3 })).toBe('3 of {total}');
    });

    it('returns the template unchanged without params', () => {
        expect(interpolate('Hello {name}')).toBe('Hello {name}');
    });
});

describe('translateFrom', () => {
    const messages = {
        en: { 'app.title': 'Title', 'app.greeting': 'Hi {name}', 'app.onlyEnglish': 'English only' },
        es: { 'app.title': 'Título', 'app.greeting': 'Hola {name}' }
    };

    it('uses the requested language', () => {
        expect(translateFrom(messages, 'es', 'app.greeting', { name: 'Ana' })).toBe('Hola Ana');
    });

    it('falls back to English for keys missing in the language', () => {
        expect(translateFrom(messages, 'es', 'app.onlyEnglish')).toBe('English only');
    });

    it('returns the key itself when no language has it', () => {
        expect(translateFrom(messages, 'es', 'app.unknown')).toBe('app.unknown');
    });
});

describe('real catalog', () => {
    it('resolves area-prefixed nested keys', () => {
        expect(translate('en', 'app.tabs.files')).toBe('Files');
        expect(translate('es', 'app.tabs.files')).toBe('Archivos');
    });
});

describe('loading languages', () => {
    it('bundles English only and loads another language when it is first used', async () => {
        // A fresh copy: the test setup preloads every language into the shared one.
        vi.resetModules();
        const fresh = await import('./catalog');
        expect(fresh.isLanguageLoaded('en')).toBe(true);
        expect(fresh.isLanguageLoaded('es')).toBe(false);
        expect(Object.keys(fresh.catalog)).toEqual(['en']);
        expect(fresh.translate('es', 'app.tabs.files')).toBe('Files');

        await Promise.all([fresh.loadLanguage('es'), fresh.loadLanguage('es')]);
        expect(fresh.isLanguageLoaded('es')).toBe(true);
        expect(fresh.translate('es', 'app.tabs.files')).toBe('Archivos');
    });
});

describe('language detection helpers', () => {
    it('maps any Spanish locale to es and everything else to en', () => {
        expect(languageFromLocale('es')).toBe('es');
        expect(languageFromLocale('es-ES')).toBe('es');
        expect(languageFromLocale('ES-419')).toBe('es');
        expect(languageFromLocale('en-US')).toBe('en');
        expect(languageFromLocale('fr-FR')).toBe('en');
        expect(languageFromLocale(undefined)).toBe('en');
    });

    it('recognises only supported languages', () => {
        expect(isLanguage('es')).toBe(true);
        expect(isLanguage('fr')).toBe(false);
        expect(isLanguage(null)).toBe(false);
    });
});
