import { afterEach, describe, expect, it, vi } from 'vitest';
import { bearerToken, generateToken, tokensMatch } from './auth';

async function loadAuth(token?: string) {
    vi.resetModules();
    process.env.DOTENV_CONFIG_QUIET = 'true';
    if (token === undefined) delete process.env.SHELLMIND_AUTH_TOKEN;
    else process.env.SHELLMIND_AUTH_TOKEN = token;
    return import('./auth');
}

afterEach(() => {
    delete process.env.SHELLMIND_AUTH_TOKEN;
});

describe('getSessionToken', () => {
    it('uses SHELLMIND_AUTH_TOKEN and removes it from the environment', async () => {
        const { getSessionToken } = await loadAuth('  from-env-token  ');
        expect(getSessionToken()).toEqual({ value: 'from-env-token', generated: false });
        expect(process.env.SHELLMIND_AUTH_TOKEN).toBeUndefined();
    });

    it('generates a stable random token when none is configured', async () => {
        const { getSessionToken } = await loadAuth();
        const session = getSessionToken();
        expect(session.generated).toBe(true);
        expect(session.value).toMatch(/^[\w-]{43}$/);
        expect(getSessionToken()).toBe(session);
    });
});

describe('tokensMatch', () => {
    it('matches only the exact token', () => {
        expect(tokensMatch('secret-token', 'secret-token')).toBe(true);
        expect(tokensMatch('secret-token', 'secret-tokeN')).toBe(false);
        expect(tokensMatch('secret-token', 'secret')).toBe(false);
        expect(tokensMatch('secret-token', 'secret-token-and-more')).toBe(false);
    });

    it('rejects missing and non-string candidates, and an empty expected token', () => {
        expect(tokensMatch('secret-token', undefined)).toBe(false);
        expect(tokensMatch('secret-token', '')).toBe(false);
        expect(tokensMatch('secret-token', 42)).toBe(false);
        expect(tokensMatch('secret-token', ['secret-token'])).toBe(false);
        expect(tokensMatch('', '')).toBe(false);
    });

    it('generates distinct url-safe tokens', () => {
        const a = generateToken();
        expect(a).toMatch(/^[\w-]{43}$/);
        expect(generateToken()).not.toBe(a);
    });
});

describe('bearerToken', () => {
    it('extracts the token of a Bearer header', () => {
        expect(bearerToken('Bearer abc.def-123')).toBe('abc.def-123');
        expect(bearerToken('bearer   abc ')).toBe('abc');
    });

    it('ignores other schemes and malformed values', () => {
        expect(bearerToken(undefined)).toBeUndefined();
        expect(bearerToken('abc')).toBeUndefined();
        expect(bearerToken('Basic abc')).toBeUndefined();
        expect(bearerToken('Bearer ')).toBeUndefined();
        expect(bearerToken('Bearer a b')).toBeUndefined();
    });
});
