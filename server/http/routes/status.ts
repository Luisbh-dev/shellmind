import { Router } from "express";
import { collectStatus } from "../../status/collect";
import { abortOnClose, sendRemoteError } from "../remote";
import { routeId, sendError, serverNotFound } from "../respond";

const UNSUPPORTED = "Status dashboard is only available for SSH-capable servers.";

export function createStatusRouter(): Router {
    const router = Router();

    // Live metrics of a Linux/Windows server over its pooled SSH connection.
    router.get("/api/servers/:id/status", async (req, res) => {
        const id = routeId(req.params.id);
        if (id === null) return sendError(res, serverNotFound(), "GET /api/servers/:id/status");
        const request = abortOnClose(res);
        try {
            res.json(await collectStatus(id, request.signal));
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, "GET /api/servers/:id/status", UNSUPPORTED);
        } finally {
            request.dispose();
        }
    });

    return router;
}
