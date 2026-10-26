import { beforeEach, describe, expect, it, vi } from 'vitest';
import { io } from 'socket.io-client';
import { onUnauthorized } from './api';
import { createSocket, reconnectRefusedSockets } from './socket';

// The stored session token, as the socket's handshake reads it.
const session = vi.hoisted(() => ({ token: undefined as string | undefined }));
vi.mock('./api', async (importOriginal) => ({ ...await importOriginal<typeof import('./api')>(), getAuthToken: () => session.token }));

// Just enough of a socket.io client socket: listeners, connect, disconnect.
function fakeSocket() {
    const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    const disconnected = vi.fn();
    return {
        on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        }),
        connect: vi.fn(),
        // createSocket wraps this method; the spy sees the real calls.
        disconnect: () => disconnected(),
        disconnected,
        emitLocal: (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((listener) => listener(...args))
    };
}

type FakeSocket = ReturnType<typeof fakeSocket>;

vi.mock('socket.io-client', () => ({ io: vi.fn() }));

beforeEach(() => {
    vi.mocked(io).mockReset();
    vi.mocked(io).mockImplementation((() => fakeSocket()) as never);
    reconnectRefusedSockets();
});

const created = () => vi.mocked(io).mock.results.map((result) => result.value as FakeSocket);

describe('createSocket', () => {
    it('connects websocket-first to the API base with a per-connect auth payload', () => {
        createSocket();

        const [url, options] = vi.mocked(io).mock.calls[0] as unknown as [string, Record<string, unknown>];
        expect(url).toBe('http://127.0.0.1:3001');
        expect(options.transports).toEqual(['websocket', 'polling']);
        expect(options.tryAllTransports).toBe(true);

        const callback = vi.fn();
        (options.auth as (cb: (data: object) => void) => void)(callback);
        expect(callback).toHaveBeenCalledWith({});
    });

    it('connects the sockets refused for their token again once the session is renewed', () => {
        createSocket();
        createSocket();
        const closed = createSocket();
        const [refusedOne, healthy, refusedThenClosed] = created();

        refusedOne.emitLocal('connect_error', new Error('unauthorized'));
        healthy.emitLocal('connect_error', new Error('xhr poll error'));
        refusedThenClosed.emitLocal('connect_error', new Error('unauthorized'));
        // Its panel went away meanwhile: it must stay closed.
        closed.disconnect();

        expect(reconnectRefusedSockets()).toBe(1);
        expect(refusedOne.connect).toHaveBeenCalledTimes(1);
        expect(healthy.connect).not.toHaveBeenCalled();
        expect(refusedThenClosed.connect).not.toHaveBeenCalled();
        expect(refusedThenClosed.disconnected).toHaveBeenCalledTimes(1);

        // Connected again: nothing left to renew.
        refusedOne.emitLocal('connect');
        expect(reconnectRefusedSockets()).toBe(0);
    });

    // A terminal reconnecting after the backend restarted with another token
    // may be the only thing talking to it: the refusal has to reach the gate.
    it('reports a handshake refused for its token like an HTTP 401, with the token it carried', () => {
        const refusals: Array<string | undefined> = [];
        const stop = onUnauthorized((token) => refusals.push(token));
        try {
            session.token = 'old-token';
            createSocket();
            const [socket] = created();
            const [, options] = vi.mocked(io).mock.calls[0] as unknown as [string, { auth: (cb: (data: object) => void) => void }];
            const handshake = vi.fn();
            options.auth(handshake);
            expect(handshake).toHaveBeenCalledWith({ token: 'old-token' });
            session.token = 'newer-token';

            socket.emitLocal('connect_error', new Error('xhr poll error'));
            expect(refusals).toEqual([]);
            socket.emitLocal('connect_error', new Error('unauthorized'));
            expect(refusals).toEqual(['old-token']);
        } finally {
            stop();
            session.token = undefined;
        }
    });
});
