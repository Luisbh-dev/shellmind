import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { IndexHtmlTransformHook } from 'vite';
import { buildCsp, cspPlugin, scriptHash } from '../../scripts/csp';
import { THEME_BOOT_PLACEHOLDER, injectThemeBoot, themeBootPlugin } from '../../scripts/themeBoot';
import { themeBootScript } from '../../src/features/appearance/bootScript';
import {
    APPEARANCE_STORAGE_KEY, CHROME_COLORS, readStoredAppearance, resolveTheme
} from '../../src/features/appearance/model';

type Outcome = { attributes: Record<string, string>; colorScheme: string; themeColor: string };

// Runs the boot script against a minimal page: what it leaves on <html> and
// in the theme-color meta.
function boot(stored: string | null, systemDark: boolean | 'no-matchMedia' | 'throws', options: { storageThrows?: boolean } = {}): Outcome {
    const attributes: Record<string, string> = {};
    const root = { setAttribute: (name: string, value: string) => { attributes[name] = value; }, style: { colorScheme: '' } };
    const head: Array<{ tag: string; attributes: Record<string, string> }> = [];
    const createElement = (tag: string) => {
        const element = { tag, attributes: {} as Record<string, string>, setAttribute: (name: string, value: string) => { element.attributes[name] = value; } };
        return element;
    };
    const context: Record<string, unknown> = {
        document: { documentElement: root, createElement, head: { appendChild: (element: (typeof head)[number]) => head.push(element) } },
        localStorage: {
            getItem: (key: string) => {
                if (options.storageThrows) throw new Error('SecurityError');
                return key === APPEARANCE_STORAGE_KEY ? stored : null;
            }
        },
        JSON
    };
    if (systemDark === 'throws') context.matchMedia = () => { throw new Error('nope'); };
    else if (systemDark !== 'no-matchMedia') context.matchMedia = () => ({ matches: systemDark });
    vm.runInNewContext(themeBootScript(), context);
    // One theme-color meta, added to <head>.
    expect(head.map((element) => [element.tag, element.attributes.name])).toEqual([['meta', 'theme-color']]);
    return { attributes, colorScheme: root.style.colorScheme, themeColor: head[0].attributes.content };
}

// What the app itself makes of the same storage (model.ts + dom.ts).
function expected(stored: string | null, systemDark: boolean): Outcome {
    const prefs = readStoredAppearance({ getItem: () => stored });
    const theme = resolveTheme(prefs.theme, systemDark);
    return {
        attributes: { 'data-theme': theme, 'data-accent': prefs.accent, 'data-density': prefs.density },
        colorScheme: theme,
        themeColor: CHROME_COLORS[theme]
    };
}

describe('theme boot script', () => {
    const STORED: Array<string | null> = [
        null,
        '',
        'not json',
        '42',
        'null',
        '[]',
        JSON.stringify({ theme: 'light' }),
        JSON.stringify({ theme: 'light', accent: 'violet', density: 'compact' }),
        JSON.stringify({ theme: 'system', accent: 'fuchsia' }),
        JSON.stringify({ theme: 'dark', accent: 'emerald', density: 'comfortable', terminalTheme: 'nord' }),
        JSON.stringify({ theme: 'sepia', accent: 'pink', density: 'cosy' }),
        JSON.stringify({ theme: 1, accent: ['teal'], density: null }),
        JSON.stringify({ theme: 'toString', accent: 'constructor' })
    ];

    it.each(STORED.flatMap((stored) => [true, false].map((systemDark) => [stored, systemDark] as const)))(
        'agrees with the app for %j (system dark: %s)',
        (stored, systemDark) => {
            expect(boot(stored, systemDark)).toEqual(expected(stored, systemDark));
        }
    );

    it('falls back to dark for "system" when the OS cannot be asked, like the app', () => {
        const stored = JSON.stringify({ theme: 'system' });
        expect(boot(stored, 'no-matchMedia').attributes['data-theme']).toBe('dark');
        expect(boot(stored, 'throws').attributes['data-theme']).toBe('dark');
    });

    it('uses the defaults when storage is blocked', () => {
        expect(boot(null, true, { storageThrows: true })).toEqual(expected(null, true));
    });

    it('takes the place index.html marks, while serving and in builds', () => {
        const plugin = themeBootPlugin('code()');
        expect(plugin.apply).toBeUndefined();
        const transform = plugin.transformIndexHtml as IndexHtmlTransformHook;
        expect(transform.call(undefined as never, `<head>${THEME_BOOT_PLACEHOLDER}</head>`, {} as never)).toBe('<head><script>code()</script></head>');
        // Replacement patterns in the code are kept as they are.
        expect(injectThemeBoot(`a ${THEME_BOOT_PLACEHOLDER} b`, 'x="$&"')).toBe('a <script>x="$&"</script> b');
        expect(() => injectThemeBoot('<head></head>', 'code()')).toThrow(/theme-boot/);
    });

    it('runs early in index.html: after the charset, before any stylesheet or script', () => {
        const html = fs.readFileSync(path.join(__dirname, '../../index.html'), 'utf8');
        const at = html.indexOf(THEME_BOOT_PLACEHOLDER);
        expect(at).toBeGreaterThan(html.indexOf('<meta charset'));
        expect(at).toBeLessThan(html.indexOf('</head>'));
        expect(html.slice(0, at)).not.toMatch(/<link|<script|<style/);
        // The boot script adds the theme-color meta; a second one would win over it.
        expect(html).not.toContain('theme-color');
    });

    it('is the only inline script the built page allows, by its hash', () => {
        const code = themeBootScript();
        const digest = createHash('sha256').update(code).digest('base64');
        expect(scriptHash(code)).toBe(`'sha256-${digest}'`);
        const scriptSrc = buildCsp(undefined, [code]).split('; ').find((directive) => directive.startsWith('script-src '));
        // W7-S6: 'wasm-unsafe-eval' lets the RDP client compile WebAssembly; it allows no inline script.
        expect(scriptSrc).toBe(`script-src 'self' 'wasm-unsafe-eval' 'sha256-${digest}'`);
        const transform = cspPlugin(undefined, [code]).transformIndexHtml as IndexHtmlTransformHook;
        const [meta] = transform.call(undefined as never, '', {} as never) as Array<{ attrs: Record<string, string> }>;
        expect(meta.attrs.content).toBe(buildCsp(undefined, [code]));
    });
});
