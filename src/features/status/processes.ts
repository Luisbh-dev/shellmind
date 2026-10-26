import type { StatusProcess } from '@shared/status';

// Sorting of the top-processes table.

export type ProcessSortKey = 'name' | 'pid' | 'cpu' | 'memory';
export type SortDirection = 'asc' | 'desc';
export type ProcessSort = { key: ProcessSortKey; direction: SortDirection };

export const DEFAULT_PROCESS_SORT: ProcessSort = { key: 'cpu', direction: 'desc' };

// Text and ids read best A→Z; amounts biggest first.
export function defaultDirection(key: ProcessSortKey): SortDirection {
    return key === 'name' || key === 'pid' ? 'asc' : 'desc';
}

// A click on the sorted column turns it around; on another column, sorts by
// that one in its natural direction.
export function nextSort(current: ProcessSort, key: ProcessSortKey): ProcessSort {
    if (current.key === key) return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
    return { key, direction: defaultDirection(key) };
}

function valueOf(process: StatusProcess, key: Exclude<ProcessSortKey, 'name'>): number | null {
    if (key === 'pid') return process.pid;
    if (key === 'cpu') return process.cpuPercent;
    return process.memoryMB;
}

// A new array; processes without the value (memory on some hosts) always go
// last, and ties fall back to CPU, then PID, so the order is stable between
// refreshes.
export function sortProcesses(processes: StatusProcess[], sort: ProcessSort, language?: string): StatusProcess[] {
    const sign = sort.direction === 'asc' ? 1 : -1;
    const collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true });
    return [...processes].sort((a, b) => {
        let order = 0;
        if (sort.key === 'name') {
            order = sign * collator.compare(a.name, b.name);
        } else {
            const left = valueOf(a, sort.key);
            const right = valueOf(b, sort.key);
            if (left === null || right === null) {
                if (left !== right) return left === null ? 1 : -1;
            } else {
                order = sign * (left - right);
            }
        }
        return order || b.cpuPercent - a.cpuPercent || a.pid - b.pid;
    });
}
