import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import pkg from '../../package.json';
import { rawRequest } from '../helpers/rawHttp';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Session-token auth, Host/Origin enforcement, body limits and the JSON error
// contract of the HTTP API.

let server: TestServer;

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

const MB = 1024 * 1024;

async function serverCount(): Promise<number> {
    const res = await server.fetch('/api/servers');
    const body = await res.json() as { data: unknown[] };
    return body.data.length;
}

describe('session token', () => {
    it('keeps GET /api/health public', async () => {
        const res = await fetch(`${server.baseUrl}/api/health`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true, version: pkg.version });
    });

    it.each([
        ['no Authorization header', {}],
        ['a wrong token', { authorization: 'Bearer not-the-token' }],
        ['the token without the Bearer scheme', null],
        ['an empty bearer', { authorization: 'Bearer ' }],
    ])('answers 401 with %s', async (_label, headers) => {
        const res = await fetch(`${server.baseUrl}/api/servers`, {
            headers: headers ?? { authorization: server.token },
        });
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer realm="ShellMind"');
        expect(await res.json()).toEqual({ error: 'Authentication required', code: 'UNAUTHORIZED' });
    });

    it('accepts the right token', async () => {
        const res = await server.fetch('/api/session');
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ authenticated: true });
        expect((await server.fetch('/api/servers')).status).toBe(200);
    });

    it('never runs a protected handler without the token', async () => {
        const before = await serverCount();
        const res = await fetch(`${server.baseUrl}/api/servers`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'sneaky', ip: '10.9.9.9', type: 'linux' }),
        });
        expect(res.status).toBe(401);
        expect(await serverCount()).toBe(before);
    });

    it('protects unknown paths too, and 404s them as JSON once authenticated', async () => {
        expect((await fetch(`${server.baseUrl}/`)).status).toBe(401);
        expect((await fetch(`${server.baseUrl}/api/nope`)).status).toBe(401);

        const res = await server.fetch('/api/nope');
        expect(res.status).toBe(404);
        expect(await res.json()).toEqual({ error: 'Not found: GET /api/nope', code: 'NOT_FOUND' });
    });

    it('answers CORS preflights from allowed origins without a token', async () => {
        const res = await fetch(`${server.baseUrl}/api/servers`, {
            method: 'OPTIONS',
            headers: {
                origin: 'http://localhost:5173',
                'access-control-request-method': 'POST',
                'access-control-request-headers': 'authorization,content-type',
            },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
        expect(res.headers.get('access-control-allow-headers')).toBe('authorization,content-type');
    });
});

describe('Host and Origin enforcement', () => {
    it.each([
        'evil.example',
        'evil.example:3001',
        'localhost.evil.example',
        '127.0.0.2',
    ])('refuses Host %s with 403 before authentication', async (host) => {
        for (const path of ['/api/health', '/api/servers']) {
            const res = await rawRequest(server.port, { path, headers: { host, ...server.authHeaders } });
            expect(res.status).toBe(403);
            expect(res.body).toEqual({ error: 'Host not allowed', code: 'HOST_NOT_ALLOWED' });
        }
    });

    it.each(['localhost', '127.0.0.1', '[::1]'])('serves the loopback name %s on any port', async (name) => {
        const res = await rawRequest(server.port, { path: '/api/health', headers: { host: `${name}:${server.port}` } });
        expect(res.status).toBe(200);
    });

    it('refuses foreign origins with 403 even on the public health route', async () => {
        const res = await rawRequest(server.port, { path: '/api/health', headers: { origin: 'https://evil.example' } });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
    });

    // A sandboxed iframe on any website sends Origin "null"; only the desktop
    // backend accepts it (desktop-origin.test.ts).
    it.each(['null', 'file://'])('refuses the %s origin even with the token', async (origin) => {
        const res = await server.fetch('/api/servers', { headers: { origin } });
        expect(res.status).toBe(403);
        expect(await res.json()).toEqual({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
    });
});

describe('request bodies', () => {
    const putHistory = (size: number, headers: Record<string, string> = server.authHeaders) =>
        fetch(`${server.baseUrl}/api/chat/history/7`, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ messages: [{ role: 'user', content: 'x'.repeat(size) }] }),
        });

    it('lets the chat routes carry long conversations (8 MB)', async () => {
        const res = await putHistory(3 * MB);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ message: 'success', count: 1 });
    });

    it('answers 413 with a JSON message above the chat limit', async () => {
        const res = await putHistory(9 * MB);
        expect(res.status).toBe(413);
        expect(res.headers.get('content-type')).toMatch(/application\/json/);
        expect(await res.json()).toEqual({ error: 'Request body is too large (limit 8 MB).', code: 'PAYLOAD_TOO_LARGE' });
    });

    it('keeps other routes at 1 MB', async () => {
        const res = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'big', ip: '10.0.0.1', type: 'linux', notes: 'x'.repeat(1.5 * MB) }),
        });
        expect(res.status).toBe(413);
        expect(await res.json()).toEqual({ error: 'Request body is too large (limit 1 MB).', code: 'PAYLOAD_TOO_LARGE' });
    });

    it('does not read bodies of unauthenticated requests', async () => {
        const res = await putHistory(9 * MB, {});
        expect(res.status).toBe(401);
    });

    it('reports malformed JSON as a 400 without a stack trace', async () => {
        const res = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{"name": ',
        });
        expect(res.status).toBe(400);
        const text = await res.text();
        expect(JSON.parse(text)).toEqual({ error: 'Malformed JSON in request body.', code: 'MALFORMED_JSON' });
        expect(text).not.toMatch(/at \w+ \(|node_modules/);
    });
});

describe('security headers', () => {
    it('hardens API responses', async () => {
        const res = await server.fetch('/api/servers');
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('referrer-policy')).toBe('no-referrer');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(res.headers.get('cache-control')).toBe('no-store');
        expect(res.headers.get('x-powered-by')).toBeNull();
    });

    it('also hardens refusals', async () => {
        const res = await fetch(`${server.baseUrl}/api/servers`);
        expect(res.status).toBe(401);
        expect(res.headers.get('x-content-type-options')).toBe('nosniff');
        expect(res.headers.get('cache-control')).toBe('no-store');
    });
});
