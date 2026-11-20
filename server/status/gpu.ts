import type { StatusGpu, StatusGpuInfo, StatusGpuProcess } from "../../shared/status";
import { clampPercent, percent, roundTo } from "./parse";

// NVIDIA GPUs through nvidia-smi, as two sections of the Linux status script.
// `timeout` (when the host has it) keeps a wedged driver from using up the
// whole report's time; the second query runs only when the first answered.
// nvidia-smi answers N/A where a GPU has no such reading: the GB10 of a DGX
// Spark shares the system's memory and reports none of its own, but its
// per-process figures work.

const QUERY_GPU = "index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,power.draw,power.limit";
const QUERY_APPS = "pid,process_name,used_memory";

export const GPU_SCRIPT_LINES = [
    "m gpu",
    "GQ=",
    "if command -v nvidia-smi >/dev/null 2>&1; then",
    "T=; command -v timeout >/dev/null 2>&1 && T='timeout 5'",
    "echo present",
    `GQ=$($T nvidia-smi --query-gpu=${QUERY_GPU} --format=csv,noheader,nounits </dev/null 2>/dev/null)`,
    "printf '%s\\n' \"$GQ\"",
    "fi",
    "m gpuprocs",
    `if [ -n "$GQ" ]; then $T nvidia-smi --query-compute-apps=${QUERY_APPS} --format=csv,noheader,nounits </dev/null 2>/dev/null; fi`
];

export const TOP_GPU_PROCESSES = 8;

function numberOrNull(raw: string | undefined): number | null {
    const value = (raw ?? "").trim();
    return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}

// "0, NVIDIA GB10, 96, [N/A], [N/A], 61, 38.5, [N/A]". The name sits between
// the index and the six readings, so a comma inside it cannot shift them.
export function parseGpuDevices(raw: string): StatusGpu[] {
    const devices: StatusGpu[] = [];
    for (const line of raw.split("\n")) {
        const fields = line.split(",");
        if (fields.length < 8) continue;
        const index = Number(fields[0].trim());
        if (!Number.isInteger(index) || index < 0) continue;
        const [utilization, used, total, temperature, power, powerLimit] = fields.slice(-6).map(numberOrNull);
        devices.push({
            index,
            name: fields.slice(1, -6).join(",").trim() || `GPU ${index}`,
            utilizationPercent: utilization === null ? null : clampPercent(utilization),
            memory: used !== null && total !== null && total > 0
                ? { totalMB: roundTo(total, 1), usedMB: roundTo(used, 1), usagePercent: percent(used, total) }
                : null,
            temperatureC: temperature === null ? null : Math.round(temperature),
            powerWatts: power === null ? null : roundTo(power, 1),
            powerLimitWatts: powerLimit === null ? null : roundTo(powerLimit, 1)
        });
    }
    return devices;
}

// "2065247, /usr/bin/python3, 102843": the name is the part between the pid
// and the memory, shown without its directory. A process on several GPUs is
// one row.
export function parseGpuProcesses(raw: string): StatusGpuProcess[] {
    const byPid = new Map<number, StatusGpuProcess>();
    for (const line of raw.split("\n")) {
        const fields = line.split(",");
        if (fields.length < 3) continue;
        const pid = Number(fields[0].trim());
        if (!Number.isInteger(pid) || pid <= 0) continue;
        const memory = numberOrNull(fields[fields.length - 1]);
        const path = fields.slice(1, -1).join(",").trim();
        const name = path.slice(path.lastIndexOf("/") + 1) || "?";
        const known = byPid.get(pid);
        if (known) {
            if (memory !== null) known.memoryMB = roundTo((known.memoryMB ?? 0) + memory, 1);
        } else {
            byPid.set(pid, { pid, name, memoryMB: memory === null ? null : roundTo(memory, 1) });
        }
    }
    return [...byPid.values()]
        .sort((a, b) => (b.memoryMB ?? -1) - (a.memoryMB ?? -1) || a.pid - b.pid)
        .slice(0, TOP_GPU_PROCESSES);
}

// `gpu` is null when the host has no nvidia-smi; `unreadable` when it has one
// that answered nothing usable (a driver that is not loaded, a timeout).
export function parseGpu(sections: Map<string, string>): { gpu: StatusGpuInfo | null; unreadable: boolean } {
    const body = sections.get("gpu");
    if (body === undefined || !/^present$/m.test(body)) return { gpu: null, unreadable: false };
    const devices = parseGpuDevices(body);
    if (devices.length === 0) return { gpu: null, unreadable: true };
    return {
        gpu: {
            devices,
            unifiedMemory: devices.some((device) => device.memory === null),
            processes: parseGpuProcesses(sections.get("gpuprocs") ?? "")
        },
        unreadable: false
    };
}
