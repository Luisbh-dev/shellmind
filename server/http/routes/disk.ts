import { Router, type Request, type Response } from "express";
import type { CleanupOverview, CleanupPreview, DeletedOpenResult, DirectoryListing, DiskActionResult, DiskOverview, LargeFilesResult } from "../../../shared/disk";
import type { OpsCapabilities } from "../../../shared/ops";
import { loadConnectionTarget } from "../../connections/target";
import { cleanupOverview, previewCleanup, requireCleanup, requireParams, runCleanup, runMeasured } from "../../disk/cleanups";
import { findDeletedOpenFiles, parseReleaseInput, prepareRelease } from "../../disk/deleted";
import { findLargeFiles, requireThreshold } from "../../disk/largeFiles";
import { listMounts, requireMount } from "../../disk/mounts";
import { diskAccess } from "../../disk/remote";
import { requireBudget, requirePath, scanDirectory } from "../../disk/usage";
import { getCapabilities } from "../../ops/capabilities";
import { sshPool, type SshLease } from "../../ssh/pool";
import { abortOnClose, sendRemoteError } from "../remote";
import { jsonBody, routeId, sendError, serverNotFound } from "../respond";

// W8-T4 disk-full toolkit of a Linux/Windows server: its filesystems, the
// directory usage explorer, the largest files, deleted files still held
// open, and the cleanups (previewed, then run). Requests name a path, a
// mount, a cleanup and its parameters, or a process: the commands are built
// server-side (server/disk) from validated values, quoted, and run on the
// server's pooled SSH connection; everything that changes the server is
// recorded in the audit log (source "ops").

type DiskRequestContext = {
    lease: SshLease;
    caps: OpsCapabilities;
    user: string;
    signal: AbortSignal;
};

const UNSUPPORTED = "The disk toolkit is only available for SSH-capable servers.";

const query = (req: Request, name: string): string | undefined => {
    const value = req.query[name];
    return typeof value === "string" ? value : undefined;
};

function handle(context: string, work: (ctx: DiskRequestContext, req: Request) => Promise<unknown>) {
    return async (req: Request, res: Response) => {
        const id = routeId(req.params.id);
        if (id === null) {
            sendError(res, serverNotFound(), context);
            return;
        }
        const request = abortOnClose(res);
        let lease: SshLease | null = null;
        try {
            const target = await loadConnectionTarget(id, "exec");
            lease = await sshPool.acquire(target.serverId);
            // refresh=1: what the server offers (root, sudo, engines) is read again.
            const caps = await getCapabilities(lease, target.os, { signal: request.signal, refresh: query(req, "refresh") === "1" });
            res.json(await work({ lease, caps, user: target.username, signal: request.signal }, req));
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, context, UNSUPPORTED);
        } finally {
            lease?.release();
            request.dispose();
        }
    };
}

export function createDiskRouter(): Router {
    const router = Router();

    router.get("/api/servers/:id/disk", handle("GET disk", async ({ lease, caps, user, signal }): Promise<DiskOverview> => ({
        access: diskAccess(caps, user),
        mounts: await listMounts(lease, caps, signal),
        collectedAt: Date.now()
    })));

    // ?path=<directory>&budget=<seconds>&rescan=1 (rescan: scan again, not from the cache)
    router.get("/api/servers/:id/disk/usage", handle("GET disk/usage", async ({ lease, caps, signal }, req): Promise<DirectoryListing> => {
        const path = requirePath(caps.platform, query(req, "path"));
        const budgetSeconds = requireBudget(query(req, "budget"));
        const mounts = await listMounts(lease, caps, signal);
        return scanDirectory(lease, caps, mounts, { path, budgetSeconds, refresh: query(req, "rescan") === "1" });
    }));

    // ?mount=<mount point>&minMB=<threshold>&rescan=1
    router.get("/api/servers/:id/disk/large-files", handle("GET disk/large-files", async ({ lease, caps, signal }, req): Promise<LargeFilesResult> => {
        const minMB = requireThreshold(query(req, "minMB"));
        const mount = requireMount(await listMounts(lease, caps, signal), query(req, "mount"));
        return findLargeFiles(lease, caps, { mount, minMB, refresh: query(req, "rescan") === "1" });
    }));

    // ?mount=<mount point>
    router.get("/api/servers/:id/disk/deleted", handle("GET disk/deleted", async ({ lease, caps, signal }, req): Promise<DeletedOpenResult> => {
        const mount = requireMount(await listMounts(lease, caps, signal), query(req, "mount"));
        return findDeletedOpenFiles(lease, caps, mount, signal);
    }));

    // Body DeletedReleaseRequest.
    router.post("/api/servers/:id/disk/deleted/release", handle("POST disk/deleted/release", async ({ lease, caps, signal }, req): Promise<DiskActionResult> => {
        const body = jsonBody(req);
        const input = parseReleaseInput(body);
        const mounts = await listMounts(lease, caps, signal);
        const mount = requireMount(mounts, body.mount);
        return runMeasured({ lease, caps, mounts, signal }, prepareRelease(caps, mount, input), [mount.mount]);
    }));

    router.get("/api/servers/:id/disk/cleanups", handle("GET disk/cleanups", async ({ lease, caps, signal }): Promise<CleanupOverview> => {
        const mounts = await listMounts(lease, caps, signal);
        return { cleanups: await cleanupOverview({ lease, caps, mounts, signal }) };
    }));

    // ?days=&keepMB=&keepDays=: the preview of one cleanup with these parameters.
    router.get("/api/servers/:id/disk/cleanups/:cleanup", handle("GET disk/cleanups/:cleanup", async ({ lease, caps, signal }, req): Promise<CleanupPreview> => {
        const id = requireCleanup(String(req.params.cleanup ?? ""));
        const params = requireParams(id, { days: query(req, "days"), keepMB: query(req, "keepMB"), keepDays: query(req, "keepDays") });
        const mounts = await listMounts(lease, caps, signal);
        return previewCleanup({ lease, caps, mounts, signal }, id, params);
    }));

    // Body CleanupParams.
    router.post("/api/servers/:id/disk/cleanups/:cleanup", handle("POST disk/cleanups/:cleanup", async ({ lease, caps, signal }, req): Promise<DiskActionResult> => {
        const id = requireCleanup(String(req.params.cleanup ?? ""));
        const params = requireParams(id, jsonBody(req));
        const mounts = await listMounts(lease, caps, signal);
        return runCleanup({ lease, caps, mounts, signal }, id, params);
    }));

    return router;
}
