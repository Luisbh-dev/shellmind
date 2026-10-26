import type { CleanupId, CleanupItem, CleanupParams, CleanupPreview, DiskMount } from "../../../shared/disk";
import type { OpsCapabilities } from "../../../shared/ops";
import type { PreparedAction } from "../../ops/actions";
import type { SshLease } from "../../ssh/pool";

// What every cleanup works with: the server's pooled connection, what it
// offers, its local filesystems now, and the request's cancellation.
export type CleanupContext = {
    lease: SshLease;
    caps: OpsCapabilities;
    mounts: DiskMount[];
    signal?: AbortSignal;
};

// A cleanup ready to run: the audited action, and how to read the space the
// tool itself says it freed from its output.
export type PreparedCleanup = {
    preview: CleanupPreview;
    action: PreparedAction;
    reported?: (output: string) => number | null;
};

// A group of cleanups (Linux files, the container engine, Windows): their
// overview in one go, the preview of one with its parameters, and its run.
export type CleanupProvider = {
    ids: readonly CleanupId[];
    overview: (ctx: CleanupContext) => Promise<CleanupPreview[]>;
    preview: (ctx: CleanupContext, id: CleanupId, params: CleanupParams) => Promise<CleanupPreview>;
    prepare: (ctx: CleanupContext, id: CleanupId, params: CleanupParams) => Promise<PreparedCleanup>;
};

export const MAX_ITEMS = 50;

// The largest first, at most MAX_ITEMS.
export function topItems(items: CleanupItem[]): CleanupItem[] {
    return [...items].sort((a, b) => (b.bytes ?? 0) - (a.bytes ?? 0)).slice(0, MAX_ITEMS);
}
