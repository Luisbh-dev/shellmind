import { CLEANUP_IDS, isCleanupId, resolveCleanupParams, type CleanupId, type CleanupParams, type CleanupPreview, type DiskActionResult, type DiskMount, type MountDelta } from "../../../shared/disk";
import { AppError } from "../../errors";
import { performAction, type PreparedAction } from "../../ops/actions";
import { clearDiskScans } from "../cache";
import { listMounts } from "../mounts";
import { InvalidDiskInputError } from "../usage";
import { dockerCleanups } from "./docker";
import { linuxFileCleanups } from "./linux";
import type { CleanupContext, CleanupProvider } from "./types";
import { windowsCleanups } from "./windows";

// Every cleanup the toolkit offers, by platform, and the run of one: its
// fresh preview (a cleanup that is unavailable or has nothing to remove is
// refused), the audited command, and the free space of the filesystems it
// acts on before and after (the space freed, whatever the tool reports).

function providers(ctx: Pick<CleanupContext, "caps">): CleanupProvider[] {
    return ctx.caps.platform === "windows" ? [windowsCleanups] : [linuxFileCleanups, dockerCleanups];
}

function providerOf(ctx: CleanupContext, id: CleanupId): CleanupProvider {
    const provider = providers(ctx).find((entry) => entry.ids.includes(id));
    if (!provider) throw new AppError("OPS_UNSUPPORTED", `The ${id} cleanup is not available on ${ctx.caps.platform === "windows" ? "Windows" : "Linux"} servers.`, 409);
    return provider;
}

export function requireCleanup(value: string): CleanupId {
    if (!isCleanupId(value)) throw new InvalidDiskInputError(`"${value.slice(0, 40)}" is not a cleanup. Known: ${CLEANUP_IDS.join(", ")}.`);
    return value;
}

export function requireParams(id: CleanupId, input: Record<string, unknown>): CleanupParams {
    const params = resolveCleanupParams(id, input);
    if (!params) throw new InvalidDiskInputError(`Those are not parameters the ${id} cleanup takes.`);
    return params;
}

export async function cleanupOverview(ctx: CleanupContext): Promise<CleanupPreview[]> {
    const groups = await Promise.all(providers(ctx).map((provider) => provider.overview(ctx)));
    return groups.flat();
}

export function previewCleanup(ctx: CleanupContext, id: CleanupId, params: CleanupParams): Promise<CleanupPreview> {
    return providerOf(ctx, id).preview(ctx, id, params);
}

// The free space of `mounts` before and after, and the change summed over
// those that could be read both times (null: none could).
export function mountDeltas(mounts: string[], before: DiskMount[], after: DiskMount[]): { deltas: MountDelta[]; freed: number | null } {
    const deltas = mounts.flatMap((mount): MountDelta[] => {
        const was = before.find((entry) => entry.mount === mount);
        const now = after.find((entry) => entry.mount === mount);
        return was && now ? [{ mount, freeBefore: was.freeBytes, freeAfter: now.freeBytes }] : [];
    });
    return { deltas, freed: deltas.length ? deltas.reduce((sum, delta) => sum + delta.freeAfter - delta.freeBefore, 0) : null };
}

// Runs `action` on `mounts` with their free space measured right before and
// after it; the server's cached scans are dropped (its disks changed). Once
// started, the action is not tied to the request (`ctx.signal`): a closed
// window or a dropped connection to the app must not kill a cleanup halfway
// (Windows Update stopped, DISM interrupted); each run has its own timeout.
export async function runMeasured(ctx: CleanupContext, action: PreparedAction, mounts: string[], reported?: (output: string) => number | null): Promise<DiskActionResult> {
    const before = mounts.length ? await listMounts(ctx.lease, ctx.caps, ctx.signal).catch(() => ctx.mounts) : ctx.mounts;
    ctx.signal?.throwIfAborted();
    try {
        const result = await performAction(ctx.lease, action);
        const after = await listMounts(ctx.lease, ctx.caps).catch(() => [] as DiskMount[]);
        const { deltas, freed } = mountDeltas(mounts, before, after);
        return { ...result, freedBytes: freed, reportedBytes: reported?.(result.output) ?? null, mounts: deltas };
    } finally {
        clearDiskScans(ctx.lease.serverId);
    }
}

export async function runCleanup(ctx: CleanupContext, id: CleanupId, params: CleanupParams): Promise<DiskActionResult> {
    const prepared = await providerOf(ctx, id).prepare(ctx, id, params);
    const { preview } = prepared;
    if (preview.status === "unavailable") {
        const status = preview.reason?.code === "NOT_ELEVATED" ? 403 : 409;
        throw new AppError(status === 403 ? "OPS_PERMISSION_DENIED" : "OPS_UNSUPPORTED", preview.reason?.message ?? "This cleanup cannot run on this server.", status);
    }
    if (preview.status === "nothing") throw new AppError("DISK_NOTHING_TO_CLEAN", "There is nothing to clean up right now.", 409);
    return runMeasured(ctx, prepared.action, preview.mounts, prepared.reported);
}
