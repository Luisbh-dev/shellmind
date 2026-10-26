// Turning remote file bytes into editor text and back without damaging them:
// only UTF-8 text is editable, and the byte-order mark and the dominant line
// ending are put back on save (the editor works with "\n" internally).

export type LineEnding = '\n' | '\r\n';

export type DecodedText = {
    text: string;
    bom: boolean;
    lineEnding: LineEnding;
};

export type DecodeFailure = 'binary' | 'notUtf8';

const BOM = [0xef, 0xbb, 0xbf];
const SNIFF_BYTES = 8192;

export function decodeText(bytes: Uint8Array): DecodedText | DecodeFailure {
    // A NUL byte near the start: an executable, an image, a database...
    if (bytes.subarray(0, SNIFF_BYTES).includes(0)) return 'binary';
    const bom = bytes.length >= 3 && BOM.every((byte, index) => bytes[index] === byte);
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
    } catch {
        return 'notUtf8';
    }
    const crlf = text.match(/\r\n/g)?.length ?? 0;
    const lf = (text.match(/\n/g)?.length ?? 0) - crlf;
    return { text, bom, lineEnding: crlf > lf ? '\r\n' : '\n' };
}

export function encodeText(text: string, format: Pick<DecodedText, 'bom' | 'lineEnding'>): Uint8Array {
    const body = new TextEncoder().encode(format.lineEnding === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text);
    if (!format.bom) return body;
    const bytes = new Uint8Array(body.length + 3);
    bytes.set(BOM);
    bytes.set(body, 3);
    return bytes;
}
