import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { rawRequest, rawUpgrade } from '../helpers/rawHttp';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The socket.io handshake needs the session token (auth.token) and passes the
// same Host/Origin checks as the HTTP API.

let server: TestServer;
const sockets: Socket[] = [];

const WEBSOCKET_PATH = '/socket.io/?EIO=4&transport=websocket';
const POLLING_PATH = '/socket.io/?EIO=4&transport=polling';

function open(options: Parameters<typeof connect>[1]): Socket {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, ...options });
    sockets.push(socket);
    return socket;
}

// Resolves with null once connected, or with the connect_error.
function handshake(socket: Socket): Promise<(Error & { type?: string }) | null> {
    return new Promise((resolve) => {
        socket.once('connect', () => resolve(null));
        socket.once('connect_error', (error) => resolve(error));
    });
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
});

afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('socket handshake', () => {
    it('connects with the session token', async () => {
        expect(await handshake(open({ auth: { token: server.token } }))).toBeNull();
    });

    it.each([
        ['without a token', {}],
        ['with a wrong token', { token: 'nope' }],
        ['with a non-string token', { token: 42 }],
    ])('is refused %s', async (_label, auth) => {
        expect((await handshake(open({ auth })))?.message).toBe('unauthorized');
    });

    it('is refused at the WebSocket upgrade for a foreign origin, even with the token', async () => {
        const error = await handshake(open({ auth: { token: server.token }, extraHeaders: { origin: 'https://evil.example' } }));
        // The upgrade itself failed: the connection never reached the token check.
        expect(error).toMatchObject({ type: 'TransportError', message: 'websocket error' });

        const res = await rawUpgrade(server.port, { path: WEBSOCKET_PATH, headers: { origin: 'https://evil.example' } });
        expect(res).toEqual({ status: 400, text: 'Origin not allowed' });
    });

    it.each([
        ['a foreign Host', { host: 'rebind.evil.example' }, 'Host not allowed'],
        ['a foreign Origin', { origin: 'https://evil.example' }, 'Origin not allowed'],
        ['the "null" Origin of a sandboxed iframe', { origin: 'null' }, 'Origin not allowed'],
    ])('refuses a handshake with %s', async (_label, headers, reason) => {
        const polling = await rawRequest(server.port, { path: POLLING_PATH, headers });
        expect(polling.status).toBe(403);
        expect(polling.body).toEqual({ code: 4, message: reason });

        expect(await rawUpgrade(server.port, { path: WEBSOCKET_PATH, headers })).toEqual({ status: 400, text: reason });
    });

    it('lets loopback handshakes through to the token check', async () => {
        expect((await rawRequest(server.port, { path: POLLING_PATH })).status).toBe(200);
        expect((await rawUpgrade(server.port, { path: WEBSOCKET_PATH, headers: { origin: 'http://localhost:5173' } })).status).toBe(101);
    });
});
