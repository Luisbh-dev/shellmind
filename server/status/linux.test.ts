import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LINUX_STATUS_SCRIPT, parseCpuLine, parseDf, parseLinuxStatus, parseMeminfo, parseNetDev } from './linux';

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/ops/${name}`, import.meta.url)), 'utf8');

describe('LINUX_STATUS_SCRIPT', () => {
    it('is a POSIX script for `sh -s`: no login-shell quoting, df only on local mounts, two samples', () => {
        expect(LINUX_STATUS_SCRIPT).toContain('MemAvailable');
        expect(LINUX_STATUS_SCRIPT).toContain('df -P -k "$@"');
        expect(LINUX_STATUS_SCRIPT).not.toMatch(/df -P -k\s*(2>|$)/m);
        expect(LINUX_STATUS_SCRIPT.match(/^sleep 1$/gm)).toHaveLength(1);
        expect(LINUX_STATUS_SCRIPT.trimEnd().endsWith('m end')).toBe(true);
        // awk fields of the meminfo/df commands are not mangled by an outer shell.
        expect(LINUX_STATUS_SCRIPT).not.toContain('sh -c');
    });
});

describe('parseLinuxStatus', () => {
    const snapshot = parseLinuxStatus(fixture('status-ubuntu.txt'), 42);

    it('reads host identity, uptime and load', () => {
        expect(snapshot).toMatchObject({
            platform: 'linux',
            collectedAt: 42,
            hostname: 'web-01',
            os: 'Ubuntu 22.04.4 LTS',
            kernel: '5.15.0-105-generic',
            uptimeSeconds: 1234568,
            load: { one: 0.52, five: 0.48, fifteen: 0.4 },
            failedUnits: 1,
            loggedInUsers: 2,
            sampleSeconds: 1,
            unavailable: [],
        });
    });

    it('computes CPU usage and iowait from the /proc/stat deltas', () => {
        expect(snapshot.cpu).toEqual({ usagePercent: 60, cores: 2, iowaitPercent: 8 });
    });

    it('uses MemAvailable for used memory (Known issue backend/status-linux-memory-awk-broken fixed)', () => {
        expect(snapshot.memory).toEqual({ totalMB: 15990.8, usedMB: 6345.7, availableMB: 9645.1, usagePercent: 39.7 });
        expect(snapshot.swap).toEqual({ totalMB: 4096, usedMB: 189.7, usagePercent: 4.6 });
    });

    it('lists each filesystem once: bind mounts dropped, ZFS datasets merged per pool', () => {
        expect(snapshot.disks.map((disk) => disk.mount)).toEqual(['/', '/boot', '/boot/efi', '/data', '/mnt/backup disk', '/tank']);
        expect(snapshot.disks[0]).toEqual({
            name: '/dev/mapper/ubuntu--vg-ubuntu--lv', mount: '/', fsType: 'ext4', totalGB: 96.9, usedGB: 43.6, freeGB: 48.4, usagePercent: 47.4,
        });
        expect(snapshot.disks.find((disk) => disk.mount === '/tank')).toMatchObject({ name: 'tank', fsType: 'zfs', usedGB: 524.5, freeGB: 858.3, totalGB: 1382.8 });
        expect(snapshot.disks.find((disk) => disk.mount === '/mnt/backup disk')?.fsType).toBe('ext4');
        // 96.9 + 1.9 + 1 + 499.8 + 98.3 + 1382.8, not the 3 TB a plain sum of every row gives.
        expect(snapshot.storage?.totalGB).toBeCloseTo(2080.7, 1);
    });

    it('counts physical interfaces only (bridges and veths repeat their traffic)', () => {
        expect(snapshot.network).toEqual({
            rxBytesPerSec: 500000,
            txBytesPerSec: 250000,
            interfaces: [{ name: 'eth0', rxBytesPerSec: 500000, txBytesPerSec: 250000 }],
        });
    });

    it('ranks processes by CPU used during the sample (100 = one core)', () => {
        expect(snapshot.processes).toEqual([
            { pid: 1234, name: 'java', cpuPercent: 80, memoryMB: 200, memoryPercent: 1.3 },
            { pid: 2345, name: 'tmux: server', cpuPercent: 20, memoryMB: 8, memoryPercent: 0.1 },
            { pid: 3456, name: 'postgres', cpuPercent: 0, memoryMB: 1171.9, memoryPercent: 7.3 },
            { pid: 1235, name: '(sd-pam)', cpuPercent: 0, memoryMB: 4.3, memoryPercent: 0 },
        ]);
    });

    it('falls back for old kernels and reports missing sections instead of zeros', () => {
        const legacy = parseLinuxStatus(fixture('status-legacy.txt'));
        expect(legacy.os).toBe('Linux');
        // No MemAvailable: free + buffers + cache.
        expect(legacy.memory).toEqual({ totalMB: 3952, usedMB: 2352, availableMB: 1600, usagePercent: 59.5 });
        expect(legacy.swap).toEqual({ totalMB: 0, usedMB: 0, usagePercent: 0 });
        expect(legacy.cpu).toEqual({ usagePercent: 33.3, cores: 1, iowaitPercent: 0 });
        // A wrapped 32-bit counter does not become a huge negative rate.
        expect(legacy.network?.interfaces).toEqual([{ name: 'eth0', rxBytesPerSec: 0, txBytesPerSec: 100 }]);
        expect(legacy.sampleSeconds).toBe(2);
        expect(legacy.processes).toEqual([]);
        expect(legacy.failedUnits).toBeNull();
        expect(legacy.unavailable).toEqual(['processes', 'failedUnits']);
    });

    it('reports the logged-in users as unavailable when `who` has no utmp to read', () => {
        // The script prints nothing in the users section on such systems (Alpine).
        expect(LINUX_STATUS_SCRIPT).toContain('if [ -n "$u" ] || [ -e /run/utmp ] || [ -e /var/run/utmp ]; then');
        const alpine = parseLinuxStatus(fixture('status-ubuntu.txt').replace(/(@@SM:users\n)[^@]*/, '$1'));
        expect(alpine.loggedInUsers).toBeNull();
        expect(alpine.unavailable).toContain('users');
    });

    it('rejects a report cut off before its end marker', () => {
        const cut = fixture('status-ubuntu.txt').split('@@SM:procs')[0];
        expect(() => parseLinuxStatus(cut)).toThrow(/cut off/);
        expect(() => parseLinuxStatus('')).toThrow(/cut off/);
    });
});

describe('Linux status helpers', () => {
    it('parses the aggregate cpu line, ignoring guest time', () => {
        expect(parseCpuLine('cpu  10 1 5 100 4 1 2 3 7 0')).toEqual({ total: 126, idle: 104, iowait: 4 });
        expect(parseCpuLine('cpu0 1 2 3 4')).toBeNull();
        expect(parseCpuLine(undefined)).toBeNull();
    });

    it('parses meminfo and net/dev rows', () => {
        expect(parseMeminfo('MemTotal:  100 kB\nbogus\nSwapFree: 7 kB')).toEqual({ MemTotal: 100, SwapFree: 7 });
        expect([...parseNetDev('  eth0:12 0 0 0 0 0 0 0 34 0 0 0 0 0 0 0\nwlan0: 1 2 3').entries()]).toEqual([['eth0', { rx: 12, tx: 34 }]]);
    });

    it('parses df rows with spaces in the mount point', () => {
        expect(parseDf('/dev/sdb1 1048576 524288 524288 50% /mnt/my disk', new Map())).toEqual([
            { name: '/dev/sdb1', mount: '/mnt/my disk', fsType: null, totalGB: 1, usedGB: 0.5, freeGB: 0.5, usagePercent: 50 },
        ]);
    });
});
