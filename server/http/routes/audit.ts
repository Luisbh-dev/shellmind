import { Router } from "express";
import { AUDIT_SOURCES, CLIENT_AUDIT_SOURCES, CLIENT_REPORTED, type AuditSource, type ClientAuditSource } from "../../../shared/types";
import { AUDIT_PAGE_MAX, auditRepo, recordAudit, type AuditQuery } from "../../db/auditRepo";
import { getAuditSettings, pruneAuditLog, setAuditRetention } from "../../db/auditRetention";
import { AppError } from "../../errors";
import { jsonBody, sendError } from "../respond";

const MAX_COMMAND_LENGTH = 10_000;
const MAX_SEARCH_LENGTH = 200;
const MAX_META_BYTES = 4096;

function isAuditSource(value: unknown): value is AuditSource {
    return typeof value === "string" && (AUDIT_SOURCES as readonly string[]).includes(value);
}

function isClientAuditSource(value: unknown): value is ClientAuditSource {
    return typeof value === "string" && (CLIENT_AUDIT_SOURCES as readonly string[]).includes(value);
}

function positiveInt(value: unknown, name: string, max = Number.MAX_SAFE_INTEGER): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed) || parsed <= 0 || parsed > max) {
        throw new AppError("INVALID_AUDIT", `${name} must be a positive integer${max < Number.MAX_SAFE_INTEGER ? ` up to ${max}` : ""}`);
    }
    return parsed;
}

// Epoch milliseconds (0 allowed).
function timestamp(value: unknown, name: string): number | undefined {
    if (value === undefined || value === "") return undefined;
    const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
    if (!Number.isSafeInteger(parsed)) throw new AppError("INVALID_AUDIT", `${name} must be a timestamp in milliseconds`);
    return parsed;
}

function invalid(message: string): AppError {
    return new AppError("INVALID_AUDIT", message);
}

// Audit log of commands run through the app. The server side records its own
// actions with recordAudit(); the frontend reports what it typed into a
// terminal (AI runs, snippets, ...) through POST, only under the sources it
// reports and marked as reported (meta.reportedBy): it cannot add entries
// that look like the backend's own fleet, keychain or RDP records.
export function createAuditRouter(): Router {
    const router = Router();

    // ?serverId=&source=&limit=&before=<id of the last entry of the previous page>
    //  &q=<text in the command or server name>&from=&to=<epoch ms, inclusive>
    router.get("/api/audit", async (req, res) => {
        try {
            const query: AuditQuery = {
                serverId: positiveInt(req.query.serverId, "serverId"),
                limit: positiveInt(req.query.limit, "limit", AUDIT_PAGE_MAX),
                before: positiveInt(req.query.before, "before"),
                from: timestamp(req.query.from, "from"),
                to: timestamp(req.query.to, "to")
            };
            if (req.query.q !== undefined) {
                if (typeof req.query.q !== "string" || req.query.q.length > MAX_SEARCH_LENGTH) {
                    throw invalid(`q must be a string of up to ${MAX_SEARCH_LENGTH} characters`);
                }
                query.search = req.query.q.trim() || undefined;
            }
            if (req.query.source !== undefined) {
                if (!isAuditSource(req.query.source)) throw invalid(`source must be one of: ${AUDIT_SOURCES.join(", ")}`);
                query.source = req.query.source;
            }
            res.json({ message: "success", data: await auditRepo.list(query) });
        } catch (err) {
            sendError(res, err, "GET /api/audit");
        }
    });

    router.post("/api/audit", async (req, res) => {
        try {
            const body = jsonBody(req);
            if (!isClientAuditSource(body.source)) throw invalid(`source must be one of: ${CLIENT_AUDIT_SOURCES.join(", ")}`);
            if (typeof body.command !== "string" || !body.command.trim()) throw invalid("command is required");
            if (body.command.length > MAX_COMMAND_LENGTH) throw invalid("command is too long");

            let exitCode: number | null = null;
            if (body.exitCode !== undefined && body.exitCode !== null) {
                if (typeof body.exitCode !== "number" || !Number.isInteger(body.exitCode)) throw invalid("exitCode must be an integer");
                exitCode = body.exitCode;
            }

            let meta: Record<string, unknown> = {};
            if (body.meta !== undefined && body.meta !== null) {
                if (typeof body.meta !== "object" || Array.isArray(body.meta)) throw invalid("meta must be an object");
                if (JSON.stringify(body.meta).length > MAX_META_BYTES) throw invalid("meta is too large");
                meta = body.meta as Record<string, unknown>;
            }
            meta = { ...meta, reportedBy: CLIENT_REPORTED };

            const entry = await recordAudit({
                serverId: positiveInt(body.serverId, "serverId") ?? null,
                source: body.source,
                command: body.command,
                exitCode,
                meta
            });
            res.status(201).json({ message: "success", data: entry });
        } catch (err) {
            sendError(res, err, "POST /api/audit");
        }
    });

    // Retention: { retentionDays (30, 90, 180, 365 or 0 = no age limit), maxEntries }.
    router.get("/api/audit/settings", async (_req, res) => {
        try {
            res.json({ message: "success", data: await getAuditSettings() });
        } catch (err) {
            sendError(res, err, "GET /api/audit/settings");
        }
    });

    // Saves the retention and applies it at once (`pruned`: entries removed).
    router.put("/api/audit/settings", async (req, res) => {
        try {
            const data = await setAuditRetention(jsonBody(req).retentionDays);
            res.json({ message: "success", data, pruned: await pruneAuditLog() });
        } catch (err) {
            sendError(res, err, "PUT /api/audit/settings");
        }
    });

    return router;
}
