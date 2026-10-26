import { describe, expect, it } from 'vitest';
import { sections } from '../../test/helpers/opsHost';
import { fileRunScript } from './cleanups/linux';
import { linuxLargeFilesScript } from './largeFiles';
import { linuxTreeScript, linuxUsageScript, parseLinuxUsage, parseTree, parseWindowsUsage, requireBudget, requirePath, windowsUsageScript } from './usage';

const DU = [
    '390568\t/',
    '196628\t/srv',
    '112100\t/usr',
    '80184\t/var',
    '1472\t/etc',
    '4\t/mnt',
    '0\t/lib',
    '0\t/.dockerenv',
    '@@REST 12 48',
].join('\n');

describe('the Linux explorer script', () => {
    it('quotes the path and stays on its filesystem, at low priority, within the budget', () => {
        const script = linuxUsageScript("/srv/it's $(reboot)", 60);
        expect(script).toContain("p='/srv/it'\\''s $(reboot)'");
        expect(script.match(/\$\(reboot\)/g)).toHaveLength(1);
        expect(script).toContain('du -x -k -a -d 1 -- "$p"');
        expect(script).toContain('L="timeout 60"');
        expect(script).toContain('nice -n 19');
        expect(script).toContain('ionice -c3');
    });

    it('keeps its side files in a private folder (it may run as root)', () => {
        for (const script of [linuxUsageScript('/var', 60), linuxLargeFilesScript('/var', 100), fileRunScript('tmp', { days: 10 }, 'delete')]) {
            expect(script).toContain('d=$(mktemp -d 2>/dev/null) || { d=/tmp/.shellmind.$$; mkdir -m 700 "$d"');
            expect(script).toContain('rm -rf "$d"');
            expect(script).not.toMatch(/mktemp 2>|\/tmp\/\.shellmind-/);
        }
    });

    it('lists one level, largest first, with kinds, other filesystems and what did not fit', () => {
        const listing = parseLinuxUsage('/', sections({
            check: 'ok', du: DU, rc: '1', errors: 'denied 8', dirs: '/srv\n/usr\n/var\n/etc\n/mnt', links: '/lib', mounts: '/\n/proc\n/mnt',
        }));
        expect(listing.totalBytes).toBe(390568 * 1024);
        expect(listing.entries.map((entry) => [entry.name, entry.kind, entry.bytes])).toEqual([
            ['srv', 'dir', 196628 * 1024], ['usr', 'dir', 112100 * 1024], ['var', 'dir', 80184 * 1024], ['etc', 'dir', 1472 * 1024],
            ['mnt', 'dir', 4096], ['lib', 'other', 0], ['.dockerenv', 'file', 0],
        ]);
        expect(listing.entries.find((entry) => entry.name === 'mnt')?.otherFs).toBe(true);
        expect(listing.omitted).toEqual({ count: 12, bytes: 48 * 1024 });
        expect(listing).toMatchObject({ denied: 8, timedOut: false });
    });

    it('keeps what finished before the time budget ran out', () => {
        const listing = parseLinuxUsage('/var', sections({ check: 'ok', du: '50000\t/var/lib\n20\t/var/tmp', rc: '124', errors: 'denied 0', dirs: '/var/lib\n/var/tmp', mounts: '/' }));
        expect(listing).toMatchObject({ timedOut: true, totalBytes: null });
        expect(listing.entries).toHaveLength(2);
    });

    it('says when the directory is gone, unreadable or the scan failed', () => {
        expect(() => parseLinuxUsage('/gone', sections({ check: 'missing', du: '', rc: '', errors: 'denied 0' }))).toThrow(/not a directory/);
        expect(() => parseLinuxUsage('/root', sections({ check: 'denied', du: '', rc: '', errors: 'denied 0' }))).toThrow(/may not read/);
        expect(() => parseLinuxUsage('/x', sections({ check: 'ok', du: '', rc: '2', errors: 'denied 0\ndu: invalid option -- d' }))).toThrow(/invalid option/);
        expect(() => parseLinuxUsage('/x', '@@SM:check\nok\n')).toThrow(/cut off/);
    });

    it('leaves out names it cannot place (a newline inside a name), every part of them', () => {
        // "b\nc", and "e\n2\t/srv/a" whose second part looks like a line of its own.
        const listing = parseLinuxUsage('/srv', sections({
            check: 'ok', du: '8\t/srv/a\n4\t/srv/b\nc\n3\t/srv/e\n2\t/srv/a\n20\t/srv', rc: '0', errors: 'denied 0', dirs: '', mounts: '', odd: '/srv/b\x01c\n/srv/e\x012\t/srv/a',
        }));
        expect(listing.entries.map((entry) => [entry.name, entry.bytes])).toEqual([['a', 8 * 1024]]);
        expect(listing.totalBytes).toBe(20 * 1024);
    });

    it('lists only names, NUL-safe, and counts only lines of du beyond the cap', () => {
        const script = linuxUsageScript('/srv', 60, '/');
        expect(script).toContain('find "$p" -mindepth 1 -maxdepth 1 -name "*$nl*" -print0');
        expect(script).toContain("tr '\\n\\000' '\\001\\n'");
        expect(script).toContain("awk -v cap=301 '!/^[0-9]+\\t/ { next }");
    });

    it('stays on the filesystem asked for: /proc below "/" is refused', () => {
        const script = linuxUsageScript('/proc', 60, '/');
        expect(script).toContain("mp='/'");
        expect(script).toContain('[ "$(stat -L -c %d -- "$p" 2>/dev/null)" != "$(stat -L -c %d -- "$mp" 2>/dev/null)" ]');
        expect(script).toContain('if [ "$c" = ok ]; then { $L du -x');
        expect(() => parseLinuxUsage('/proc', sections({ check: 'otherfs', du: '', rc: '', errors: 'denied 0' }), '/')).toThrow(/\/proc is not on \/: it is on another filesystem/);
    });
});

describe('the two-level tree for the AI', () => {
    it('lists directories two levels deep, largest first', () => {
        expect(linuxTreeScript('/var', 30, 40)).toContain("du -x -k -d 2 -- '/var' 2>/dev/null | sort -rn | head -n 40");
        expect(parseTree('100\t/var\n60\t/var/lib\nnoise')).toEqual([{ path: '/var', bytes: 102400 }, { path: '/var/lib', bytes: 61440 }]);
    });
});

describe('the Windows explorer script', () => {
    it('walks with a time budget and does not follow reparse points', () => {
        const script = windowsUsageScript("C:\\Users\\Bob's files", 30);
        expect(script).toContain("$root='C:\\Users\\Bob''s files'");
        expect(script).toContain('$limit=30000');
        expect(script).toContain('[IO.FileAttributes]::ReparsePoint');
        expect(script).not.toMatch(/FromBase64String|EncodedCommand|Invoke-Expression/);
    });

    it('reads the walk, partial and unmeasured folders included', () => {
        const listing = parseWindowsUsage('C:\\Users', JSON.stringify({
            entries: [
                { n: 'admin', b: 5368709120, k: 'd', p: true },
                { n: 'pagefile.sys', b: 1073741824, k: 'f' },
                { n: 'All Users', b: 0, k: 'd', o: true },
                { n: 'Public', b: null, k: 'd' },
                { n: '..\\evil', b: 1, k: 'f' },
            ],
            total: 6442450944, restCount: 2, restBytes: 1024, denied: 3, timedOut: true,
        }));
        expect(listing.entries.map((entry) => [entry.path, entry.bytes, entry.kind, entry.partial ?? false, entry.otherFs ?? false])).toEqual([
            ['C:\\Users\\admin', 5368709120, 'dir', true, false],
            ['C:\\Users\\pagefile.sys', 1073741824, 'file', false, false],
            ['C:\\Users\\All Users', 0, 'dir', false, true],
            ['C:\\Users\\Public', null, 'dir', false, false],
        ]);
        expect(listing).toMatchObject({ totalBytes: null, timedOut: true, denied: 3, omitted: { count: 2, bytes: 1024 } });
        expect(parseWindowsUsage('C:\\', '{"entries":[],"total":0,"restCount":0,"denied":0,"timedOut":false}').entries[0]).toBeUndefined();
        expect(() => parseWindowsUsage('C:\\x', '{"missing":true}')).toThrow(/not a folder/);
        expect(() => parseWindowsUsage('C:\\x', '{"denied":true}')).toThrow(/may not read/);
    });
});

describe('request checks', () => {
    it('take absolute paths and the listed budgets only', () => {
        expect(requirePath('linux', '/var//log/')).toBe('/var/log');
        expect(() => requirePath('linux', '../etc')).toThrow(/absolute directory/);
        expect(() => requirePath('linux', undefined)).toThrow(/absolute directory/);
        expect(requirePath('windows', 'c:/Windows')).toBe('C:\\Windows');
        expect(() => requirePath('windows', '/var')).toThrow(/on a drive/);
        expect(requireBudget(undefined)).toBe(60);
        expect(requireBudget('180')).toBe(180);
        expect(() => requireBudget('5')).toThrow(/time budget/);
    });
});
