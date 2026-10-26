import fs from "fs";
import os from "os";
import path from "path";
import { glob, LineType, parse, type Line } from "ssh-config";
import { effectivePort } from "../../shared/ports";
import type {
    ImportOutcome,
    ImportReport,
    SshConfigApplyEntry,
    SshConfigApplyResult,
    SshConfigEntry,
    SshConfigPreview,
    SshConfigWarning
} from "../../shared/organization";
import type { ServerSummary } from "../../shared/types";
import { identitiesRepo } from "../db/identitiesRepo";
import { serversRepo, normalizeHost } from "../db/serversRepo";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import { auditIdentityLinks, type IdentityLink } from "./configBundle";

// Imports hosts from an OpenSSH client config. Only parse() of the ssh-config
// package is used: its compute() can run `Match exec` commands and nslookup,
// which an import must never do. Options are resolved here instead, the way
// OpenSSH does for a plain alias (first value wins, Match blocks ignored).

const log = createLogger("import");

const MAX_FILE_BYTES = 512 * 1024;
const MAX_INCLUDE_DEPTH = 5;
const MAX_INCLUDED_FILES = 64;
const MAX_ENTRIES = 1000;
const DEFAULT_SSH_PORT = 22;

// Linear on any input (a lazy capture followed by `\s*$` backtracks
// quadratically on long runs of spaces); the capture is trimmed by the caller.
const INCLUDE_LINE = /^\s*include\b\s*=?\s*([\s\S]*)$/i;
const WILDCARD = /[*?]/;

// --- Reading the file ---------------------------------------------------------

export type SshConfigText = { text: string; source: string | null; warnings: SshConfigWarning[] };

// The words of an option value; double quotes group words with spaces.
function words(value: string): string[] {
    return [...value.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2]);
}

function isInside(dir: string, file: string): boolean {
    const relative = path.relative(dir, file);
    return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function readLimited(file: string): string {
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("not a file");
    if (stat.size > MAX_FILE_BYTES) throw new Error("file too large");
    return fs.readFileSync(file, "utf8");
}

// Files an Include pattern names. Relative patterns are relative to ~/.ssh;
// wildcards are only supported in the file name. Only files inside ~/.ssh are
// read: an import shows host names, and nothing else should leak through it.
function includeTargets(pattern: string, sshDir: string, homeDir: string): string[] | null {
    const expanded = pattern.startsWith("~/") ? path.join(homeDir, pattern.slice(2)) : pattern;
    const absolute = path.resolve(sshDir, expanded);
    if (!isInside(sshDir, absolute)) return null;
    const dir = path.dirname(absolute);
    const name = path.basename(absolute);
    if (WILDCARD.test(dir.slice(sshDir.length))) return null;
    if (!WILDCARD.test(name)) return [absolute];
    let names: string[];
    try {
        names = fs.readdirSync(dir);
    } catch {
        return [];
    }
    return names
        .filter((candidate) => !candidate.startsWith(".") && glob(name, candidate))
        .sort()
        .map((candidate) => path.join(dir, candidate));
}

// Inlines the Include files of `text`, like OpenSSH reads them in place.
function inlineIncludes(
    text: string,
    context: { sshDir: string; homeDir: string; depth: number; seen: Set<string>; warnings: SshConfigWarning[] }
): string {
    return text.split(/\r?\n/).map((line) => {
        const match = INCLUDE_LINE.exec(line);
        if (!match) return line;
        const parts: string[] = [];
        for (const pattern of words(match[1].trim())) {
            const targets = context.depth >= MAX_INCLUDE_DEPTH ? null : includeTargets(pattern, context.sshDir, context.homeDir);
            if (targets === null) {
                context.warnings.push({ code: "include-unresolved", detail: pattern });
                continue;
            }
            for (const file of targets) {
                if (context.seen.has(file)) continue;
                if (context.seen.size >= MAX_INCLUDED_FILES) {
                    context.warnings.push({ code: "include-unresolved", detail: pattern });
                    break;
                }
                context.seen.add(file);
                try {
                    parts.push(inlineIncludes(readLimited(file), { ...context, depth: context.depth + 1 }));
                } catch {
                    context.warnings.push({ code: "include-unresolved", detail: pattern });
                }
            }
        }
        return parts.join("\n");
    }).join("\n");
}

// ~/.ssh/config of the user the backend runs as, with its Include files.
export function readUserSshConfig(homeDir = os.homedir()): SshConfigText {
    const sshDir = path.join(homeDir, ".ssh");
    const file = path.join(sshDir, "config");
    let text: string;
    try {
        text = readLimited(file);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        if (code === "ENOENT" || code === "ENOTDIR") {
            throw new AppError("SSH_CONFIG_NOT_FOUND", `There is no SSH config file at ${file}.`, 404, { path: file });
        }
        throw new AppError("SSH_CONFIG_UNREADABLE", `The SSH config file ${file} could not be read: ${errorMessage(err)}`, 422, { path: file });
    }
    const warnings: SshConfigWarning[] = [];
    const inlined = inlineIncludes(text, { sshDir, homeDir, depth: 0, seen: new Set([file]), warnings });
    return { text: inlined, source: file, warnings };
}

// Pasted text: there are no files to include.
export function pastedSshConfig(text: string): SshConfigText {
    if (text.length > MAX_FILE_BYTES) throw new AppError("SSH_CONFIG_TOO_LARGE", "The SSH config text is too large.", 413);
    const warnings: SshConfigWarning[] = [];
    const lines = text.split(/\r?\n/).filter((line) => {
        const match = INCLUDE_LINE.exec(line);
        if (match) warnings.push({ code: "include-in-text", detail: match[1].trim() });
        return !match;
    });
    return { text: lines.join("\n"), source: null, warnings };
}

// --- Resolving hosts ----------------------------------------------------------

type DirectiveLine = Extract<Line, { param: string }>;

function isDirective(line: Line): line is DirectiveLine {
    return line.type === LineType.DIRECTIVE;
}

function valueWords(value: DirectiveLine["value"]): string[] {
    return Array.isArray(value) ? value.map((part) => part.val) : [value];
}

function sectionOf(line: DirectiveLine): Line[] {
    return "config" in line ? line.config : [];
}

// Option name (lower case) -> values, first occurrence first.
function optionsFor(config: Line[], alias: string): Map<string, string[][]> {
    const options = new Map<string, string[][]>();
    const add = (line: Line) => {
        if (!isDirective(line)) return;
        const key = line.param.toLowerCase();
        options.set(key, [...(options.get(key) ?? []), valueWords(line.value)]);
    };
    for (const line of config) {
        if (!isDirective(line)) continue;
        if (/^host$/i.test(line.param)) {
            if (glob(valueWords(line.value), alias)) sectionOf(line).forEach(add);
        } else if (!/^match$/i.test(line.param)) {
            add(line);
        }
    }
    return options;
}

function first(options: Map<string, string[][]>, key: string): string | null {
    const value = options.get(key)?.[0];
    return value && value.length ? value.join(" ") : null;
}

// %-tokens of IdentityFile / HostName that make sense for a saved server.
function expandTokens(
    value: string,
    tokens: Record<string, string>,
    warnings: SshConfigWarning[]
): string {
    return value.replace(/%(.)/g, (whole, token: string) => {
        if (token === "%") return "%";
        if (token in tokens) return tokens[token];
        warnings.push({ code: "unsupported-token", detail: whole });
        return whole;
    });
}

// "user@host:port" or "ssh://user@host:port" -> host.
function jumpHost(hop: string): string {
    const withoutScheme = hop.replace(/^ssh:\/\//i, "");
    const withoutUser = withoutScheme.slice(withoutScheme.lastIndexOf("@") + 1);
    const bracketed = /^\[([^\]]+)\](?::\d+)?$/.exec(withoutUser);
    if (bracketed) return bracketed[1];
    // A bare IPv6 address has several colons and no port.
    return withoutUser.split(":").length === 2 ? withoutUser.replace(/:\d+$/, "") : withoutUser;
}

function aliasesOf(config: Line[]): string[] {
    const aliases: string[] = [];
    for (const line of config) {
        if (!isDirective(line) || !/^host$/i.test(line.param)) continue;
        for (const pattern of valueWords(line.value)) {
            if (!pattern || WILDCARD.test(pattern) || pattern.startsWith("!")) continue;
            if (!aliases.includes(pattern)) aliases.push(pattern);
        }
    }
    return aliases.slice(0, MAX_ENTRIES);
}

function hasMatchBlocks(config: Line[]): boolean {
    return config.some((line) => isDirective(line) && /^match$/i.test(line.param));
}

function localUserName(): string | null {
    try {
        return os.userInfo().username || null;
    } catch {
        return process.env.USER || process.env.USERNAME || null;
    }
}

type SavedServer = Pick<ServerSummary, "id" | "name" | "ip" | "type" | "port" | "ssh_port" | "username">;

const isSshServer = (server: SavedServer) => server.type === "linux" || server.type === "windows";

function sameTarget(server: SavedServer, host: string, port: number | null, user: string | null): boolean {
    return isSshServer(server)
        && normalizeHost(server.ip).toLowerCase() === normalizeHost(host).toLowerCase()
        && effectivePort(server, "terminal") === (port ?? DEFAULT_SSH_PORT)
        && (server.username ?? "") === (user ?? "");
}

// The saved SSH server a jump hop names (by name, else by address).
function savedJump(saved: SavedServer[], hop: string): SavedServer | undefined {
    const ssh = saved.filter(isSshServer);
    return ssh.find((server) => server.name === hop)
        ?? ssh.find((server) => normalizeHost(server.ip).toLowerCase() === hop.toLowerCase());
}

export function resolveSshConfig(
    source: SshConfigText,
    saved: SavedServer[],
    localUser: string | null = localUserName()
): SshConfigPreview {
    const config = parse(source.text);
    const warnings = [...source.warnings];
    if (hasMatchBlocks(config)) warnings.push({ code: "match-ignored" });
    const aliases = aliasesOf(config);

    const entries = aliases.map((alias): SshConfigEntry => {
        const options = optionsFor(config, alias);
        const entryWarnings: SshConfigWarning[] = [];

        const host = expandTokens(first(options, "hostname") ?? alias, { h: alias }, entryWarnings);

        let port: number | null = null;
        const rawPort = first(options, "port");
        if (rawPort !== null) {
            const parsed = Number(rawPort);
            if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 65535) port = parsed === DEFAULT_SSH_PORT ? null : parsed;
            else entryWarnings.push({ code: "invalid-port", detail: rawPort });
        }

        let user = first(options, "user");
        if (user === null && localUser) {
            user = localUser;
            entryWarnings.push({ code: "user-default", detail: localUser });
        }

        const identities = (options.get("identityfile") ?? []).map((value) => value.join(" "));
        if (identities.length > 1) entryWarnings.push({ code: "identity-multiple", detail: identities[0] });
        const identityFile = identities.length
            ? expandTokens(identities[0], { d: "~", h: host, r: user ?? "", u: localUser ?? "" }, entryWarnings)
            : null;
        const identityAgent = first(options, "identityagent");

        let proxyJump: string | null = null;
        let proxyJumpSavedId: number | null = null;
        const rawJump = first(options, "proxyjump");
        if (rawJump && rawJump.toLowerCase() !== "none") {
            const hops = rawJump.split(",").map((hop) => hop.trim()).filter(Boolean);
            if (hops.length > 1) entryWarnings.push({ code: "proxy-jump-chain", detail: rawJump });
            const hop = jumpHost(hops[hops.length - 1] ?? "");
            if (hop && hop !== alias) {
                proxyJump = hop;
                if (!aliases.includes(hop)) {
                    const jump = savedJump(saved, hop);
                    if (jump) proxyJumpSavedId = jump.id;
                    else entryWarnings.push({ code: "proxy-jump-unknown", detail: hop });
                }
            }
        }
        if (first(options, "proxycommand")) entryWarnings.push({ code: "proxy-command" });

        const duplicate = saved.find((server) => sameTarget(server, host, port, user));
        return {
            alias,
            host,
            port,
            user,
            identityFile,
            proxyJump,
            proxyJumpSavedId,
            duplicateOf: duplicate ? { id: duplicate.id, name: duplicate.name } : null,
            warnings: entryWarnings,
            identityAgent: identityAgent !== null && identityAgent.toLowerCase() !== "none"
        };
    });

    // A jump alias of this file that is already saved is not imported again
    // (the wizard does not offer it): its hosts jump through the saved copy,
    // found by address, never by a name another server may share.
    const byAlias = new Map(entries.map((entry) => [entry.alias, entry]));
    for (const entry of entries) {
        const jump = entry.proxyJump === null ? undefined : byAlias.get(entry.proxyJump);
        if (jump?.duplicateOf) entry.proxyJumpSavedId = jump.duplicateOf.id;
    }

    return { source: source.source, entries, warnings };
}

// --- Creating the servers -----------------------------------------------------
//
// W7-S2: a host's IdentityFile and IdentityAgent become its identity (shared
// by every host with the same ones) instead of its own key file, so the key
// is changed in one place. Identities saved before are reused only when they
// hold nothing but that key file: a pasted config never gets a saved password.

function optionalText(value: unknown, field: string, max: number): string | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw new AppError("INVALID_IMPORT", `${field} must be a string`, 400);
    const trimmed = value.trim();
    if (trimmed.length > max) throw new AppError("INVALID_IMPORT", `${field} is too long`, 400);
    return trimmed || null;
}

function parseApplyEntries(body: Record<string, unknown>): SshConfigApplyEntry[] {
    const raw = body.entries;
    if (!Array.isArray(raw) || raw.length === 0) throw new AppError("INVALID_IMPORT", "entries must be a non-empty array", 400);
    if (raw.length > MAX_ENTRIES) throw new AppError("INVALID_IMPORT", `at most ${MAX_ENTRIES} entries can be imported at once`, 400);
    return raw.map((item, index): SshConfigApplyEntry => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new AppError("INVALID_IMPORT", `entries[${index}] must be an object`, 400);
        }
        const entry = item as Record<string, unknown>;
        const alias = optionalText(entry.alias, "alias", 255);
        const host = optionalText(entry.host, "host", 255);
        if (!alias || !host) throw new AppError("INVALID_IMPORT", `entries[${index}] needs an alias and a host`, 400);
        const port = entry.port;
        if (port !== undefined && port !== null && (typeof port !== "number" || !Number.isInteger(port))) {
            throw new AppError("INVALID_IMPORT", `entries[${index}].port must be an integer`, 400);
        }
        const savedId = entry.proxyJumpSavedId;
        if (savedId !== undefined && savedId !== null && (typeof savedId !== "number" || !Number.isSafeInteger(savedId) || savedId < 1)) {
            throw new AppError("INVALID_IMPORT", `entries[${index}].proxyJumpSavedId must be a server id`, 400);
        }
        if (entry.identityAgent !== undefined && entry.identityAgent !== null && typeof entry.identityAgent !== "boolean") {
            throw new AppError("INVALID_IMPORT", `entries[${index}].identityAgent must be a boolean`, 400);
        }
        return {
            alias,
            name: optionalText(entry.name, "name", 200) ?? alias,
            host,
            port: typeof port === "number" ? port : null,
            user: optionalText(entry.user, "user", 255),
            identityFile: optionalText(entry.identityFile, "identityFile", 1024),
            proxyJump: optionalText(entry.proxyJump, "proxyJump", 255),
            ...(savedId === undefined ? {} : { proxyJumpSavedId: savedId as number | null }),
            identityAgent: entry.identityAgent === true
        };
    });
}

// W7-S2: the identity of hosts that share a key file and agent use: one saved
// before that holds nothing else (identitiesRepo.findKeyFileOnly), else a new
// one named after the key file. Created once per import, then shared.
type ResolvedIdentity = { id: number; name: string; saved: boolean };

function identityResolver(report: ImportReport) {
    const resolved = new Map<string, ResolvedIdentity>();
    return async (keyFile: string | null, useAgent: boolean): Promise<ResolvedIdentity | null> => {
        if (!keyFile && !useAgent) return null;
        const key = JSON.stringify([keyFile, useAgent]);
        const known = resolved.get(key);
        if (known) return known;
        const reusable = await identitiesRepo.findKeyFileOnly(keyFile, useAgent);
        let identity: ResolvedIdentity;
        if (reusable) {
            identity = { ...reusable, saved: true };
            report.skipped.push({ name: reusable.name, id: reusable.id, reason: "duplicate" });
        } else {
            const fileName = keyFile ? keyFile.split(/[\\/]/).filter(Boolean).pop() ?? keyFile : null;
            const name = await identitiesRepo.freeName([fileName, useAgent ? "ssh-agent" : null].filter(Boolean).join(" + "));
            identity = { id: await identitiesRepo.create({ name, private_key_path: keyFile, use_agent: useAgent }), name, saved: false };
            report.created.push({ name, id: identity.id });
        }
        resolved.set(key, identity);
        return identity;
    };
}

// Jump hosts first: an entry comes after the entry its ProxyJump names.
function jumpHostsFirst(entries: SshConfigApplyEntry[]): { ordered: SshConfigApplyEntry[]; looping: SshConfigApplyEntry[] } {
    const byAlias = new Map(entries.map((entry) => [entry.alias, entry]));
    const ordered: SshConfigApplyEntry[] = [];
    const looping: SshConfigApplyEntry[] = [];
    const state = new Map<string, "visiting" | "done">();
    const visit = (entry: SshConfigApplyEntry): boolean => {
        const current = state.get(entry.alias);
        if (current === "done") return true;
        if (current === "visiting") return false;
        state.set(entry.alias, "visiting");
        const jump = entry.proxyJump ? byAlias.get(entry.proxyJump) : undefined;
        const ok = !jump || visit(jump);
        state.set(entry.alias, "done");
        if (ok) ordered.push(entry);
        else looping.push(entry);
        return ok;
    };
    entries.forEach(visit);
    return { ordered, looping };
}

export async function applySshConfigImport(body: Record<string, unknown>): Promise<SshConfigApplyResult> {
    const entries = parseApplyEntries(body);
    const group = optionalText(body.group_name, "group_name", 128);
    const saved: SavedServer[] = await serversRepo.listSummaries();
    const { ordered, looping } = jumpHostsFirst(entries);

    const created: ImportOutcome[] = [];
    const skipped: ImportOutcome[] = looping.map((entry) => ({ name: entry.name ?? entry.alias, reason: "jump-missing" as const, detail: entry.proxyJump ?? undefined }));
    // alias -> id of the server it became (or the saved duplicate it matched).
    const idByAlias = new Map<string, number>();
    const requested = new Set(entries.map((entry) => entry.alias));
    const identities: ImportReport = { created: [], skipped: [] };
    const identityFor = identityResolver(identities);
    const links: IdentityLink[] = [];

    // The jump host of an entry: an entry of this request (once created), else
    // the saved server the preview resolved, else (callers that did not
    // preview) a saved server with that name or address.
    const jumpFor = (entry: SshConfigApplyEntry, hop: string): number | null => {
        if (requested.has(hop)) return idByAlias.get(hop) ?? null;
        if (entry.proxyJumpSavedId !== undefined) {
            const jump = saved.find((server) => server.id === entry.proxyJumpSavedId);
            return jump && isSshServer(jump) ? jump.id : null;
        }
        return savedJump(saved, hop)?.id ?? null;
    };

    for (const entry of ordered) {
        const name = entry.name ?? entry.alias;
        const port = entry.port === DEFAULT_SSH_PORT ? null : entry.port ?? null;
        const user = entry.user ?? null;

        const duplicate = saved.find((server) => sameTarget(server, entry.host, port, user));
        if (duplicate) {
            idByAlias.set(entry.alias, duplicate.id);
            skipped.push({ name, id: duplicate.id, reason: "duplicate", detail: duplicate.name });
            continue;
        }

        let jumpId: number | null = null;
        if (entry.proxyJump) {
            jumpId = jumpFor(entry, entry.proxyJump);
            if (jumpId === null) {
                skipped.push({ name, reason: "jump-missing", detail: entry.proxyJump });
                continue;
            }
        }

        try {
            const identity = await identityFor(entry.identityFile ?? null, entry.identityAgent === true);
            const id = await serversRepo.create({
                name,
                ip: entry.host,
                type: "linux",
                username: user,
                port,
                identity_id: identity?.id ?? null,
                jump_server_id: jumpId,
                group_name: group
            });
            idByAlias.set(entry.alias, id);
            saved.push({ id, name, ip: entry.host, type: "linux", port, ssh_port: null, username: user });
            created.push({ name, id });
            if (identity) links.push({ serverId: id, identityId: identity.id, identity: identity.name, saved: identity.saved, agentForward: false });
        } catch (err) {
            if (!(err instanceof AppError)) throw err;
            skipped.push({ name, reason: "invalid", detail: err.message });
        }
    }

    // An identity created for hosts that were all refused is not kept.
    for (const outcome of [...identities.created]) {
        if (links.some((link) => link.identityId === outcome.id) || outcome.id === undefined) continue;
        await identitiesRepo.remove(outcome.id);
        identities.created.splice(identities.created.indexOf(outcome), 1);
    }
    await auditIdentityLinks(links);
    log.info(`SSH config import: ${created.length} created, ${skipped.length} skipped, ${identities.created.length} identities created`);
    return { created, skipped, ...(identities.created.length || identities.skipped.length ? { identities } : {}) };
}
