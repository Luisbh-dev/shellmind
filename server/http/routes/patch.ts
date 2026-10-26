import { Router, type Request, type Response } from "express";
import type { PatchScanEvent } from "../../../shared/patch";
import { createLogger } from "../../logger";
import { parseOptions, parseServerIds, planRun, toPreview } from "../../patch/plan";
import { busyServers, patchFleet, refreshServer, serverPatchState, startPatchRun, type RunDeps } from "../../patch/run";
import { scanMany, scanServer, type ScanDeps } from "../../patch/scan";
import { abortOnClose, sendRemoteError } from "../remote";
import { jsonBody, routeId, sendError, serverNotFound } from "../respond";
import { createSseStream } from "../sse";

// The patch center (W8-T3). Every route sits behind the session token and the
// Host/Origin checks of createApp(). Requests name saved servers and pick
// options from fixed sets (a mode, two booleans, a multi-exec strategy); the
// scripts that reach the servers are the backend's own (server/patch). Runs
// are multi-exec jobs: they are followed, paused, resumed and cancelled
// through /api/multiexec/jobs/:id.

const log = createLogger("patch");

const PING_INTERVAL_MS = 15_000;
const UNSUPPORTED = "The patch center only reads Linux and Windows servers (over SSH).";

export type PatchRouterOptions = { run?: RunDeps; scan?: ScanDeps };

function serverIdOf(req: Request, res: Response, context: string): number | null {
    const id = routeId(req.params.id);
    if (id === null) sendError(res, serverNotFound(), context);
    return id;
}

export function createPatchRouter(options: PatchRouterOptions = {}): Router {
    const router = Router();

    router.get("/api/patch/fleet", async (_req, res) => {
        try {
            res.json({ message: "success", data: await patchFleet() });
        } catch (err) {
            sendError(res, err, "GET /api/patch/fleet");
        }
    });

    // { serverIds }: read-only scans, a few at a time, streamed as
    // PatchScanEvent; closing the stream stops the scans not started yet.
    router.post("/api/patch/scan", async (req, res) => {
        let ids: number[];
        try {
            ids = parseServerIds(jsonBody(req).serverIds);
        } catch (err) {
            sendError(res, err, "POST /api/patch/scan");
            return;
        }
        const controller = new AbortController();
        let ping: NodeJS.Timeout | null = null;
        const sse = createSseStream(res, () => {
            controller.abort();
            if (ping) clearInterval(ping);
        });
        sse.start();
        ping = setInterval(() => sse.send({ type: "ping" } satisfies PatchScanEvent), PING_INTERVAL_MS);
        ping.unref?.();
        try {
            await scanMany(ids, (event) => sse.send(event satisfies PatchScanEvent), controller.signal, options.scan);
        } catch (err) {
            log.warn(`Scanning ${ids.length} server(s) failed`, err);
        } finally {
            if (ping) clearInterval(ping);
            sse.send({ type: "end" } satisfies PatchScanEvent);
            sse.end();
        }
    });

    // { serverIds, mode, refresh, reboot }: what a run would do.
    router.post("/api/patch/preview", async (req, res) => {
        try {
            const body = jsonBody(req);
            const plan = await planRun(parseServerIds(body.serverIds), parseOptions(body), busyServers());
            res.json({ message: "success", data: toPreview(plan) });
        } catch (err) {
            sendError(res, err, "POST /api/patch/preview");
        }
    });

    // PatchApplyRequest: starts the run (a multi-exec job) once the number
    // of servers confirmed matches the plan.
    router.post("/api/patch/apply", async (req, res) => {
        try {
            res.status(201).json({ message: "started", data: await startPatchRun(jsonBody(req), options.run) });
        } catch (err) {
            sendError(res, err, "POST /api/patch/apply");
        }
    });

    router.get("/api/servers/:id/patch", async (req, res) => {
        const id = serverIdOf(req, res, "GET servers/:id/patch");
        if (id === null) return;
        try {
            res.json({ message: "success", data: await serverPatchState(id) });
        } catch (err) {
            sendError(res, err, "GET servers/:id/patch");
        }
    });

    router.post("/api/servers/:id/patch/scan", async (req, res) => {
        const id = serverIdOf(req, res, "POST servers/:id/patch/scan");
        if (id === null) return;
        const request = abortOnClose(res);
        try {
            res.json({ message: "success", data: await scanServer(id, { signal: request.signal }, options.scan) });
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, "POST servers/:id/patch/scan", UNSUPPORTED);
        } finally {
            request.dispose();
        }
    });

    // Refreshes the package lists (Windows: an online search), then reads
    // the server again.
    router.post("/api/servers/:id/patch/refresh", async (req, res) => {
        const id = serverIdOf(req, res, "POST servers/:id/patch/refresh");
        if (id === null) return;
        const request = abortOnClose(res);
        try {
            res.json({ message: "success", data: await refreshServer(id, request.signal) });
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, "POST servers/:id/patch/refresh", UNSUPPORTED);
        } finally {
            request.dispose();
        }
    });

    return router;
}
