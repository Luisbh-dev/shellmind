import { describe, expect, it } from 'vitest';
import { sections } from '../../test/helpers/opsHost';
import { LINUX_MOUNTS_SCRIPT, parseLinuxMounts, parseWindowsMounts, requireMount } from './mounts';

const MOUNTS = [
    '/dev/sda2 / ext4 rw,relatime',
    '/dev/sda1 /boot vfat rw',
    '/dev/sdb1 /data xfs ro,noatime',
    '/dev/sda2 /var/lib/docker ext4 rw,relatime',
    '/dev/nvme0n1p3 /home btrfs rw,subvol=/home',
    '/dev/nvme0n1p3 /srv btrfs rw,subvol=/srv',
    '/dev/sdc1 /mnt/my\\040disk ext4 rw',
].join('\n');

const DF = [
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/sda2         41152736 37000000   2054808      95% /',
    '/dev/sda1           523248     5356    517892       2% /boot',
    '/dev/sdb1        104806400 10000000  94806400      10% /data',
    // A bind mount of the root filesystem: the same device and figures.
    '/dev/sda2         41152736 37000000   2054808      95% /var/lib/docker',
    '/dev/nvme0n1p3   488281250 100000000 388281250     21% /home',
    '/dev/nvme0n1p3   488281250 100000000 388281250     21% /srv',
    '/dev/sdc1          1000000   500000    500000      50% /mnt/my disk',
].join('\n');

const INODES = [
    'Filesystem      Inodes   IUsed   IFree IUse% Mounted on',
    '/dev/sda2      2621440 2600000   21440   100% /',
    '/dev/sda1            0       0       0     - /boot',
].join('\n');

describe('Linux filesystems', () => {
    it('reads the local filesystems in bytes, with inodes, read-only flags and bind mounts left out', () => {
        const mounts = parseLinuxMounts(sections({ mounts: MOUNTS, df: DF, inodes: INODES }));
        expect(mounts.map((mount) => mount.mount)).toEqual(['/', '/boot', '/data', '/home', '/mnt/my disk', '/srv']);
        expect(mounts[0]).toEqual({
            mount: '/', device: '/dev/sda2', fsType: 'ext4', totalBytes: 41152736 * 1024, usedBytes: 37000000 * 1024, freeBytes: 2054808 * 1024,
            usagePercent: 94.7, inodes: { total: 2621440, used: 2600000, free: 21440, usagePercent: 99.2 }, readOnly: false,
        });
        expect(mounts.find((mount) => mount.mount === '/boot')?.inodes).toBeNull();
        expect(mounts.find((mount) => mount.mount === '/data')?.readOnly).toBe(true);
        // Subvolumes of one btrfs pool are each explored on their own.
        expect(mounts.filter((mount) => mount.fsType === 'btrfs')).toHaveLength(2);
        expect(mounts.find((mount) => mount.mount === '/mnt/my disk')?.fsType).toBe('ext4');
    });

    it('refuses a check that was cut off', () => {
        expect(() => parseLinuxMounts('@@SM:mounts\n/dev/sda1 / ext4 rw\n')).toThrow(/cut off/);
    });

    it('lists only local filesystems, through df -P', () => {
        expect(LINUX_MOUNTS_SCRIPT).toContain('df -P -k "$@"');
        expect(LINUX_MOUNTS_SCRIPT).toContain('df -P -i "$@"');
        expect(LINUX_MOUNTS_SCRIPT).toMatch(/\$2 == "\/" \|\| \$3 ~ \/\^\(ext\[234\]\|xfs/);
    });
});

describe('Windows drives', () => {
    it('reads the fixed drives', () => {
        const mounts = parseWindowsMounts('{"disks":[{"n":"C:","fs":"NTFS","s":107374182400,"f":10737418240},{"n":"D:","fs":"NTFS","s":0,"f":0},{"n":"bad","s":1,"f":1}]}');
        expect(mounts).toEqual([{
            mount: 'C:\\', device: 'C:', fsType: 'NTFS', totalBytes: 107374182400, usedBytes: 96636764160, freeBytes: 10737418240,
            usagePercent: 90, inodes: null, readOnly: false,
        }]);
    });
});

describe('requireMount', () => {
    const mounts = parseLinuxMounts(sections({ mounts: MOUNTS, df: DF, inodes: INODES }));

    it('accepts a mount the server reports, exactly (drive letters in any case)', () => {
        expect(requireMount(mounts, '/data').mount).toBe('/data');
        expect(() => requireMount(mounts, '/DATA')).toThrow(/not a local filesystem/);
        expect(() => requireMount(mounts, '/etc')).toThrow(/not a local filesystem/);
        expect(() => requireMount(mounts, undefined)).toThrow(/not a local filesystem/);
        const drives = parseWindowsMounts('{"disks":[{"n":"C:","fs":"NTFS","s":100,"f":10}]}');
        expect(requireMount(drives, 'c:\\').mount).toBe('C:\\');
        // The Status page names a drive without its backslash.
        expect(requireMount(drives, 'C:').mount).toBe('C:\\');
        expect(() => requireMount(drives, 'D:')).toThrow(/not a local filesystem/);
    });
});
