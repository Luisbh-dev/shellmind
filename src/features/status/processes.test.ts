import { describe, expect, it } from 'vitest';
import type { StatusProcess } from '@shared/status';
import { DEFAULT_PROCESS_SORT, nextSort, sortProcesses } from './processes';

const processes: StatusProcess[] = [
    { pid: 30, name: 'nginx', cpuPercent: 5, memoryMB: 40, memoryPercent: 0.5 },
    { pid: 12, name: 'Java', cpuPercent: 180, memoryMB: 2048, memoryPercent: 25 },
    { pid: 7, name: 'kworker/0:1', cpuPercent: 5, memoryMB: null, memoryPercent: null },
    { pid: 101, name: 'bash', cpuPercent: 0, memoryMB: 4, memoryPercent: 0.05 },
];

const order = (list: StatusProcess[]) => list.map((process) => process.pid);

describe('process sorting', () => {
    it('starts with the busiest first, ties by PID', () => {
        expect(DEFAULT_PROCESS_SORT).toEqual({ key: 'cpu', direction: 'desc' });
        expect(order(sortProcesses(processes, DEFAULT_PROCESS_SORT))).toEqual([12, 7, 30, 101]);
        expect(order(sortProcesses(processes, { key: 'cpu', direction: 'asc' }))).toEqual([101, 7, 30, 12]);
    });

    it('sorts names alphabetically, ignoring case', () => {
        expect(sortProcesses(processes, { key: 'name', direction: 'asc' }, 'en').map((process) => process.name)).toEqual(['bash', 'Java', 'kworker/0:1', 'nginx']);
        expect(sortProcesses(processes, { key: 'name', direction: 'desc' }, 'en').map((process) => process.name)).toEqual(['nginx', 'kworker/0:1', 'Java', 'bash']);
    });

    it('sorts by PID and by memory, without memory always last', () => {
        expect(order(sortProcesses(processes, { key: 'pid', direction: 'asc' }))).toEqual([7, 12, 30, 101]);
        expect(order(sortProcesses(processes, { key: 'memory', direction: 'desc' }))).toEqual([12, 30, 101, 7]);
        expect(order(sortProcesses(processes, { key: 'memory', direction: 'asc' }))).toEqual([101, 30, 12, 7]);
    });

    it('leaves the input untouched', () => {
        const before = order(processes);
        sortProcesses(processes, { key: 'pid', direction: 'desc' });
        expect(order(processes)).toEqual(before);
    });

    it('turns the sorted column around, and opens another in its natural direction', () => {
        expect(nextSort({ key: 'cpu', direction: 'desc' }, 'cpu')).toEqual({ key: 'cpu', direction: 'asc' });
        expect(nextSort({ key: 'cpu', direction: 'asc' }, 'cpu')).toEqual({ key: 'cpu', direction: 'desc' });
        expect(nextSort({ key: 'cpu', direction: 'desc' }, 'name')).toEqual({ key: 'name', direction: 'asc' });
        expect(nextSort({ key: 'name', direction: 'asc' }, 'memory')).toEqual({ key: 'memory', direction: 'desc' });
        expect(nextSort({ key: 'memory', direction: 'desc' }, 'pid')).toEqual({ key: 'pid', direction: 'asc' });
    });
});
