import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { acceptKey, acceptWebSocket, CLOSE, handshakeProblem, type WebSocketConnection } from './websocket';

// The gateway's WebSocket server against Node's own WebSocket client and
// against hand-made frames for what a client must not send.

type Harness = { port: number; connections: WebSocketConnection[]; close: () => Promise<void> };

const servers: http.Server[] = [];
// Upgraded sockets leave the HTTP server: they are closed here.
const sockets = new Set<net.Socket | import("node:stream").Duplex>();

async function startServer(options: { maxMessageBytes?: number; keepAliveMs?: number; onConnection?: (ws: WebSocketConnection) => void } = {}): Promise<Harness> {
    const connections: WebSocketConnection[] = [];
    const server = http.createServer((_req, res) => res.end());
    server.on('upgrade', (req, socket, head) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        const problem = handshakeProblem(req);
        if (problem) {
            socket.end(`HTTP/1.1 400 Bad Request\r\n\r\n${problem}`);
            return;
        }
        const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: options.maxMessageBytes ?? 1024, keepAliveMs: options.keepAliveMs });
        connections.push(ws);
        if (options.onConnection) options.onConnection(ws);
        else ws.on('message', (data) => ws.send(Buffer.concat([Buffer.from('echo:'), data])));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    return {
        port: (server.address() as AddressInfo).port,
        connections,
        close: () => new Promise((resolve) => server.close(() => resolve())),
    };
}

afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    for (const server of servers.splice(0)) {
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});

// A raw client: does the handshake, then writes the frames the test builds.
async function rawClient(port: number): Promise<{ socket: net.Socket; received: () => Buffer; closed: Promise<void> }> {
    const socket = net.connect(port, '127.0.0.1');
    sockets.add(socket);
    const key = randomBytes(16).toString('base64');
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); });
    const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
    socket.on('error', () => undefined);
    await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: ${key}\r\n\r\n`);
    await waitFor(() => buffer.includes('\r\n\r\n'));
    const head = buffer.subarray(0, buffer.indexOf('\r\n\r\n') + 4).toString();
    expect(head).toContain('101 Switching Protocols');
    expect(head).toContain(`Sec-WebSocket-Accept: ${acceptKey(key)}`);
    buffer = buffer.subarray(buffer.indexOf('\r\n\r\n') + 4);
    return { socket, received: () => buffer, closed };
}

function frame(opcode: number, payload: Buffer, options: { fin?: boolean; mask?: boolean; rsv?: number } = {}): Buffer {
    const fin = options.fin ?? true;
    const masked = options.mask ?? true;
    const first = (fin ? 0x80 : 0) | (options.rsv ?? 0) | opcode;
    let header: Buffer;
    if (payload.length < 126) header = Buffer.from([first, (masked ? 0x80 : 0) | payload.length]);
    else {
        header = Buffer.from([first, (masked ? 0x80 : 0) | 126, 0, 0]);
        header.writeUInt16BE(payload.length, 2);
    }
    if (!masked) return Buffer.concat([header, payload]);
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i += 1) body[i] ^= mask[i & 3];
    return Buffer.concat([header, mask, body]);
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}

// The close code in a server close frame at the start of `bytes`.
const closeCode = (bytes: Buffer) => (bytes[0] === 0x88 ? bytes.readUInt16BE(2) : null);

describe('WebSocket handshake', () => {
    it('validates the upgrade request', () => {
        const request = (headers: Record<string, string>, method = 'GET') => ({ method, headers }) as unknown as http.IncomingMessage;
        const good = { upgrade: 'websocket', connection: 'keep-alive, Upgrade', 'sec-websocket-version': '13', 'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==' };
        expect(handshakeProblem(request(good))).toBeNull();
        expect(handshakeProblem(request(good, 'POST'))).toMatch(/GET/);
        expect(handshakeProblem(request({ ...good, upgrade: 'h2c' }))).toMatch(/not a WebSocket/);
        expect(handshakeProblem(request({ ...good, connection: 'close' }))).toMatch(/Connection/);
        expect(handshakeProblem(request({ ...good, 'sec-websocket-version': '8' }))).toMatch(/version/);
        expect(handshakeProblem(request({ ...good, 'sec-websocket-key': 'short' }))).toMatch(/Key/);
    });

    it('answers with the key of RFC 6455', () => {
        expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
    });
});

describe('WebSocket messages', () => {
    it('exchanges binary messages with a standard client', async () => {
        const { port } = await startServer();
        const client = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        client.binaryType = 'arraybuffer';
        const replies: string[] = [];
        client.onmessage = (event) => replies.push(Buffer.from(event.data as ArrayBuffer).toString());
        await new Promise((resolve) => { client.onopen = resolve; });
        client.send(new TextEncoder().encode('ping'));
        client.send(new Uint8Array(300).fill(0x61));
        await waitFor(() => replies.length === 2);
        expect(replies[0]).toBe('echo:ping');
        expect(replies[1]).toBe(`echo:${'a'.repeat(300)}`);
        const closed = new Promise<CloseEvent>((resolve) => { client.onclose = resolve; });
        client.close(1000, 'done');
        expect((await closed).code).toBe(1000);
    });

    it('reassembles fragments and answers pings in between', async () => {
        const { port } = await startServer();
        const { socket, received } = await rawClient(port);
        socket.write(frame(0x2, Buffer.from('he'), { fin: false }));
        socket.write(frame(0x9, Buffer.from('p1')));
        socket.write(frame(0x0, Buffer.from('ll'), { fin: false }));
        socket.write(frame(0x0, Buffer.from('o')));
        await waitFor(() => received().includes('echo:hello'));
        // pong "p1" (unmasked, from the server) came first.
        expect(received().subarray(0, 4)).toEqual(Buffer.from([0x8a, 0x02, 0x70, 0x31]));
    });

    it('delivers a frame split across many writes', async () => {
        const { port } = await startServer();
        const { socket, received } = await rawClient(port);
        const bytes = frame(0x2, Buffer.from('slow'));
        for (const byte of bytes) socket.write(Buffer.from([byte]));
        await waitFor(() => received().includes('echo:slow'));
    });

    it.each([
        ['unmasked frames', frame(0x2, Buffer.from('x'), { mask: false }), CLOSE.protocolError],
        ['reserved bits', frame(0x2, Buffer.from('x'), { rsv: 0x40 }), CLOSE.protocolError],
        ['text messages', frame(0x1, Buffer.from('x')), CLOSE.unsupportedData],
        ['unknown opcodes', frame(0x3, Buffer.from('x')), CLOSE.protocolError],
        ['fragmented control frames', frame(0x9, Buffer.from('x'), { fin: false }), CLOSE.protocolError],
        ['continuations without a message', frame(0x0, Buffer.from('x')), CLOSE.protocolError],
        ['messages over the limit', frame(0x2, Buffer.alloc(2000)), CLOSE.tooBig],
    ])('closes the connection on %s', async (_name, bytes, code) => {
        const { port, connections } = await startServer();
        const { socket, received, closed } = await rawClient(port);
        socket.write(bytes);
        await waitFor(() => received().length >= 4);
        expect(closeCode(received())).toBe(code);
        expect(connections[0].isOpen).toBe(false);
        socket.write(frame(0x8, Buffer.from([0x03, 0xe8])));
        await closed;
    });

    it('closes when fragments add up to more than the limit', async () => {
        const { port } = await startServer();
        const { socket, received } = await rawClient(port);
        socket.write(frame(0x2, Buffer.alloc(600), { fin: false }));
        socket.write(frame(0x0, Buffer.alloc(600)));
        await waitFor(() => received().length >= 4);
        expect(closeCode(received())).toBe(CLOSE.tooBig);
    });

    it('answers a close frame and reports the code', async () => {
        let reported: [number, string] | null = null;
        const { port } = await startServer({ onConnection: (ws) => ws.on('close', (code, reason) => { reported = [code, reason]; }) });
        const { socket, received, closed } = await rawClient(port);
        socket.write(frame(0x8, Buffer.concat([Buffer.from([0x0f, 0xa0]), Buffer.from('bye')])));
        await closed;
        expect(closeCode(received())).toBe(4000);
        expect(reported).toEqual([4000, 'bye']);
    });

    it('drops a client that stops answering pings', async () => {
        const { port, connections } = await startServer({ keepAliveMs: 40 });
        const { received, closed } = await rawClient(port);
        await closed;
        // It was pinged before it was dropped.
        expect(received().subarray(0, 2)).toEqual(Buffer.from([0x89, 0x00]));
        expect(connections[0].isOpen).toBe(false);
    });

    it('pings before it drops a client, also after the event loop was busy, and keeps one that answers', async () => {
        const stalled = await startServer({ keepAliveMs: 40, onConnection: () => {
            // Busy for longer than two intervals before the first tick.
            const until = Date.now() + 150;
            while (Date.now() < until) { /* busy */ }
        } });
        const silent = await rawClient(stalled.port);
        await silent.closed;
        expect(silent.received().subarray(0, 2)).toEqual(Buffer.from([0x89, 0x00]));

        const { port, connections } = await startServer({ keepAliveMs: 40 });
        const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
        await new Promise((resolve) => { ws.onopen = resolve; });
        // The standard client answers the pings.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(connections[0].isOpen).toBe(true);
        ws.close();
    });

    it('sends nothing after closing', async () => {
        const { port, connections } = await startServer({ onConnection: () => undefined });
        const { received } = await rawClient(port);
        await waitFor(() => connections.length === 1);
        connections[0].close(CLOSE.normal, 'done');
        expect(connections[0].send(Buffer.from('late'))).toBe(false);
        await waitFor(() => received().length >= 4);
        expect(received().includes('late')).toBe(false);
    });
});
