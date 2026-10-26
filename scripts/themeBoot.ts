import type { Plugin } from 'vite';

// Puts the theme boot script (src/features/appearance/bootScript.ts) inline in
// index.html where it marks the spot, while serving and in builds: early in
// <head>, before any stylesheet, so the saved theme (and its colour scheme,
// which the browser paints the empty page with) is set before the first
// paint in every browser. The built page's CSP allows it by hash
// (scripts/csp.ts).

export const THEME_BOOT_PLACEHOLDER = '<!-- shellmind:theme-boot -->';

export function injectThemeBoot(html: string, code: string): string {
    if (!html.includes(THEME_BOOT_PLACEHOLDER)) throw new Error(`index.html lacks the ${THEME_BOOT_PLACEHOLDER} marker`);
    return html.replace(THEME_BOOT_PLACEHOLDER, () => `<script>${code}</script>`);
}

export function themeBootPlugin(code: string): Plugin {
    return {
        name: 'shellmind-theme-boot',
        transformIndexHtml: (html) => injectThemeBoot(html, code)
    };
}
