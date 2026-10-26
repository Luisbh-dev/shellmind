// The single socket.io factory for the ShellMind backend.
import { io, type Socket } from 'socket.io-client';
import type { ClientToServerEvents, ServerToClientEvents } from '@shared/protocol';
import { getApiBase, getAuthToken, notifyUnauthorized } from './api';
import { clearRefused, markRefused } from './refusedSockets';

export { reconnectRefusedSockets } from './refusedSockets';

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

// The backend's handshake refusal of a missing or wrong token
// (server/sockets/io.ts).
const UNAUTHORIZED = 'unauthorized';

// WebSocket first, so the local backend is reached without long-polling round
// trips; polling stays as a fallback for proxies that block the upgrade. The
// auth payload is read on every (re)connect, so a renewed token is picked up.
// socket.io never retries a refusal by the server's middleware: a socket
// refused for its token waits until the session is renewed
// (reconnectRefusedSockets), unless its owner disconnects it first. The
// refusal is reported like an HTTP 401, so the access gate asks for the new
// token even when nothing else talks to the backend (a terminal reconnecting
// after the backend restarted with another token).
export function createSocket(): AppSocket {
    // The token the latest handshake carried.
    let handshakeToken: string | undefined;
    const socket: AppSocket = io(getApiBase(), {
        transports: ['websocket', 'polling'],
        tryAllTransports: true,
        auth: (cb) => {
            handshakeToken = getAuthToken();
            cb(handshakeToken ? { token: handshakeToken } : {});
        }
    });
    socket.on('connect_error', (error) => {
        if (error.message !== UNAUTHORIZED) return;
        markRefused(socket);
        notifyUnauthorized(handshakeToken);
    });
    socket.on('connect', () => clearRefused(socket));
    const disconnect = socket.disconnect.bind(socket);
    socket.disconnect = () => {
        clearRefused(socket);
        return disconnect();
    };
    return socket;
}
