import { describe, expect, it } from 'vitest';
import { externalUrl, isAppUrl } from '../../electron/urls';

describe('externalUrl', () => {
    it('lets web and mail links through, normalized', () => {
        expect(externalUrl('https://example.com/docs?a=1')).toBe('https://example.com/docs?a=1');
        expect(externalUrl('http://Example.com')).toBe('http://example.com/');
        expect(externalUrl('mailto:ops@example.com')).toBe('mailto:ops@example.com');
    });

    it.each([
        'file:///C:/Windows/System32/calc.exe',
        'file://attacker/share/x.png',
        'search-ms:query=secret&crumb=location:\\\\attacker\\share',
        'ms-msdt:/id PCWDiagnostic',
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'shellmind://open',
        '//attacker/share',
        'not a url',
    ])('refuses %s', (url) => {
        expect(externalUrl(url)).toBeNull();
    });
});

describe('isAppUrl', () => {
    const packaged = 'file:///C:/Program%20Files/ShellMind/resources/app.asar/dist/index.html';

    it('accepts the packaged index.html with any query or hash', () => {
        expect(isAppUrl(packaged, packaged)).toBe(true);
        expect(isAppUrl(`${packaged}?api=http://127.0.0.1:1234&token=t`, packaged)).toBe(true);
        expect(isAppUrl(`${packaged}#settings`, packaged)).toBe(true);
    });

    it('compares Windows paths case-insensitively only when asked to', () => {
        const other = packaged.replace('C:/Program%20Files', 'c:/program files');
        expect(isAppUrl(other, packaged, true)).toBe(true);
        expect(isAppUrl(other, packaged, false)).toBe(false);
    });

    it('refuses other files and other schemes', () => {
        expect(isAppUrl('file:///C:/Users/me/Downloads/phish.html', packaged)).toBe(false);
        expect(isAppUrl('file://attacker/share/dist/index.html', packaged)).toBe(false);
        expect(isAppUrl('https://evil.example/', packaged)).toBe(false);
        expect(isAppUrl('garbage', packaged)).toBe(false);
    });

    it('accepts the dev server origin only', () => {
        const dev = 'http://localhost:5173';
        expect(isAppUrl('http://localhost:5173/', dev)).toBe(true);
        expect(isAppUrl('http://localhost:5173/src/main.tsx?t=1', dev)).toBe(true);
        expect(isAppUrl('http://localhost:5174/', dev)).toBe(false);
        expect(isAppUrl('https://localhost:5173/', dev)).toBe(false);
        expect(isAppUrl('http://evil.example/', dev)).toBe(false);
    });
});
