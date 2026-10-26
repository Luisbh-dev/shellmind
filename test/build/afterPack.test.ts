import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import afterPack, { checkPackedNatives, LINUX_BASELINE, SKIP_LINUX_CHECK_ENV } from '../../scripts/after-pack.mjs';
import { compareVersions, elfVersionNeeds, newestVersions } from '../../scripts/elf-versions.mjs';

// The afterPack check of a packed desktop app (BPE-01): a Linux package must
// not ship native modules that need a newer glibc than its baseline, as
// sqlite3's prebuilt binary (glibc 2.38) did when packaged on a new Linux.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-afterpack-'));
afterAll(() => fs.rmSync(scratch, { recursive: true, force: true }));

type Need = { library: string; versions: string[] };

// A minimal ELF shared object: no code, only the sections the check reads
// (.dynstr and .gnu.version_r), as a linker lays them out.
function elf(needs: Need[], { is64 = true }: { is64?: boolean } = {}): Buffer {
    const strings: string[] = [''];
    const offsetOf = (text: string) => {
        let at = 0;
        for (const existing of strings) {
            if (existing === text) return at;
            at += Buffer.byteLength(existing) + 1;
        }
        strings.push(text);
        return at;
    };
    const verneed: Buffer[] = [];
    needs.forEach((need, index) => {
        const entry = Buffer.alloc(16 + 16 * need.versions.length);
        entry.writeUInt16LE(1, 0);
        entry.writeUInt16LE(need.versions.length, 2);
        entry.writeUInt32LE(offsetOf(need.library), 4);
        entry.writeUInt32LE(16, 8);
        entry.writeUInt32LE(index === needs.length - 1 ? 0 : entry.length, 12);
        need.versions.forEach((version, n) => {
            const aux = 16 + 16 * n;
            entry.writeUInt32LE(offsetOf(version), aux + 8);
            entry.writeUInt32LE(n === need.versions.length - 1 ? 0 : 16, aux + 12);
        });
        verneed.push(entry);
    });
    const dynstr = Buffer.from(strings.map((text) => `${text}\0`).join(''), 'utf8');
    const verneedData = Buffer.concat(verneed);
    const headerSize = is64 ? 64 : 52;
    const sectionSize = is64 ? 64 : 40;
    const dynstrAt = headerSize;
    const verneedAt = dynstrAt + dynstr.length;
    const sectionsAt = verneedAt + verneedData.length;
    const header = Buffer.alloc(headerSize);
    header.set([0x7f, 0x45, 0x4c, 0x46, is64 ? 2 : 1, 1, 1], 0);
    header.writeUInt16LE(3, 16); // ET_DYN
    if (is64) {
        header.writeBigUInt64LE(BigInt(sectionsAt), 0x28);
        header.writeUInt16LE(sectionSize, 0x3a);
        header.writeUInt16LE(3, 0x3c);
    } else {
        header.writeUInt32LE(sectionsAt, 0x20);
        header.writeUInt16LE(sectionSize, 0x2e);
        header.writeUInt16LE(3, 0x30);
    }
    const section = (type: number, offset: number, size: number, link = 0, info = 0) => {
        const entry = Buffer.alloc(sectionSize);
        entry.writeUInt32LE(type, 4);
        if (is64) {
            entry.writeBigUInt64LE(BigInt(offset), 0x18);
            entry.writeBigUInt64LE(BigInt(size), 0x20);
            entry.writeUInt32LE(link, 0x28);
            entry.writeUInt32LE(info, 0x2c);
        } else {
            entry.writeUInt32LE(offset, 0x10);
            entry.writeUInt32LE(size, 0x14);
            entry.writeUInt32LE(link, 0x18);
            entry.writeUInt32LE(info, 0x1c);
        }
        return entry;
    };
    return Buffer.concat([
        header,
        dynstr,
        verneedData,
        section(0, 0, 0),
        section(3, dynstrAt, dynstr.length), // SHT_STRTAB
        section(0x6ffffffe, verneedAt, verneedData.length, 1, needs.length), // SHT_GNU_verneed
    ]);
}

// node-pty as the Debian 11 build container compiles it (glibc 2.31, GCC 10).
const DEBIAN_11_BUILD: Need[] = [
    { library: 'libstdc++.so.6', versions: ['CXXABI_1.3.9', 'GLIBCXX_3.4.22', 'CXXABI_1.3', 'GLIBCXX_3.4'] },
    { library: 'libc.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.28', 'GLIBC_2.14'] },
];
// What Debian 12 builds: glibc 2.34 at most, GCC 11-era libstdc++ symbols.
const DEBIAN_12_BUILD: Need[] = [
    { library: 'libstdc++.so.6', versions: ['CXXABI_1.3', 'GLIBCXX_3.4.21', 'GLIBCXX_3.4.9'] },
    { library: 'libc.so.6', versions: ['GLIBC_2.2.5', 'GLIBC_2.34', 'GLIBC_2.14', 'GLIBC_PRIVATE'] },
];
// sqlite3 6.0.1's prebuilt linux-x64 binary.
const PREBUILT_SQLITE3: Need[] = [
    { library: 'libm.so.6', versions: ['GLIBC_2.29', 'GLIBC_2.2.5'] },
    { library: 'libc.so.6', versions: ['GLIBC_2.38', 'GLIBC_2.34', 'GLIBC_2.2.5'] },
];
const WINDOWS_DLL = Buffer.from('MZ\x90\x00 not an ELF file', 'latin1');

let tree = 0;
function packed(binaries: Record<string, Buffer>): string {
    const dir = path.join(scratch, `app-${tree++}`, 'resources', 'app.asar.unpacked');
    for (const [file, bytes] of Object.entries(binaries)) {
        fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
        fs.writeFileSync(path.join(dir, file), bytes);
    }
    return dir;
}
const SQLITE3 = 'node_modules/sqlite3/build/Release/node_sqlite3.node';
const PTY = 'node_modules/node-pty/build/Release/pty.node';

describe('ELF symbol versions', () => {
    it('reads the versions a 64-bit or 32-bit binary needs per library, as objdump -T lists them', () => {
        for (const is64 of [true, false]) {
            expect(elfVersionNeeds(elf(DEBIAN_12_BUILD, { is64 }))).toEqual(DEBIAN_12_BUILD);
        }
        expect(elfVersionNeeds(WINDOWS_DLL)).toBeNull();
        expect(elfVersionNeeds(elf([]))).toEqual([]);
    });

    it('takes the newest numbered version of each family', () => {
        expect(newestVersions(DEBIAN_12_BUILD)).toEqual({ CXXABI: '1.3', GLIBCXX: '3.4.21', GLIBC: '2.34' });
        expect(newestVersions(PREBUILT_SQLITE3)).toEqual({ GLIBC: '2.38' });
        expect(compareVersions('2.9', '2.34')).toBeLessThan(0);
        expect(compareVersions('3.4', '3.4.0')).toBe(0);
    });
});

describe('afterPack native module check', () => {
    it('passes a Linux package built within the baseline and names what each module needs', () => {
        const unpackedDir = packed({ [SQLITE3]: elf(DEBIAN_11_BUILD), [PTY]: elf(DEBIAN_11_BUILD) });
        const result = checkPackedNatives({ platform: 'linux', unpackedDir, env: {} });
        expect(result.errors).toEqual([]);
        expect(result.notes).toEqual([
            'node_modules/node-pty/build/Release/pty.node: CXXABI_1.3.9, GLIBCXX_3.4.22, GLIBC_2.28',
            'node_modules/sqlite3/build/Release/node_sqlite3.node: CXXABI_1.3.9, GLIBCXX_3.4.22, GLIBC_2.28',
        ]);
    });

    it('fails a Linux package with the prebuilt sqlite3 binary, which needs glibc 2.38', () => {
        const unpackedDir = packed({ [SQLITE3]: elf(PREBUILT_SQLITE3), [PTY]: elf(DEBIAN_11_BUILD) });
        const { errors } = checkPackedNatives({ platform: 'linux', unpackedDir, env: {} });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`${SQLITE3} needs GLIBC_2.38`);
        expect(errors[0]).not.toContain('pty.node');
        expect(errors[0]).toContain('npm run dist:linux');
        expect(errors[0]).toContain(`${SKIP_LINUX_CHECK_ENV}=1`);
    });

    it('fails a package whose native modules were compiled on a newer Linux than Debian 11', () => {
        const unpackedDir = packed({ [SQLITE3]: elf(DEBIAN_12_BUILD), [PTY]: elf(DEBIAN_12_BUILD) });
        const { errors } = checkPackedNatives({ platform: 'linux', unpackedDir, env: {} });
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain(`${SQLITE3} needs GLIBC_2.34`);
        expect(errors[0]).toContain(`${PTY} needs GLIBC_2.34`);
        expect(errors[0]).toContain('Debian 11, Ubuntu 20.04: GLIBC_2.31, GLIBCXX_3.4.28, CXXABI_1.3.12');
    });

    it('holds libstdc++ to the baseline too', () => {
        const newerCxx = [{ library: 'libstdc++.so.6', versions: ['GLIBCXX_3.4.29', 'CXXABI_1.3.13'] }, { library: 'libc.so.6', versions: ['GLIBC_2.17'] }];
        const unpackedDir = packed({ [SQLITE3]: elf(DEBIAN_11_BUILD), [PTY]: elf(newerCxx) });
        const { errors } = checkPackedNatives({ platform: 'linux', unpackedDir, env: {} });
        expect(errors.join('\n')).toContain(`${PTY} needs GLIBCXX_3.4.29, CXXABI_1.3.13`);
        expect(LINUX_BASELINE.GLIBCXX).toBe('3.4.28');
    });

    it('only warns when packaging for the build machine\'s Linux is asked for', () => {
        const unpackedDir = packed({ [SQLITE3]: elf(PREBUILT_SQLITE3), [PTY]: elf(DEBIAN_11_BUILD) });
        const result = checkPackedNatives({ platform: 'linux', unpackedDir, env: { [SKIP_LINUX_CHECK_ENV]: '1' } });
        expect(result.errors).toEqual([]);
        expect(result.warnings.join('\n')).toContain('GLIBC_2.38');
    });

    it('fails when the native modules are missing instead of passing with nothing checked', () => {
        for (const platform of ['linux', 'win32', 'darwin']) {
            const { errors } = checkPackedNatives({ platform, unpackedDir: packed({}), env: {} });
            expect(errors.map((error) => error.split(' ')[1])).toEqual(['sqlite3', 'node-pty']);
        }
        const { errors } = checkPackedNatives({ platform: 'linux', unpackedDir: packed({ [PTY]: elf(DEBIAN_11_BUILD) }), env: {} });
        expect(errors).toEqual([expect.stringContaining('No sqlite3 binary')]);
    });

    it('fails a Linux package holding binaries of another OS', () => {
        const unpackedDir = packed({ [SQLITE3]: WINDOWS_DLL, [PTY]: elf(DEBIAN_11_BUILD) });
        const { errors } = checkPackedNatives({ platform: 'linux', unpackedDir, env: {} });
        expect(errors).toEqual([expect.stringContaining(`${SQLITE3} is not a Linux binary`)]);
    });

    it('does not read glibc versions on Windows or macOS', () => {
        const unpackedDir = packed({
            'node_modules/sqlite3/build/Release/node_sqlite3.node': WINDOWS_DLL,
            'node_modules/node-pty/prebuilds/win32-x64/pty.node': WINDOWS_DLL,
        });
        expect(checkPackedNatives({ platform: 'win32', unpackedDir, env: {} })).toEqual({ errors: [], warnings: [], notes: [] });
    });

    it('stops electron-builder with the problem, from the resources folder of the platform', async () => {
        const bad = packed({ [SQLITE3]: elf(PREBUILT_SQLITE3), [PTY]: elf(DEBIAN_11_BUILD) });
        const good = packed({ [SQLITE3]: elf(DEBIAN_11_BUILD), [PTY]: elf(DEBIAN_11_BUILD) });
        const context = (unpackedDir: string) => ({
            appOutDir: path.dirname(path.dirname(unpackedDir)),
            electronPlatformName: 'linux',
            packager: { getResourcesDir: (appOutDir: string) => path.join(appOutDir, 'resources') },
        });
        const saved = process.env[SKIP_LINUX_CHECK_ENV];
        delete process.env[SKIP_LINUX_CHECK_ENV];
        try {
            await expect(afterPack(context(bad))).rejects.toThrow('needs GLIBC_2.38');
            await expect(afterPack(context(good))).resolves.toBeUndefined();
        } finally {
            if (saved !== undefined) process.env[SKIP_LINUX_CHECK_ENV] = saved;
        }
    });

    it('is the afterPack hook of every desktop build', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as { build: { afterPack?: string } };
        expect(pkg.build.afterPack).toBe('./scripts/after-pack.mjs');
        expect(fs.existsSync(path.join(repoRoot, pkg.build.afterPack ?? ''))).toBe(true);
    });
});
