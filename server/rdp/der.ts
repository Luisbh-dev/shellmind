// A strict subset of ASN.1 DER: what RDCleanPath PDUs are made of (SEQUENCE,
// INTEGER, UTF8String, OCTET STRING and explicit context-specific tags), and
// the walk to an X.509 certificate's key usage (keyUsage.ts). Only the
// distinguished encoding is accepted: definite, minimal lengths, minimal
// integers, valid UTF-8, nothing past the end of a value. Every length is
// checked against the bytes actually there before it is used.

export const TAG = {
    integer: 0x02,
    bitString: 0x03,
    octetString: 0x04,
    objectIdentifier: 0x06,
    utf8String: 0x0c,
    sequence: 0x30
} as const;

// [n] EXPLICIT: constructed, context-specific.
export const contextTag = (n: number): number => 0xa0 | n;

export class DerError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "DerError";
    }
}

export type Tlv = {
    tag: number;
    // The value's bytes (a view of the input, not a copy).
    value: Buffer;
    // Offset of the first byte after this element in the input.
    end: number;
};

// The header (tag and length) of the element at `offset`, or null when the
// input ends before the header does. `maxLength` bounds the declared length.
export function readHeader(input: Buffer, offset: number, maxLength: number): { tag: number; length: number; headerLength: number } | null {
    if (offset >= input.length) return null;
    const tag = input[offset];
    // High tag numbers (0x1f) never occur in RDCleanPath.
    if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tags are not supported");
    if (offset + 1 >= input.length) return null;
    const first = input[offset + 1];
    if (first < 0x80) return { tag, length: first, headerLength: 2 };
    const count = first & 0x7f;
    if (count === 0) throw new DerError("indefinite lengths are not DER");
    if (count > 4) throw new DerError("length too large");
    if (offset + 2 + count > input.length) return null;
    let length = 0;
    for (let i = 0; i < count; i += 1) length = length * 256 + input[offset + 2 + i];
    if (input[offset + 2] === 0) throw new DerError("length is not minimally encoded");
    if (length < 0x80) throw new DerError("length is not minimally encoded");
    if (length > maxLength) throw new DerError(`length ${length} exceeds the limit of ${maxLength}`);
    return { tag, length, headerLength: 2 + count };
}

// The complete element at `offset`; throws when it is cut short.
export function readTlv(input: Buffer, offset: number, limit = input.length): Tlv {
    const scope = input.subarray(0, limit);
    const header = readHeader(scope, offset, limit);
    if (!header) throw new DerError("truncated element");
    const start = offset + header.headerLength;
    const end = start + header.length;
    if (end > limit) throw new DerError("truncated element");
    return { tag: header.tag, value: input.subarray(start, end), end };
}

function expectTag(tlv: Tlv, tag: number, what: string): Buffer {
    if (tlv.tag !== tag) throw new DerError(`expected ${what} (tag 0x${tag.toString(16)}), got tag 0x${tlv.tag.toString(16)}`);
    return tlv.value;
}

// A non-negative INTEGER no larger than `max`.
export function decodeUnsigned(value: Buffer, max = Number.MAX_SAFE_INTEGER): number {
    if (value.length === 0) throw new DerError("empty INTEGER");
    if (value[0] & 0x80) throw new DerError("negative INTEGER");
    if (value.length > 1 && value[0] === 0 && !(value[1] & 0x80)) throw new DerError("INTEGER is not minimally encoded");
    if (value.length > 8) throw new DerError("INTEGER too large");
    let result = 0;
    for (const byte of value) result = result * 256 + byte;
    if (result > max) throw new DerError(`INTEGER ${result} exceeds ${max}`);
    return result;
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

export function decodeUtf8(value: Buffer): string {
    try {
        return utf8.decode(value);
    } catch {
        throw new DerError("invalid UTF-8 in UTF8String");
    }
}

// The elements of a constructed value, which must fill it exactly.
export function readChildren(value: Buffer): Tlv[] {
    const children: Tlv[] = [];
    let offset = 0;
    while (offset < value.length) {
        const child = readTlv(value, offset);
        children.push(child);
        offset = child.end;
    }
    return children;
}

// The single element inside an explicit [n] tag.
export function unwrapExplicit(tlv: Tlv): Tlv {
    const children = readChildren(tlv.value);
    if (children.length !== 1) throw new DerError("an explicit tag must hold exactly one element");
    return children[0];
}

export const read = {
    unsigned: (tlv: Tlv, max?: number) => decodeUnsigned(expectTag(tlv, TAG.integer, "INTEGER"), max),
    utf8: (tlv: Tlv) => decodeUtf8(expectTag(tlv, TAG.utf8String, "UTF8String")),
    octets: (tlv: Tlv) => expectTag(tlv, TAG.octetString, "OCTET STRING"),
    sequence: (tlv: Tlv) => readChildren(expectTag(tlv, TAG.sequence, "SEQUENCE"))
};

// --- encoding ---

function encodeLength(length: number): Buffer {
    if (length < 0x80) return Buffer.from([length]);
    const bytes: number[] = [];
    for (let rest = length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    return Buffer.from([0x80 | bytes.length, ...bytes]);
}

export function encodeTlv(tag: number, value: Buffer): Buffer {
    return Buffer.concat([Buffer.from([tag]), encodeLength(value.length), value]);
}

export function encodeUnsigned(value: number): Buffer {
    if (!Number.isSafeInteger(value) || value < 0) throw new DerError(`cannot encode ${value} as an unsigned INTEGER`);
    const bytes: number[] = [];
    for (let rest = value; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
    if (bytes.length === 0 || bytes[0] & 0x80) bytes.unshift(0);
    return encodeTlv(TAG.integer, Buffer.from(bytes));
}

export const write = {
    unsigned: encodeUnsigned,
    utf8: (text: string) => encodeTlv(TAG.utf8String, Buffer.from(text, "utf8")),
    octets: (bytes: Buffer) => encodeTlv(TAG.octetString, bytes),
    sequence: (items: Buffer[]) => encodeTlv(TAG.sequence, Buffer.concat(items)),
    explicit: (n: number, inner: Buffer) => encodeTlv(contextTag(n), inner)
};
