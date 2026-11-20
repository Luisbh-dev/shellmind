import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseSections } from '../ops/remote';
import { GPU_SCRIPT_LINES, parseGpu, parseGpuDevices, parseGpuProcesses } from './gpu';
import { LINUX_STATUS_SCRIPT, parseLinuxStatus } from './linux';

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/ops/${name}`, import.meta.url)), 'utf8');
const withGpu = (body: string, procs = '') => fixture('status-ubuntu.txt').replace('\n@@SM:end', `\n@@SM:gpu\n${body}\n@@SM:gpuprocs\n${procs}\n@@SM:end`);

// A DGX Spark (GB10): no dedicated memory, power limit and fan unknown.
const SPARK = 'present\n0, NVIDIA GB10, 96, [N/A], [N/A], 61, 38.52, [N/A]';
const SPARK_APPS = '2065247, /usr/bin/python3, 36593\n2065301, VLLM::EngineCore, 1949\n2065400, /opt/app-root/bin/python3, [N/A]';

describe('the GPU part of the status script', () => {
    const script = GPU_SCRIPT_LINES.join('\n');

    it('asks nvidia-smi only when it is there, bounded by timeout, and never reads the script from stdin', () => {
        expect(script).toContain('command -v nvidia-smi');
        expect(script).toContain("T='timeout 5'");
        expect(script).toContain('</dev/null');
        expect(script).toContain('if [ -n "$GQ" ]');
        expect(LINUX_STATUS_SCRIPT).toContain('m gpu\n');
        expect(LINUX_STATUS_SCRIPT.trimEnd().endsWith('m end')).toBe(true);
    });
});

describe('parseGpuDevices', () => {
    it('reads a discrete GPU with dedicated memory', () => {
        expect(parseGpuDevices('0, NVIDIA GeForce RTX 4090, 37, 6144, 24564, 54, 120.4, 450.00')).toEqual([{
            index: 0,
            name: 'NVIDIA GeForce RTX 4090',
            utilizationPercent: 37,
            memory: { totalMB: 24564, usedMB: 6144, usagePercent: 25 },
            temperatureC: 54,
            powerWatts: 120.4,
            powerLimitWatts: 450
        }]);
    });

    it('keeps N/A readings as null instead of zero (DGX Spark / GB10)', () => {
        expect(parseGpuDevices('0, NVIDIA GB10, 96, [N/A], [N/A], 61, 38.52, [N/A]')).toEqual([{
            index: 0,
            name: 'NVIDIA GB10',
            utilizationPercent: 96,
            memory: null,
            temperatureC: 61,
            powerWatts: 38.5,
            powerLimitWatts: null
        }]);
    });

    it('reads several GPUs and a name with a comma in it', () => {
        const devices = parseGpuDevices('0, Tesla T4, 5, 100, 15360, 40, 30, 70\n1, Odd, Name, 0, 0, 15360, 35, 28, 70\nnoise');
        expect(devices.map((device) => [device.index, device.name])).toEqual([[0, 'Tesla T4'], [1, 'Odd, Name']]);
    });

    it('skips lines that are not a GPU row (a driver error printed on stdout)', () => {
        expect(parseGpuDevices('NVIDIA-SMI has failed because it could not communicate with the NVIDIA driver.')).toEqual([]);
        expect(parseGpuDevices('')).toEqual([]);
    });
});

describe('parseGpuProcesses', () => {
    it('names the program without its directory, keeps unknown memory as null and ranks by memory', () => {
        expect(parseGpuProcesses(SPARK_APPS)).toEqual([
            { pid: 2065247, name: 'python3', memoryMB: 36593 },
            { pid: 2065301, name: 'VLLM::EngineCore', memoryMB: 1949 },
            { pid: 2065400, name: 'python3', memoryMB: null }
        ]);
    });

    it('merges a process that uses several GPUs into one row', () => {
        expect(parseGpuProcesses('10, /usr/bin/train, 1000\n10, /usr/bin/train, 500')).toEqual([{ pid: 10, name: 'train', memoryMB: 1500 }]);
    });
});

describe('parseGpu', () => {
    it('is absent on a host without nvidia-smi and unreadable when it answers nothing', () => {
        expect(parseGpu(parseSections('@@SM:gpu\n\n@@SM:end\n'))).toEqual({ gpu: null, unreadable: false });
        expect(parseGpu(parseSections('@@SM:end\n'))).toEqual({ gpu: null, unreadable: false });
        expect(parseGpu(parseSections('@@SM:gpu\npresent\n@@SM:end\n'))).toEqual({ gpu: null, unreadable: true });
    });

    it('flags unified memory when the GPU reports none of its own', () => {
        expect(parseGpu(parseSections(`@@SM:gpu\n${SPARK}\n@@SM:gpuprocs\n${SPARK_APPS}\n@@SM:end\n`)).gpu?.unifiedMemory).toBe(true);
        expect(parseGpu(parseSections('@@SM:gpu\npresent\n0, Tesla T4, 5, 100, 15360, 40, 30, 70\n@@SM:end\n')).gpu?.unifiedMemory).toBe(false);
    });
});

describe('parseLinuxStatus with a GPU', () => {
    it('adds the GPUs of a DGX Spark to the snapshot', () => {
        const snapshot = parseLinuxStatus(withGpu(SPARK, SPARK_APPS));
        expect(snapshot.gpu?.unifiedMemory).toBe(true);
        expect(snapshot.gpu?.devices).toHaveLength(1);
        expect(snapshot.gpu?.devices[0]).toMatchObject({ name: 'NVIDIA GB10', utilizationPercent: 96, temperatureC: 61 });
        expect(snapshot.gpu?.processes).toHaveLength(3);
        expect(snapshot.unavailable).toEqual([]);
    });

    it('has no gpu field on a host without one, and reports an unreadable one as not reported', () => {
        expect(parseLinuxStatus(fixture('status-ubuntu.txt'))).not.toHaveProperty('gpu');
        const broken = parseLinuxStatus(withGpu('present'));
        expect(broken).not.toHaveProperty('gpu');
        expect(broken.unavailable).toEqual(['gpu']);
    });
});
