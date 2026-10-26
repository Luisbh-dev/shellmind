import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Express, Router } from 'express';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// arch-error-protocol-inconsistent: the same failure reached the client with
// or without a code depending on the route. Every route of the API is walked
// here with ids that do not exist and bodies that make no sense, and every
// non-2xx JSON answer must be the one envelope { error, code, details? }.
// The chat answer stream (POST /api/chat, which would call the AI provider)
// is left out; its errors are covered by the chat API tests.

let server: TestServer;
let app: Express;

type Route = { method: string; path: string };

// Express 5 keeps the routers' layers in app.router.stack.
type Layer = { route?: { path: string; methods: Record<string, boolean> }; handle?: { stack?: Layer[] } };

function routesOf(stack: Layer[]): Route[] {
    return stack.flatMap((layer): Route[] => {
        if (layer.route) return Object.keys(layer.route.methods).map((method) => ({ method: method.toUpperCase(), path: layer.route!.path }));
        return layer.handle?.stack ? routesOf(layer.handle.stack) : [];
    });
}

const fill = (path: string) => path.replace(/:runId/g, 'no-such-run').replace(/:[A-Za-z]+/g, '999999');

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    server = await bootTestServer();
    const { createApp } = await import('../../server/http/app');
    app = createApp({ authToken: server.token });
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

async function expectEnvelope(label: string, res: Response): Promise<void> {
    if (res.status < 400) return;
    expect(res.headers.get('content-type'), label).toMatch(/^application\/json/);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body.error, `${label}: ${JSON.stringify(body)}`).toBe('string');
    expect(typeof body.code, `${label}: ${JSON.stringify(body)}`).toBe('string');
    expect(Object.keys(body).filter((key) => !['error', 'code', 'details'].includes(key)), label).toEqual([]);
}

describe('the API error envelope', () => {
    it('is { error, code, details? } on every failing route', async () => {
        const routes = routesOf((app as unknown as { router: Router & { stack: Layer[] } }).router.stack)
            .filter((route) => route.path !== '/api/chat' && route.path !== '/api/import/ssh-config/preview');
        expect(routes.length).toBeGreaterThan(40);

        let failures = 0;
        for (const route of routes) {
            for (const body of [undefined, { serverId: 999999, retentionDays: 'x', ids: 'x', snippets: 'x', key: 42, model: 42, os_detail: 7, favorite: 'x' }]) {
                const res = await server.fetch(fill(route.path), {
                    method: route.method,
                    headers: body === undefined || route.method === 'GET' ? {} : { 'content-type': 'application/json' },
                    body: body === undefined || route.method === 'GET' ? undefined : JSON.stringify(body),
                });
                if (res.status >= 400) failures += 1;
                await expectEnvelope(`${route.method} ${fill(route.path)}`, res);
            }
        }
        // The walk did reach the failure paths.
        expect(failures).toBeGreaterThan(routes.length);
    });

    it('covers authentication, unknown routes, bad bodies and the network guard', async () => {
        await expectEnvelope('no token', await fetch(`${server.baseUrl}/api/servers`));
        await expectEnvelope('unknown route', await server.fetch('/api/nope'));
        await expectEnvelope('malformed JSON', await server.fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' }));
        await expectEnvelope('too large', await server.fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ notes: 'x'.repeat(2 * 1024 * 1024) }) }));
        await expectEnvelope('foreign origin', await fetch(`${server.baseUrl}/api/health`, { headers: { origin: 'https://evil.example' } }));
    });

    it('answers an unexpected failure with a generic 500 and logs it redacted', async () => {
        const { sendError } = await import('../../server/http/respond');
        const sent: { status?: number; body?: unknown } = {};
        const res = {
            headersSent: false,
            status(code: number) { sent.status = code; return this; },
            json(body: unknown) { sent.body = body; return this; },
        };
        const error = vi.mocked(console.error);
        error.mockClear();

        sendError(res as never, new Error("SQLITE_ERROR: no such table: secrets_of_C:\\Users\\me"), 'GET /api/thing');

        expect(sent).toEqual({ status: 500, body: { error: 'Internal server error.', code: 'INTERNAL' } });
        // Through the logger (level, scope), not a bare console.error.
        expect(error).toHaveBeenCalledWith(expect.stringMatching(/ ERROR \[http\] GET \/api\/thing failed$/), expect.any(Error));
    });
});
