import {
    canApply,
    canInstall,
    canTellSecurity,
    isPatchServerType,
    PATCH_LIMITS,
    PATCH_MODES,
    pendingFor,
    type PatchCommandPlan,
    type PatchMode,
    type PatchOptions,
    type PatchPreview,
    type PatchPreviewServer,
    type PatchRebootPlan,
    type PatchSkipReason
} from "../../shared/patch";
import type { ServerSummary } from "../../shared/types";
import { serversRepo } from "../db/serversRepo";
import { AppError } from "../errors";
import { cachedScan } from "./scan";
import { buildApplyScript, planCommands } from "./scripts";

// What a patch run would do, server by server, from the latest scans: a run
// only starts on servers that were read, can install (root or passwordless
// sudo), have a manager ShellMind patches with and have something to do.

export function invalid(message: string, field: string): AppError {
    return new AppError("INVALID_PATCH", message, 400, { field });
}

export function parseServerIds(value: unknown): number[] {
    if (!Array.isArray(value) || value.length === 0) throw invalid("serverIds must list at least one server", "serverIds");
    const ids = [...new Set(value as unknown[])];
    if (ids.length > PATCH_LIMITS.maxServers) throw invalid(`at most ${PATCH_LIMITS.maxServers} servers at once`, "serverIds");
    if (!ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id > 0)) throw invalid("serverIds must be positive integers", "serverIds");
    return ids as number[];
}

export function parseOptions(body: Record<string, unknown>): PatchOptions {
    const mode = body.mode;
    if (typeof mode !== "string" || !(PATCH_MODES as readonly string[]).includes(mode)) throw invalid(`mode must be one of: ${PATCH_MODES.join(", ")}`, "mode");
    for (const field of ["refresh", "reboot"] as const) {
        if (body[field] !== undefined && typeof body[field] !== "boolean") throw invalid(`${field} must be true or false`, field);
    }
    const refreshOnly = mode === "refresh";
    return { mode: mode as PatchMode, refresh: refreshOnly || body.refresh === true, reboot: !refreshOnly && body.reboot === true };
}

export function parseSeconds(value: unknown, field: string, min: number, max: number, fallback: number): number {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw invalid(`${field} must be a whole number of seconds from ${min} to ${max}`, field);
    return value;
}

// Saved servers reached through each server (it is their jump host).
export function jumpDependents(servers: readonly ServerSummary[]): Map<number, number[]> {
    const dependents = new Map<number, number[]>();
    for (const server of servers) {
        if (!server.jump_server_id) continue;
        dependents.set(server.jump_server_id, [...(dependents.get(server.jump_server_id) ?? []), server.id]);
    }
    return dependents;
}

function skipFor(server: ServerSummary, options: PatchOptions, busy: ReadonlySet<number>): { skip: PatchSkipReason | null; row: Partial<PatchPreviewServer> } {
    if (!isPatchServerType(server.type)) return { skip: "unsupported", row: {} };
    const { scan, error } = cachedScan(server);
    if (!scan) return { skip: error ? "scan-failed" : "not-scanned", row: {} };
    // Nothing is installed by a refresh, and a manager without security
    // information has no security updates to count.
    const pending = scan.manager === null || options.mode === "refresh" || (options.mode === "security" && !canTellSecurity(scan.manager)) ? null : pendingFor(scan, options.mode);
    const row: Partial<PatchPreviewServer> = {
        manager: scan.manager,
        privilege: scan.privilege,
        pending,
        security: scan.security,
        rebootRequired: scan.rebootRequired,
        scannedAt: scan.scannedAt,
        metadataAt: scan.metadataAt
    };
    if (busy.has(server.id)) return { skip: "busy", row };
    if (scan.platform === "windows") return { skip: "windows", row };
    if (!canApply(scan.manager)) return { skip: "no-manager", row };
    if (!canInstall(scan.privilege)) return { skip: scan.privilege === "sudo-password" ? "sudo-password" : "privilege", row };
    if (options.mode === "security" && !canTellSecurity(scan.manager)) return { skip: "no-security", row };
    // Nothing to install and nothing to reboot (unless the lists are
    // refreshed first: the refresh may bring updates).
    const rebootPending = options.reboot && scan.rebootRequired === true;
    if (options.mode !== "refresh" && !options.refresh && !pending && !rebootPending) return { skip: "up-to-date", row };
    return { skip: null, row };
}

export type PlannedRun = PatchPreview & { eligibleServers: PatchPreviewServer[] };

// The preview of a run (and what a run starts from: it plans again on start).
export async function planRun(ids: number[], options: PatchOptions, busy: ReadonlySet<number> = new Set()): Promise<PlannedRun> {
    const all = await serversRepo.listSummaries();
    const byId = new Map(all.map((server) => [server.id, server]));
    const dependents = jumpDependents(all);
    const servers: PatchPreviewServer[] = ids.map((id) => {
        const server = byId.get(id);
        const base: PatchPreviewServer = {
            serverId: id,
            name: server?.name ?? `#${id}`,
            host: server?.ip ?? "",
            type: server?.type ?? "linux",
            manager: null,
            privilege: null,
            skip: "not-found",
            pending: null,
            security: null,
            rebootRequired: null,
            reboot: "off",
            jumpHostFor: dependents.get(id) ?? [],
            scannedAt: null,
            metadataAt: null
        };
        if (!server) return base;
        const { skip, row } = skipFor(server, options, busy);
        const reboot: PatchRebootPlan = !options.reboot ? "off" : base.jumpHostFor.length ? "jump-host" : "if-required";
        return { ...base, ...row, skip, reboot };
    });
    const eligibleServers = servers.filter((server) => server.skip === null);
    const managers = [...new Set(eligibleServers.map((server) => server.manager).filter((manager) => canApply(manager)))];
    const plans = planCommands(options);
    const commands: PatchCommandPlan[] = managers.map((manager) => ({ manager: manager!, commands: plans[manager as keyof typeof plans] }));
    return {
        options,
        servers,
        eligible: eligibleServers.length,
        totals: {
            pending: eligibleServers.reduce((sum, server) => sum + (server.pending ?? 0), 0),
            security: eligibleServers.reduce((sum, server) => sum + (server.security ?? 0), 0)
        },
        rebootable: eligibleServers.filter((server) => server.reboot === "if-required").length,
        commands,
        script: buildApplyScript(options),
        eligibleServers
    };
}

export function toPreview(plan: PlannedRun): PatchPreview {
    const { eligibleServers: _eligible, ...preview } = plan;
    return preview;
}

