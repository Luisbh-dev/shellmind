import { Router } from "express";
import { knownHostsRepo } from "../../db/knownHostsRepo";
import { AppError } from "../../errors";
import { routeId, sendError } from "../respond";

const knownHostNotFound = () => new AppError("KNOWN_HOST_NOT_FOUND", "Known host not found", 404);

// SSH host keys pinned on first use. Removing one lets the next connection
// trust the host's current key (after a legitimate reinstall).
export function createKnownHostsRouter(): Router {
    const router = Router();

    router.get("/api/known-hosts", async (_req, res) => {
        try {
            res.json({ message: "success", data: await knownHostsRepo.list() });
        } catch (err) {
            sendError(res, err, "GET /api/known-hosts");
        }
    });

    router.delete("/api/known-hosts/:id", async (req, res) => {
        try {
            const id = routeId(req.params.id);
            if (id === null || !(await knownHostsRepo.remove(id))) throw knownHostNotFound();
            res.json({ message: "deleted", changes: 1 });
        } catch (err) {
            sendError(res, err, "DELETE /api/known-hosts/:id");
        }
    });

    return router;
}
