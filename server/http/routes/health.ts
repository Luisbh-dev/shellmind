import { Router } from "express";
import type { HealthResponse, SessionResponse } from "../../../shared/types";
import { APP_VERSION } from "../../version";

// Public liveness probe: the UI polls it while the backend starts. It must
// not reveal anything beyond the version.
export function createHealthRouter(): Router {
    const router = Router();

    router.get("/api/health", (req, res) => {
        const body: HealthResponse = { ok: true, version: APP_VERSION };
        res.json(body);
    });

    return router;
}

// Mounted behind the auth middleware: answers 200 only for a valid token, so
// the UI can tell "backend up" from "token accepted".
export function createSessionRouter(): Router {
    const router = Router();

    router.get("/api/session", (req, res) => {
        const body: SessionResponse = { authenticated: true };
        res.json(body);
    });

    return router;
}
