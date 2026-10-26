// Translation catalogs. Each UI area keeps its strings in
// locales/<language>/<area>.ts (default export, nested objects allowed); they
// are collected here at build time, so adding an area is just adding files.
// Keys are addressed as "<area>.<path>", e.g. "app.tabs.files".
//
// English, the fallback, is part of the app's code. Every other language is
// a chunk of its own (bundles/<language>.ts) loaded when it is first used, so
// the app does not download strings it never shows; the saved language loads
// before the first render (main.tsx).
import { createLogger } from '@/lib/logger';

export type Language = 'en' | 'es';
export const LANGUAGES: readonly Language[] = ['en', 'es'];
export const FALLBACK_LANGUAGE: Language = 'en';

export type MessageTree = { [key: string]: string | MessageTree };
export type TranslationParams = Record<string, string | number>;

const log = createLogger('i18n');

const fallbackModules = import.meta.glob<MessageTree>('./locales/en/*.ts', { eager: true, import: 'default' });
const bundles = import.meta.glob<Record<string, MessageTree>>('./bundles/*.ts', { import: 'default' });

function flatten(tree: MessageTree, prefix: string, out: Record<string, string>) {
    for (const [name, value] of Object.entries(tree)) {
        const key = `${prefix}.${name}`;
        if (typeof value === 'string') out[key] = value;
        else flatten(value, key, out);
    }
}

// language -> flat key -> template (other languages appear once loaded)
export const catalog: Record<string, Record<string, string>> = {};

function addModules(modules: Record<string, MessageTree>) {
    for (const [path, tree] of Object.entries(modules)) {
        const match = /\/locales\/([^/]+)\/([^/]+)\.ts$/.exec(path);
        if (!match) continue;
        const [, language, area] = match;
        flatten(tree, area, (catalog[language] ??= {}));
    }
}

addModules(fallbackModules);

export function isLanguage(value: unknown): value is Language {
    return typeof value === 'string' && (LANGUAGES as readonly string[]).includes(value);
}

const loading = new Map<Language, Promise<void>>();

export function isLanguageLoaded(language: Language): boolean {
    return language in catalog;
}

// Loads a language's strings (once; a failed download is tried again on the
// next call). Until then its keys fall back to English.
export function loadLanguage(language: Language): Promise<void> {
    if (isLanguageLoaded(language)) return Promise.resolve();
    let pending = loading.get(language);
    if (!pending) {
        const bundle = bundles[`./bundles/${language}.ts`];
        pending = bundle
            ? bundle().then((modules) => addModules(modules))
            : Promise.reject(new Error(`No translations for "${language}"`));
        pending = pending.catch((error: unknown) => {
            loading.delete(language);
            log.warn(`Could not load the "${language}" translations`, error);
            throw error;
        });
        loading.set(language, pending);
    }
    return pending;
}

// "es", "es-ES", "es-419"... -> es; anything else -> en.
export function languageFromLocale(locale: string | undefined): Language {
    return locale?.toLowerCase().startsWith('es') ? 'es' : 'en';
}

// Replaces {name} placeholders; unknown placeholders are left as they are.
export function interpolate(template: string, params?: TranslationParams): string {
    if (!params) return template;
    return template.replace(/\{(\w+)\}/g, (placeholder, name: string) =>
        Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : placeholder
    );
}

const reportedMissing = new Set<string>();

// Missing keys fall back to English, then to the key itself (so a typo is
// visible in the UI instead of rendering nothing).
export function translateFrom(
    messages: Record<string, Record<string, string>>,
    language: Language,
    key: string,
    params?: TranslationParams
): string {
    const template = messages[language]?.[key] ?? messages[FALLBACK_LANGUAGE]?.[key];
    if (template === undefined) {
        if (import.meta.env.DEV && import.meta.env.MODE !== 'test' && !reportedMissing.has(key)) {
            reportedMissing.add(key);
            log.warn(`Missing translation key "${key}"`);
        }
        return key;
    }
    return interpolate(template, params);
}

export function translate(language: Language, key: string, params?: TranslationParams): string {
    return translateFrom(catalog, language, key, params);
}
