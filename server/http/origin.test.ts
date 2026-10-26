import { afterEach, describe, expect, it, vi } from 'vitest';

// EXTRA_ALLOWED_ORIGINS and ALLOW_FILE_ORIGIN are read from the environment
// when server/config loads, so every case imports a fresh copy of the module.
async function loadOrigin(allowedOrigins?: string, allowFileOrigin = false) {
    vi.resetModules();
    process.env.DOTENV_CONFIG_QUIET = 'true';
    if (allowedOrigins === undefined) delete process.env.ALLOWED_ORIGINS;
    else process.env.ALLOWED_ORIGINS = allowedOrigins;
    if (allowFileOrigin) process.env.SHELLMIND_ALLOW_FILE_ORIGIN = '1';
    else delete process.env.SHELLMIND_ALLOW_FILE_ORIGIN;
    return import('./origin');
}

afterEach(() => {
    delete process.env.ALLOWED_ORIGINS;
    delete process.env.SHELLMIND_ALLOW_FILE_ORIGIN;
});

describe('isAllowedOrigin', () => {
    it('allows requests without an Origin', async () => {
        const { isAllowedOrigin } = await loadOrigin();
        expect(isAllowedOrigin(undefined)).toBe(true);
        expect(isAllowedOrigin('')).toBe(true);
    });

    it('refuses the "null" and "file://" origins, which any page can produce', async () => {
        const { isAllowedOrigin } = await loadOrigin();
        expect(isAllowedOrigin('null')).toBe(false);
        expect(isAllowedOrigin('file://')).toBe(false);
    });

    it('allows the origins of a file:// page for the desktop backend only', async () => {
        const { isAllowedOrigin } = await loadOrigin(undefined, true);
        expect(isAllowedOrigin('null')).toBe(true);
        expect(isAllowedOrigin('file://')).toBe(true);
        expect(isAllowedOrigin('https://evil.example')).toBe(false);
    });

    it('allows loopback origins on any port', async () => {
        const { isAllowedOrigin } = await loadOrigin();
        expect(isAllowedOrigin('http://localhost:5173')).toBe(true);
        expect(isAllowedOrigin('https://localhost')).toBe(true);
        expect(isAllowedOrigin('http://127.0.0.1:3001')).toBe(true);
        expect(isAllowedOrigin('http://[::1]:5173')).toBe(true);
    });

    it('rejects other and malformed origins', async () => {
        const { isAllowedOrigin } = await loadOrigin();
        expect(isAllowedOrigin('https://evil.example')).toBe(false);
        expect(isAllowedOrigin('http://localhost.evil.example')).toBe(false);
        expect(isAllowedOrigin('http://127.0.0.2')).toBe(false);
        expect(isAllowedOrigin('not a url')).toBe(false);
    });

    it('allows the origins listed in ALLOWED_ORIGINS, ignoring trailing slashes', async () => {
        const { isAllowedOrigin } = await loadOrigin(' https://shellmind.example.com/ ,https://b.example');
        expect(isAllowedOrigin('https://shellmind.example.com')).toBe(true);
        expect(isAllowedOrigin('https://shellmind.example.com/')).toBe(true);
        expect(isAllowedOrigin('https://b.example')).toBe(true);
        expect(isAllowedOrigin('https://c.example')).toBe(false);
        expect(isAllowedOrigin('http://shellmind.example.com')).toBe(false);
    });
});

describe('corsOriginCheck', () => {
    it('reports the decision through the callback without an error', async () => {
        const { corsOriginCheck } = await loadOrigin();
        const callback = vi.fn();
        corsOriginCheck('https://evil.example', callback);
        corsOriginCheck('http://localhost:5173', callback);
        expect(callback.mock.calls).toEqual([[null, false], [null, true]]);
    });
});
