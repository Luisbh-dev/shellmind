import { afterEach, describe, expect, it, vi } from 'vitest';

// ALLOWED_HOSTS / ALLOWED_ORIGINS are read when server/config loads, so every
// case imports a fresh copy of the module.
async function loadNetwork(env: { ALLOWED_HOSTS?: string; ALLOWED_ORIGINS?: string } = {}) {
    vi.resetModules();
    process.env.DOTENV_CONFIG_QUIET = 'true';
    for (const name of ['ALLOWED_HOSTS', 'ALLOWED_ORIGINS'] as const) {
        if (env[name] === undefined) delete process.env[name];
        else process.env[name] = env[name];
    }
    return import('./network');
}

afterEach(() => {
    delete process.env.ALLOWED_HOSTS;
    delete process.env.ALLOWED_ORIGINS;
});

describe('isAllowedHost', () => {
    it('accepts loopback names on any port', async () => {
        const { isAllowedHost } = await loadNetwork();
        for (const host of ['localhost', 'localhost:3001', '127.0.0.1:49152', '[::1]:5173', 'LOCALHOST:3001']) {
            expect(isAllowedHost(host)).toBe(true);
        }
    });

    it('rejects everything else, including look-alikes and malformed values', async () => {
        const { isAllowedHost } = await loadNetwork();
        for (const host of [undefined, '', 'evil.example', 'localhost.evil.example', 'localhost.', '127.0.0.2:3001', '0.0.0.0:3001', 'user@localhost', 'localhost/x', 'a b']) {
            expect(isAllowedHost(host)).toBe(false);
        }
    });

    it('accepts ALLOWED_HOSTS entries, with or without a fixed port', async () => {
        const { isAllowedHost } = await loadNetwork({ ALLOWED_HOSTS: ' ShellMind.example.com , 192.168.1.10:3001 ' });
        expect(isAllowedHost('shellmind.example.com')).toBe(true);
        expect(isAllowedHost('shellmind.example.com:8443')).toBe(true);
        expect(isAllowedHost('192.168.1.10:3001')).toBe(true);
        expect(isAllowedHost('192.168.1.10:3002')).toBe(false);
        expect(isAllowedHost('192.168.1.10')).toBe(false);
        expect(isAllowedHost('other.example.com')).toBe(false);
    });

    it('accepts the hosts of ALLOWED_ORIGINS', async () => {
        const { isAllowedHost } = await loadNetwork({ ALLOWED_ORIGINS: 'https://shellmind.example.com' });
        expect(isAllowedHost('shellmind.example.com')).toBe(true);
        expect(isAllowedHost('example.com')).toBe(false);
    });
});

describe('requestRejection', () => {
    it('checks the Host first, then the Origin', async () => {
        const { requestRejection } = await loadNetwork();
        expect(requestRejection({ host: 'localhost:3001' })).toBeNull();
        expect(requestRejection({ host: '127.0.0.1:3001', origin: 'http://localhost:5173' })).toBeNull();
        expect(requestRejection({ host: 'localhost:3001', origin: 'null' })).toBe('Origin not allowed');
        expect(requestRejection({ host: 'evil.example', origin: 'https://evil.example' })).toBe('Host not allowed');
        expect(requestRejection({ host: 'localhost:3001', origin: 'https://evil.example' })).toBe('Origin not allowed');
    });

    it('accepts the own origin of an ALLOWED_HOSTS name (the UI of `npm run serve`)', async () => {
        const { requestRejection } = await loadNetwork({ ALLOWED_HOSTS: '192.168.1.10:3001,shellmind.example.com' });
        expect(requestRejection({ host: '192.168.1.10:3001', origin: 'http://192.168.1.10:3001' })).toBeNull();
        expect(requestRejection({ host: 'shellmind.example.com', origin: 'https://shellmind.example.com' })).toBeNull();
        expect(requestRejection({ host: 'shellmind.example.com', origin: 'http://shellmind.example.com' })).toBeNull();
        expect(requestRejection({ host: 'shellmind.example.com:443', origin: 'https://shellmind.example.com' })).toBeNull();
        expect(requestRejection({ host: 'shellmind.example.com:8443', origin: 'https://shellmind.example.com:8443' })).toBeNull();
    });

    it('still refuses any other origin sent to an ALLOWED_HOSTS name', async () => {
        const { requestRejection } = await loadNetwork({ ALLOWED_HOSTS: '192.168.1.10:3001,shellmind.example.com' });
        for (const origin of [
            'http://192.168.1.10:3002',
            'http://192.168.1.10',
            'https://evil.example',
            'http://shellmind.example.com.evil.example',
            'https://shellmind.example.com:8443',
            'null',
            'file://',
        ]) {
            const host = origin.includes('192.168') ? '192.168.1.10:3001' : 'shellmind.example.com';
            expect(requestRejection({ host, origin }), origin).toBe('Origin not allowed');
        }
    });
});
