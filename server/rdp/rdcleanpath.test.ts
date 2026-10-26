import { describe, expect, it } from 'vitest';
import { write } from './der';
import { decodePdu, decodeRequest, encodeError, encodeRequest, encodeResponse, NEGOTIATION_ERROR_CODE, pduLength } from './rdcleanpath';

// Byte vectors of the IronRDP test suite (crates/ironrdp-testsuite-core/tests/rdcleanpath.rs).
const bytes = (...values: number[]) => Buffer.from(values);
const DEADBEEF = bytes(0xde, 0xad, 0xbe, 0xff);
const REQUEST_WITH_PCB = bytes(
    0x30, 0x32, 0xa0, 0x4, 0x2, 0x2, 0xd, 0x3e, 0xa2, 0xd, 0xc, 0xb, 0x64, 0x65, 0x73, 0x74, 0x69, 0x6e, 0x61, 0x74,
    0x69, 0x6f, 0x6e, 0xa3, 0xc, 0xc, 0xa, 0x70, 0x72, 0x6f, 0x78, 0x79, 0x20, 0x61, 0x75, 0x74, 0x68, 0xa5, 0x5, 0xc,
    0x3, 0x50, 0x43, 0x42, 0xa6, 0x6, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff,
);
const RESPONSE_SUCCESS = bytes(
    0x30, 0x34, 0xa0, 0x4, 0x2, 0x2, 0xd, 0x3e, 0xa6, 0x6, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0xa7, 0x14, 0x30, 0x12,
    0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0x4, 0x4, 0xde, 0xad, 0xbe, 0xff, 0xa9, 0xe,
    0xc, 0xc, 0x31, 0x39, 0x32, 0x2e, 0x31, 0x36, 0x38, 0x2e, 0x37, 0x2e, 0x39, 0x35,
);
const RESPONSE_HTTP_ERROR = bytes(
    0x30, 0x15, 0xa0, 0x4, 0x2, 0x2, 0xd, 0x3e, 0xa1, 0xd, 0x30, 0xb, 0xa0, 0x3, 0x2, 0x1, 0x1, 0xa1, 0x4, 0x2, 0x2, 0x1, 0xf4,
);
const RESPONSE_TLS_ERROR = bytes(
    0x30, 0x14, 0xa0, 0x04, 0x02, 0x02, 0x0d, 0x3e, 0xa1, 0x0c, 0x30, 0x0a, 0xa0, 0x03, 0x02, 0x01, 0x01, 0xa3, 0x03, 0x02, 0x01, 0x30,
);
// REQUEST_WITH_PCB without its preconnection blob field.
const REQUEST = Buffer.concat([bytes(0x30, 0x2b), REQUEST_WITH_PCB.subarray(2, 37), REQUEST_WITH_PCB.subarray(44)]);

describe('RDCleanPath encoding', () => {
    it('writes the responses byte for byte like IronRDP', () => {
        expect(encodeResponse({ x224: DEADBEEF, certChain: [DEADBEEF, DEADBEEF, DEADBEEF], serverAddr: '192.168.7.95' })).toEqual(RESPONSE_SUCCESS);
        expect(encodeError({ errorCode: 1, httpStatusCode: 500 })).toEqual(RESPONSE_HTTP_ERROR);
        expect(encodeError({ errorCode: 1, tlsAlertCode: 48 })).toEqual(RESPONSE_TLS_ERROR);
        expect(encodeRequest({ destination: 'destination', proxyAuth: 'proxy auth', preconnectionBlob: 'PCB', x224: DEADBEEF })).toEqual(REQUEST_WITH_PCB);
    });

    it('carries the server confirm in a negotiation error', () => {
        const pdu = decodePdu(encodeError({ errorCode: NEGOTIATION_ERROR_CODE }, DEADBEEF));
        expect(pdu).toEqual({ version: 3390, error: { errorCode: 2 }, x224: DEADBEEF });
    });

    it('decodes what it encodes', () => {
        expect(decodePdu(RESPONSE_SUCCESS)).toEqual({ version: 3390, x224: DEADBEEF, serverCertChain: [DEADBEEF, DEADBEEF, DEADBEEF], serverAddr: '192.168.7.95' });
        expect(decodePdu(encodeError({ errorCode: 1, httpStatusCode: 401, wsaLastError: 10061, tlsAlertCode: 42 }))).toEqual({
            version: 3390, error: { errorCode: 1, httpStatusCode: 401, wsaLastError: 10061, tlsAlertCode: 42 },
        });
    });
});

describe('RDCleanPath requests', () => {
    it('reads a client request', () => {
        expect(decodeRequest(REQUEST)).toEqual({ destination: 'destination', proxyAuth: 'proxy auth', x224: DEADBEEF });
    });

    it('knows the full length as soon as the header is there', () => {
        expect(pduLength(REQUEST.subarray(0, 1))).toBeNull();
        expect(pduLength(REQUEST.subarray(0, 2))).toBe(REQUEST.length);
        expect(() => pduLength(bytes(0x04, 0x01))).toThrow(/not an RDCleanPath/);
        expect(() => pduLength(bytes(0x30, 0x84, 0x7f, 0xff, 0xff, 0xff))).toThrow(/exceeds/);
        // A plain X.224 request (TPKT) is not one either.
        expect(() => pduLength(bytes(0x03, 0x00, 0x00, 0x13))).toThrow(/not an RDCleanPath/);
    });

    it('refuses preconnection blobs and VMConnect requests', () => {
        expect(() => decodeRequest(REQUEST_WITH_PCB)).toThrow(/preconnection/);
        const vmconnect = encodeRequest({ destination: 'vm', proxyAuth: 't', preconnectionBlob: 'pcb', x224: DEADBEEF });
        expect(() => decodeRequest(vmconnect)).toThrow(/preconnection/);
    });

    it('refuses responses and incomplete requests posing as requests', () => {
        expect(() => decodeRequest(RESPONSE_SUCCESS)).toThrow(/proxy fields/);
        expect(() => decodeRequest(RESPONSE_HTTP_ERROR)).toThrow(/proxy fields/);
        const noX224 = write.sequence([write.explicit(0, write.unsigned(3390)), write.explicit(2, write.utf8('d')), write.explicit(3, write.utf8('t'))]);
        expect(() => decodeRequest(noX224)).toThrow(/needs a destination/);
    });

    it('is strict about the structure', () => {
        const field = (n: number, inner: Buffer) => write.explicit(n, inner);
        const version = field(0, write.unsigned(3390));
        const pdu = (...fields: Buffer[]) => write.sequence(fields);
        expect(() => decodeRequest(pdu(field(0, write.unsigned(3389)), field(2, write.utf8('d'))))).toThrow(/version 3389/);
        expect(() => decodeRequest(pdu(field(2, write.utf8('d')), version))).toThrow(/order/);
        expect(() => decodeRequest(pdu(version, field(2, write.utf8('a')), field(2, write.utf8('b'))))).toThrow(/order or repeated/);
        expect(() => decodeRequest(pdu(version, field(8, write.utf8('ocsp'))))).toThrow(/unknown field \[8\]/);
        expect(() => decodeRequest(pdu(version, field(2, write.octets(Buffer.from('d')))))).toThrow(/UTF8String/);
        expect(() => decodeRequest(Buffer.concat([REQUEST, bytes(0)]))).toThrow(/trailing/);
        expect(() => decodeRequest(REQUEST.subarray(0, REQUEST.length - 1))).toThrow(/truncated/);
        expect(() => decodeRequest(pdu(version, field(2, write.utf8('x'.repeat(5000)))))).toThrow(/too long/);
        expect(() => decodeRequest(Buffer.alloc(20_000))).toThrow(/too large/);
    });
});
