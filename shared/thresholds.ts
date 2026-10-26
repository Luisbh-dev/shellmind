import type { StatusSnapshot } from "./status";

// Where a reading turns amber (warn) or red (critical). The meters, the disk
// rows, the load bars and the health summary all classify through here, so
// a limit is changed in one place. Shared: the backend grades the same way
// (the fleet board's health snapshots).
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

export type Tone = "ok" | "warn" | "critical";
export type Threshold = { warn: number; critical: number };

export const THRESHOLDS = {
    // Whole-machine CPU use, %.
    cpu: { warn: 75, critical: 90 },
    // Memory held by applications (total minus available), %.
    memory: { warn: 80, critical: 90 },
    // Each local filesystem, %.
    disk: { warn: 80, critical: 90 },
    // Load average per core: 1 means every core is busy and work starts to queue.
    loadPerCore: { warn: 1, critical: 2 },
    // systemd units in the failed state.
    failedUnits: { warn: 1, critical: 5 }
} as const satisfies Record<string, Threshold>;

export function classify(value: number, threshold: Threshold): Tone {
    if (!Number.isFinite(value)) return "ok";
    if (value >= threshold.critical) return "critical";
    if (value >= threshold.warn) return "warn";
    return "ok";
}

const RANK: Record<Tone, number> = { ok: 0, warn: 1, critical: 2 };

export function worstTone(tones: Iterable<Tone>): Tone {
    let worst: Tone = "ok";
    for (const tone of tones) if (RANK[tone] > RANK[worst]) worst = tone;
    return worst;
}

// Load average against the core count (without one, against a single core).
export function loadTone(load: number, cores: number | null): Tone {
    return classify(load / Math.max(1, cores ?? 1), THRESHOLDS.loadPerCore);
}

export type StorageReading = {
    usagePercent: number;
    usedGB: number;
    totalGB: number;
    freeGB: number;
    // The filesystem the reading is about; null for the host's total, when it listed none.
    mount: string | null;
    // All the filesystems together, when there are several.
    total: { usedGB: number; totalGB: number; count: number } | null;
};

// What the storage tile shows: the fullest filesystem, which is the one that
// fills up and the one the health counts (an average would hide a full /var
// behind an empty /data), with the total as context.
export function storageReading(snapshot: StatusSnapshot): StorageReading | null {
    const { disks, storage } = snapshot;
    const fullest = disks.reduce<StatusSnapshot["disks"][number] | null>((worst, disk) => (!worst || disk.usagePercent > worst.usagePercent ? disk : worst), null);
    if (fullest) {
        return {
            usagePercent: fullest.usagePercent,
            usedGB: fullest.usedGB,
            totalGB: fullest.totalGB,
            freeGB: fullest.freeGB,
            mount: fullest.mount,
            total: disks.length > 1 && storage ? { usedGB: storage.usedGB, totalGB: storage.totalGB, count: disks.length } : null
        };
    }
    if (!storage) return null;
    return { usagePercent: storage.usagePercent, usedGB: storage.usedGB, totalGB: storage.totalGB, freeGB: storage.freeGB, mount: null, total: null };
}

export type HealthMetric = "cpu" | "load" | "memory" | "disk" | "failedUnits";

// Metrics that make the verdict a warning at most. The load average also
// counts processes waiting on disks or the network, so a high one is a reason
// to look, not proof that the machine is in trouble.
const WARN_ONLY: ReadonlySet<HealthMetric> = new Set(["load"]);

export type HealthIssue = {
    metric: HealthMetric;
    tone: Exclude<Tone, "ok">;
    // The reading: a percentage, a count, or the one-minute load per core.
    value: number;
    // The filesystem, for a disk.
    mount?: string;
};

export type Health = {
    // 'unknown' when the host reported none of the metrics.
    tone: Tone | "unknown";
    // Worst first.
    issues: HealthIssue[];
    // The metrics the verdict is based on.
    checked: HealthMetric[];
};

export type AssessOptions = {
    // The core count, when the snapshot has no CPU reading to carry it (the
    // fleet check takes no CPU sample but counts the cores).
    cores?: number | null;
};

// The overall verdict: the worst of CPU, the load per core (a warning at
// most), memory, every local filesystem (the fullest one matters, not the
// average) and the failed units.
export function assessHealth(snapshot: StatusSnapshot, options: AssessOptions = {}): Health {
    const issues: HealthIssue[] = [];
    const checked: HealthMetric[] = [];
    const check = (metric: HealthMetric, value: number, threshold: Threshold, mount?: string) => {
        const graded = classify(value, threshold);
        if (graded === "ok") return;
        const tone = WARN_ONLY.has(metric) ? "warn" : graded;
        issues.push({ metric, tone, value, ...(mount !== undefined ? { mount } : {}) });
    };

    if (snapshot.cpu) {
        checked.push("cpu");
        check("cpu", snapshot.cpu.usagePercent, THRESHOLDS.cpu);
    }
    if (snapshot.load) {
        checked.push("load");
        // As the load tile grades it (loadTone): against the cores, one without a count.
        check("load", snapshot.load.one / Math.max(1, snapshot.cpu?.cores ?? options.cores ?? 1), THRESHOLDS.loadPerCore);
    }
    if (snapshot.memory) {
        checked.push("memory");
        check("memory", snapshot.memory.usagePercent, THRESHOLDS.memory);
    }
    if (snapshot.disks.length) {
        checked.push("disk");
        for (const disk of snapshot.disks) check("disk", disk.usagePercent, THRESHOLDS.disk, disk.mount);
    } else if (snapshot.storage) {
        checked.push("disk");
        check("disk", snapshot.storage.usagePercent, THRESHOLDS.disk);
    }
    if (snapshot.failedUnits !== null) {
        checked.push("failedUnits");
        check("failedUnits", snapshot.failedUnits, THRESHOLDS.failedUnits);
    }

    issues.sort((a, b) => RANK[b.tone] - RANK[a.tone]);
    return {
        tone: checked.length ? worstTone(issues.map((issue) => issue.tone)) : "unknown",
        issues,
        checked
    };
}
