import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { rawRequest } from '../helpers/rawHttp';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The desktop backend (SHELLMIND_ALLOW_FILE_ORIGIN=1, set by electron/main.ts)
// serves a file:// page. Electron sends no Origin on its fetches and
// "file://" on WebSocket handshakes; "null" is accepted as well.

let server: TestServer;
const sockets: Socket[] = [];

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer({ env: { SHELLMIND_ALLOW_FILE_ORIGIN: '1' } });
});

afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('desktop backend', () => {
    it.each(['null', 'file://'])('accepts API requests with the %s origin and the token', async (origin) => {
        const res = await server.fetch('/api/servers', { headers: { origin } });
        expect(res.status).toBe(200);
    });

    it('still requires the token from a file:// page', async () => {
        const res = await fetch(`${server.baseUrl}/api/servers`, { headers: { origin: 'null' } });
        expect(res.status).toBe(401);
    });

    it('lets the window open its WebSocket (Origin file://)', async () => {
        const socket = connect(server.baseUrl, {
            transports: ['websocket'],
            reconnection: false,
            forceNew: true,
            auth: { token: server.token },
            extraHeaders: { origin: 'file://' },
        });
        sockets.push(socket);
        const outcome = await new Promise<string | null>((resolve) => {
            socket.once('connect', () => resolve(null));
            socket.once('connect_error', (error) => resolve(error.message));
        });
        expect(outcome).toBeNull();
    });

    it('keeps refusing foreign origins', async () => {
        const res = await rawRequest(server.port, { path: '/api/health', headers: { origin: 'https://evil.example' } });
        expect(res.status).toBe(403);
    });
});
