import { DerError, TAG, read, readHeader, readTlv, unwrapExplicit, write, type Tlv } from "./der";

// RDCleanPath (Devolutions IronRDP): the browser cannot open raw TCP or TLS,
// so the RDP client sends its X.224 Connection Request inside this PDU over a
// WebSocket. The proxy connects, forwards it, upgrades the connection to TLS
// and answers with the server's X.224 Connection Confirm and certificate
// chain; afterwards the WebSocket carries the RDP stream that the proxy
// relays over TLS. ASN.1 (EXPLICIT tags):
//
//   RDCleanPathPdu ::= SEQUENCE {
//     version            [0] INTEGER,              -- 3390
//     error              [1] RDCleanPathErr OPTIONAL,
//     destination        [2] UTF8String OPTIONAL,
//     proxyAuth          [3] UTF8String OPTIONAL,
//     serverAuth         [4] UTF8String OPTIONAL,
//     preconnectionBlob  [5] UTF8String OPTIONAL,
//     x224ConnectionPdu  [6] OCTET STRING OPTIONAL,
//     serverCertChain    [7] SEQUENCE OF OCTET STRING OPTIONAL,
//     serverAddr         [9] UTF8String OPTIONAL }
//   RDCleanPathErr ::= SEQUENCE {
//     errorCode [0] INTEGER, httpStatusCode [1] INTEGER OPTIONAL,
//     wsaLastError [2] INTEGER OPTIONAL, tlsAlertCode [3] INTEGER OPTIONAL }

export const RDCLEANPATH_VERSION = 3390;
export const GENERAL_ERROR_CODE = 1;
export const NEGOTIATION_ERROR_CODE = 2;

// A request is an X.224 Connection Request (a few dozen bytes), a host name
// and a token: anything near this size is not one.
export const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_TEXT_BYTES = 2048;
const MAX_X224_BYTES = 4096;
const MAX_CERTIFICATES = 16;
const MAX_CERTIFICATE_BYTES = 64 * 1024;

export type RdCleanPathError = {
    errorCode: number;
    httpStatusCode?: number;
    wsaLastError?: number;
    tlsAlertCode?: number;
};

export type RdCleanPathPdu = {
    version: number;
    error?: RdCleanPathError;
    destination?: string;
    proxyAuth?: string;
    serverAuth?: string;
    preconnectionBlob?: string;
    x224?: Buffer;
    serverCertChain?: Buffer[];
    serverAddr?: string;
};

export type RdCleanPathRequest = {
    destination: string;
    proxyAuth: string;
    x224: Buffer;
};

const FIELD = { version: 0, error: 1, destination: 2, proxyAuth: 3, serverAuth: 4, preconnectionBlob: 5, x224: 6, serverCertChain: 7, serverAddr: 9 } as const;

function boundedText(tlv: Tlv, what: string): string {
    if (tlv.value.length > MAX_TEXT_BYTES) throw new DerError(`${what} is too long`);
    return read.utf8(tlv);
}

// Explicitly tagged fields in ascending tag order, each at most once, and no
// tag outside `allowed`.
function taggedFields(items: Tlv[], allowed: readonly number[]): Map<number, Tlv> {
    const fields = new Map<number, Tlv>();
    let last = -1;
    for (const item of items) {
        if ((item.tag & 0xe0) !== 0xa0) throw new DerError(`unexpected tag 0x${item.tag.toString(16)}`);
        const number = item.tag & 0x1f;
        if (!allowed.includes(number)) throw new DerError(`unknown field [${number}]`);
        if (number <= last) throw new DerError("fields out of order or repeated");
        last = number;
        fields.set(number, unwrapExplicit(item));
    }
    return fields;
}

function decodeError(tlv: Tlv): RdCleanPathError {
    const fields = taggedFields(read.sequence(tlv), [0, 1, 2, 3]);
    const code = fields.get(0);
    if (!code) throw new DerError("RDCleanPathErr without an error code");
    const optional = (n: number, max: number) => {
        const field = fields.get(n);
        return field ? read.unsigned(field, max) : undefined;
    };
    return {
        errorCode: read.unsigned(code, 0xffff),
        httpStatusCode: optional(1, 0xffff),
        wsaLastError: optional(2, 0xffff),
        tlsAlertCode: optional(3, 0xff)
    };
}

// Total byte length of the PDU at the start of `input` once its header has
// arrived (null until then). Throws when the bytes cannot start an
// RDCleanPath PDU or announce one larger than `maxBytes`.
export function pduLength(input: Buffer, maxBytes = MAX_REQUEST_BYTES): number | null {
    const header = readHeader(input, 0, maxBytes);
    if (!header) return null;
    if (header.tag !== TAG.sequence) throw new DerError("not an RDCleanPath PDU");
    return header.headerLength + header.length;
}

// Decodes exactly one PDU spanning all of `input`.
export function decodePdu(input: Buffer, maxBytes = MAX_REQUEST_BYTES): RdCleanPathPdu {
    if (input.length > maxBytes) throw new DerError("PDU too large");
    const outer = readTlv(input, 0);
    if (outer.end !== input.length) throw new DerError("trailing bytes after the PDU");
    const fields = taggedFields(read.sequence(outer), Object.values(FIELD));
    const version = fields.get(FIELD.version);
    if (!version) throw new DerError("PDU without a version");
    const pdu: RdCleanPathPdu = { version: read.unsigned(version) };
    if (pdu.version !== RDCLEANPATH_VERSION) throw new DerError(`unsupported RDCleanPath version ${pdu.version}`);

    const text = (n: number, what: string) => {
        const field = fields.get(n);
        return field ? boundedText(field, what) : undefined;
    };
    const error = fields.get(FIELD.error);
    if (error) pdu.error = decodeError(error);
    pdu.destination = text(FIELD.destination, "destination");
    pdu.proxyAuth = text(FIELD.proxyAuth, "proxy auth");
    pdu.serverAuth = text(FIELD.serverAuth, "server auth");
    pdu.preconnectionBlob = text(FIELD.preconnectionBlob, "preconnection blob");
    const x224 = fields.get(FIELD.x224);
    if (x224) {
        const bytes = read.octets(x224);
        if (bytes.length > MAX_X224_BYTES) throw new DerError("X.224 PDU too large");
        pdu.x224 = Buffer.from(bytes);
    }
    const chain = fields.get(FIELD.serverCertChain);
    if (chain) {
        const items = read.sequence(chain);
        if (items.length > MAX_CERTIFICATES) throw new DerError("too many certificates");
        pdu.serverCertChain = items.map((item) => {
            const bytes = read.octets(item);
            if (bytes.length > MAX_CERTIFICATE_BYTES) throw new DerError("certificate too large");
            return Buffer.from(bytes);
        });
    }
    pdu.serverAddr = text(FIELD.serverAddr, "server address");
    for (const key of Object.keys(pdu) as Array<keyof RdCleanPathPdu>) {
        if (pdu[key] === undefined) delete pdu[key];
    }
    return pdu;
}

// A client request: destination, token and X.224 Connection Request, and none
// of the fields only a proxy sends. A VMConnect request (no X.224, a
// preconnection blob for Hyper-V) is not supported.
export function decodeRequest(input: Buffer): RdCleanPathRequest {
    const pdu = decodePdu(input);
    if (pdu.error || pdu.serverCertChain || pdu.serverAddr) throw new DerError("not a request: it carries proxy fields");
    if (pdu.preconnectionBlob !== undefined) throw new DerError("preconnection blobs are not supported");
    if (pdu.destination === undefined || pdu.proxyAuth === undefined || !pdu.x224) {
        throw new DerError("a request needs a destination, a proxy token and an X.224 Connection Request");
    }
    return { destination: pdu.destination, proxyAuth: pdu.proxyAuth, x224: pdu.x224 };
}

function encode(fields: Array<[number, Buffer]>): Buffer {
    return write.sequence([
        write.explicit(FIELD.version, write.unsigned(RDCLEANPATH_VERSION)),
        ...fields.map(([n, inner]) => write.explicit(n, inner))
    ]);
}

export function encodeResponse(response: { x224: Buffer; certChain: Buffer[]; serverAddr: string }): Buffer {
    return encode([
        [FIELD.x224, write.octets(response.x224)],
        [FIELD.serverCertChain, write.sequence(response.certChain.map(write.octets))],
        [FIELD.serverAddr, write.utf8(response.serverAddr)]
    ]);
}

// An error answer; a negotiation error carries the server's X.224 Connection
// Confirm (RDP_NEG_FAILURE) so the client can tell why.
export function encodeError(error: RdCleanPathError, x224?: Buffer): Buffer {
    const inner: Buffer[] = [write.explicit(0, write.unsigned(error.errorCode))];
    if (error.httpStatusCode !== undefined) inner.push(write.explicit(1, write.unsigned(error.httpStatusCode)));
    if (error.wsaLastError !== undefined) inner.push(write.explicit(2, write.unsigned(error.wsaLastError)));
    if (error.tlsAlertCode !== undefined) inner.push(write.explicit(3, write.unsigned(error.tlsAlertCode)));
    const fields: Array<[number, Buffer]> = [[FIELD.error, write.sequence(inner)]];
    if (x224) fields.push([FIELD.x224, write.octets(x224)]);
    return encode(fields);
}

// Request encoder (what the IronRDP client sends), for tests and tools.
export function encodeRequest(request: RdCleanPathRequest & { preconnectionBlob?: string }): Buffer {
    const fields: Array<[number, Buffer]> = [
        [FIELD.destination, write.utf8(request.destination)],
        [FIELD.proxyAuth, write.utf8(request.proxyAuth)]
    ];
    if (request.preconnectionBlob !== undefined) fields.push([FIELD.preconnectionBlob, write.utf8(request.preconnectionBlob)]);
    fields.push([FIELD.x224, write.octets(request.x224)]);
    return encode(fields);
}
