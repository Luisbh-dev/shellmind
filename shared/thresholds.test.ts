import { describe, expect, it } from "vitest";
import type { StatusSnapshot } from "./status";
import { assessHealth, classify, loadTone, storageReading, THRESHOLDS, worstTone } from "./thresholds";

const snapshot = (overrides: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
    platform: "linux",
    collectedAt: 1,
    hostname: "h",
    os: "Linux",
    kernel: null,
    uptimeSeconds: 1,
    cpu: { usagePercent: 10, cores: 4, iowaitPercent: null },
    memory: { totalMB: 100, usedMB: 50, availableMB: 50, usagePercent: 50 },
    swap: null,
    load: null,
    storage: { totalGB: 10, usedGB: 5, freeGB: 5, usagePercent: 50 },
    disks: [{ name: "/dev/sda1", mount: "/", fsType: "ext4", totalGB: 10, usedGB: 5, freeGB: 5, usagePercent: 50 }],
    processes: [],
    network: null,
    failedUnits: 0,
    loggedInUsers: null,
    sampleSeconds: 1,
    unavailable: [],
    ...overrides,
});

describe("classify", () => {
    it("turns warn and critical at the limits themselves", () => {
        const limits = { warn: 75, critical: 90 };
        expect(classify(74.9, limits)).toBe("ok");
        expect(classify(75, limits)).toBe("warn");
        expect(classify(89.9, limits)).toBe("warn");
        expect(classify(90, limits)).toBe("critical");
        expect(classify(140, limits)).toBe("critical");
        expect(classify(Number.NaN, limits)).toBe("ok");
    });

    it("keeps every limit in one table, warn below critical", () => {
        for (const limit of Object.values(THRESHOLDS)) expect(limit.warn).toBeLessThan(limit.critical);
        expect(classify(THRESHOLDS.disk.warn, THRESHOLDS.disk)).toBe("warn");
    });

    it("picks the worst tone", () => {
        expect(worstTone([])).toBe("ok");
        expect(worstTone(["ok", "warn", "ok"])).toBe("warn");
        expect(worstTone(["warn", "critical", "ok"])).toBe("critical");
    });

    it("grades the load per core", () => {
        expect(loadTone(3.9, 4)).toBe("ok");
        expect(loadTone(4, 4)).toBe("warn");
        expect(loadTone(8, 4)).toBe("critical");
        // Without a core count, against one core.
        expect(loadTone(1.5, null)).toBe("warn");
    });
});

describe("assessHealth", () => {
    it("is healthy when every metric is within its limits", () => {
        expect(assessHealth(snapshot())).toEqual({ tone: "ok", issues: [], checked: ["cpu", "memory", "disk", "failedUnits"] });
    });

    it("takes the worst of CPU, memory, each filesystem and the failed units, worst first", () => {
        const health = assessHealth(snapshot({
            cpu: { usagePercent: 80, cores: 4, iowaitPercent: null },
            memory: { totalMB: 100, usedMB: 95, availableMB: 5, usagePercent: 95 },
            storage: { totalGB: 100, usedGB: 50, freeGB: 50, usagePercent: 50 },
            disks: [
                { name: "/dev/sda1", mount: "/", fsType: "ext4", totalGB: 90, usedGB: 40, freeGB: 50, usagePercent: 44 },
                // The total is fine; this one is not.
                { name: "/dev/sda2", mount: "/var", fsType: "xfs", totalGB: 10, usedGB: 9.2, freeGB: 0.8, usagePercent: 92 },
            ],
            failedUnits: 2,
        }));
        expect(health.tone).toBe("critical");
        expect(health.issues).toEqual([
            { metric: "memory", tone: "critical", value: 95 },
            { metric: "disk", tone: "critical", value: 92, mount: "/var" },
            { metric: "cpu", tone: "warn", value: 80 },
            { metric: "failedUnits", tone: "warn", value: 2 },
        ]);
    });

    // Status leftover: the load per core was graded on its tile but left out of the verdict.
    it("counts the load per core, as a warning at most", () => {
        const load = (one: number) => ({ one, five: 0.5, fifteen: 0.5 });
        expect(assessHealth(snapshot({ load: load(3.9) }))).toEqual({ tone: "ok", issues: [], checked: ["cpu", "load", "memory", "disk", "failedUnits"] });
        expect(assessHealth(snapshot({ load: load(6) })).issues).toEqual([{ metric: "load", tone: "warn", value: 1.5 }]);
        // Far past the critical load of the tile, still a warning.
        expect(loadTone(12, 4)).toBe("critical");
        expect(assessHealth(snapshot({ load: load(12) }))).toMatchObject({ tone: "warn", issues: [{ metric: "load", tone: "warn", value: 3 }] });
        // Without a core count, against one core (as the tile).
        expect(assessHealth(snapshot({ cpu: { usagePercent: 10, cores: null, iowaitPercent: null }, load: load(1.2) })).issues)
            .toEqual([{ metric: "load", tone: "warn", value: 1.2 }]);
        // Worst first: a critical metric leads.
        const both = assessHealth(snapshot({ load: load(8), memory: { totalMB: 100, usedMB: 95, availableMB: 5, usagePercent: 95 } }));
        expect(both.tone).toBe("critical");
        expect(both.issues.map((issue) => issue.metric)).toEqual(["memory", "load"]);
    });

    it("falls back to the storage total without a filesystem list", () => {
        const health = assessHealth(snapshot({ disks: [], storage: { totalGB: 10, usedGB: 8.5, freeGB: 1.5, usagePercent: 85 } }));
        expect(health.issues).toEqual([{ metric: "disk", tone: "warn", value: 85 }]);
    });

    it("judges only what the host reported (Windows has no systemd)", () => {
        const health = assessHealth(snapshot({ platform: "windows", failedUnits: null }));
        expect(health.checked).toEqual(["cpu", "memory", "disk"]);
        expect(health.tone).toBe("ok");
    });

    it("is unknown when nothing it is based on was reported", () => {
        const health = assessHealth(snapshot({ cpu: null, memory: null, storage: null, disks: [], failedUnits: null }));
        expect(health).toEqual({ tone: "unknown", issues: [], checked: [] });
    });
});

describe("storageReading", () => {
    const disk = (mount: string, usagePercent: number, totalGB = 100) => ({
        name: `/dev/${mount}`, mount, fsType: "ext4", totalGB, usedGB: (totalGB * usagePercent) / 100, freeGB: totalGB - (totalGB * usagePercent) / 100, usagePercent,
    });

    it("leads with the fullest filesystem, so the tile agrees with the health verdict", () => {
        const report = snapshot({
            disks: [disk("/", 62), disk("/var", 93.4), disk("/home", 12)],
            storage: { totalGB: 300, usedGB: 167.4, freeGB: 132.6, usagePercent: 55.8 },
        });
        const reading = storageReading(report);
        expect(reading).toMatchObject({ usagePercent: 93.4, mount: "/var", totalGB: 100, total: { usedGB: 167.4, totalGB: 300, count: 3 } });
        // The tile's tone is the worst disk issue's tone.
        expect(classify(reading?.usagePercent ?? 0, THRESHOLDS.disk)).toBe(assessHealth(report).issues[0].tone);
    });

    it("needs no total for a single filesystem, and ties keep the first", () => {
        expect(storageReading(snapshot())).toMatchObject({ mount: "/", usagePercent: 50, freeGB: 5, total: null });
        expect(storageReading(snapshot({ disks: [disk("/a", 40), disk("/b", 40)] }))?.mount).toBe("/a");
    });

    it("falls back to the total without a filesystem list, and to nothing without either", () => {
        expect(storageReading(snapshot({ disks: [] }))).toEqual({ usagePercent: 50, usedGB: 5, totalGB: 10, freeGB: 5, mount: null, total: null });
        expect(storageReading(snapshot({ disks: [], storage: null }))).toBeNull();
    });
});
