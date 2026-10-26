import { describe, expect, it } from 'vitest';
import { decodeText, encodeText } from './textCodec';

const bytes = (text: string) => new TextEncoder().encode(text);

describe('decodeText', () => {
    it('decodes UTF-8 and finds the dominant line ending', () => {
        expect(decodeText(bytes('a\nb\n'))).toEqual({ text: 'a\nb\n', bom: false, lineEnding: '\n' });
        expect(decodeText(bytes('a\r\nb\r\nc\n'))).toEqual({ text: 'a\r\nb\r\nc\n', bom: false, lineEnding: '\r\n' });
        expect(decodeText(bytes('ñandú €'))).toMatchObject({ text: 'ñandú €' });
        expect(decodeText(new Uint8Array())).toEqual({ text: '', bom: false, lineEnding: '\n' });
    });

    it('strips and remembers a byte-order mark', () => {
        expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0x68, 0x69]))).toEqual({ text: 'hi', bom: true, lineEnding: '\n' });
    });

    it('refuses binary data and other encodings', () => {
        expect(decodeText(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x00, 0x01]))).toBe('binary');
        expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]))).toBe('notUtf8');
    });
});

describe('encodeText', () => {
    it('restores line endings and the byte-order mark', () => {
        expect(new TextDecoder().decode(encodeText('a\nb', { bom: false, lineEnding: '\r\n' }))).toBe('a\r\nb');
        expect([...encodeText('x', { bom: true, lineEnding: '\n' })]).toEqual([0xef, 0xbb, 0xbf, 0x78]);
    });

    it('round-trips what it decoded', () => {
        const original = bytes('server {\r\n    listen 80;\r\n}\r\n');
        const decoded = decodeText(original);
        if (typeof decoded === 'string') throw new Error(decoded);
        // The editor works with "\n" only.
        const edited = decoded.text.replace(/\r\n/g, '\n');
        expect(encodeText(edited, decoded)).toEqual(original);
    });
});
