import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LINUX_STATUS_SCRIPT } from "../status/linux";
import { FLEET_WINDOWS_SCRIPT, fleetLinuxScript, parseFleetLinux, parseFleetWindows, parseRebootLine, parseUpdatesLine } from "./probe";

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/fleet/${name}`, import.meta.url)), "utf8");

describe("fleet Linux script", () => {
    it("reuses the status report's sections without its one-second sample", () => {
        const script = fleetLinuxScript();
        for (const section of ["host", "os", "kernel", "loadavg", "meminfo", "mounts", "df", "failed", "users", "up1", "up2", "cpu1", "reboot", "updates", "end"]) {
            expect(script).toContain(`\nm ${section}\n`);
        }
        expect(LINUX_STATUS_SCRIPT).toContain("sleep 1");
        expect(script).not.toMatch(/\bsleep\b/);
        expect(script).not.toMatch(/\bm (cpu2|net1|net2|procs)\b/);
        expect(script.startsWith(LINUX_STATUS_SCRIPT.slice(0, LINUX_STATUS_SCRIPT.indexOf("\nm up1\n")))).toBe(true);
    });

    it("only reads: no refresh of the package cache, no privileges", () => {
        const script = fleetLinuxScript();
        expect(script).not.toMatch(/\bsudo\b|apt(-get)? update|makecache|zypper (ref|refresh)|apk update|pacman -S/);
        // Every package manager runs from its cache.
        expect(script).toContain("apt-get -s ");
        expect(script).toContain("-q -C check-update");
        expect(script).toContain("--no-refresh");
        // apk 3 would download indexes older than four hours.
        expect(script).toContain("apk --no-network version -l '<'");
    });
});

describe("fleet Linux reading", () => {
    it("grades the reading with the shared thresholds and adds the fleet signals", () => {
        const reading = parseFleetLinux(fixture("linux-ubuntu.txt"), 1_800_000_000_000);
        expect(reading.tone).toBe("critical");
        expect(reading.issues).toEqual([
            { metric: "disk", tone: "critical", value: 93, mount: "/" },
            { metric: "load", tone: "warn", value: 1.3 },
            { metric: "failedUnits", tone: "warn", value: 1 }
        ]);
        expect(reading.metrics).toMatchObject({
            platform: "linux",
            hostname: "web-01",
            os: "Ubuntu 22.04.4 LTS",
            kernel: "5.15.0-105-generic",
            uptimeSeconds: 1234567,
            bootedAt: 1_800_000_000_000 - 1234567 * 1000,
            cores: 2,
            cpuPercent: null,
            load: { one: 2.6, five: 1.48, fifteen: 0.9 },
            loadPerCore: 1.3,
            memory: { usagePercent: 39.7 },
            disk: { mount: "/", usagePercent: 93 },
            diskCount: 3,
            failedUnits: 1,
            loggedInUsers: 2,
            rebootRequired: true,
            updates: { manager: "apt", count: 12, security: 5, cacheAt: 1_792_000_000_000 }
        });
    });

    it("refuses a report cut short", () => {
        expect(() => parseFleetLinux(fixture("linux-ubuntu.txt").split("@@SM:end")[0])).toThrow(/cut off/);
    });
});

describe("fleet signal lines", () => {
    it("reads the pending reboot", () => {
        expect(parseRebootLine("yes")).toBe(true);
        expect(parseRebootLine("no\n")).toBe(false);
        expect(parseRebootLine("")).toBeNull();
        expect(parseRebootLine(undefined)).toBeNull();
        expect(parseRebootLine("maybe")).toBeNull();
    });

    it("reads the pending updates of each package manager", () => {
        expect(parseUpdatesLine("apt 12 5 1792000000")).toEqual({ manager: "apt", count: 12, security: 5, cacheAt: 1_792_000_000_000 });
        expect(parseUpdatesLine("dnf 15 - ")).toEqual({ manager: "dnf", count: 15, security: null, cacheAt: null });
        expect(parseUpdatesLine("apk 0 -")).toEqual({ manager: "apk", count: 0, security: null, cacheAt: null });
        // More security advisories than packages (one package, several advisories).
        expect(parseUpdatesLine("dnf 3 7 1")).toMatchObject({ count: 3, security: 3 });
        expect(parseUpdatesLine("chocolatey 3 1 1")).toBeNull();
        expect(parseUpdatesLine("apt lots")).toBeNull();
        expect(parseUpdatesLine("apt 9999999 0")).toBeNull();
        expect(parseUpdatesLine("")).toBeNull();
    });
});

describe("fleet Windows reading", () => {
    const report = (extra: Record<string, unknown> = {}) => JSON.stringify({
        host: "WIN-SRV01", os: "Microsoft Windows Server 2022 Standard", ver: "10.0.20348", up: 7200, cores: 4,
        mem: { t: 8388608, f: 838860, st: 0, sf: 0 },
        disks: [{ n: "C:", fs: "NTFS", s: 107374182400, f: 32212254720 }, { n: "D:", fs: "NTFS", s: 53687091200, f: 2147483648 }],
        load: 35, reboot: true, ...extra
    });

    it("uses the processor load as the CPU reading and reports a pending reboot", () => {
        const reading = parseFleetWindows(`${report()}\r\n`, 1_800_000_000_000);
        expect(reading.tone).toBe("critical");
        expect(reading.issues).toEqual([
            { metric: "memory", tone: "critical", value: 90 },
            { metric: "disk", tone: "critical", value: 96, mount: "D:" }
        ]);
        expect(reading.metrics).toMatchObject({
            platform: "windows",
            hostname: "WIN-SRV01",
            os: "Microsoft Windows Server 2022 Standard",
            kernel: "10.0.20348",
            cores: 4,
            cpuPercent: 35,
            load: null,
            loadPerCore: null,
            disk: { mount: "D:", usagePercent: 96 },
            failedUnits: null,
            rebootRequired: true,
            updates: null
        });
    });

    it("leaves out what the host did not report", () => {
        const reading = parseFleetWindows(report({ load: null, reboot: null }));
        expect(reading.metrics.cpuPercent).toBeNull();
        expect(reading.metrics.rebootRequired).toBeNull();
    });

    it("reads the registry keys of a pending reboot", () => {
        expect(FLEET_WINDOWS_SCRIPT).toContain("Component Based Servicing\\RebootPending");
        expect(FLEET_WINDOWS_SCRIPT).toContain("WindowsUpdate\\Auto Update\\RebootRequired");
        expect(FLEET_WINDOWS_SCRIPT).not.toMatch(/Start-Sleep|Get-Process/);
    });
});
