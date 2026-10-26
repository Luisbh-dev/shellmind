import { describe, expect, it } from 'vitest';
import { sections } from '../../test/helpers/opsHost';
import { linuxLargeFilesScript, parseLinuxLargeFiles, parseWindowsLargeFiles, requireThreshold, windowsLargeFilesScript } from './largeFiles';

describe('largest files', () => {
    it('searches one filesystem above the threshold, GNU find or busybox', () => {
        const script = linuxLargeFilesScript('/var', 100);
        expect(script).toContain("p='/var'");
        // Paths with a newline would come out over several lines: left out.
        expect(script).toContain('find "$p" -xdev -type f -size +102400k ! -path "*$nl*" -printf');
        expect(script).toContain("! -path \"*$nl*\" -exec stat -c '%s %Y %U %n' {} +");
        expect(script).toContain("nl=$(printf '\\nx')");
        expect(script).toContain('sort -rn | head -n 50');
        expect(script).toContain('L="timeout 90"');
    });

    it('reads sizes, times and owners, and a search stopped at its budget', () => {
        const output = sections({
            files: [
                '125829120 1792886545.9648356650 root /srv/data/archive/backup 2026-09.tar',
                '73400320 1792886546 www-data /srv/data/uploads/video.mp4',
                'garbage line',
            ].join('\n'),
            rc: '124',
            errors: 'denied 4',
        });
        expect(parseLinuxLargeFiles(output)).toEqual({
            files: [
                { path: '/srv/data/archive/backup 2026-09.tar', bytes: 125829120, modifiedAt: 1792886545965, owner: 'root' },
                { path: '/srv/data/uploads/video.mp4', bytes: 73400320, modifiedAt: 1792886546000, owner: 'www-data' },
            ],
            timedOut: true,
            denied: 4,
        });
    });

    it('walks a Windows drive with a budget', () => {
        const script = windowsLargeFilesScript('D:\\', 500);
        expect(script).toContain(`$min=[long]${500 * 1024 * 1024}`);
        expect(script).toContain("New-Object IO.DirectoryInfo('D:\\')");
        expect(parseWindowsLargeFiles('{"files":[{"p":"D:\\\\vm.vhdx","b":2147483648,"t":1700000000000}],"denied":1,"timedOut":false}')).toEqual({
            files: [{ path: 'D:\\vm.vhdx', bytes: 2147483648, modifiedAt: 1700000000000, owner: null }], timedOut: false, denied: 1,
        });
    });

    it('takes the listed thresholds only', () => {
        expect(requireThreshold(undefined)).toBe(100);
        expect(requireThreshold('1024')).toBe(1024);
        expect(() => requireThreshold('7')).toThrow(/threshold/);
    });
});
