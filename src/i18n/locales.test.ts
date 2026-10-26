import { describe, expect, it } from 'vitest';
import { catalog, FALLBACK_LANGUAGE, LANGUAGES } from './catalog';

const placeholders = (template: string) => [...template.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('locale catalogs', () => {
    const english = catalog[FALLBACK_LANGUAGE];
    const englishKeys = Object.keys(english).sort();

    it('has one catalog per supported language and no others', () => {
        expect(Object.keys(catalog).sort()).toEqual([...LANGUAGES].sort());
        expect(englishKeys.length).toBeGreaterThan(0);
    });

    for (const language of LANGUAGES.filter((lang) => lang !== FALLBACK_LANGUAGE)) {
        const messages = catalog[language];

        it(`${language} translates every English key`, () => {
            expect(englishKeys.filter((key) => !(key in messages))).toEqual([]);
        });

        it(`${language} has no keys that English lacks`, () => {
            expect(Object.keys(messages).filter((key) => !(key in english))).toEqual([]);
        });

        it(`${language} uses the same {placeholders} as English`, () => {
            const mismatched = englishKeys.filter((key) =>
                key in messages && placeholders(messages[key]).join() !== placeholders(english[key]).join()
            );
            expect(mismatched).toEqual([]);
        });
    }

    it('has no empty messages', () => {
        const empty = LANGUAGES.flatMap((language) =>
            Object.entries(catalog[language]).filter(([, value]) => !value.trim()).map(([key]) => `${language}:${key}`)
        );
        expect(empty).toEqual([]);
    });
});
