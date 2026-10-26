import { describe, expect, it } from 'vitest';
import { sections } from '../../test/helpers/opsHost';
import { testCaps } from '../../test/helpers/opsCaps';
import type { DiskMount } from '../../shared/disk';
import { deletedScanScript, ownerOf, parseDeletedScan, parseReleaseInput, prepareRelease, releaseScript } from './deleted';

const ROOT: DiskMount = { mount: '/', device: '/dev/sda1', fsType: 'ext4', totalBytes: 1, usedBytes: 1, freeBytes: 0, usagePercent: 100, inodes: null, readOnly: false };
const DOCKER_ID = 'a'.repeat(64);

describe('the scan', () => {
    it('finds deleted files with lsof, else in /proc, and checks each one there', () => {
        const script = deletedScanScript("/var/it's");
        expect(script).toContain("p='/var/it'\\''s'");
        expect(script).toContain('lsof -nP -w +L1 -F pf');
        expect(script).toContain('lsof -v 2>&1 | grep -qi revision && S=lsof');
        expect(script).toContain('ls -l /proc/[0-9]*/fd');
        expect(script).toContain('stat -L -c \'%s %d %i\' "$f"');
        expect(script).toContain('[ "$2" = "$dev" ] || continue');
        // The start time follows the name, which may hold ") " itself.
        expect(script).toContain('st=${st##*") "}');
        expect(script).toContain('st=${20:-}');
    });

    it('reads the files holding space, their processes and what runs them, largest first', () => {
        const output = sections({
            source: 'proc',
            files: [
                'F\t812\t5\t52428800\t1311\t/var/log/nginx/access.log (deleted)',
                'F\t901\t3\t1048576\t18446744073709551615\t/srv/app/out.log (deleted)',
                'F\t812\t7\t2097152\t1312\t/var/log/nginx/error.log (deleted)',
                // Empty: holds nothing.
                'F\t812\t9\t0\t1313\t/tmp/#1234 (deleted)',
            ].join('\n'),
            procs: [
                'P\t812\twww-data\t0::/system.slice/nginx.service \t4242\tnginx',
                `P\t901\troot\t0::/system.slice/docker-${DOCKER_ID}.scope \t\tnode server`,
            ].join('\n'),
        });
        const { files, source } = parseDeletedScan(output);
        expect(source).toBe('proc');
        expect(files.map((file) => [file.pid, file.fd, file.bytes, file.path, file.process, file.unit, file.container])).toEqual([
            [812, 5, 52428800, '/var/log/nginx/access.log', 'nginx', 'nginx.service', null],
            [812, 7, 2097152, '/var/log/nginx/error.log', 'nginx', 'nginx.service', null],
            [901, 3, 1048576, '/srv/app/out.log', 'node server', null, DOCKER_ID.slice(0, 12)],
        ]);
        // Inodes past 2^53 stay exact; a start time the scan could not read is null.
        expect(files.map((file) => [file.inode, file.started])).toEqual([['1311', '4242'], ['1312', '4242'], ['18446744073709551615', null]]);
    });
});

describe('ownerOf', () => {
    it('names the system service or the container that runs a process', () => {
        expect(ownerOf('0::/system.slice/rsyslog.service ')).toEqual({ unit: 'rsyslog.service', container: null });
        expect(ownerOf('12:pids:/system.slice/cron.service 1:name=systemd:/system.slice/cron.service ')).toEqual({ unit: 'cron.service', container: null });
        expect(ownerOf(`0::/docker/${DOCKER_ID} `)).toEqual({ unit: null, container: 'aaaaaaaaaaaa' });
        expect(ownerOf(`0::/machine.slice/libpod-${'b'.repeat(64)}.scope/container `)).toEqual({ unit: null, container: 'bbbbbbbbbbbb' });
        expect(ownerOf('0::/user.slice/user-1000.slice/user@1000.service/app.slice/foo.service ')).toEqual({ unit: null, container: null });
        expect(ownerOf('0::/ ')).toEqual({ unit: null, container: null });
        expect(ownerOf('0::/system.slice/bad;name.service ')).toEqual({ unit: null, container: null });
    });
});

describe('releasing a deleted file', () => {
    it('validates what the request names', () => {
        expect(parseReleaseInput({ action: 'truncate', pid: 812, fd: 5, process: 'nginx' })).toMatchObject({ action: 'truncate', pid: 812, fd: 5 });
        expect(() => parseReleaseInput({ action: 'rm', pid: 812, process: 'nginx' })).toThrow(/not a way/);
        expect(() => parseReleaseInput({ action: 'truncate', pid: '812', fd: 5, process: 'nginx' })).toThrow(/pid/);
        expect(() => parseReleaseInput({ action: 'truncate', pid: 812, process: 'nginx' })).toThrow(/fd/);
        expect(() => parseReleaseInput({ action: 'restart-service', pid: 812, process: 'nginx', unit: 'nginx; reboot' })).toThrow(/unit/);
        expect(() => parseReleaseInput({ action: 'restart-container', pid: 812, process: 'nginx', container: '-rf' })).toThrow(/container/);
        expect(() => parseReleaseInput({ action: 'terminate', pid: 812, process: 'a\nb' })).toThrow(/process/);
        expect(parseReleaseInput({ action: 'truncate', pid: 812, fd: 5, process: 'nginx', started: '4242', inode: '18446744073709551615' })).toMatchObject({ started: '4242', inode: '18446744073709551615' });
        expect(() => parseReleaseInput({ action: 'truncate', pid: 812, fd: 5, process: 'nginx', inode: '1; reboot' })).toThrow(/inode/);
        expect(() => parseReleaseInput({ action: 'terminate', pid: 812, process: 'nginx', started: 4242 })).toThrow(/started/);
    });

    // SEC-3: the descriptor belongs to a process any user may run, which can
    // point it at another file at any moment. The checks and root's write
    // must go through one descriptor the script opened itself.
    it('opens the descriptor once and checks and truncates through that one', () => {
        const input = parseReleaseInput({ action: 'truncate', pid: 812, fd: 5, process: 'nginx', started: '4242', inode: '1311' });
        const lines = releaseScript('/', input, ': > /proc/$$/fd/3').split('\n');
        const open = lines.indexOf('exec 3< /proc/812/fd/5');
        expect(open).toBeGreaterThan(0);
        // Before it, only the process checks and a look at the type (a FIFO
        // would block the open); after it, nothing goes through the process's
        // descriptor again.
        expect(lines.slice(0, open).filter((line) => line.includes('/proc/812/fd/5'))).toHaveLength(1);
        expect(lines.slice(0, open).find((line) => line.includes('/proc/812/fd/5'))).toMatch(/^\[ -f \/proc\/812\/fd\/5 \]/);
        expect(lines.slice(open + 1).some((line) => line.includes('/proc/812/fd/5'))).toBe(false);
        const after = lines.slice(open + 1).join('\n');
        expect(after).toContain('t=$(readlink /proc/$$/fd/3');
        expect(after).toContain('[ "$(stat -L -c %d /proc/$$/fd/3 2>/dev/null)" = "$(stat -c %d -- \'/\' 2>/dev/null)" ]');
        expect(after).toContain('[ "$(stat -L -c %i /proc/$$/fd/3 2>/dev/null)" = 1311 ]');
        expect(lines.filter(Boolean).at(-1)).toBe(': > /proc/$$/fd/3');
        // The pid is still the process of the scan: its name and start time.
        expect(lines.slice(0, open).join('\n')).toContain('[ "$st" = 4242 ]');
    });

    it('checks the start time before signalling a process, when the scan read it', () => {
        const kill = releaseScript('/', parseReleaseInput({ action: 'terminate', pid: 812, process: 'nginx', started: '4242' }), 'kill -TERM 812');
        expect(kill.indexOf('[ "$st" = 4242 ]')).toBeLessThan(kill.indexOf('kill -TERM 812'));
        expect(kill.indexOf('[ "$st" = 4242 ]')).toBeGreaterThan(0);
        expect(releaseScript('/', parseReleaseInput({ action: 'terminate', pid: 812, process: 'nginx' }), 'kill -TERM 812')).not.toContain('$st');
    });

    it('truncates through /proc after checking the process and the file, as root', () => {
        const sudo = testCaps({ root: false, sudo: true });
        const action = prepareRelease(sudo, ROOT, parseReleaseInput({ action: 'truncate', pid: 812, fd: 5, process: "it's" }));
        expect(action.display).toBe("sudo -n sh -c 'exec 3< /proc/812/fd/5 && : > /proc/$$/fd/3'");
        expect(action.meta).toEqual({ kind: 'disk', action: 'truncate', target: "it's (pid 812), fd 5" });
        expect(() => prepareRelease(testCaps({ root: false, sudo: false }), ROOT, parseReleaseInput({ action: 'truncate', pid: 812, fd: 5, process: 'x' }))).toThrow(/needs root/);
    });

    it('restarts the unit with the operations panel action', () => {
        const action = prepareRelease(testCaps(), ROOT, parseReleaseInput({ action: 'restart-service', pid: 812, process: 'nginx', unit: 'nginx.service' }));
        expect(action.display).toBe("systemctl --no-ask-password restart -- 'nginx.service'");
        expect(action.meta).toMatchObject({ kind: 'disk', action: 'restart-service', target: 'nginx.service' });
        const container = prepareRelease(testCaps(), ROOT, parseReleaseInput({ action: 'restart-container', pid: 901, process: 'node', container: 'aaaaaaaaaaaa' }));
        expect(container.display).toBe("docker 'restart' 'aaaaaaaaaaaa'");
    });

    it('is a Linux check', () => {
        expect(() => prepareRelease(testCaps({ platform: 'windows' }), ROOT, parseReleaseInput({ action: 'terminate', pid: 812, process: 'x' }))).toThrow(/Linux/);
    });
});
