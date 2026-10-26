import { Router, type Request, type Response } from "express";
import type { OpsCapabilities, PruneResult } from "../../../shared/ops";
import { loadConnectionTarget } from "../../connections/target";
import { performAction } from "../../ops/actions";
import { getCapabilities } from "../../ops/capabilities";
import { composeOverview, prepareComposeAction } from "../../ops/compose";
import {
    containerLogs,
    containerStats,
    containerStatsOf,
    inspectContainer,
    listContainers,
    prepareContainerAction,
    summarizeInspect
} from "../../ops/containers";
import { diskUsage, listImages, parsePruneOutput, prepareImageRemoval, preparePrune, prunePreview } from "../../ops/images";
import { InvalidOpsInputError, listServices, prepareServiceAction, readJournal, serviceDetail } from "../../ops/services";
import { sshPool, type SshLease } from "../../ssh/pool";
import { abortOnClose, sendRemoteError } from "../remote";
import { jsonBody, routeId, sendError, serverNotFound } from "../respond";

// Operations panels of a Linux/Windows server: services, containers and
// their logs. Requests name things (a unit, a container, an action); the
// commands are built server-side (server/ops) and run on the server's pooled
// SSH connection. A request the client abandons cancels its command.

type OpsRequestContext = {
    lease: SshLease;
    caps: OpsCapabilities;
    signal: AbortSignal;
};

const UNSUPPORTED = "Operations panels are only available for SSH-capable servers.";

function lineCount(value: unknown): number {
    const lines = typeof value === "string" ? Number.parseInt(value, 10) : NaN;
    return Number.isFinite(lines) ? lines : 200;
}

function handle(context: string, work: (ctx: OpsRequestContext, req: Request) => Promise<unknown>) {
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
            const caps = await getCapabilities(lease, target.os, { signal: request.signal, refresh: req.query.refresh === "1" });
            res.json(await work({ lease, caps, signal: request.signal }, req));
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, context, UNSUPPORTED);
        } finally {
            lease?.release();
            request.dispose();
        }
    };
}

const param = (req: Request, name: string) => String(req.params[name] ?? "");

export function createOpsRouter(): Router {
    const router = Router();

    router.get("/api/servers/:id/ops/capabilities", handle("GET ops/capabilities", async ({ caps }) => caps));

    router.get("/api/servers/:id/ops/services", handle("GET ops/services", ({ lease, caps, signal }) => listServices(lease, caps, signal)));

    router.get("/api/servers/:id/ops/services/:name", handle("GET ops/services/:name", ({ lease, caps, signal }, req) =>
        serviceDetail(lease, caps, param(req, "name"), signal)
    ));

    router.get("/api/servers/:id/ops/services/:name/journal", handle("GET ops/services/:name/journal", async ({ lease, caps, signal }, req) => ({
        text: await readJournal(lease, caps, param(req, "name"), lineCount(req.query.lines), signal)
    })));

    router.post("/api/servers/:id/ops/services/:name/:action", handle("POST ops/services/:name/:action", ({ lease, caps, signal }, req) =>
        performAction(lease, prepareServiceAction(caps, param(req, "name"), param(req, "action")), signal)
    ));

    router.get("/api/servers/:id/ops/containers", handle("GET ops/containers", ({ lease, caps, signal }) =>
        listContainers(lease, caps, signal)
    ));

    router.get("/api/servers/:id/ops/container-stats", handle("GET ops/container-stats", async ({ lease, caps, signal }) => ({
        stats: await containerStats(lease, caps, signal)
    })));

    router.get("/api/servers/:id/ops/containers/:ref", handle("GET ops/containers/:ref", async ({ lease, caps, signal }, req) => {
        const inspect = await inspectContainer(lease, caps, param(req, "ref"), signal);
        return { inspect, summary: summarizeInspect(inspect) };
    }));

    router.get("/api/servers/:id/ops/containers/:ref/stats", handle("GET ops/containers/:ref/stats", async ({ lease, caps, signal }, req) => ({
        stats: await containerStatsOf(lease, caps, param(req, "ref"), signal)
    })));

    router.get("/api/servers/:id/ops/containers/:ref/logs", handle("GET ops/containers/:ref/logs", async ({ lease, caps, signal }, req) => ({
        text: await containerLogs(lease, caps, param(req, "ref"), lineCount(req.query.lines), signal)
    })));

    router.post("/api/servers/:id/ops/containers/:ref/:action", handle("POST ops/containers/:ref/:action", ({ lease, caps, signal }, req) =>
        performAction(lease, prepareContainerAction(caps, param(req, "ref"), param(req, "action")), signal)
    ));

    // --- W7-S3: Compose projects and images ---

    router.get("/api/servers/:id/ops/compose", handle("GET ops/compose", ({ lease, caps, signal }) =>
        composeOverview(lease, caps, signal)
    ));

    // Body { service? }: one service of the project instead of all of them.
    router.post("/api/servers/:id/ops/compose/:project/:action", handle("POST ops/compose/:project/:action", async ({ lease, caps, signal }, req) => {
        const { service } = jsonBody(req);
        if (service !== undefined && typeof service !== "string") throw new InvalidOpsInputError("service must be a service name.");
        const action = await prepareComposeAction(lease, caps, param(req, "project"), param(req, "action"), service || undefined, signal);
        return performAction(lease, action, signal);
    }));

    router.get("/api/servers/:id/ops/images", handle("GET ops/images", ({ lease, caps, signal }) =>
        listImages(lease, caps, signal)
    ));

    router.get("/api/servers/:id/ops/disk-usage", handle("GET ops/disk-usage", ({ lease, caps, signal }) =>
        diskUsage(lease, caps, signal)
    ));

    router.get("/api/servers/:id/ops/images/prune-preview", handle("GET ops/images/prune-preview", ({ lease, caps, signal }, req) =>
        prunePreview(lease, caps, String(req.query.mode ?? ""), signal)
    ));

    // Body { mode }: what to prune (see PruneMode).
    router.post("/api/servers/:id/ops/images/prune", handle("POST ops/images/prune", async ({ lease, caps, signal }, req): Promise<PruneResult> => {
        const result = await performAction(lease, preparePrune(caps, String(jsonBody(req).mode ?? "")), signal);
        return { ...result, ...parsePruneOutput(result.output) };
    }));

    // Body { ref }: an image id or repository:tag.
    router.post("/api/servers/:id/ops/images/remove", handle("POST ops/images/remove", ({ lease, caps, signal }, req) =>
        performAction(lease, prepareImageRemoval(caps, jsonBody(req).ref), signal)
    ));

    return router;
}
