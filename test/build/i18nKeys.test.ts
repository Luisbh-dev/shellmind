import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');

// Every English key of every area is used somewhere in the app: a key that
// nothing references any more is removed from both languages
// (src/i18n/locales.test.ts checks that the languages match). A key built at
// runtime counts as used when the code names its prefix, e.g.
// t(`sidebar.sort.${mode}`), and a plural form when the code names its base
// key (plural(t, 'a.b', n) reads a.b.one / a.b.other; countKey('a.b', n)
// reads a.b / a.bOne).
const AREAS = fs.readdirSync(path.join(root, 'src/i18n/locales/en'))
    .filter((file) => file.endsWith('.ts'))
    .map((file) => file.slice(0, -'.ts'.length));

type Tree = { [key: string]: string | Tree };

function flatten(tree: Tree, prefix: string, out: string[]) {
    for (const [name, value] of Object.entries(tree)) {
        const key = `${prefix}.${name}`;
        if (typeof value === 'string') out.push(key);
        else flatten(value, key, out);
    }
}

function sources(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!file.includes(path.join('i18n', 'locales'))) sources(file, out);
        } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
            out.push(file);
        }
    }
    return out;
}

describe('translation keys', () => {
    it('are all used by the app', async () => {
        const keys: string[] = [];
        for (const area of AREAS) {
            const module = await import(pathToFileURL(path.join(root, 'src/i18n/locales/en', `${area}.ts`)).href) as { default: Tree };
            flatten(module.default, area, keys);
        }
        const code = [...sources(path.join(root, 'src')), ...sources(path.join(root, 'shared'))]
            .map((file) => fs.readFileSync(file, 'utf8'))
            .join('\n');
        // `area.path.${…}` or 'area.path.' + … (W8-T2: an area name may hold digits, "k8s")
        const prefixes = [...code.matchAll(/[`'"]([a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9_]+)*\.)(?:\$\{|['"]\s*\+)/g)].map((match) => match[1]);

        const named = (key: string) => new RegExp(`['"\`]${key.replace(/\./g, '\\.')}['"\`]`).test(code);
        const pluralBase = (key: string) => key.replace(/\.(?:zero|one|two|few|many|other)$/, '').replace(/One$/, '');
        const unused = keys.filter((key) =>
            !named(key) && !(pluralBase(key) !== key && named(pluralBase(key))) && !prefixes.some((prefix) => key.startsWith(prefix))
        );
        expect(unused).toEqual([]);
    });
});
