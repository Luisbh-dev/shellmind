import { describe, expect, it } from 'vitest';
import { parseDismAnalysis, parseWindowsCleanups, updateCacheRunScript, windowsCleanupScript, windowsCommand } from './windows';

const REPORT = JSON.stringify({
    system: 'C:',
    tempPaths: ['C:\\Users\\ops\\AppData\\Local\\Temp', 'C:\\Windows\\Temp'],
    updatePath: 'C:\\Windows\\SoftwareDistribution\\Download',
    recyclePaths: ['C:\\$Recycle.Bin', 'D:\\$Recycle.Bin'],
    temp: { b: 52428800, c: 120, stopped: false, top: [{ p: 'C:\\Windows\\Temp\\big.tmp', b: 31457280, t: 1700000000000 }] },
    update: { b: 1073741824, c: 40, stopped: true, top: [] },
    recycle: { b: 0, c: 0, stopped: false, top: [] },
});

describe('Windows cleanups', () => {
    it('measures without changing anything', () => {
        const script = windowsCleanupScript(7);
        expect(script).toContain('Measure-Files $t (Get-Date).ToUniversalTime().AddDays(-7)');
        expect(script).not.toMatch(/Remove-Item|\.Delete\(\)|Stop-Service|Dism/);
        expect(script).not.toMatch(/FromBase64String|Invoke-Expression|EncodedCommand/);
    });

    it('reads the measurements, the drives and the analysis DISM still needs', () => {
        const previews = parseWindowsCleanups(REPORT, true, ['C:\\', 'D:\\'], { days: 7 });
        const byId = Object.fromEntries(previews.map((preview) => [preview.id, preview]));
        expect(byId['win-temp']).toMatchObject({ status: 'ready', bytes: 52428800, count: 120, estimate: 'about', mounts: ['C:\\'], params: { days: 7 } });
        expect(byId['win-temp'].command).toContain('AddDays(-7)');
        expect(byId['win-update-cache']).toMatchObject({ status: 'ready', estimate: 'at-least', mounts: ['C:\\'] });
        expect(byId['win-recycle-bin']).toMatchObject({ status: 'nothing', mounts: ['C:\\', 'D:\\'] });
        expect(byId['win-component-store']).toMatchObject({ status: 'analyze', bytes: null });
    });

    it('needs an administrator', () => {
        const previews = parseWindowsCleanups(REPORT, false, ['C:\\'], { days: 7 });
        expect(previews.every((preview) => preview.status === 'unavailable' && preview.reason?.code === 'NOT_ELEVATED')).toBe(true);
    });

    it('reads DISM\'s analysis, in either decimal notation', () => {
        const report = [
            'exit=0',
            'Component Store (WinSxS) information:',
            'Windows Explorer Reported Size of Component Store : 8.43 GB',
            'Actual Size of Component Store : 8.27 GB',
            '    Shared with Windows : 5.29 GB',
            '    Backups and Disabled Features : 2.68 GB',
            '    Cache and Temporary Data : 297.66 MB',
            'Date of Last Cleanup : 2026-09-14 03:12:44',
            'Number of Reclaimable Packages : 3',
            'Component Store Cleanup Recommended : Yes',
        ].join('\r\n');
        expect(parseDismAnalysis(report)).toEqual({
            exitCode: 0,
            recommended: true,
            bytes: Math.round(2.68 * 1024 ** 3) + Math.round(297.66 * 1024 ** 2),
            facts: { size: Math.round(8.27 * 1024 ** 3), backups: Math.round(2.68 * 1024 ** 3), cache: Math.round(297.66 * 1024 ** 2), packages: 3, lastCleanup: '2026-09-14 03:12:44', recommended: 'yes' },
        });
        expect(parseDismAnalysis('exit=0\nBackups and Disabled Features : 2,68 GB\nComponent Store Cleanup Recommended : No').bytes).toBe(Math.round(2.68 * 1024 ** 3));
        expect(parseDismAnalysis('exit=740\nError: 740').exitCode).toBe(740);
    });

    it('names the commands as an administrator would type them', () => {
        expect(windowsCommand('win-component-store', {})).toBe('Dism.exe /Online /Cleanup-Image /StartComponentCleanup');
        expect(windowsCommand('win-update-cache', {})).toMatch(/^Stop-Service wuauserv,bits -Force; Rename-Item .*; Start-Service wuauserv,bits; Remove-Item .*Download\.shellmind-\*" -Recurse -Force$/);
    });

    it('stops Windows Update only while its download folder is renamed aside', () => {
        const script = updateCacheRunScript();
        expect(script).toContain("$names=@('wuauserv','bits')");
        const restart = script.indexOf('finally{foreach($n in $running){Start-Service');
        expect(script.indexOf('$active|Stop-Service')).toBeLessThan(script.indexOf('Rename-Item -LiteralPath $dl'));
        expect(script.indexOf('Rename-Item -LiteralPath $dl')).toBeLessThan(restart);
        // What was renamed aside goes once the services run again.
        expect(script.lastIndexOf("-Filter 'Download.shellmind-*'")).toBeGreaterThan(restart);
        expect(script).not.toMatch(/FromBase64String|Invoke-Expression|EncodedCommand/);
    });
});
