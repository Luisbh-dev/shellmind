import { describe, expect, it } from 'vitest';
import { resolveCleanupParams } from '../../../shared/disk';
import { sections } from '../../../test/helpers/opsHost';
import { testCaps } from '../../../test/helpers/opsCaps';
import {
    FILE_CLEANUPS,
    estimateVacuum,
    fileRunScript,
    journalCommand,
    linuxCleanupScript,
    parseLinuxCleanups,
    parseVacuumOutput,
    rotatedLogsExpression,
    tmpExpression
} from './linux';

const params = Object.fromEntries(FILE_CLEANUPS.map((id) => [id, resolveCleanupParams(id, {})!])) as Parameters<typeof linuxCleanupScript>[0];
const NOW = Date.UTC(2026, 9, 25);
const DAY = 86_400_000;
const MiB = 1024 * 1024;

// What the Debian test server printed (test/fixtures/disk/e2e/seed.sh).
const OUTPUT = sections({
    journal: [
        'tool',
        `${8 * MiB} ${(NOW - 30 * DAY) / 1000} /var/log/journal/x/system@aaa-0000000000000001-0001.journal`,
        `${9 * MiB} ${(NOW - 20 * DAY) / 1000} /var/log/journal/x/system@aaa-0000000000005323-0002.journal`,
        `${48 * MiB} ${NOW / 1000} /var/log/journal/x/system.journal`,
        `${8 * MiB} ${(NOW - 10 * DAY) / 1000} /var/log/journal/x/user-1000@bbb-0000000000002dd1-0003.journal`,
    ].join('\n'),
    packages: 'apt\napt 24592 /var/cache/apt',
    rotated: `10485760 1791158546 /var/log/app/app.log.1\n5242880 1791158546 /var/log/app/app.log.2.gz\n@@TOTAL 2 15728640`,
    tmp: '@@TOTAL 0 0',
    core: '31457280 1792627346 /var/lib/systemd/coredump/core.worker.1000.1.zst\n@@TOTAL 1 31457280',
    where: '/var/log/journal\t/\n/var/cache/apt\t/\n/var/log\t/var\n/tmp\t/tmp\n/var/tmp\t/var\n/var/lib/systemd/coredump\t/var',
});

describe('the cleanup check', () => {
    it('measures every file cleanup in one read-only script', () => {
        const script = linuxCleanupScript(params);
        // Whether find takes -delete is tried on an empty folder of its own,
        // with a test that is false for the folder itself.
        const probe = 'p=$(mktemp -d 2>/dev/null) && { if find "$p" -maxdepth 0 -type f -delete 2>/dev/null; then echo delete; else echo rm; fi; rmdir "$p" 2>/dev/null; }';
        expect(script.split('\n')).toContain(probe);
        expect(script.split('\n').filter((line) => line !== probe).join('\n')).not.toMatch(/\brm\b|-delete|--vacuum|clean all|apt-get clean/);
        expect(script).toContain("find /var/log -xdev -type f ! -path '/var/log/journal/*'");
        expect(script).toContain("-exec stat -c '%b %B %Y %n' {} +");
    });

    it('turns the measurements into previews with the filesystems they free', () => {
        const previews = parseLinuxCleanups(OUTPUT, testCaps({ root: true }), ['/', '/var'], params, NOW);
        const byId = Object.fromEntries(previews.map((preview) => [preview.id, preview]));
        // 73 MiB of journal, 200 MiB allowed: nothing to vacuum.
        expect(byId.journal).toMatchObject({ status: 'nothing', bytes: 0, count: 0, mounts: ['/'], command: 'journalctl --vacuum-size=200M', facts: { usage: 73 * MiB, files: 4, archived: 3 } });
        expect(byId['package-cache']).toMatchObject({ status: 'ready', bytes: 24592 * 1024, estimate: 'up-to', mounts: ['/'], command: 'apt-get clean', facts: { manager: 'apt' } });
        expect(byId['rotated-logs']).toMatchObject({ status: 'ready', bytes: 15728640, count: 2, mounts: ['/var'] });
        expect(byId['rotated-logs'].items[0]).toEqual({ label: '/var/log/app/app.log.1', bytes: 10485760, modifiedAt: 1791158546000 });
        // /tmp is not a local filesystem here (tmpfs): only /var/tmp's counts.
        expect(byId.tmp).toMatchObject({ status: 'nothing', count: 0, mounts: ['/var'] });
        expect(byId['core-dumps']).toMatchObject({ status: 'ready', bytes: 31457280, count: 1 });
    });

    it('needs root or passwordless sudo to clean, and says so', () => {
        const previews = parseLinuxCleanups(OUTPUT, testCaps({ root: false, sudo: false }), ['/'], params, NOW);
        expect(previews.every((preview) => preview.status === 'unavailable' && preview.reason?.code === 'NOT_ELEVATED')).toBe(true);
        const sudo = parseLinuxCleanups(OUTPUT, testCaps({ root: false, sudo: true }), ['/'], params, NOW);
        expect(sudo.find((preview) => preview.id === 'package-cache')?.command).toBe('sudo -n apt-get clean');
    });

    it('says what is not there', () => {
        const previews = parseLinuxCleanups(sections({ journal: '', packages: '', rotated: '@@TOTAL 0 0', tmp: '', core: '', where: '' }), testCaps(), ['/'], params, NOW);
        expect(previews.find((preview) => preview.id === 'journal')).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_FOUND' } });
        expect(previews.find((preview) => preview.id === 'package-cache')).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_FOUND' } });
        expect(previews.find((preview) => preview.id === 'core-dumps')).toMatchObject({ status: 'nothing', count: 0 });
    });
});

describe('the journal vacuum', () => {
    const files = [
        { bytes: 100 * MiB, modifiedAt: NOW - 30 * DAY, path: '/var/log/journal/x/system@a-1.journal' },
        { bytes: 100 * MiB, modifiedAt: NOW - 20 * DAY, path: '/var/log/journal/x/system@a-2.journal' },
        { bytes: 100 * MiB, modifiedAt: NOW - 2 * DAY, path: '/var/log/journal/x/system@a-3.journal~' },
        { bytes: 100 * MiB, modifiedAt: NOW, path: '/var/log/journal/x/system.journal' },
    ];

    it('removes the oldest archived files until the journal fits, or those too old', () => {
        expect(estimateVacuum(files, 200, 0, NOW)).toMatchObject({ bytes: 200 * MiB });
        expect(estimateVacuum(files, 2000, 7, NOW).removed.map((file) => file.path)).toEqual([files[0].path, files[1].path]);
        // The active file never goes, whatever the size asked for.
        expect(estimateVacuum(files, 50, 0, NOW).removed).toHaveLength(3);
    });

    it('builds the command and reads what it freed', () => {
        expect(journalCommand({ keepMB: 500, keepDays: 14 })).toBe('journalctl --vacuum-size=500M --vacuum-time=14d');
        expect(parseVacuumOutput('Deleted archived journal /var/log/journal/x/system@a.journal (8.0M).\nVacuuming done, freed 1.2G of archived journals from /var/log/journal/x.\nVacuuming done, freed 0B of archived journals from /run/log/journal.')).toBe(Math.round(1.2 * 1024 ** 3));
        expect(parseVacuumOutput('nothing')).toBeNull();
    });
});

describe('the file cleanups', () => {
    it('select rotated logs and old temporary files by age', () => {
        expect(rotatedLogsExpression(7)).toMatch(/-name '\*\.gz' -o .* -name '\*-\[0-9\]\[0-9\]\[0-9\]\[0-9\]\[0-9\]\[0-9\]\[0-9\]\[0-9\]' \\\) -mtime \+6$/);
        expect(tmpExpression('"$@"', 10)).toContain("! -path '/tmp/systemd-private-*'");
        expect(tmpExpression('"$@"', 10)).toMatch(/-atime \+9 -mtime \+9 -ctime \+9$/);
    });

    it('remove what the preview selects, over the folders that exist, and keep find\'s status', () => {
        const script = fileRunScript('tmp', { days: 10 }, 'delete');
        expect(script).toContain("for d in '/tmp' '/var/tmp'; do [ -d \"$d\" ] && set -- \"$@\" \"$d\"; done");
        expect(script).toContain(`find ${tmpExpression('"$@"', 10)} -print -delete`);
        expect(script).toContain('files removed');
        expect(fileRunScript('core-dumps', { days: 0 }, 'delete')).toContain("find \"$@\" -xdev -type f -print -delete");
    });

    // SEC-4: other users can swap a folder of /tmp for a symbolic link
    // between find's walk and a removal by path. find -delete removes each
    // file relative to the folder it walks; rm by path only where a busybox
    // find cannot -delete, which the preview then shows.
    it('remove with find -delete where the server\'s find has it, else with rm by path, as the preview shows', () => {
        expect(fileRunScript('tmp', { days: 10 }, 'delete')).not.toContain('rm -f');
        expect(fileRunScript('tmp', { days: 10 }, 'rm')).toContain(`find ${tmpExpression('"$@"', 10)} -print -exec rm -f -- {} +`);
        const deleting = parseLinuxCleanups(OUTPUT.replace('\n@@SM:end\n', '\n@@SM:remove\ndelete\n@@SM:end\n'), testCaps({ root: true }), ['/', '/var'], params, NOW);
        const rotated = deleting.find((preview) => preview.id === 'rotated-logs');
        expect(rotated?.command).toBe(`find ${rotatedLogsExpression(7)} -delete`);
        expect(rotated?.facts).toEqual({ removal: 'delete' });
        // A server that did not answer the probe gets rm, which every find has.
        const removing = parseLinuxCleanups(OUTPUT, testCaps({ root: true }), ['/', '/var'], params, NOW);
        expect(removing.find((preview) => preview.id === 'tmp')).toMatchObject({ command: `find ${tmpExpression('/tmp /var/tmp', 10)} -exec rm -f -- {} +`, facts: { removal: 'rm' } });
    });
});
