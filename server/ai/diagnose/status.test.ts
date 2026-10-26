import { describe, expect, it } from 'vitest';
import type { StatusSnapshot } from '../../../shared/status';
import { formatSnapshot } from './status';

const SNAPSHOT: StatusSnapshot = {
    platform: 'linux',
    collectedAt: Date.UTC(2024, 4, 6, 10, 0, 0),
    hostname: 'web-01',
    os: 'Ubuntu 22.04.4 LTS',
    kernel: '5.15.0-105-generic',
    uptimeSeconds: 3 * 86400 + 4 * 3600,
    cpu: { usagePercent: 97.24, cores: 4, iowaitPercent: 31.5 },
    memory: { totalMB: 3900, usedMB: 3600, availableMB: 300, usagePercent: 92.3 },
    swap: { totalMB: 2048, usedMB: 1024, usagePercent: 50 },
    load: { one: 9.12, five: 7.5, fifteen: 4 },
    storage: { totalGB: 100, usedGB: 60, freeGB: 40, usagePercent: 60 },
    disks: [
        { name: '/dev/sda1', mount: '/', fsType: 'ext4', totalGB: 50, usedGB: 47, freeGB: 3, usagePercent: 94 },
        { name: '/dev/sdb1', mount: '/data', fsType: 'xfs', totalGB: 50, usedGB: 13, freeGB: 37, usagePercent: 26 }
    ],
    processes: [{ pid: 4242, name: 'java', cpuPercent: 350.5, memoryMB: 2048, memoryPercent: 52 }],
    network: { rxBytesPerSec: 3 * 1024 * 1024, txBytesPerSec: 2048, interfaces: [] },
    failedUnits: 2,
    loggedInUsers: 1,
    sampleSeconds: 1.02,
    unavailable: []
};

describe('formatSnapshot', () => {
    it('reports the snapshot graded with the dashboard thresholds', () => {
        const text = formatSnapshot(SNAPSHOT);
        expect(text).toContain('Host: web-01 (Ubuntu 22.04.4 LTS, kernel 5.15.0-105-generic)');
        expect(text).toContain('Collected: 2024-05-06T10:00:00.000Z, up 3 d 4 h');
        expect(text).toContain('Health: critical: CPU 97.2% (critical), memory 92.3% (critical), disk / 94% (critical), load 2.28 per core (warn), 2 failed units (warn)');
        expect(text).toContain('Thresholds (warn/critical): CPU 75/90%, memory 80/90%, disk 80/90%, load per core 1/2');
        expect(text).toContain('CPU: 97.2% over 1 s of 4 cores, iowait 31.5%');
        expect(text).toContain('Load average: 9.12 7.5 4');
        expect(text).toContain('Memory: 3.5 of 3.8 GB used (92.3%), 0.3 GB available');
        expect(text).toContain('  / (/dev/sda1, ext4): 94% used, 3 of 50 GB free');
        expect(text).toContain('Network: in 3 MB/s, out 2 KB/s');
        expect(text).toContain('  pid 4242 java: CPU 350.5%, 2048 MB');
    });

    it('says what the host did not report', () => {
        const text = formatSnapshot({ ...SNAPSHOT, cpu: null, memory: null, load: null, disks: [], storage: null, failedUnits: null, processes: [], unavailable: ['cpu', 'memory'] });
        expect(text).toContain('Health: unknown (no metric was reported)');
        expect(text).toContain('Not reported by the host: cpu, memory');
        expect(text).not.toContain('CPU:');
    });
});
