import type { PackageManager } from "../../shared/fleet";
import {
    PATCH_LIMITS,
    type HeldUpdate,
    type PatchAdvisory,
    type PatchManager,
    type PatchNotice,
    type PatchPrivilege,
    type PatchScan,
    type PendingUpdate
} from "../../shared/patch";
import { parseRebootLine } from "../fleet/probe";
import { asString, ensureArray, extractJson, isRecord, parseSections } from "../ops/remote";

// Reading what the scan scripts (scripts.ts) print. Every manager's output is
// parsed defensively: lines that are not what a row looks like are skipped,
// and a listing that failed becomes a notice instead of an empty list.

const LINUX_MANAGERS: readonly PackageManager[] = ["apt", "dnf", "yum", "zypper", "apk", "pacman"];

// Windows Update's "Security Updates" classification (its name follows the
// system's language).
const SECURITY_CLASSIFICATION = "0fa1201d-4330-4fa8-8ae9-b877473b6441";

const SEVERITY_ORDER = ["critical", "important", "high", "moderate", "medium", "low"];

type Listing = { lines: string[]; rc: number | null };

// A section that ends with the "@@rc <code>" line the scan adds.
function listing(raw: string | undefined): Listing {
    const lines = (raw ?? "").split("\n");
    let rc: number | null = null;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const match = /^@@rc (\d+)$/.exec(lines[index].trim());
        if (match) {
            rc = Number(match[1]);
            lines.splice(index, 1);
            break;
        }
    }
    return { lines: lines.map((line) => line.replace(/\r$/, "")), rc };
}

// The manager's own complaint, for a notice (its error lines, else its last lines).
function complaint(lines: string[]): string {
    const errors = lines.filter((line) => /^(E:|Error|error:|ERROR|Problem|Repository|Cannot|Failed|Fatal)/.test(line.trim()));
    return (errors.length ? errors : lines.filter((line) => line.trim()).slice(-3)).join("\n").trim().slice(0, 500);
}

function epochMs(raw: string | undefined): number | null {
    const value = (raw ?? "").trim().split("\n").pop()?.trim() ?? "";
    if (!/^\d{9,11}$/.test(value)) return null;
    return Number(value) * 1000;
}

function privilegeOf(uid: string | undefined, sudo: string | undefined): PatchPrivilege {
    if ((uid ?? "").trim() === "0") return "root";
    const answer = (sudo ?? "").trim();
    if (answer === "yes") return "sudo";
    return answer === "password" ? "sudo-password" : "none";
}

function strongerSeverity(a: string | null, b: string | null): string | null {
    if (!a) return b;
    if (!b) return a;
    const rank = (value: string) => {
        const index = SEVERITY_ORDER.indexOf(value.toLowerCase());
        return index === -1 ? SEVERITY_ORDER.length : index;
    };
    return rank(b) < rank(a) ? b : a;
}

// --- apt ---

// `Inst <name> [<installed>] (<candidate> <origin>/<archive>[, ...] [<arch>])`;
// a new package has no [installed]. Whatever follows the parenthesis (apt's
// notes on dependency loops) is ignored.
const APT_INST = /^Inst (\S+)(?: \[([^\]]*)\])? \((\S+)(?: ([^)]*))?\)/;

export function parseAptSimulation(lines: string[]): { updates: PendingUpdate[]; held: HeldUpdate[] } {
    const updates: PendingUpdate[] = [];
    const held: HeldUpdate[] = [];
    let block: HeldUpdate["reason"] | null = null;
    for (const line of lines) {
        if (/^The following packages have been kept back:/.test(line)) {
            block = "kept-back";
            continue;
        }
        if (/^The following upgrades have been deferred due to phasing:/.test(line)) {
            block = "phased";
            continue;
        }
        if (block && /^\s+\S/.test(line)) {
            for (const name of line.trim().split(/\s+/)) held.push({ name, reason: block });
            continue;
        }
        block = null;
        const match = APT_INST.exec(line);
        if (!match) continue;
        const [, name, current, available, rest = ""] = match;
        const arch = /\[([^\]\s]+)\]\s*$/.exec(rest)?.[1] ?? null;
        const origins = rest.replace(/\s*\[[^\]]*\]\s*$/, "").split(/,\s*/).map((origin) => origin.trim()).filter(Boolean);
        const archives = origins.map((origin) => origin.includes("/") ? origin.slice(origin.indexOf("/") + 1) : origin);
        updates.push({
            name,
            arch,
            current: current ?? null,
            available,
            repository: archives.length ? [...new Set(archives)].join(", ") : null,
            security: origins.some((origin) => /-security\b|^[^:]*Security:/i.test(origin)),
            severity: null
        });
    }
    return { updates, held };
}

// The upgradable packages with a newer version than the installed one in a
// security archive, whatever their candidate ("<name> <version> <archive>",
// scripts.ts APT_SECURITY_VERSIONS_FUNCTION).
export function parseAptSecurityVersions(raw: string | undefined): Map<string, { version: string; archive: string | null }> {
    const found = new Map<string, { version: string; archive: string | null }>();
    for (const line of (raw ?? "").split("\n")) {
        const [name, version, archive] = line.trim().split(/\s+/);
        if (name && version && !found.has(name)) found.set(name, { version, archive: archive || null });
    }
    return found;
}

// An update is a security update when its candidate comes from a security
// archive, or when a security archive has a newer version than the installed
// one that the candidate supersedes (a point release that ships the fix
// again): installing the candidate installs the fix.
export function withAptSecurity(updates: PendingUpdate[], fixes: ReadonlyMap<string, { archive: string | null }>): PendingUpdate[] {
    return updates.map((update) => {
        const fix = fixes.get(update.name);
        if (!fix || update.security) return update;
        const archives = [...new Set([...(update.repository ?? "").split(", ").filter(Boolean), ...(fix.archive ? [fix.archive] : [])])];
        return { ...update, security: true, repository: archives.length ? archives.join(", ") : null };
    });
}

// --- dnf / yum ---

// "name-[epoch:]version-release.arch" -> "name.arch".
export function nevraKey(nevra: string): string | null {
    const dot = nevra.lastIndexOf(".");
    if (dot <= 0) return null;
    const arch = nevra.slice(dot + 1);
    const parts = nevra.slice(0, dot).split("-");
    if (parts.length < 3 || !/^[\w]+$/.test(arch)) return null;
    return `${parts.slice(0, -2).join("-")}.${arch}`;
}

const RPM_VERSION = /^[\w.:~^+-]*\d[\w.:~^+-]*$/;

// `check-update` rows: "name.arch  version  repository". A long name pushes
// the rest of its row to the next line; "Obsoleting Packages" ends the list.
export function parseCheckUpdate(lines: string[]): Array<{ key: string; version: string; repository: string }> {
    const rows: Array<{ key: string; version: string; repository: string }> = [];
    let pending: string[] = [];
    for (const line of lines) {
        if (/^Obsoleting Packages/i.test(line.trim())) break;
        const tokens = line.trim().split(/\s+/).filter(Boolean);
        if (!tokens.length) {
            pending = [];
            continue;
        }
        const candidate = pending.length && tokens.length === 2 ? [...pending, ...tokens] : tokens;
        if (candidate.length === 3 && candidate[0].includes(".") && RPM_VERSION.test(candidate[1])) {
            rows.push({ key: candidate[0], version: candidate[1], repository: candidate[2] });
            pending = [];
        } else {
            pending = tokens.length === 1 && tokens[0].includes(".") ? tokens : [];
        }
    }
    return rows;
}

// `updateinfo list --security` (dnf 4 and yum: "ADVISORY Severity/Sec. NEVRA";
// dnf 5: a table with the NEVRA and the severity in their own columns).
export function parseSecurityAdvisories(lines: string[]): Map<string, string | null> {
    const found = new Map<string, string | null>();
    for (const line of lines) {
        const tokens = line.trim().split(/\s+/);
        if (tokens.length < 3) continue;
        const nevra = tokens.find((token, index) => index > 0 && /^[\w+.-]+-(\d+:)?[\w.+~^]+-[\w.+~^]+\.\w+$/.test(token) && nevraKey(token));
        if (!nevra) continue;
        const key = nevraKey(nevra)!;
        const severity = tokens.map((token) => /^(Critical|Important|Moderate|Low|High|Medium)\b/i.exec(token)?.[1] ?? null).find(Boolean) ?? null;
        found.set(key, strongerSeverity(found.get(key) ?? null, severity ? severity[0].toUpperCase() + severity.slice(1).toLowerCase() : null));
    }
    return found;
}

function parseRpmInstalled(raw: string | undefined): Map<string, string> {
    const installed = new Map<string, string>();
    for (const line of (raw ?? "").split("\n")) {
        const [key, version] = line.trim().split(/\s+/);
        if (key && version) installed.set(key, version);
    }
    return installed;
}

function splitKey(key: string): { name: string; arch: string | null } {
    const dot = key.lastIndexOf(".");
    return dot > 0 ? { name: key.slice(0, dot), arch: key.slice(dot + 1) } : { name: key, arch: null };
}

// --- zypper ---

// zypper's tables: a header row naming the columns, a ruler, then rows.
function parseTable(lines: string[]): Array<Record<string, string>> {
    const rows: Array<Record<string, string>> = [];
    let header: string[] | null = null;
    for (const line of lines) {
        if (!line.includes("|")) continue;
        const cells = line.split("|").map((cell) => cell.trim());
        if (!header) {
            if (cells.some((cell) => /^name$/i.test(cell))) header = cells.map((cell) => cell.toLowerCase());
            continue;
        }
        if (cells.every((cell) => /^[-+]*$/.test(cell))) continue;
        rows.push(Object.fromEntries(header.map((name, index) => [name, cells[index] ?? ""])));
    }
    return rows;
}

export function parseZypperUpdates(lines: string[]): PendingUpdate[] {
    return parseTable(lines).filter((row) => row.name).map((row) => ({
        name: row.name,
        arch: row.arch || null,
        current: row["current version"] || null,
        available: row["available version"] || "",
        repository: row.repository || null,
        security: null,
        severity: null
    }));
}

export function parseZypperPatches(lines: string[]): PatchAdvisory[] {
    return parseTable(lines)
        .filter((row) => row.name && (!row.status || /needed|applicable/i.test(row.status)))
        .map((row) => ({
            name: row.name,
            category: row.category || "security",
            severity: row.severity && row.severity !== "-" ? row.severity : null,
            repository: row.repository || null,
            summary: row.summary ?? ""
        }));
}

// --- apk / pacman ---

// "busybox-1.36.1-r31" -> name and version (apk versions end in -r<N>).
function splitApkPackage(text: string): { name: string; version: string } | null {
    const match = /^(.+)-([^-]+-r\d+)$/.exec(text);
    return match ? { name: match[1], version: match[2] } : null;
}

// `apk list -u` ("<new> <arch> {<origin>} (<license>) [upgradable from: <old>]")
// or, on older apk, `apk version -l '<'` ("<old>  < <new version>").
export function parseApk(lines: string[]): PendingUpdate[] {
    const updates: PendingUpdate[] = [];
    for (const line of lines) {
        const listed = /^(\S+) (\S+) \{[^}]*\} \(.*\) \[upgradable from: (\S+)\]$/.exec(line.trim());
        if (listed) {
            const next = splitApkPackage(listed[1]);
            const now = splitApkPackage(listed[3]);
            if (next) updates.push({ name: next.name, arch: listed[2], current: now?.version ?? null, available: next.version, repository: null, security: null, severity: null });
            continue;
        }
        const versioned = /^(\S+)\s+<\s+(\S+)$/.exec(line.trim());
        if (versioned) {
            const now = splitApkPackage(versioned[1]);
            if (now) updates.push({ name: now.name, arch: null, current: now.version, available: versioned[2], repository: null, security: null, severity: null });
        }
    }
    return updates;
}

// `pacman -Qu`: "name old -> new", with " [ignored]" for a package pacman skips.
export function parsePacman(lines: string[]): { updates: PendingUpdate[]; held: HeldUpdate[] } {
    const updates: PendingUpdate[] = [];
    const held: HeldUpdate[] = [];
    for (const line of lines) {
        const match = /^(\S+) (\S+) -> (\S+)( \[ignored\])?$/.exec(line.trim());
        if (!match) continue;
        if (match[4]) held.push({ name: match[1], reason: "kept-back" });
        else updates.push({ name: match[1], arch: null, current: match[2], available: match[3], repository: null, security: null, severity: null });
    }
    return { updates, held };
}

// --- reboot details ---

function parseNeedrestart(raw: string | undefined): { kernel: boolean | null; services: string[] } {
    let kernel: boolean | null = null;
    const services: string[] = [];
    for (const line of (raw ?? "").split("\n")) {
        const status = /^NEEDRESTART-KSTA:\s*(\d+)/.exec(line);
        if (status) kernel = Number(status[1]) >= 2 ? true : Number(status[1]) === 1 ? false : null;
        const service = /^NEEDRESTART-SVC:\s*(\S+)/.exec(line);
        if (service) services.push(service[1]);
    }
    return { kernel, services };
}

function parseServiceNames(raw: string | undefined): string[] {
    return (raw ?? "").split("\n").map((line) => line.trim()).filter((line) => /^[\w@.:-]+\.service$/.test(line));
}

function lines(raw: string | undefined): string[] {
    return (raw ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
}

function bound(scan: Omit<PatchScan, "total">): PatchScan {
    const total = scan.updates.length;
    if (total <= PATCH_LIMITS.maxListed) return { ...scan, total };
    return {
        ...scan,
        total,
        updates: scan.updates.slice(0, PATCH_LIMITS.maxListed),
        notices: [...scan.notices, { code: "truncated", detail: String(total) }]
    };
}

export type ScanTiming = { serverId: number; scannedAt: number; durationMs: number };

export function parseLinuxScan(output: string, timing: ScanTiming): PatchScan {
    const sections = parseSections(output);
    if (!sections.has("end")) throw new Error("The update check was cut off before it finished.");
    const name = (sections.get("manager") ?? "").trim();
    const manager: PatchManager | null = LINUX_MANAGERS.includes(name as PackageManager) ? name as PackageManager : null;
    const notices: PatchNotice[] = [];
    const busy = lines(sections.get("busy"));
    if (busy.length) notices.push({ code: "manager-busy", detail: busy.join(", ") });
    const metadataAt = epochMs(sections.get("metadata"));
    if (manager && metadataAt === null) notices.push({ code: "metadata-missing" });

    let updates: PendingUpdate[] = [];
    let held: HeldUpdate[] = [];
    let patches: PatchAdvisory[] = [];
    let security: number | null = null;
    const listed = listing(sections.get("updates"));
    const failed = (rc: number | null, ok: readonly number[]) => rc !== null && !ok.includes(rc);

    switch (manager) {
        case "apt": {
            if (failed(listed.rc, [0])) {
                notices.push({ code: "listing-failed", detail: complaint(listed.lines) });
                break;
            }
            ({ updates, held } = parseAptSimulation(listed.lines));
            updates = withAptSecurity(updates, parseAptSecurityVersions(sections.get("aptsecurity")));
            security = updates.filter((update) => update.security).length;
            break;
        }
        case "dnf":
        case "yum": {
            if (failed(listed.rc, [0, 100])) {
                if (metadataAt !== null) notices.push({ code: "listing-failed", detail: complaint(listed.lines) });
                break;
            }
            const advisories = listing(sections.get("security"));
            const securityKnown = !failed(advisories.rc, [0]);
            const fixes = securityKnown ? parseSecurityAdvisories(advisories.lines) : new Map<string, string | null>();
            const installed = parseRpmInstalled(sections.get("installed"));
            updates = parseCheckUpdate(listed.lines).map((row) => {
                const { name: packageName, arch } = splitKey(row.key);
                return {
                    name: packageName,
                    arch,
                    current: installed.get(row.key) ?? null,
                    available: row.version,
                    repository: row.repository,
                    security: securityKnown ? fixes.has(row.key) : null,
                    severity: fixes.get(row.key) ?? null
                };
            });
            if (securityKnown) security = updates.filter((update) => update.security).length;
            else notices.push({ code: "security-unknown", detail: complaint(advisories.lines) });
            break;
        }
        case "zypper": {
            if (failed(listed.rc, [0])) {
                if (metadataAt !== null) notices.push({ code: "listing-failed", detail: complaint(listed.lines) });
                break;
            }
            updates = parseZypperUpdates(listed.lines);
            const advisories = listing(sections.get("security"));
            // list-patches exits 100/101 when patches (security ones) are needed.
            if (failed(advisories.rc, [0, 100, 101])) {
                notices.push({ code: "security-unknown", detail: complaint(advisories.lines) });
            } else {
                patches = parseZypperPatches(advisories.lines);
                security = patches.length;
            }
            break;
        }
        case "apk": {
            if (failed(listed.rc, [0])) {
                if (metadataAt !== null) notices.push({ code: "listing-failed", detail: complaint(listed.lines) });
                break;
            }
            updates = parseApk(listed.lines);
            break;
        }
        case "pacman": {
            // pacman -Qu exits 1 when nothing is pending.
            if (failed(listed.rc, [0, 1])) {
                notices.push({ code: "listing-failed", detail: complaint(listed.lines) });
                break;
            }
            ({ updates, held } = parsePacman(listed.lines));
            break;
        }
        default:
            break;
    }

    const needrestart = parseNeedrestart(sections.get("needrestart"));
    let rebootRequired = parseRebootLine(sections.get("reboot"));
    if (needrestart.kernel === true) rebootRequired = true;
    else if (rebootRequired === null && needrestart.kernel === false) rebootRequired = false;

    return bound({
        serverId: timing.serverId,
        platform: "linux",
        manager,
        privilege: privilegeOf(sections.get("uid"), sections.get("sudo")),
        updates,
        security,
        held,
        patches,
        rebootRequired,
        rebootPackages: lines(sections.get("rebootpkgs")),
        restartServices: [...new Set([...needrestart.services, ...parseServiceNames(sections.get("restarting"))])],
        lastUpdateAt: epochMs(sections.get("last")),
        metadataAt,
        notices,
        scannedAt: timing.scannedAt,
        durationMs: timing.durationMs
    });
}

function isoMs(value: unknown): number | null {
    const text = asString(value);
    if (!text) return null;
    const ms = Date.parse(text);
    return Number.isFinite(ms) ? ms : null;
}

export function parseWindowsScan(output: string, timing: ScanTiming): PatchScan {
    const report = extractJson(output);
    if (!isRecord(report)) throw new Error("The Windows Update check returned no data.");
    const notices: PatchNotice[] = [];
    const error = asString(report.error).trim();
    // E_ACCESSDENIED (0x80070005), in the COM error of any language.
    if (error) notices.push({ code: report.admin !== true && /80070005/.test(error) ? "search-denied" : "search-failed", detail: error.slice(0, 500) });
    const updates: PendingUpdate[] = ensureArray(report.updates).filter(isRecord).map((entry) => {
        const classes = ensureArray(entry.classes).filter(isRecord);
        const kb = ensureArray(entry.kb).map(asString).filter((id) => /^\d+$/.test(id));
        const severity = asString(entry.severity).trim();
        return {
            name: asString(entry.title).trim() || "Windows update",
            arch: null,
            current: null,
            available: kb.length ? kb.map((id) => `KB${id}`).join(", ") : "—",
            repository: classes.map((item) => asString(item.name)).filter(Boolean).join(", ") || null,
            security: classes.some((item) => asString(item.id).toLowerCase() === SECURITY_CLASSIFICATION),
            severity: severity || null
        };
    });
    return bound({
        serverId: timing.serverId,
        platform: "windows",
        manager: "windows-update",
        privilege: report.admin === true ? "admin" : "user",
        updates,
        security: error && !updates.length ? null : updates.filter((update) => update.security).length,
        held: [],
        patches: [],
        rebootRequired: typeof report.reboot === "boolean" ? report.reboot : null,
        rebootPackages: [],
        restartServices: [],
        lastUpdateAt: isoMs(report.lastInstall),
        metadataAt: isoMs(report.lastSearch),
        notices,
        scannedAt: timing.scannedAt,
        durationMs: timing.durationMs
    });
}
