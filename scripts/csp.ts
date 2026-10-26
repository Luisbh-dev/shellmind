import { createHash } from 'node:crypto';
import type { Plugin } from 'vite';

// Content-Security-Policy of the built UI. It is injected at build time only:
// the Vite dev server needs inline scripts (React refresh) that it would block.
// The UI talks to its backend on a loopback port chosen at launch (Electron) or
// to the origin it was served from (`npm run serve`), plus VITE_API_BASE when
// the API lives elsewhere. xterm and CodeMirror inject <style> elements.
// W7-S6: the embedded Remote Desktop client is WebAssembly (compiling it needs
// 'wasm-unsafe-eval', which still forbids eval) inlined in its module as a
// data: URL that it fetch()es (connect-src data:); its gateway is a WebSocket
// on the backend, covered by the loopback and VITE_API_BASE sources.

const LOOPBACK_SOURCES = ['http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*'];

function apiSources(apiBase: string | undefined): string[] {
    if (!apiBase?.trim()) return [];
    let url: URL;
    try {
        url = new URL(apiBase.trim());
    } catch {
        throw new Error(`VITE_API_BASE is not a valid URL: ${apiBase}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`VITE_API_BASE must be an http(s) URL: ${apiBase}`);
    }
    const socketProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return [url.origin, `${socketProtocol}//${url.host}`];
}

// A CSP source allowing exactly this inline script.
export function scriptHash(code: string): string {
    return `'sha256-${createHash('sha256').update(code, 'utf8').digest('base64')}'`;
}

// `inlineScripts`: the inline scripts index.html carries (the theme boot
// script), allowed by hash and nothing else inline.
export function buildCsp(apiBase?: string, inlineScripts: readonly string[] = []): string {
    const directives: Array<[string, string[]]> = [
        ['default-src', ["'self'"]],
        ['script-src', ["'self'", "'wasm-unsafe-eval'", ...inlineScripts.map(scriptHash)]],
        ['style-src', ["'self'", "'unsafe-inline'"]],
        ['img-src', ["'self'", 'data:', 'blob:']],
        ['font-src', ["'self'", 'data:']],
        ['connect-src', ["'self'", 'data:', ...LOOPBACK_SOURCES, ...apiSources(apiBase)]],
        ['object-src', ["'none'"]],
        ['base-uri', ["'none'"]],
        ['form-action', ["'none'"]]
    ];
    return directives.map(([name, sources]) => `${name} ${sources.join(' ')}`).join('; ');
}

export function cspPlugin(apiBase?: string, inlineScripts: readonly string[] = []): Plugin {
    const content = buildCsp(apiBase, inlineScripts);
    return {
        name: 'shellmind-csp',
        apply: 'build',
        transformIndexHtml: () => [
            // First in <head>: a meta policy only covers what is parsed after it.
            { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content }, injectTo: 'head-prepend' }
        ]
    };
}
