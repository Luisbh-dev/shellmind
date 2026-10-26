import { describe, expect, it } from 'vitest';
import { DerError, decodeUnsigned, decodeUtf8, encodeTlv, encodeUnsigned, readChildren, readHeader, readTlv, unwrapExplicit, write } from './der';

const hex = (text: string) => Buffer.from(text.replace(/\s+/g, ''), 'hex');

describe('DER lengths', () => {
    it('reads short and minimal long forms', () => {
        expect(readHeader(hex('30 05'), 0, 100)).toEqual({ tag: 0x30, length: 5, headerLength: 2 });
        expect(readHeader(hex('04 81 80'), 0, 1000)).toEqual({ tag: 0x04, length: 128, headerLength: 3 });
        expect(readHeader(hex('04 82 01 00'), 0, 1000)).toEqual({ tag: 0x04, length: 256, headerLength: 4 });
    });

    it('waits for the rest of a header', () => {
        expect(readHeader(hex(''), 0, 100)).toBeNull();
        expect(readHeader(hex('30'), 0, 100)).toBeNull();
        expect(readHeader(hex('30 82 01'), 0, 1000)).toBeNull();
    });

    it('refuses what DER forbids or the caller does not allow', () => {
        expect(() => readHeader(hex('30 80'), 0, 100)).toThrow(/indefinite/);
        expect(() => readHeader(hex('30 81 05'), 0, 100)).toThrow(/minimally/);
        expect(() => readHeader(hex('30 82 00 90'), 0, 1000)).toThrow(/minimally/);
        expect(() => readHeader(hex('30 85 01 00 00 00 00'), 0, 1000)).toThrow(/too large/);
        expect(() => readHeader(hex('30 82 10 00'), 0, 1000)).toThrow(/exceeds/);
        expect(() => readHeader(hex('1f 01 00'), 0, 100)).toThrow(/multi-byte/);
    });

    it('never reads past the input', () => {
        expect(() => readTlv(hex('04 05 01 02'), 0)).toThrow(DerError);
        expect(() => readTlv(hex('04 02 01 02 03'), 0, 3)).toThrow(/truncated/);
        expect(readTlv(hex('04 02 01 02 ff'), 0)).toMatchObject({ tag: 4, end: 4, value: hex('01 02') });
    });
});

describe('DER values', () => {
    it('decodes minimal non-negative integers only', () => {
        expect(decodeUnsigned(hex('00'))).toBe(0);
        expect(decodeUnsigned(hex('0d 3e'))).toBe(3390);
        expect(decodeUnsigned(hex('00 80'))).toBe(128);
        expect(() => decodeUnsigned(hex(''))).toThrow(/empty/);
        expect(() => decodeUnsigned(hex('80'))).toThrow(/negative/);
        expect(() => decodeUnsigned(hex('00 01'))).toThrow(/minimally/);
        expect(() => decodeUnsigned(hex('01 00 00'), 0xffff)).toThrow(/exceeds/);
        expect(() => decodeUnsigned(hex('01 02 03 04 05 06 07 08 09'))).toThrow(/too large/);
    });

    it('encodes integers the way it decodes them', () => {
        for (const value of [0, 1, 127, 128, 255, 256, 3390, 65535, 2 ** 40]) {
            const tlv = readTlv(encodeUnsigned(value), 0);
            expect(decodeUnsigned(tlv.value)).toBe(value);
        }
        expect(encodeUnsigned(128)).toEqual(hex('02 02 00 80'));
        expect(() => encodeUnsigned(-1)).toThrow(DerError);
    });

    it('accepts valid UTF-8 only', () => {
        expect(decodeUtf8(Buffer.from('Añadir €'))).toBe('Añadir €');
        expect(() => decodeUtf8(hex('c3 28'))).toThrow(/UTF-8/);
    });

    it('splits constructed values and explicit tags exactly', () => {
        const sequence = write.sequence([write.unsigned(1), write.utf8('a')]);
        const children = readChildren(readTlv(sequence, 0).value);
        expect(children.map((child) => child.tag)).toEqual([0x02, 0x0c]);
        const explicit = readTlv(write.explicit(3, write.utf8('x')), 0);
        expect(explicit.tag).toBe(0xa3);
        expect(unwrapExplicit(explicit).value.toString()).toBe('x');
        expect(() => unwrapExplicit(readTlv(encodeTlv(0xa0, Buffer.concat([write.unsigned(1), write.unsigned(2)])), 0))).toThrow(/exactly one/);
        expect(() => readChildren(hex('02 01'))).toThrow(/truncated/);
    });

    it('writes long lengths minimally', () => {
        expect(write.octets(Buffer.alloc(200)).subarray(0, 3)).toEqual(hex('04 81 c8'));
        expect(write.octets(Buffer.alloc(300)).subarray(0, 4)).toEqual(hex('04 82 01 2c'));
    });
});
