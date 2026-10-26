import { Router } from "express";
import type { ServerSummary } from "../../../shared/types";
import { recordAudit } from "../../db/auditRepo";
import { identitiesRepo } from "../../db/identitiesRepo";
import { serversRepo } from "../../db/serversRepo";
import { AppError, errorMessage } from "../../errors";
import { createLogger } from "../../logger";
import { sshPool } from "../../ssh/pool";
import { tunnelManager } from "../../tunnels/manager";
import { jsonBody, routeId, sendError, serverNotFound } from "../respond";

const log = createLogger("servers");

const MAX_REORDER = 10000;

// Body of POST /api/servers/reorder: { ids: number[] } (distinct positive ids).
function reorderIds(body: Record<string, unknown>): number[] {
    const { ids } = body;
    if (!Array.isArray(ids) || ids.length > MAX_REORDER || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
        throw new AppError("INVALID_ORDER", "ids must be an array of server ids", 400);
    }
    if (new Set(ids).size !== ids.length) throw new AppError("INVALID_ORDER", "ids must not repeat", 400);
    return ids as number[];
}

// W7-S2: what an edit changed in how the server signs in, for the audit log
// (what changed, never a value).
async function credentialChanges(body: Record<string, unknown>, before: ServerSummary, after: ServerSummary): Promise<string[]> {
    const changes: string[] = [];
    if ((before.identity_id ?? null) !== (after.identity_id ?? null)) {
        const identity = after.identity_id ? await identitiesRepo.getSummary(after.identity_id) : null;
        changes.push(identity ? `identity "${identity.name}"` : "identity removed");
    }
    const secrets = [["password", "clear_password", "password"], ["privateKey", "clear_private_key", "private key"], ["passphrase", "clear_passphrase", "passphrase"], ["s3_secret_key", "clear_s3_secret_key", "S3 secret key"]] as const;
    for (const [column, clearFlag, label] of secrets) {
        if (typeof body[column] === "string" && (body[column] as string).trim()) changes.push(`${label} replaced`);
        else if (body[clearFlag] === true) changes.push(`${label} removed`);
    }
    if ((before.private_key_path ?? null) !== (after.private_key_path ?? null)) changes.push("key file");
    if (Boolean(before.agent_forward) !== Boolean(after.agent_forward)) changes.push(after.agent_forward ? "agent forwarding on" : "agent forwarding off");
    return changes;
}

async function auditCredentialChanges(id: number, body: Record<string, unknown>, before: ServerSummary | null, after: ServerSummary | null): Promise<void> {
    if (!before || !after) return;
    try {
        const changes = await credentialChanges(body, before, after);
        if (changes.length === 0) return;
        await recordAudit({ serverId: id, source: "identity", command: `credentials changed: ${changes.join(", ")}`, meta: { action: "credentials", changes } });
    } catch (err) {
        log.warn(`Could not record the credential change of server #${id}: ${errorMessage(err)}`);
    }
}

export function createServersRouter(): Router {
    const router = Router();

    // Get all servers.
    // Secrets (password, private key, passphrase, S3 secret) never leave the
    // backend: connections are made by server id and credentials are resolved
    // from the database server-side. The has_* flags let the edit UI show that
    // a secret is already saved.
    router.get("/api/servers", async (_req, res) => {
        try {
            res.json({ message: "success", data: await serversRepo.listSummaries() });
        } catch (err) {
            sendError(res, err, "GET /api/servers");
        }
    });

    // Add a new server. Answers with the saved summary (no secrets).
    router.post("/api/servers", async (req, res) => {
        try {
            const id = await serversRepo.create(jsonBody(req));
            const saved = await serversRepo.getSummary(id);
            log.info(`Server #${id} added (${saved?.type})`);
            res.json({ message: "success", data: saved });
        } catch (err) {
            sendError(res, err, "POST /api/servers");
        }
    });

    // The manual order of the sidebar (sort_order follows the list).
    router.post("/api/servers/reorder", async (req, res) => {
        try {
            const changes = await serversRepo.reorder(reorderIds(jsonBody(req)));
            res.json({ message: "success", changes });
        } catch (err) {
            sendError(res, err, "POST /api/servers/reorder");
        }
    });

    // Update an existing server (semantics: ServerInput in shared/types.ts).
    // Pooled SSH connections to the old settings are not handed out again,
    // and the tunnels of a server that is no longer an SSH server stop.
    router.put("/api/servers/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            const body = jsonBody(req);
            const before = id === null ? null : await serversRepo.getSummary(id);
            if (id === null || !(await serversRepo.update(id, body))) throw serverNotFound();
            sshPool.invalidate(id);
            const saved = await serversRepo.getSummary(id);
            await auditCredentialChanges(id, body, before, saved);
            if (saved) await tunnelManager.serverUpdated(saved);
            res.json({ message: "success", changes: 1, data: saved });
        } catch (err) {
            sendError(res, err, "PUT /api/servers/:id");
        }
    });

    // OS detected by a live session (a non-empty name, or null to forget it).
    router.patch("/api/servers/:id/os", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            if (id === null) throw serverNotFound();
            const { os_detail } = jsonBody(req);
            const value = typeof os_detail === "string" ? os_detail.trim().slice(0, 255) : os_detail;
            if (value !== null && (typeof value !== "string" || !value)) {
                throw new AppError("INVALID_SERVER", "os_detail must be a non-empty string or null", 400, { field: "os_detail" });
            }
            if (!(await serversRepo.setOsDetail(id, value))) throw serverNotFound();
            res.json({ message: "success" });
        } catch (err) {
            sendError(res, err, "PATCH /api/servers/:id/os");
        }
    });

    // Pin or unpin a server at the top of the sidebar: { favorite: boolean }.
    router.patch("/api/servers/:id/favorite", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            if (id === null) throw serverNotFound();
            const { favorite } = jsonBody(req);
            if (typeof favorite !== "boolean") throw new AppError("INVALID_SERVER", "favorite must be a boolean", 400, { field: "favorite" });
            if (!(await serversRepo.setFavorite(id, favorite))) throw serverNotFound();
            res.json({ message: "success", data: await serversRepo.getSummary(id) });
        } catch (err) {
            sendError(res, err, "PATCH /api/servers/:id/favorite");
        }
    });

    // Delete a server with its chat/CLI history, tunnels and scoped snippets,
    // and close its pooled SSH connections. A jump host other servers still
    // use is refused (409 JUMP_HOST_IN_USE, details.dependents).
    router.delete("/api/servers/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            if (id === null || !(await serversRepo.remove(id))) throw serverNotFound();
            await tunnelManager.forgetServer(id);
            sshPool.invalidate(id, { close: true });
            res.json({ message: "deleted", changes: 1 });
        } catch (err) {
            sendError(res, err, "DELETE /api/servers/:id");
        }
    });

    return router;
}
