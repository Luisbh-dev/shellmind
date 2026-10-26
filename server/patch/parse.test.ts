import fs from "node:fs";
import { describe, expect, it } from "vitest";
import {
    nevraKey,
    parseApk,
    parseAptSecurityVersions,
    parseAptSimulation,
    parseCheckUpdate,
    parseLinuxScan,
    parsePacman,
    parseSecurityAdvisories,
    parseWindowsScan,
    parseZypperPatches,
    parseZypperUpdates,
    withAptSecurity
} from "./parse";

// Scan outputs captured from real hosts (test/fixtures/patch, the docker
// images of test/e2e/patch-distros.test.ts) and hand-made edge cases.

const fixture = (name: string) => fs.readFileSync(new URL(`../../test/fixtures/patch/${name}`, import.meta.url), "utf8");
const timing = { serverId: 7, scannedAt: 1000, durationMs: 50 };

// A scan output with the given sections (the scan script's @@SM: markers).
function sections(values: Record<string, string>): string {
    const names = ["uid", "sudo", "manager", "busy", "metadata", "last", "reboot", "rebootpkgs", "needrestart", "restarting", "updates", "security", "aptsecurity", "installed"];
    return `${names.map((name) => `\n@@SM:${name}\n${values[name] ?? ""}`).join("")}\n@@SM:end\n`;
}

describe("Linux scans of real hosts", () => {
    it("reads Debian 12: the security pocket, versions and the age of the package lists", () => {
        const scan = parseLinuxScan(fixture("scan-debian.txt"), timing);
        expect(scan).toMatchObject({ serverId: 7, platform: "linux", manager: "apt", privilege: "sudo", total: 45, security: 19, held: [], notices: [], rebootRequired: null });
        expect(scan.updates[0]).toEqual({ name: "base-files", arch: "amd64", current: "12.4+deb12u1", available: "12.4+deb12u15", repository: "oldstable", security: false, severity: null });
        expect(scan.updates.find((update) => update.name === "perl-base")).toMatchObject({ security: true, repository: "oldstable-security", current: "5.36.0-7", available: "5.36.0-7+deb12u4" });
        expect(scan.metadataAt).toBe(1792886744000);
        // The image's history has installs only: no update yet.
        expect(scan.lastUpdateAt).toBeNull();
    });

    it("counts Debian's security fixes that a point release ships again (the candidate supersedes them)", () => {
        const scan = parseLinuxScan(fixture("scan-debian.txt"), timing);
        // glibc: 2.36-9+deb12u1 installed, 2.36-9+deb12u7 in bookworm-security
        // (CVE-2023-4911 among its fixes), 2.36-9+deb12u14 the candidate.
        expect(scan.updates.find((update) => update.name === "libc6")).toMatchObject({
            current: "2.36-9+deb12u1", available: "2.36-9+deb12u14", repository: "oldstable, bookworm-security", security: true
        });
        for (const name of ["libc-bin", "libsystemd0", "libudev1", "util-linux", "mount", "libblkid1"]) {
            expect(scan.updates.find((update) => update.name === name)?.security).toBe(true);
        }
        // Without that section (an older scan), only the candidates' origins count.
        const plain = parseLinuxScan(fixture("scan-debian.txt").replace(/@@SM:aptsecurity\n[\s\S]*?(?=@@SM:)/, ""), timing);
        expect(plain.security).toBe(7);
        expect(plain.updates.find((update) => update.name === "libc6")).toMatchObject({ repository: "oldstable", security: false });
    });

    it("reads Ubuntu 24.04, whose security fixes are in -updates and -security", () => {
        const scan = parseLinuxScan(fixture("scan-ubuntu.txt"), timing);
        expect(scan).toMatchObject({ manager: "apt", total: 68, security: 40 });
        expect(scan.updates.find((update) => update.name === "libc6")).toMatchObject({ repository: "noble-updates, noble-security", security: true });
        expect(scan.updates.find((update) => update.name === "base-files")).toMatchObject({ repository: "noble-updates", security: false });
        // A package the upgrade installs (no version installed yet).
        expect(scan.updates.find((update) => update.name === "libdb5.3t64")).toMatchObject({ current: null });
    });

    it("reads Rocky Linux 9: check-update joined with the installed versions and the security advisories", () => {
        const scan = parseLinuxScan(fixture("scan-rocky.txt"), timing);
        expect(scan).toMatchObject({ manager: "dnf", privilege: "sudo", total: 117, security: 67, notices: [] });
        expect(scan.updates[0]).toEqual({ name: "acl", arch: "x86_64", current: "2.3.1-3.el9", available: "2.4.0-1.el9_8", repository: "baseos", security: true, severity: "Important" });
        expect(scan.updates.find((update) => update.name === "dbus")).toMatchObject({ available: "1:1.12.20-8.el9", security: true });
        expect(scan.updates.every((update) => update.current)).toBe(true);
        expect(scan.lastUpdateAt).toBe(1792885423000);
    });

    it("reads Alpine: no security information, and says so with null", () => {
        const scan = parseLinuxScan(fixture("scan-alpine.txt"), timing);
        expect(scan).toMatchObject({ manager: "apk", total: 10, security: null });
        expect(scan.updates[1]).toEqual({ name: "busybox", arch: "x86_64", current: "1.36.1-r28", available: "1.36.1-r31", repository: null, security: null, severity: null });
    });

    it("reads openSUSE: updates and the needed security patches", () => {
        const scan = parseLinuxScan(fixture("scan-opensuse.txt"), timing);
        expect(scan).toMatchObject({ manager: "zypper", privilege: "root", total: 2, security: 4 });
        expect(scan.updates[0]).toMatchObject({ name: "curl", current: "8.14.1-150600.4.28.1", available: "8.14.1-150600.4.40.1", arch: "x86_64", repository: "Update repository with updates from SUSE Linux Enterprise 15", security: null });
        expect(scan.patches).toHaveLength(4);
        expect(scan.patches[3]).toEqual({ name: "openSUSE-SLE-15.6-2026-885", category: "security", severity: "important", repository: "Update repository with updates from SUSE Linux Enterprise 15", summary: "Security update for curl" });
    });
});

describe("Linux scan details", () => {
    it("refuses a scan that was cut off", () => {
        expect(() => parseLinuxScan("@@SM:uid\n1000\n", timing)).toThrow(/cut off/);
    });

    it("tells who may install", () => {
        const privilege = (uid: string, sudo: string) => parseLinuxScan(sections({ uid, sudo, manager: "apt", metadata: "1700000000", updates: "@@rc 0" }), timing).privilege;
        expect(privilege("0", "")).toBe("root");
        expect(privilege("1000", "yes")).toBe("sudo");
        expect(privilege("1000", "password")).toBe("sudo-password");
        expect(privilege("1000", "none")).toBe("none");
    });

    it("reports a server without a supported manager, missing package lists and a busy manager", () => {
        expect(parseLinuxScan(sections({ uid: "0" }), timing)).toMatchObject({ manager: null, total: 0, security: null, notices: [] });
        const fresh = parseLinuxScan(sections({ uid: "0", manager: "dnf", busy: "dnf\nunattended-upgr", updates: "Error: Cache-only enabled but no cache for 'baseos'\n@@rc 1" }), timing);
        expect(fresh.notices).toEqual([{ code: "manager-busy", detail: "dnf, unattended-upgr" }, { code: "metadata-missing" }]);
        expect(fresh.total).toBe(0);
    });

    it("reports a failed listing with the manager's own error", () => {
        const scan = parseLinuxScan(sections({ uid: "0", manager: "apt", metadata: "1700000000", updates: "Reading package lists...\nE: The package lists or status file could not be parsed or opened.\n@@rc 100" }), timing);
        expect(scan.notices).toEqual([{ code: "listing-failed", detail: "E: The package lists or status file could not be parsed or opened." }]);
    });

    it("says when dnf cannot tell security updates (no updateinfo)", () => {
        const scan = parseLinuxScan(sections({
            uid: "0",
            manager: "dnf",
            metadata: "1700000000",
            updates: "bash.x86_64   5.1.8-9.el9   baseos\n@@rc 100",
            security: "Error: no updateinfo\n@@rc 1",
            installed: "bash.x86_64 5.1.8-6.el9"
        }), timing);
        expect(scan.security).toBeNull();
        expect(scan.updates[0]).toMatchObject({ security: null, current: "5.1.8-6.el9" });
        expect(scan.notices).toEqual([{ code: "security-unknown", detail: "Error: no updateinfo" }]);
    });

    it("combines the fleet probe's reboot check with needrestart and lists services to restart", () => {
        const scan = parseLinuxScan(sections({
            uid: "0", manager: "apt", metadata: "1700000000", updates: "@@rc 0",
            reboot: "", rebootpkgs: "linux-image-6.1.0-26-amd64\nlibc6",
            needrestart: "NEEDRESTART-VER: 3.6\nNEEDRESTART-KCUR: 6.1.0-25-amd64\nNEEDRESTART-KSTA: 3\nNEEDRESTART-SVC: nginx.service\nNEEDRESTART-SVC: ssh.service",
            restarting: "sshd.service\nnot a unit"
        }), timing);
        expect(scan).toMatchObject({ rebootRequired: true, rebootPackages: ["linux-image-6.1.0-26-amd64", "libc6"], restartServices: ["nginx.service", "ssh.service", "sshd.service"] });
        expect(parseLinuxScan(sections({ manager: "apt", reboot: "", needrestart: "NEEDRESTART-KSTA: 1", updates: "@@rc 0" }), timing).rebootRequired).toBe(false);
        expect(parseLinuxScan(sections({ manager: "apt", reboot: "yes", updates: "@@rc 0" }), timing).rebootRequired).toBe(true);
    });

    it("keeps the list within bounds and says how many there were", () => {
        const many = Array.from({ length: 2100 }, (_, index) => `pkg${index} 1.0-1 -> 1.0-2`).join("\n");
        const scan = parseLinuxScan(sections({ manager: "pacman", metadata: "1700000000", updates: `${many}\n@@rc 0` }), timing);
        expect(scan.updates).toHaveLength(2000);
        expect(scan.total).toBe(2100);
        expect(scan.notices).toEqual([{ code: "truncated", detail: "2100" }]);
    });
});

describe("package manager outputs", () => {
    it("apt: new packages, several archives, dependency-loop notes and held updates", () => {
        const { updates, held } = parseAptSimulation([
            "The following packages have been kept back:",
            "  linux-image-amd64 grub-pc",
            "The following upgrades have been deferred due to phasing:",
            "  snapd",
            "Inst gcc-12-base [12.2.0-14] (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64]) [libstdc++6:amd64 libgcc-s1:amd64 ]",
            "Conf gcc-12-base (12.2.0-14+deb12u1 Debian:12.15/oldstable [amd64])",
            "Inst linux-image-6.1.0-27-amd64 (6.1.115-1 Debian-Security:12/oldstable-security [amd64])",
            "Inst libfoo [1.0] (1.1 localrepo [all])"
        ]);
        expect(held).toEqual([{ name: "linux-image-amd64", reason: "kept-back" }, { name: "grub-pc", reason: "kept-back" }, { name: "snapd", reason: "phased" }]);
        expect(updates).toEqual([
            { name: "gcc-12-base", arch: "amd64", current: "12.2.0-14", available: "12.2.0-14+deb12u1", repository: "oldstable", security: false, severity: null },
            { name: "linux-image-6.1.0-27-amd64", arch: "amd64", current: null, available: "6.1.115-1", repository: "oldstable-security", security: true, severity: null },
            { name: "libfoo", arch: "all", current: "1.0", available: "1.1", repository: "localrepo", security: false, severity: null }
        ]);
    });

    it("apt: security versions newer than the installed one mark their update, once", () => {
        const fixes = parseAptSecurityVersions("libc6 2.36-9+deb12u7 bookworm-security\nlibc6 2.36-9+deb12u3 bookworm-security\nlibssl1.1 1.1.1n-0+deb10u6\n\n");
        expect([...fixes]).toEqual([["libc6", { version: "2.36-9+deb12u7", archive: "bookworm-security" }], ["libssl1.1", { version: "1.1.1n-0+deb10u6", archive: null }]]);
        const base = { arch: "amd64", current: "1", available: "2", severity: null };
        expect(withAptSecurity([
            { ...base, name: "libc6", repository: "oldstable", security: false },
            { ...base, name: "perl-base", repository: "oldstable-security", security: true },
            { ...base, name: "libssl1.1", repository: null, security: false },
            { ...base, name: "base-files", repository: "oldstable", security: false }
        ], fixes).map((update) => [update.name, update.repository, update.security])).toEqual([
            ["libc6", "oldstable, bookworm-security", true],
            ["perl-base", "oldstable-security", true],
            ["libssl1.1", null, true],
            ["base-files", "oldstable", false]
        ]);
    });

    it("dnf: rows pushed to the next line by a long name, and the obsoletes that follow", () => {
        expect(parseCheckUpdate([
            "",
            "NetworkManager-libnm-very-long-package-name.x86_64",
            "                          1:1.46.0-8.el9          baseos",
            "bash.x86_64   5.1.8-9.el9   baseos",
            "Obsoleting Packages",
            "grub2-tools.x86_64   1:2.06-80.el9   baseos"
        ])).toEqual([
            { key: "NetworkManager-libnm-very-long-package-name.x86_64", version: "1:1.46.0-8.el9", repository: "baseos" },
            { key: "bash.x86_64", version: "5.1.8-9.el9", repository: "baseos" }
        ]);
    });

    it("dnf: advisories of dnf 4 and dnf 5, the strongest severity of a package winning", () => {
        const fixes = parseSecurityAdvisories([
            "RLSA-2022:6157  Moderate/Sec.  curl-7.76.1-14.el9_0.5.x86_64",
            "RLSA-2026:55439 Important/Sec. curl-7.76.1-40.el9_8.5.x86_64",
            "RLSA-2023:0335  Moderate/Sec.  dbus-1:1.12.20-7.el9_1.x86_64",
            "Name                     Type     Severity  Package                              Issued",
            "FEDORA-2024-1a2b3c4d5e   security Low       openssl-1:3.2.2-1.fc40.x86_64       2024-06-11 01:02:03"
        ]);
        expect([...fixes]).toEqual([["curl.x86_64", "Important"], ["dbus.x86_64", "Moderate"], ["openssl.x86_64", "Low"]]);
        expect(nevraKey("python3-libselinux-3.6-1.el9.x86_64")).toBe("python3-libselinux.x86_64");
        expect(nevraKey("nonsense")).toBeNull();
    });

    it("zypper: tables by their header, patches that are needed", () => {
        const updates = parseZypperUpdates([
            "Loading repository data...",
            "S | Repository | Name | Current Version | Available Version | Arch",
            "--+------------+------+-----------------+-------------------+-------",
            "v | Main Update | libzypp | 17.31.8-150400 | 17.31.10-150400 | x86_64"
        ]);
        expect(updates).toEqual([{ name: "libzypp", arch: "x86_64", current: "17.31.8-150400", available: "17.31.10-150400", repository: "Main Update", security: null, severity: null }]);
        expect(parseZypperPatches([
            "Repository | Name | Category | Severity | Interactive | Status | Summary",
            "-----------+------+----------+----------+-------------+--------+--------",
            "Update | SUSE-2024-1 | security | critical | --- | needed | openssl",
            "Update | SUSE-2024-2 | security | low | --- | applied | old one"
        ])).toEqual([{ name: "SUSE-2024-1", category: "security", severity: "critical", repository: "Update", summary: "openssl" }]);
    });

    it("apk: older apk's version listing too", () => {
        expect(parseApk(["Installed:                                Available:", "py3-setuptools-70.3.0-r0                < 70.3.0-r1 "])).toEqual([
            { name: "py3-setuptools", arch: null, current: "70.3.0-r0", available: "70.3.0-r1", repository: null, security: null, severity: null }
        ]);
    });

    it("pacman: ignored packages are held", () => {
        expect(parsePacman(["linux 6.9.7.arch1-1 -> 6.9.8.arch1-1", "nvidia 550.90-1 -> 555.58-1 [ignored]"])).toEqual({
            updates: [{ name: "linux", arch: null, current: "6.9.7.arch1-1", available: "6.9.8.arch1-1", repository: null, security: null, severity: null }],
            held: [{ name: "nvidia", reason: "kept-back" }]
        });
    });
});

describe("Windows Update scans", () => {
    it("reads the search, the security classification by id whatever its language, the reboot flag and the dates", () => {
        const output = JSON.stringify({
            updates: [
                { reboot: 2, title: "2026-09 Security Update (KB5122871)", severity: null, classes: [{ id: "0FA1201D-4330-4FA8-8AE9-B877473B6441", name: "Actualizaciones de seguridad" }], kb: ["5122871"] },
                { reboot: 0, title: "Microsoft Defender Antivirus antimalware platform update", severity: "", classes: { id: "e0789628-ce08-4437-be74-2495b842f43b", name: "Definition Updates" }, kb: "4052623" }
            ],
            error: null,
            lastInstall: "2026-10-24T04:08:56.0000000Z",
            reboot: true,
            admin: true,
            lastSearch: "2026-10-24T20:16:59.0000000Z"
        });
        const scan = parseWindowsScan(`noise before\n${output}\n`, timing);
        expect(scan).toMatchObject({ platform: "windows", manager: "windows-update", privilege: "admin", total: 2, security: 1, rebootRequired: true, notices: [] });
        expect(scan.updates).toEqual([
            { name: "2026-09 Security Update (KB5122871)", arch: null, current: null, available: "KB5122871", repository: "Actualizaciones de seguridad", security: true, severity: null },
            { name: "Microsoft Defender Antivirus antimalware platform update", arch: null, current: null, available: "KB4052623", repository: "Definition Updates", security: false, severity: null }
        ]);
        expect(scan.lastUpdateAt).toBe(Date.parse("2026-10-24T04:08:56Z"));
        expect(scan.metadataAt).toBe(Date.parse("2026-10-24T20:16:59Z"));
    });

    it("reports a search that failed, and a user who is not an administrator", () => {
        // Over SSH Windows Update lets only administrators search it (captured on Windows Server 2025).
        const denied = "Creating an instance of the COM component with CLSID {4CB43D7F-7EEE-4906-8698-60DA1C38F2FE} from the IClassFactory failed due to the following error: 80070005 Access is denied. (Exception from HRESULT: 0x80070005 (E_ACCESSDENIED)).";
        const scan = parseWindowsScan(JSON.stringify({ updates: [], error: denied, reboot: false, admin: false }), timing);
        expect(scan).toMatchObject({ privilege: "user", security: null, total: 0, notices: [{ code: "search-denied", detail: denied }] });
        const failed = parseWindowsScan(JSON.stringify({ updates: [], error: "Exception from HRESULT: 0x8024402C", reboot: false, admin: true }), timing);
        expect(failed.notices).toEqual([{ code: "search-failed", detail: "Exception from HRESULT: 0x8024402C" }]);
        expect(() => parseWindowsScan("no json", timing)).toThrow(/no data/);
    });
});
