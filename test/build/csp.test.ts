import { describe, expect, it } from 'vitest';
import type { IndexHtmlTransformHook } from 'vite';
import { buildCsp, cspPlugin } from '../../scripts/csp';

const directives = (csp: string) =>
    Object.fromEntries(csp.split('; ').map((directive) => {
        const [name, ...sources] = directive.split(' ');
        return [name, sources];
    }));

describe('buildCsp', () => {
    it('locks scripts, objects, base and forms down and allows the loopback backend', () => {
        expect(directives(buildCsp())).toEqual({
            'default-src': ["'self'"],
            'script-src': ["'self'", "'wasm-unsafe-eval'"],
            'style-src': ["'self'", "'unsafe-inline'"],
            'img-src': ["'self'", 'data:', 'blob:'],
            'font-src': ["'self'", 'data:'],
            'connect-src': ["'self'", 'data:', 'http://127.0.0.1:*', 'http://localhost:*', 'ws://127.0.0.1:*', 'ws://localhost:*'],
            'object-src': ["'none'"],
            'base-uri': ["'none'"],
            'form-action': ["'none'"],
        });
    });

    it('adds the VITE_API_BASE origin with its WebSocket variant', () => {
        expect(directives(buildCsp('https://api.example.com/base/'))['connect-src'].slice(-2))
            .toEqual(['https://api.example.com', 'wss://api.example.com']);
        expect(directives(buildCsp('http://10.0.0.5:3001'))['connect-src'].slice(-2))
            .toEqual(['http://10.0.0.5:3001', 'ws://10.0.0.5:3001']);
        expect(buildCsp('  ')).toBe(buildCsp());
    });

    it('refuses an API base that is not an http(s) URL', () => {
        expect(() => buildCsp('api.example.com')).toThrow(/not a valid URL/);
        expect(() => buildCsp('ftp://api.example.com')).toThrow(/http\(s\)/);
    });
});

describe('the embedded Remote Desktop client', () => {
    // W7-S6: IronRDP compiles its inlined WebAssembly (fetched from a data:
    // URL) and talks to the gateway WebSocket of the backend.
    it('may compile WebAssembly but never eval, and fetch its data: module', () => {
        const csp = directives(buildCsp('https://api.example.com', ['boot()']));
        expect(csp['script-src']).toContain("'wasm-unsafe-eval'");
        expect(csp['script-src']).not.toContain("'unsafe-eval'");
        expect(csp['script-src']).not.toContain("'unsafe-inline'");
        expect(csp['connect-src']).toContain('data:');
        expect(csp['connect-src']).toEqual(expect.arrayContaining(['ws://127.0.0.1:*', 'wss://api.example.com']));
    });
});

describe('cspPlugin', () => {
    it('applies to builds only and prepends the meta tag to <head>', () => {
        const plugin = cspPlugin();
        expect(plugin.apply).toBe('build');
        const transform = plugin.transformIndexHtml as IndexHtmlTransformHook;
        expect(transform.call(undefined as never, '', {} as never)).toEqual([{
            tag: 'meta',
            attrs: { 'http-equiv': 'Content-Security-Policy', content: buildCsp() },
            injectTo: 'head-prepend',
        }]);
    });
});
