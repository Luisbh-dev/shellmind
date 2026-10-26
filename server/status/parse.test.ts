import { describe, expect, it } from 'vitest';
import type { StatusDisk } from '../../shared/status';
import { aggregateStorage, dedupeDisks, percent, roundTo } from './parse';

const disk = (name: string, mount: string, totalGB: number, usedGB: number, fsType: string | null = 'ext4'): StatusDisk => ({
    name, mount, fsType, totalGB, usedGB, freeGB: roundTo(totalGB - usedGB, 1), usagePercent: percent(usedGB, totalGB),
});

describe('dedupeDisks (Known issue backend/status-disk-aggregation fixed)', () => {
    it('keeps the shortest mount point of a device and drops container/snap mounts', () => {
        const disks = [
            disk('/dev/sda1', '/home', 100, 40, 'btrfs'),
            disk('/dev/sda1', '/', 100, 40, 'btrfs'),
            disk('/dev/sda1', '/var/lib/docker/btrfs/subvolumes/abc', 100, 40, 'btrfs'),
            disk('/dev/loop3', '/snap/core/1234', 0.1, 0.1, 'ext4'),
            disk('/dev/sdb1', '/srv', 50, 10),
        ];
        expect(dedupeDisks(disks).map((entry) => `${entry.name} ${entry.mount}`)).toEqual(['/dev/sda1 /', '/dev/sdb1 /srv']);
    });

    it('merges ZFS datasets into one pool entry (free space counted once)', () => {
        const datasets = [
            { ...disk('rpool/ROOT/ubuntu', '/', 0, 0, 'zfs'), usedGB: 20, freeGB: 80, totalGB: 100 },
            { ...disk('rpool/USERDATA/home', '/home', 0, 0, 'zfs'), usedGB: 30, freeGB: 80, totalGB: 110 },
        ];
        expect(dedupeDisks(datasets)).toEqual([
            { name: 'rpool', mount: '/', fsType: 'zfs', totalGB: 130, usedGB: 50, freeGB: 80, usagePercent: 38.5 },
        ]);
    });

    it('drops empty pseudo filesystems', () => {
        expect(dedupeDisks([disk('none', '/mnt/empty', 0, 0)])).toEqual([]);
    });
});

describe('aggregateStorage', () => {
    it('sums the deduplicated filesystems', () => {
        expect(aggregateStorage([disk('/dev/sda1', '/', 100, 40), disk('/dev/sdb1', '/srv', 50, 10)])).toEqual({
            totalGB: 150, usedGB: 50, freeGB: 100, usagePercent: 33.3,
        });
    });

    it('is null without filesystems', () => {
        expect(aggregateStorage([])).toBeNull();
    });
});

describe('percent', () => {
    it('clamps and guards against empty totals', () => {
        expect(percent(5, 0)).toBe(0);
        expect(percent(150, 100)).toBe(100);
        expect(percent(1, 3)).toBe(33.3);
    });
});
