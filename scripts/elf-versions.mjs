// The symbol versions an ELF binary needs from the shared libraries it links
// (its .gnu.version_r section, what `objdump -T` lists): `GLIBC_2.34` from
// libc.so.6, `GLIBCXX_3.4.29` from libstdc++.so.6 and so on. A Linux system
// can load the binary only when its libraries provide every one of them.

const SHT_GNU_VERNEED = 0x6ffffffe;

/**
 * @param {Uint8Array} bytes the whole file
 * @returns {Array<{ library: string, versions: string[] }> | null} null when the file is not ELF
 */
export function elfVersionNeeds(bytes) {
    if (bytes.length < 52 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return null;
    const is64 = bytes[4] === 2;
    const little = bytes[5] === 1;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const u16 = (offset) => view.getUint16(offset, little);
    const u32 = (offset) => view.getUint32(offset, little);
    const word = (offset) => (is64 ? Number(view.getBigUint64(offset, little)) : u32(offset));

    const sectionTable = word(is64 ? 0x28 : 0x20);
    const sectionSize = u16(is64 ? 0x3a : 0x2e);
    const sectionCount = u16(is64 ? 0x3c : 0x30);
    const section = (index) => {
        const at = sectionTable + index * sectionSize;
        return {
            type: u32(at + 4),
            offset: word(at + (is64 ? 0x18 : 0x10)),
            size: word(at + (is64 ? 0x20 : 0x14)),
            link: u32(at + (is64 ? 0x28 : 0x18)),
            count: u32(at + (is64 ? 0x2c : 0x1c)),
        };
    };
    const text = (table, at) => {
        const start = table.offset + at;
        let end = start;
        while (end < table.offset + table.size && bytes[end] !== 0) end += 1;
        return new TextDecoder().decode(bytes.subarray(start, end));
    };

    const needs = [];
    for (let index = 0; index < sectionCount; index += 1) {
        const verneed = section(index);
        if (verneed.type !== SHT_GNU_VERNEED) continue;
        const strings = section(verneed.link);
        // sh_info holds the number of Verneed entries, each followed by its
        // Vernaux entries; every `next` is relative to the entry it is in.
        let entry = verneed.offset;
        for (let n = 0; n < verneed.count; n += 1) {
            const library = text(strings, u32(entry + 4));
            const versions = [];
            let aux = entry + u32(entry + 8);
            for (let m = 0; m < u16(entry + 2); m += 1) {
                versions.push(text(strings, u32(aux + 8)));
                aux += u32(aux + 12);
            }
            needs.push({ library, versions });
            const next = u32(entry + 12);
            if (next === 0) break;
            entry += next;
        }
    }
    return needs;
}

/**
 * The newest version of each family a binary needs, e.g. { GLIBC: '2.34', GLIBCXX: '3.4.29' }.
 * Unnumbered versions (GLIBC_PRIVATE) are left out.
 * @param {Array<{ library: string, versions: string[] }>} needs
 * @returns {Record<string, string>}
 */
export function newestVersions(needs) {
    /** @type {Record<string, string>} */
    const newest = {};
    for (const { versions } of needs) {
        for (const version of versions) {
            const match = /^([A-Z]+)_(\d+(?:\.\d+)*)$/.exec(version);
            if (!match) continue;
            const [, family, number] = match;
            if (!newest[family] || compareVersions(number, newest[family]) > 0) newest[family] = number;
        }
    }
    return newest;
}

/**
 * @param {string} a dotted numbers, e.g. '2.34'
 * @param {string} b
 * @returns {number} negative, zero or positive
 */
export function compareVersions(a, b) {
    const left = a.split('.').map(Number);
    const right = b.split('.').map(Number);
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const diff = (left[i] ?? 0) - (right[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}
