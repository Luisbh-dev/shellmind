// Raw DEFLATE (RFC 1951) for short texts such as scripts, synchronous and
// without dependencies (shared/ is bundled into the frontend, whose only
// built-in compressor, CompressionStream, is asynchronous). deflateRaw()
// writes one block with the fixed Huffman codes and LZ77 matches, which
// gives most of what zlib gains on scripts; inflateRaw() reads what
// deflateRaw() writes.

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DISTANCE_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DISTANCE_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
// Candidates compared per position: plenty for texts of a few kilobytes.
const MAX_CHAIN = 128;
const END_OF_BLOCK = 256;
// inflateRaw() gives up beyond this (the input is not trusted).
const MAX_INFLATED_BYTES = 1 << 20;

// The last index whose base is at most `value`.
function slot(bases: number[], value: number): number {
    let index = bases.length - 1;
    while (bases[index] > value) index--;
    return index;
}

class BitWriter {
    private readonly bytes: number[] = [];
    private pending = 0;
    private pendingBits = 0;

    // Values are packed least significant bit first.
    write(value: number, bits: number): void {
        this.pending |= value << this.pendingBits;
        this.pendingBits += bits;
        while (this.pendingBits >= 8) {
            this.bytes.push(this.pending & 0xff);
            this.pending >>>= 8;
            this.pendingBits -= 8;
        }
    }

    // Huffman codes are packed most significant bit first.
    writeCode(code: number, bits: number): void {
        let reversed = 0;
        for (let i = 0; i < bits; i++) reversed |= ((code >> i) & 1) << (bits - 1 - i);
        this.write(reversed, bits);
    }

    finish(): Uint8Array {
        if (this.pendingBits) this.bytes.push(this.pending & 0xff);
        return Uint8Array.from(this.bytes);
    }
}

// Fixed literal/length codes (RFC 1951, 3.2.6).
function writeSymbol(out: BitWriter, symbol: number): void {
    if (symbol < 144) out.writeCode(0x30 + symbol, 8);
    else if (symbol < 256) out.writeCode(0x190 + symbol - 144, 9);
    else if (symbol < 280) out.writeCode(symbol - 256, 7);
    else out.writeCode(0xc0 + symbol - 280, 8);
}

export function deflateRaw(data: Uint8Array): Uint8Array {
    const out = new BitWriter();
    // The final block, with fixed Huffman codes.
    out.write(1, 1);
    out.write(1, 2);
    // Earlier positions that start with the same three bytes, newest first.
    const latest = new Map<number, number>();
    const previous = new Int32Array(data.length);
    const key = (at: number) => (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
    const remember = (at: number) => {
        if (at + MIN_MATCH > data.length) return;
        previous[at] = latest.get(key(at)) ?? -1;
        latest.set(key(at), at);
    };

    let at = 0;
    while (at < data.length) {
        let bestLength = 0;
        let bestDistance = 0;
        if (at + MIN_MATCH <= data.length) {
            const limit = Math.min(MAX_MATCH, data.length - at);
            let candidate = latest.get(key(at)) ?? -1;
            for (let tries = 0; candidate >= 0 && at - candidate <= WINDOW && tries < MAX_CHAIN; tries++) {
                let length = 0;
                while (length < limit && data[candidate + length] === data[at + length]) length++;
                if (length > bestLength) {
                    bestLength = length;
                    bestDistance = at - candidate;
                    if (length === limit) break;
                }
                candidate = previous[candidate];
            }
        }
        if (bestLength >= MIN_MATCH) {
            const length = slot(LENGTH_BASE, bestLength);
            writeSymbol(out, END_OF_BLOCK + 1 + length);
            out.write(bestLength - LENGTH_BASE[length], LENGTH_EXTRA[length]);
            const distance = slot(DISTANCE_BASE, bestDistance);
            out.writeCode(distance, 5);
            out.write(bestDistance - DISTANCE_BASE[distance], DISTANCE_EXTRA[distance]);
            for (const end = at + bestLength; at < end; at++) remember(at);
        } else {
            writeSymbol(out, data[at]);
            remember(at);
            at++;
        }
    }
    writeSymbol(out, END_OF_BLOCK);
    return out.finish();
}

class TruncatedInput extends Error {}

// Null when `data` is not what deflateRaw() writes (blocks with fixed codes)
// or inflates to more than MAX_INFLATED_BYTES.
export function inflateRaw(data: Uint8Array): Uint8Array | null {
    let position = 0;
    const bit = () => {
        const byte = position >> 3;
        if (byte >= data.length) throw new TruncatedInput();
        return (data[byte] >> (position++ & 7)) & 1;
    };
    // Least significant bit first.
    const bits = (count: number) => {
        let value = 0;
        for (let i = 0; i < count; i++) value |= bit() << i;
        return value;
    };
    // Most significant bit first.
    const code = (count: number) => {
        let value = 0;
        for (let i = 0; i < count; i++) value = (value << 1) | bit();
        return value;
    };
    const symbol = () => {
        let value = code(7);
        if (value < 24) return 256 + value;
        value = (value << 1) | bit();
        if (value < 0xc0) return value - 0x30;
        if (value < 0xc8) return 280 + value - 0xc0;
        return 144 + ((value << 1) | bit()) - 0x190;
    };

    const out: number[] = [];
    try {
        for (let final = 0; !final;) {
            final = bit();
            if (bits(2) !== 1) return null;
            for (let next = symbol(); next !== END_OF_BLOCK; next = symbol()) {
                if (next < END_OF_BLOCK) {
                    out.push(next);
                    continue;
                }
                const length = next - END_OF_BLOCK - 1;
                if (length >= LENGTH_BASE.length) return null;
                const count = LENGTH_BASE[length] + bits(LENGTH_EXTRA[length]);
                const distance = code(5);
                if (distance >= DISTANCE_BASE.length) return null;
                const back = DISTANCE_BASE[distance] + bits(DISTANCE_EXTRA[distance]);
                if (back > out.length || out.length + count > MAX_INFLATED_BYTES) return null;
                for (let i = 0; i < count; i++) out.push(out[out.length - back]);
            }
            if (out.length > MAX_INFLATED_BYTES) return null;
        }
    } catch (error) {
        if (error instanceof TruncatedInput) return null;
        throw error;
    }
    return Uint8Array.from(out);
}
