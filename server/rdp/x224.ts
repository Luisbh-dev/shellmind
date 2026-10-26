import type { Readable } from "stream";

// The first exchange of an RDP connection (MS-RDPBCGR 2.2.1.1 and 2.2.1.2):
// an X.224 Connection Request / Confirm, each in one TPKT frame
// (RFC 1006: version 3, reserved 0, 16-bit big-endian length including the
// 4-byte header). The proxy checks what the client sends before it goes to
// the server, and reads the server's answer as exactly one frame.

export const PROTOCOL = {
    rdp: 0x0,
    ssl: 0x1,
    hybrid: 0x2,
    rdstls: 0x4,
    hybridEx: 0x8
} as const;

// RDP_NEG_FAILURE failureCode values, for messages.
export const NEGOTIATION_FAILURES: Record<number, string> = {
    1: "SSL_REQUIRED_BY_SERVER",
    2: "SSL_NOT_ALLOWED_BY_SERVER",
    3: "SSL_CERT_NOT_ON_SERVER",
    4: "INCONSISTENT_FLAGS",
    5: "HYBRID_REQUIRED_BY_SERVER",
    6: "SSL_WITH_USER_AUTH_REQUIRED_BY_SERVER"
};

const TPKT_HEADER = 4;
const X224_FIXED = 7; // LI, code, DST-REF(2), SRC-REF(2), class
const TPDU_CONNECTION_REQUEST = 0xe0;
const TPDU_CONNECTION_CONFIRM = 0xd0;
const NEG_REQUEST = 0x01;
const NEG_RESPONSE = 0x02;
const NEG_FAILURE = 0x03;
const CORRELATION_INFO = 0x06;
// Connection PDUs are a few dozen bytes; the confirm never comes close.
export const MAX_CONNECTION_PDU = 1024;

export class X224Error extends Error {
    constructor(message: string) {
        super(message);
        this.name = "X224Error";
    }
}

// The total length a TPKT header announces, or null while fewer than 4 bytes
// are there. Throws when it is not a TPKT header or the length is out of range.
export function tpktLength(buffer: Buffer, max = MAX_CONNECTION_PDU): number | null {
    if (buffer.length < TPKT_HEADER) return null;
    if (buffer[0] !== 3 || buffer[1] !== 0) throw new X224Error("not a TPKT frame");
    const length = buffer.readUInt16BE(2);
    if (length < TPKT_HEADER + X224_FIXED) throw new X224Error(`TPKT frame of ${length} bytes is too short`);
    if (length > max) throw new X224Error(`TPKT frame of ${length} bytes is too long`);
    return length;
}

// The TPDU of one complete frame (LI must cover the rest of the frame: RDP
// connection TPDUs carry everything in their variable header part).
function tpdu(frame: Buffer, code: number, what: string): Buffer {
    const length = tpktLength(frame);
    if (length !== frame.length) throw new X224Error(`${what}: the TPKT length does not match the frame`);
    const body = frame.subarray(TPKT_HEADER);
    if (body[0] !== body.length - 1) throw new X224Error(`${what}: the X.224 length indicator does not match the frame`);
    if ((body[1] & 0xf0) !== code) throw new X224Error(`${what}: unexpected TPDU code 0x${body[1].toString(16)}`);
    return body.subarray(X224_FIXED);
}

export type ConnectionRequest = {
    // mstshash cookie or routing token line, without its CRLF.
    cookie: string | null;
    // RDP_NEG_REQ requestedProtocols; null without a negotiation request.
    requestedProtocols: number | null;
};

// Validates the client's X.224 Connection Request: a cookie or routing token
// line, then an optional RDP_NEG_REQ, then optional RDP_CORRELATION_INFO.
export function parseConnectionRequest(frame: Buffer): ConnectionRequest {
    let rest = tpdu(frame, TPDU_CONNECTION_REQUEST, "Connection Request");
    const body = frame.subarray(TPKT_HEADER);
    if (body.readUInt16BE(2) !== 0) throw new X224Error("Connection Request: DST-REF must be zero");
    if (body[6] !== 0) throw new X224Error("Connection Request: only class 0 is used by RDP");
    let cookie: string | null = null;
    if (rest.length > 0 && rest[0] !== NEG_REQUEST) {
        const end = rest.indexOf("\r\n");
        if (end < 0) throw new X224Error("Connection Request: the cookie line is not terminated");
        const text = rest.subarray(0, end).toString("latin1");
        if (!/^[\x20-\x7e]*$/.test(text)) throw new X224Error("Connection Request: the cookie line is not printable");
        cookie = text;
        rest = rest.subarray(end + 2);
    }
    let requestedProtocols: number | null = null;
    if (rest.length > 0) {
        if (rest.length < 8 || rest[0] !== NEG_REQUEST || rest.readUInt16LE(2) !== 8) throw new X224Error("Connection Request: malformed RDP_NEG_REQ");
        requestedProtocols = rest.readUInt32LE(4);
        rest = rest.subarray(8);
        if (rest.length > 0) {
            if (rest.length !== 36 || rest[0] !== CORRELATION_INFO || rest.readUInt16LE(2) !== 36) {
                throw new X224Error("Connection Request: unexpected data after RDP_NEG_REQ");
            }
        }
    }
    return { cookie, requestedProtocols };
}

export type ConnectionConfirm =
    | { kind: "response"; selectedProtocol: number }
    | { kind: "failure"; code: number }
    // No negotiation data: the server only speaks standard RDP security.
    | { kind: "legacy" };

export function parseConnectionConfirm(frame: Buffer): ConnectionConfirm {
    const rest = tpdu(frame, TPDU_CONNECTION_CONFIRM, "Connection Confirm");
    if (rest.length === 0) return { kind: "legacy" };
    if (rest.length !== 8 || rest.readUInt16LE(2) !== 8) throw new X224Error("Connection Confirm: malformed negotiation data");
    if (rest[0] === NEG_RESPONSE) return { kind: "response", selectedProtocol: rest.readUInt32LE(4) };
    if (rest[0] === NEG_FAILURE) return { kind: "failure", code: rest.readUInt32LE(4) };
    throw new X224Error(`Connection Confirm: unknown negotiation type ${rest[0]}`);
}

export class FrameTimeoutError extends Error {
    constructor() {
        super("The server did not answer the connection request in time");
        this.name = "FrameTimeoutError";
    }
}

// Reads exactly one TPKT frame from `stream`. Bytes after it are put back
// and the stream is left paused, so what follows (the TLS handshake) reads
// them in order.
export function readTpktFrame(stream: Readable, timeoutMs: number, max = MAX_CONNECTION_PDU): Promise<Buffer> {
    return new Promise((resolve, reject) => {
        let buffered: Buffer = Buffer.alloc(0);
        const finish = (outcome: () => void) => {
            clearTimeout(timer);
            stream.pause();
            stream.off("data", onData);
            stream.off("end", onEnd);
            stream.off("close", onEnd);
            stream.off("error", onError);
            outcome();
        };
        const onData = (chunk: Buffer) => {
            buffered = buffered.length ? Buffer.concat([buffered, chunk]) : chunk;
            let length: number | null;
            try {
                length = tpktLength(buffered, max);
            } catch (err) {
                finish(() => reject(err));
                return;
            }
            if (length === null || buffered.length < length) return;
            const frame = Buffer.from(buffered.subarray(0, length));
            const rest = buffered.subarray(length);
            finish(() => {
                if (rest.length) stream.unshift(rest);
                resolve(frame);
            });
        };
        const onEnd = () => finish(() => reject(new X224Error("The server closed the connection during negotiation")));
        const onError = (err: Error) => finish(() => reject(err));
        const timer = setTimeout(() => finish(() => reject(new FrameTimeoutError())), timeoutMs);
        stream.on("data", onData);
        stream.once("end", onEnd);
        stream.once("close", onEnd);
        stream.once("error", onError);
        stream.resume();
    });
}
