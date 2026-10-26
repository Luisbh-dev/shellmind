import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { PATCH_MODES, type PatchOptions } from "../../shared/patch";
import { FLEET_WINDOWS_SCRIPT, LINUX_REBOOT, WINDOWS_REBOOT_PENDING } from "../fleet/probe";
import { APT_SECURITY_VERSIONS_FUNCTION, BOOT_CHECK_SCRIPT, LINUX_SCAN_SCRIPT, REBOOT_SCRIPT, buildApplyScript, describeRun, planCommands, windowsScanScript } from "./scripts";

// The scripts are fixed text plus validated options: the checks below pin
// what each mode runs, that the scan never changes anything, and (where a
// POSIX shell is at hand) that every script parses. The docker e2e
// (test/e2e/patch-distros.test.ts) runs them on real distributions.

const shell = ["dash", "sh"].find((candidate) => spawnSync(candidate, ["-c", "true"]).status === 0);
const tools = Boolean(shell) && ["awk", "grep", "head"].every((tool) => spawnSync(shell!, ["-c", `command -v ${tool}`]).status === 0);

const ALL_OPTIONS: PatchOptions[] = PATCH_MODES.flatMap((mode) => [false, true].flatMap((refresh) => [false, true].map((reboot) => ({ mode, refresh, reboot }))));

describe("patch scripts", () => {
    it.skipIf(!shell)("parse as POSIX shell", () => {
        for (const script of [LINUX_SCAN_SCRIPT, BOOT_CHECK_SCRIPT, REBOOT_SCRIPT, ...ALL_OPTIONS.map(buildApplyScript)]) {
            const result = spawnSync(shell!, ["-n"], { input: script, encoding: "utf8" });
            expect(result.stderr).toBe("");
            expect(result.status).toBe(0);
        }
    });

    it("scan only reads: no install, no refresh, sudo only to ask whether it works", () => {
        expect(LINUX_SCAN_SCRIPT).not.toMatch(/apt-get (-\S+ )*(update|install|dist-upgrade)\b|apt-get -y|apt-mark (auto|manual)|makecache|zypper (-\S+ )*(refresh|ref|update|up|patch)\b|apk (update|upgrade|add)\b|pacman -S/);
        // `command -v sudo`, then `sudo -n true`.
        expect(LINUX_SCAN_SCRIPT.match(/sudo [^\n|;]*/g)).toEqual(["sudo >/dev/null 2>&1", "sudo -n true >/dev/null 2>&1"]);
        // The simulation, cache-only listings and local indexes.
        expect(LINUX_SCAN_SCRIPT).toContain("apt-get -s -o Debug::NoLocking=true --with-new-pkgs upgrade");
        expect(LINUX_SCAN_SCRIPT).toContain("apt-cache policy $n");
        expect(LINUX_SCAN_SCRIPT).toContain("$p -q -C check-update");
        expect(LINUX_SCAN_SCRIPT).toContain("zypper -n --no-refresh -q list-updates");
        // apk 3 would download missing or old indexes for a listing.
        expect(LINUX_SCAN_SCRIPT).toContain("apk --no-network list -u");
        expect(LINUX_SCAN_SCRIPT).toContain("apk --no-network version -l '<'");
        expect(LINUX_SCAN_SCRIPT).not.toMatch(/apk (list|version)\b/);
        expect(LINUX_SCAN_SCRIPT).toContain("needrestart -b -r l");
    });

    it("Windows: searches only, from the cache unless asked to go online", () => {
        expect(windowsScanScript(false)).toContain("$searcher.Online = $false");
        expect(windowsScanScript(true)).toContain("$searcher.Online = $true");
        expect(windowsScanScript(true)).not.toMatch(/CreateUpdateInstaller|CreateUpdateDownloader|\.Install\(|\.Download\(|EncodedCommand|Invoke-Expression|iex /i);
    });

    it("tells a pending reboot as the fleet probe does, on Linux and on Windows", () => {
        expect(LINUX_SCAN_SCRIPT).toContain(LINUX_REBOOT);
        expect(windowsScanScript(false)).toContain(`$report.reboot = ${WINDOWS_REBOOT_PENDING}`);
        expect(FLEET_WINDOWS_SCRIPT).toContain(`$r=${WINDOWS_REBOOT_PENDING}`);
        expect(WINDOWS_REBOOT_PENDING).toContain(String.raw`'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending'`);
    });

    it("runs what each mode says, non-interactively, and says it in marker lines", () => {
        const security = buildApplyScript({ mode: "security", refresh: false, reboot: true });
        expect(security.split("\n")[0]).toBe("# ShellMind patch center: install security updates, then reboot where a reboot is required");
        expect(security).toContain("mode=security\nrefresh=0");
        expect(security).toContain("DEBIAN_FRONTEND=noninteractive");
        expect(security).toContain("--force-confold");
        expect(security).toContain("install --only-upgrade $k");
        expect(security).toContain("upgrade --security");
        expect(security).toContain("patch --category security");
        expect(security).toContain("say \"reboot-required=${rb:-unknown}\"");
        expect(security).toContain("fail 77 error=privilege");
        expect(security).toContain("say security-updates=none");
        // Never a password typed into sudo: -n, or nothing.
        expect(security).not.toMatch(/sudo -S|sudo -A|SUDO_ASKPASS/);
        // Nothing a run starts reads the script it comes from (sh -s).
        expect(security).toContain("run() { printf '+ %s\\n' \"$*\"; \"$@\" </dev/null; }");
        // Only marker lines of its own: no English sentences to translate.
        expect(security).not.toMatch(/echo '[A-Z]|say '[A-Z]/);
        expect(buildApplyScript({ mode: "all", refresh: true, reboot: false })).toContain("mode=all\nrefresh=1");
        expect(buildApplyScript({ mode: "refresh", refresh: false, reboot: false })).toContain("mode=refresh\nrefresh=1");
        expect(REBOOT_SCRIPT).toContain("echo '[shellmind] error=reboot-privilege' >&2; exit 77");
    });

    it("never refreshes the package lists unless asked to", () => {
        for (const options of ALL_OPTIONS.filter((entry) => entry.mode !== "refresh")) {
            const script = buildApplyScript(options);
            // dnf/yum: for every repository (their own metadata_expire wins over a global one).
            expect(script).toContain("run $S $p -y '--setopt=*.metadata_expire=never' upgrade");
            expect(script).not.toMatch(/--setopt=metadata_expire/);
            expect(script).toContain("run $S apk --cache-max-age 5256000 upgrade");
            expect(script).toContain("zypper -n --no-refresh $a");
            expect(script).toContain("pacman -Su --noconfirm");
            const refreshes = script.match(/apt-get -q -o DPkg::Lock::Timeout=300 update|-y makecache|zypper -n refresh|apk update/g) ?? [];
            // Present, but only behind `[ $refresh = 1 ]`.
            expect(refreshes).toHaveLength(4);
            expect(script).toContain(`refresh=${options.refresh ? 1 : 0}`);
        }
    });

    it("gives back the automatic marks of the packages a security run names", () => {
        const security = buildApplyScript({ mode: "security", refresh: false, reboot: false });
        expect(security).toContain("a=$(apt-mark showauto $k 2>/dev/null)");
        expect(security).toContain("run $S apt-mark auto $a || say \"auto-marks-failed=$?\"");
        // apt-mark runs after the install, whatever its exit status.
        expect(security.indexOf("apt-mark auto $a")).toBeGreaterThan(security.indexOf("install --only-upgrade $k"));
    });

    it("describes the commands of the preview", () => {
        expect(planCommands({ mode: "security", refresh: false, reboot: false })).toEqual({
            apt: [
                "apt-get -y -q -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold -o DPkg::Lock::Timeout=300 --no-remove install --only-upgrade <the pending security updates>",
                "apt-mark auto <those of them that were installed as dependencies>"
            ],
            dnf: ["dnf -y --setopt=*.metadata_expire=never upgrade --security"],
            yum: ["yum -y --setopt=*.metadata_expire=never upgrade --security"],
            zypper: ["zypper -n --no-refresh patch --category security --auto-agree-with-licenses"],
            apk: [],
            pacman: []
        });
        expect(planCommands({ mode: "all", refresh: true, reboot: false })).toMatchObject({
            apt: ["apt-get -q update", expect.stringContaining("--with-new-pkgs upgrade")],
            dnf: ["dnf -y makecache", "dnf -y --setopt=*.metadata_expire=never upgrade"],
            apk: ["apk update", "apk --cache-max-age 5256000 upgrade"],
            pacman: ["pacman -Syu --noconfirm"]
        });
        expect(planCommands({ mode: "refresh", refresh: true, reboot: false }).pacman).toEqual(["pacman -Sy --noconfirm"]);
        expect(describeRun({ mode: "all", refresh: true, reboot: false })).toBe("install all updates, refresh the package lists first");
        expect(describeRun({ mode: "refresh", refresh: true, reboot: true })).toBe("refresh the package lists");
    });
});

describe("apt security versions", () => {
    // `apt-cache policy` as a Debian 12.1 host printed it (test/fixtures/patch),
    // plus a package the upgrade installs new and a Debian 10 security line.
    const policy = `${fs.readFileSync(new URL("../../test/fixtures/patch/apt-policy-debian.txt", import.meta.url), "utf8")}${[
        "linux-image-6.1.0-27-amd64:",
        "  Installed: (none)",
        "  Candidate: 6.1.115-1",
        "  Version table:",
        "     6.1.115-1 500",
        "        500 http://deb.debian.org/debian-security bookworm-security/main amd64 Packages",
        "libssl1.1:",
        "  Installed: 1.1.1n-0+deb10u3",
        "  Candidate: 1.1.1n-0+deb10u6",
        "  Version table:",
        "     1.1.1n-0+deb10u6 500",
        "        500 http://security.debian.org buster/updates/main amd64 Packages",
        " *** 1.1.1n-0+deb10u3 100",
        "        100 /var/lib/dpkg/status",
        ""
    ].join("\n")}`;

    it.skipIf(!tools)("finds the security fixes a newer point-release candidate supersedes", () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shellmind-apt-"));
        try {
            fs.writeFileSync(path.join(dir, "policy.txt"), policy);
            // A stand-in apt-cache that prints the captured policy.
            fs.writeFileSync(path.join(dir, "apt-cache"), "#!/bin/sh\ncat \"$(dirname \"$0\")/policy.txt\"\n", { mode: 0o755 });
            const simulation = ["libc6", "perl-base", "base-files", "tzdata", "openssh-server", "linux-image-6.1.0-27-amd64", "libssl1.1", "bad;name"]
                .map((name) => `Inst ${name} [1] (2 Debian:12.15/oldstable [amd64])`).join("\n");
            // A POSIX path for the shell's PATH (Git's sh on Windows: /c/...).
            const bin = process.platform === "win32" ? dir.replace(/^([A-Za-z]):/, (_, drive: string) => `/${drive.toLowerCase()}`).replace(/\\/g, "/") : dir;
            const result = spawnSync(shell!, ["-c", `PATH="${bin}:$PATH"\n${APT_SECURITY_VERSIONS_FUNCTION}\napt_security_versions`], { input: `${simulation}\n`, encoding: "utf8" });
            expect(result.stderr).toBe("");
            expect(result.stdout.trim().split("\n")).toEqual([
                // The candidate (deb12u14) is a point release; deb12u7 is the security fix.
                "libc6 2.36-9+deb12u7 bookworm-security",
                "perl-base 5.36.0-7+deb12u4 bookworm-security",
                "tzdata 2026e-0+deb12u1 bookworm-security",
                "linux-image-6.1.0-27-amd64 6.1.115-1 bookworm-security",
                "libssl1.1 1.1.1n-0+deb10u6 buster"
            ]);
            // base-files has no security version; openssh-server's is older than the one installed.
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
