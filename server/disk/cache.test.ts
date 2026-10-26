import { describe, expect, it } from 'vitest';
import { mountDeltas } from './cleanups';
import { ScanCache } from './cache';
import type { DiskMount } from '../../shared/disk';

describe('ScanCache', () => {
    it('keeps results for a while, shares a running scan and forgets a server on request', async () => {
        let now = 0;
        const cache = new ScanCache<number>(1000, 2, () => now);
        let runs = 0;
        const scan = () => new Promise<number>((resolve) => setTimeout(() => resolve(++runs), 5));
        const [a, b] = await Promise.all([cache.run('1|x', scan), cache.run('1|x', scan)]);
        expect([a, b, runs]).toEqual([1, 1, 1]);
        expect(cache.get('1|x')).toBe(1);
        now = 1500;
        expect(cache.get('1|x')).toBeNull();
        await cache.run('1|y', scan);
        await cache.run('2|y', scan);
        await cache.run('1|z', scan);
        // At most two entries: the least recently used went.
        expect(cache.get('1|y')).toBeNull();
        cache.clear('1|');
        expect(cache.get('1|z')).toBeNull();
        expect(cache.get('2|y')).toBe(3);
    });

    it('does not keep a failed scan', async () => {
        const cache = new ScanCache<number>();
        await expect(cache.run('k', () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
        expect(cache.get('k')).toBeNull();
        await expect(cache.run('k', () => Promise.resolve(2))).resolves.toBe(2);
    });
});

describe('mountDeltas', () => {
    const mount = (name: string, free: number): DiskMount => ({ mount: name, device: 'd', fsType: 'ext4', totalBytes: 100, usedBytes: 100 - free, freeBytes: free, usagePercent: 0, inodes: null, readOnly: false });

    it('sums the change of free space over the filesystems an action touched', () => {
        expect(mountDeltas(['/', '/var'], [mount('/', 10), mount('/var', 5)], [mount('/', 30), mount('/var', 15)])).toEqual({
            deltas: [{ mount: '/', freeBefore: 10, freeAfter: 30 }, { mount: '/var', freeBefore: 5, freeAfter: 15 }],
            freed: 30,
        });
        expect(mountDeltas(['/'], [mount('/', 10)], [])).toEqual({ deltas: [], freed: null });
        expect(mountDeltas([], [mount('/', 10)], [mount('/', 20)])).toEqual({ deltas: [], freed: null });
    });
});
