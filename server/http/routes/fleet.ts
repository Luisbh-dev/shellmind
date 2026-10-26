import { Router } from "express";
import { FLEET_INTERVALS, FLEET_LIMITS, isFleetInterval } from "../../../shared/fleet";
import { AppError } from "../../errors";
import { fleetMonitor, type FleetMonitor, type FleetSettingsUpdate } from "../../fleet/monitor";
import { jsonBody, sendError } from "../respond";

// The fleet board (W7-S1). Every route sits behind the session token and the
// Host/Origin checks of createApp(); none takes a host, a command or anything
// else that reaches a server: the checks are the backend's own read-only
// script (or a connection to the saved SSH port), run on saved servers by id.

function invalid(message: string, field: string): AppError {
    return new AppError("INVALID_FLEET", message, 400, { field });
}

function serverIds(value: unknown, field: string): number[] {
    if (!Array.isArray(value)) throw invalid(`${field} must be an array of server ids`, field);
    if (value.length > FLEET_LIMITS.maxIds) throw invalid(`${field} can name at most ${FLEET_LIMITS.maxIds} servers`, field);
    if (!value.every((id) => Number.isSafeInteger(id) && id > 0)) throw invalid(`${field} must hold positive integer server ids`, field);
    return value as number[];
}

// PUT /api/fleet/settings: each field optional, each checked.
export function parseSettingsUpdate(body: Record<string, unknown>): FleetSettingsUpdate {
    const update: FleetSettingsUpdate = {};
    if (body.enabled !== undefined) {
        if (typeof body.enabled !== "boolean") throw invalid("enabled must be true or false", "enabled");
        update.enabled = body.enabled;
    }
    if (body.reachability !== undefined) {
        if (typeof body.reachability !== "boolean") throw invalid("reachability must be true or false", "reachability");
        update.reachability = body.reachability;
    }
    if (body.intervalMinutes !== undefined) {
        if (!isFleetInterval(body.intervalMinutes)) throw invalid(`intervalMinutes must be one of: ${FLEET_INTERVALS.join(", ")}`, "intervalMinutes");
        update.intervalMinutes = body.intervalMinutes;
    }
    if (body.notifications !== undefined) {
        if (typeof body.notifications !== "boolean") throw invalid("notifications must be true or false", "notifications");
        update.notifications = body.notifications;
    }
    if (body.excludedServerIds !== undefined) update.excludedServerIds = serverIds(body.excludedServerIds, "excludedServerIds");
    return update;
}

export function createFleetRouter(monitor: FleetMonitor = fleetMonitor): Router {
    const router = Router();

    router.get("/api/fleet", async (_req, res) => {
        try {
            res.json({ message: "success", data: await monitor.board() });
        } catch (err) {
            sendError(res, err, "GET /api/fleet");
        }
    });

    // { ids?: number[] }: checks start at once; their results arrive as
    // "fleet-health" events (or the next GET).
    router.post("/api/fleet/refresh", async (req, res) => {
        try {
            const body = jsonBody(req);
            const ids = body.ids === undefined || body.ids === null ? undefined : serverIds(body.ids, "ids");
            res.status(202).json({ message: "success", data: await monitor.refresh(ids) });
        } catch (err) {
            sendError(res, err, "POST /api/fleet/refresh");
        }
    });

    router.get("/api/fleet/settings", async (_req, res) => {
        try {
            res.json({ message: "success", data: await monitor.getSettings() });
        } catch (err) {
            sendError(res, err, "GET /api/fleet/settings");
        }
    });

    router.put("/api/fleet/settings", async (req, res) => {
        try {
            res.json({ message: "success", data: await monitor.updateSettings(parseSettingsUpdate(jsonBody(req))) });
        } catch (err) {
            sendError(res, err, "PUT /api/fleet/settings");
        }
    });

    return router;
}
