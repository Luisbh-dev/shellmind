import { constants, deflateRawSync, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { deflateRaw, inflateRaw } from './deflate';

const utf8 = (text: string) => new TextEncoder().encode(text);

// Varied text that does not repeat itself (a linear congruential generator).
function noise(length: number): Uint8Array {
    let seed = 12345;
    return Uint8Array.from({ length }, () => {
        seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
        return seed >>> 23;
    });
}

const SCRIPT = [
    '$os = Get-CimInstance Win32_OperatingSystem',
    '$cpu = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average',
    '$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID=\'C:\'"',
    '[pscustomobject]@{',
    '  CPU = "$([math]::Round($cpu,1)) %"',
    '  RAM = "$([math]::Round(($os.TotalVisibleMemorySize - $os.FreePhysicalMemory) / 1MB, 2)) GB usados — ñandú ✓"',
    '} | Format-List',
    'Get-Process | Sort-Object CPU -Descending | Select-Object -First 5 ProcessName, Id, @{Name=\'RAM_MB\';Expression={[math]::Round($_.WorkingSet64 / 1MB,1)}}'
].join('\n');

const SAMPLES: Array<[string, Uint8Array]> = [
    ['empty', new Uint8Array()],
    ['one byte', utf8('a')],
    ['a script', utf8(SCRIPT)],
    ['non-ASCII text', utf8('ñandú ✓ 漢字 😀 '.repeat(40))],
    ['a long run (matches of 258 bytes, overlapping)', new Uint8Array(70_000).fill(65)],
    ['noise beyond the 32 KB window', noise(80_000)]
];

describe('deflateRaw', () => {
    it.each(SAMPLES)('writes raw DEFLATE that zlib reads back: %s', (_name, data) => {
        expect(new Uint8Array(inflateRawSync(deflateRaw(data)))).toEqual(data);
    });

    it('compresses scripts about as well as zlib does with fixed codes', () => {
        const data = utf8(SCRIPT);
        const fixed = deflateRawSync(data, { level: 9, strategy: constants.Z_FIXED });
        expect(deflateRaw(data).length).toBeLessThan(data.length * 0.75);
        expect(deflateRaw(data).length).toBeLessThanOrEqual(fixed.length + 8);
    });
});

describe('inflateRaw', () => {
    it.each(SAMPLES)('reads what deflateRaw writes: %s', (_name, data) => {
        expect(inflateRaw(deflateRaw(data))).toEqual(data);
    });

    it('reads blocks with fixed codes written by zlib', () => {
        for (const [, data] of SAMPLES.slice(0, -1)) {
            expect(inflateRaw(deflateRawSync(data, { strategy: constants.Z_FIXED }))).toEqual(data);
        }
    });

    it('rejects anything else instead of throwing', () => {
        const dynamic = deflateRawSync(utf8(SCRIPT.repeat(4)));
        // zlib picked dynamic Huffman codes (block type 2).
        expect((dynamic[0] >> 1) & 3).toBe(2);
        expect(inflateRaw(dynamic)).toBeNull();
        const compressed = deflateRaw(utf8(SCRIPT));
        expect(inflateRaw(compressed.subarray(0, compressed.length - 4))).toBeNull();
        expect(inflateRaw(new Uint8Array())).toBeNull();
        // A distance before the start of the output.
        expect(inflateRaw(Uint8Array.from([0x03, 0x02, 0x00]))).toBeNull();
    });

    it('refuses to inflate past 1 MB', () => {
        const bomb = deflateRaw(new Uint8Array(1_100_000));
        expect(bomb.length).toBeLessThan(10_000);
        expect(inflateRaw(bomb)).toBeNull();
        expect(inflateRaw(deflateRaw(new Uint8Array(1 << 20)))).toHaveLength(1 << 20);
    });
});
