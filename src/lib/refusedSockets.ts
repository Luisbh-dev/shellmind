// Sockets the backend refused for their token (see socket.ts). Kept apart from
// the socket factory so that the access gate, part of the app's first chunk,
// can renew them without pulling in the socket.io client.

type Reconnectable = { connect: () => unknown };

const refused = new Set<Reconnectable>();

export function markRefused(socket: Reconnectable): void {
    refused.add(socket);
}

export function clearRefused(socket: Reconnectable): void {
    refused.delete(socket);
}

// After the user unlocked the app again (a new access token): every socket
// that was refused for its old token connects once more with the new one, so
// terminals, file sessions and log streams resume without being reopened.
export function reconnectRefusedSockets(): number {
    const sockets = [...refused];
    refused.clear();
    for (const socket of sockets) socket.connect();
    return sockets.length;
}
