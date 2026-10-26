import { createHash } from "crypto";
import { EventEmitter } from "events";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

// The server side of RFC 6455, as much as the RDP gateway needs: binary
// messages (fragmented or not), ping/pong and the closing handshake, with a
// size limit per message. No extensions and no subprotocol are negotiated.
// Every protocol violation closes the connection with the code the RFC asks for.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export const CLOSE = {
    normal: 1000,
    goingAway: 1001,
    protocolError: 1002,
    unsupportedData: 1003,
    policyViolation: 1008,
    tooBig: 1009,
    internalError: 1011
} as const;

const OPCODE = { continuation: 0x0, text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

export type WebSocketOptions = {
    // Largest message accepted from the client (after reassembly).
    maxMessageBytes: number;
    // A ping goes out after this long without traffic from the client; the
    // connection is dropped when the next interval passes without any either.
    keepAliveMs?: number;
};

// Why a handshake cannot be accepted, or null when it can.
export function handshakeProblem(req: IncomingMessage): string | null {
    if (req.method !== "GET") return "WebSocket handshakes use GET";
    const upgrade = String(req.headers.upgrade ?? "").toLowerCase();
    if (upgrade !== "websocket") return "not a WebSocket upgrade";
    const connection = String(req.headers.connection ?? "").toLowerCase().split(",").map((token) => token.trim());
    if (!connection.includes("upgrade")) return "missing Connection: Upgrade";
    if (req.headers["sec-websocket-version"] !== "13") return "unsupported WebSocket version";
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || !/^[A-Za-z0-9+/]{22}==$/.test(key.trim())) return "invalid Sec-WebSocket-Key";
    return null;
}

export function acceptKey(key: string): string {
    return createHash("sha1").update(key.trim() + GUID).digest("base64");
}

// Writes a plain HTTP refusal on a socket that asked for an upgrade.
export function refuseUpgrade(socket: Duplex, status: number, reason: string): void {
    const body = JSON.stringify({ error: reason });
    const statusText: Record<number, string> = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found", 426: "Upgrade Required", 503: "Service Unavailable" };
    if (socket.writable) {
        socket.end(
            `HTTP/1.1 ${status} ${statusText[status] ?? "Error"}\r\nConnection: close\r\nContent-Type: application/json\r\n` +
            `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`
        );
    }
    setTimeout(() => socket.destroy(), 1000).unref();
}

function frameHeader(opcode: number, length: number): Buffer {
    if (length < 126) return Buffer.from([0x80 | opcode, length]);
    if (length < 0x10000) {
        const header = Buffer.alloc(4);
        header[0] = 0x80 | opcode;
        header[1] = 126;
        header.writeUInt16BE(length, 2);
        return header;
    }
    const header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
    return header;
}

class ProtocolError extends Error {
    constructor(readonly code: number, message: string) {
        super(message);
    }
}

// One accepted connection. "message" delivers binary messages, "drain" fires
// when a send that returned false has been flushed, "close" once at the end.
type WebSocketEvents = { message: [data: Buffer]; close: [code: number, reason: string]; drain: [] };

export class WebSocketConnection extends EventEmitter<WebSocketEvents> {
    private buffer: Buffer = Buffer.alloc(0);
    private fragments: Buffer[] = [];
    private fragmentBytes = 0;
    private fragmenting = false;
    private closing = false;
    private closed = false;
    private lastSeen = Date.now();
    // When the last keepalive ping went out (0: none yet).
    private pingedAt = 0;
    private keepAlive: NodeJS.Timeout | null = null;

    // `head`: bytes that arrived with the handshake (delivered on the next turn,
    // once the caller listens).
    constructor(private readonly socket: Duplex, private readonly options: WebSocketOptions, head?: Buffer) {
        super();
        socket.on("data", (chunk: Buffer) => this.onData(chunk));
        socket.on("drain", () => this.emit("drain"));
        socket.on("error", () => this.finish(CLOSE.goingAway, "transport error"));
        socket.on("close", () => this.finish(CLOSE.goingAway, ""));
        socket.on("end", () => this.finish(CLOSE.goingAway, ""));
        const interval = options.keepAliveMs;
        if (interval) {
            // A silent client is pinged; it is dropped only once it left that
            // ping unanswered for a whole interval (a busy event loop alone
            // never drops it).
            this.keepAlive = setInterval(() => {
                const now = Date.now();
                if (this.pingedAt > this.lastSeen) {
                    if (now - this.pingedAt >= interval) this.terminate();
                } else if (now - this.lastSeen >= interval) {
                    this.pingedAt = now;
                    this.writeFrame(OPCODE.ping, Buffer.alloc(0));
                }
            }, interval);
            this.keepAlive.unref();
        }
        if (head?.length) setImmediate(() => this.onData(head));
    }

    get isOpen(): boolean {
        return !this.closing && !this.closed;
    }

    // Sends one binary message; false when the transport is backed up (wait for "drain").
    send(data: Buffer): boolean {
        if (!this.isOpen) return false;
        return this.writeFrame(OPCODE.binary, data);
    }

    // Starts the closing handshake; the transport ends once the client answers (or soon after).
    close(code: number = CLOSE.normal, reason = ""): void {
        if (!this.isOpen) return;
        this.closing = true;
        const text = Buffer.from(reason, "utf8").subarray(0, 120);
        const payload = Buffer.alloc(2 + text.length);
        payload.writeUInt16BE(code, 0);
        text.copy(payload, 2);
        this.writeFrame(OPCODE.close, payload);
        setTimeout(() => this.terminate(code, reason), 2000).unref();
    }

    // Drops the transport without a closing handshake.
    terminate(code: number = CLOSE.goingAway, reason = ""): void {
        this.socket.destroy();
        this.finish(code, reason);
    }

    pause(): void {
        this.socket.pause();
    }

    resume(): void {
        this.socket.resume();
    }

    private writeFrame(opcode: number, payload: Buffer): boolean {
        if (this.closed || !this.socket.writable) return false;
        const header = frameHeader(opcode, payload.length);
        // Small frames go out in one write; large ones are not copied.
        if (payload.length < 16 * 1024) return this.socket.write(payload.length ? Buffer.concat([header, payload]) : header);
        this.socket.write(header);
        return this.socket.write(payload);
    }

    private finish(code: number, reason: string): void {
        if (this.closed) return;
        this.closed = true;
        if (this.keepAlive) clearInterval(this.keepAlive);
        this.buffer = Buffer.alloc(0);
        this.fragments = [];
        if (!this.socket.destroyed) {
            this.socket.end();
            setTimeout(() => this.socket.destroy(), 1000).unref();
        }
        this.emit("close", code, reason);
    }

    // Fails the connection (RFC 6455 7.1.7): a close frame with the reason,
    // then the transport ends without waiting for the client's answer.
    private fail(error: ProtocolError): void {
        if (this.closed) return;
        if (this.isOpen) {
            this.closing = true;
            const payload = Buffer.alloc(2);
            payload.writeUInt16BE(error.code, 0);
            this.writeFrame(OPCODE.close, payload);
        }
        this.finish(error.code, error.message);
    }

    private onData(chunk: Buffer): void {
        if (this.closed) return;
        this.lastSeen = Date.now();
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
        try {
            while (!this.closed && this.parseFrame());
        } catch (err) {
            if (err instanceof ProtocolError) this.fail(err);
            else this.fail(new ProtocolError(CLOSE.internalError, "internal error"));
        }
    }

    // Consumes one complete frame from the buffer; false when more bytes are needed.
    private parseFrame(): boolean {
        const buffer = this.buffer;
        if (buffer.length < 2) return false;
        const fin = (buffer[0] & 0x80) !== 0;
        if (buffer[0] & 0x70) throw new ProtocolError(CLOSE.protocolError, "reserved bits set");
        const opcode = buffer[0] & 0x0f;
        if (!(buffer[1] & 0x80)) throw new ProtocolError(CLOSE.protocolError, "client frames must be masked");
        let length = buffer[1] & 0x7f;
        let offset = 2;
        if (length === 126) {
            if (buffer.length < 4) return false;
            length = buffer.readUInt16BE(2);
            offset = 4;
        } else if (length === 127) {
            if (buffer.length < 10) return false;
            const big = buffer.readBigUInt64BE(2);
            if (big > BigInt(this.options.maxMessageBytes)) throw new ProtocolError(CLOSE.tooBig, "message too big");
            length = Number(big);
            offset = 10;
        }
        const control = opcode >= 0x8;
        if (control && (!fin || length > 125)) throw new ProtocolError(CLOSE.protocolError, "invalid control frame");
        if (!control && this.fragmentBytes + length > this.options.maxMessageBytes) throw new ProtocolError(CLOSE.tooBig, "message too big");
        if (buffer.length < offset + 4 + length) return false;

        const mask = buffer.subarray(offset, offset + 4);
        const payload = Buffer.from(buffer.subarray(offset + 4, offset + 4 + length));
        for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i & 3];
        this.buffer = buffer.subarray(offset + 4 + length);
        this.handleFrame(fin, opcode, payload);
        return true;
    }

    private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
        switch (opcode) {
            case OPCODE.binary:
            case OPCODE.text:
                if (this.fragmenting) throw new ProtocolError(CLOSE.protocolError, "a new message started before the previous one ended");
                if (opcode === OPCODE.text) throw new ProtocolError(CLOSE.unsupportedData, "text messages are not accepted");
                if (fin) this.deliver(payload);
                else {
                    this.fragmenting = true;
                    this.fragments = [payload];
                    this.fragmentBytes = payload.length;
                }
                return;
            case OPCODE.continuation:
                if (!this.fragmenting) throw new ProtocolError(CLOSE.protocolError, "continuation without a message");
                this.fragments.push(payload);
                this.fragmentBytes += payload.length;
                if (fin) {
                    const message = Buffer.concat(this.fragments);
                    this.fragmenting = false;
                    this.fragments = [];
                    this.fragmentBytes = 0;
                    this.deliver(message);
                }
                return;
            case OPCODE.ping:
                this.writeFrame(OPCODE.pong, payload);
                return;
            case OPCODE.pong:
                return;
            case OPCODE.close: {
                if (payload.length === 1) throw new ProtocolError(CLOSE.protocolError, "malformed close frame");
                const code = payload.length >= 2 ? payload.readUInt16BE(0) : CLOSE.normal;
                const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
                if (!this.closing) {
                    this.closing = true;
                    const echo = Buffer.alloc(2);
                    echo.writeUInt16BE(code >= 1000 && code < 5000 ? code : CLOSE.protocolError, 0);
                    this.writeFrame(OPCODE.close, echo);
                }
                this.finish(code, reason);
                return;
            }
            default:
                throw new ProtocolError(CLOSE.protocolError, `unknown opcode ${opcode}`);
        }
    }

    private deliver(message: Buffer): void {
        if (this.isOpen) this.emit("message", message);
    }
}

// Completes the handshake of a request handshakeProblem() accepted.
export function acceptWebSocket(req: IncomingMessage, socket: Duplex, head: Buffer, options: WebSocketOptions): WebSocketConnection {
    const key = String(req.headers["sec-websocket-key"]);
    socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`
    );
    return new WebSocketConnection(socket, options, Buffer.from(head));
}
