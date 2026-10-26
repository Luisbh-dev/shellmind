import { Router, type Request, type Response } from "express";
import { IDENTITY_LIMITS, type IdentitySummary, type InstallEvent } from "../../../shared/identities";
import type { AuditInput } from "../../../shared/types";
import { recordAudit } from "../../db/auditRepo";
import { identitiesRepo, type IdentityRecord } from "../../db/identitiesRepo";
import { serversRepo } from "../../db/serversRepo";
import { AppError, errorMessage } from "../../errors";
import { assertRotatable, identityKeyPair, installKey, rotateKey } from "../../identities/service";
import { createLogger } from "../../logger";
import { agentStatus } from "../../ssh/agent";
import { sshPool } from "../../ssh/pool";
import { jsonBody, routeId, sendError } from "../respond";
import { createSseStream } from "../sse";

// W7-S2 Settings > Keychain: identities (credentials several SSH servers
// share), the SSH agent's status, assigning identities to servers, and
// installing / rotating an identity's key on its servers. Secrets are
// write-only (IdentityInput in shared/identities.ts) and never answered.
// Install and rotate stream InstallEvent as Server-Sent Events on the POST
// that starts them; closing the stream cancels the servers not done yet.

const log = createLogger("identities");

const PING_INTERVAL_MS = 15_000;

function identityNotFound(): AppError {
    return new AppError("IDENTITY_NOT_FOUND", "Identity not found", 404);
}

function invalid(message: string, details?: Record<string, unknown>): AppError {
    return new AppError("INVALID_IDENTITY", message, 400, details);
}

// Distinct positive server ids, at most IDENTITY_LIMITS.maxServers.
function serverIds(value: unknown, allowEmpty = false): number[] {
    if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) throw invalid("serverIds must list at least one server");
    const ids = [...new Set(value as unknown[])];
    if (ids.some((id) => typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0)) throw invalid("serverIds must be positive integers");
    if (ids.length > IDENTITY_LIMITS.maxServers) throw invalid(`at most ${IDENTITY_LIMITS.maxServers} servers at once`);
    return ids as number[];
}

// The SSH servers named, by id and name (400 when one is missing or not SSH).
async function sshServers(ids: number[]): Promise<Array<{ serverId: number; name: string }>> {
    const servers: Array<{ serverId: number; name: string }> = [];
    const missing: number[] = [];
    const unsupported: number[] = [];
    for (const id of ids) {
        const server = await serversRepo.getSummary(id);
        if (!server) missing.push(id);
        else if (server.type !== "linux" && server.type !== "windows") unsupported.push(id);
        else servers.push({ serverId: id, name: server.name });
    }
    if (missing.length) throw invalid(`server ${missing.map((id) => `#${id}`).join(", ")} does not exist`, { missing });
    if (unsupported.length) throw invalid("keys can only be installed on SSH servers (Linux, Windows)", { unsupported });
    return servers;
}

async function loadRecord(id: number | null): Promise<IdentityRecord> {
    const identity = id === null ? null : await identitiesRepo.getRecord(id);
    if (!identity) throw identityNotFound();
    return identity;
}

// What an edit changed, for the audit log: field names and actions only.
function changeList(body: Record<string, unknown>, before: IdentitySummary, after: IdentitySummary): string[] {
    const changes: string[] = [];
    if (before.name !== after.name) changes.push("renamed");
    if (before.username !== after.username) changes.push("username");
    if (Boolean(before.use_agent) !== Boolean(after.use_agent)) changes.push(after.use_agent ? "agent on" : "agent off");
    if (before.private_key_path !== after.private_key_path) changes.push("key file");
    for (const [column, label] of [["password", "password"], ["privateKey", "private key"], ["passphrase", "passphrase"]] as const) {
        const clearFlag = column === "privateKey" ? "clear_private_key" : `clear_${column}`;
        if (typeof body[column] === "string" && (body[column] as string).trim()) changes.push(`${label} replaced`);
        else if (body[clearFlag] === true) changes.push(`${label} removed`);
    }
    if (body.generate_key === true) changes.push(`key generated ${after.fingerprint ?? ""}`.trim());
    return changes;
}

async function audit(entry: AuditInput): Promise<void> {
    try {
        await recordAudit(entry);
    } catch (err) {
        log.warn(`Could not write the audit log: ${errorMessage(err)}`);
    }
}

// The Server-Sent Events answer of an install or rotate run. Validation
// failures (before the stream starts) are plain JSON errors.
async function streamRun(
    req: Request,
    res: Response,
    context: string,
    busy: Set<number>,
    prepare: () => Promise<{ identityId: number; run: (signal: AbortSignal, emit: (event: InstallEvent) => void) => Promise<void> }>
): Promise<void> {
    const controller = new AbortController();
    const leftEarly = () => controller.abort();
    res.once("close", leftEarly);

    let prepared: Awaited<ReturnType<typeof prepare>>;
    try {
        prepared = await prepare();
        if (busy.has(prepared.identityId)) {
            throw new AppError("IDENTITY_BUSY", "A key install or rotation of this identity is already running; wait for it to finish.", 409);
        }
    } catch (err) {
        res.off("close", leftEarly);
        sendError(res, err, context);
        return;
    }
    res.off("close", leftEarly);
    if (controller.signal.aborted) return;

    busy.add(prepared.identityId);
    const sse = createSseStream(res, () => controller.abort());
    const send = (event: InstallEvent) => sse.send(event);
    sse.start();
    const ping = setInterval(() => send({ type: "ping" }), PING_INTERVAL_MS);
    try {
        await prepared.run(controller.signal, send);
        send({ type: "done", cancelled: controller.signal.aborted });
    } catch (err) {
        log.error(`${context} failed`, err);
        send(err instanceof AppError ? { type: "error", message: err.message, code: err.code } : { type: "error", message: "Internal server error." });
    } finally {
        clearInterval(ping);
        busy.delete(prepared.identityId);
        sse.end();
    }
}

export function createIdentitiesRouter(): Router {
    const router = Router();
    // Identities with an install or rotation running.
    const busy = new Set<number>();

    router.get("/api/identities", async (_req, res) => {
        try {
            res.json({ message: "success", data: await identitiesRepo.listSummaries() });
        } catch (err) {
            sendError(res, err, "GET /api/identities");
        }
    });

    // Whether the SSH agent answers, and its keys (type, fingerprint, comment).
    router.get("/api/identities/agent", async (_req, res) => {
        try {
            res.json(await agentStatus());
        } catch (err) {
            sendError(res, err, "GET /api/identities/agent");
        }
    });

    router.post("/api/identities", async (req, res) => {
        try {
            const body = jsonBody(req);
            const id = await identitiesRepo.create(body);
            const saved = await identitiesRepo.getSummary(id);
            log.info(`Identity #${id} added`);
            await audit({
                source: "identity",
                command: `create identity "${saved?.name}"${body.generate_key === true && saved?.fingerprint ? ` with a new key ${saved.fingerprint}` : ""}`,
                meta: { identityId: id, action: "create", fingerprint: saved?.fingerprint ?? null }
            });
            res.json({ message: "success", data: saved });
        } catch (err) {
            sendError(res, err, "POST /api/identities");
        }
    });

    // Body: AssignIdentityInput. Answers AssignIdentityResult.
    router.post("/api/identities/assign", async (req, res) => {
        try {
            const body = jsonBody(req);
            const identityId = body.identityId === null ? null : routeId(String(body.identityId));
            if (identityId === null && body.identityId !== null) throw invalid("identityId must be an identity id or null");
            if (body.clearOwnCredentials !== undefined && typeof body.clearOwnCredentials !== "boolean") throw invalid("clearOwnCredentials must be a boolean");
            const clearOwn = body.clearOwnCredentials === true;
            // Without an identity that would leave the servers nothing to sign in with.
            if (clearOwn && identityId === null) throw invalid("clearOwnCredentials needs an identity: removing the identity keeps the servers' own credentials");
            const result = await identitiesRepo.assign(identityId, serverIds(body.serverIds), clearOwn);
            const identity = identityId === null ? null : await identitiesRepo.getSummary(identityId);
            for (const serverId of result.updated) {
                sshPool.invalidate(serverId);
                await audit({
                    serverId,
                    source: "identity",
                    command: identity ? `assign identity "${identity.name}"${clearOwn ? " (own credentials removed)" : ""}` : `remove identity${clearOwn ? " (own credentials removed)" : ""}`,
                    meta: { identityId, action: "assign", clearOwnCredentials: clearOwn }
                });
            }
            res.json({ message: "success", data: result });
        } catch (err) {
            sendError(res, err, "POST /api/identities/assign");
        }
    });

    // Every save changes the connection version of the servers using it: their
    // pooled connections are not handed out again.
    router.put("/api/identities/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            const before = id === null ? null : await identitiesRepo.getSummary(id);
            if (id === null || !before) throw identityNotFound();
            const body = jsonBody(req);
            if (!(await identitiesRepo.update(id, body))) throw identityNotFound();
            const saved = await identitiesRepo.getSummary(id);
            const dependents = await identitiesRepo.dependents(id);
            for (const server of dependents) sshPool.invalidate(server.id);
            if (saved) {
                const changes = changeList(body, before, saved);
                await audit({
                    source: "identity",
                    command: `update identity "${saved.name}"${changes.length ? `: ${changes.join(", ")}` : ""}`,
                    meta: { identityId: id, action: "update", changes, servers: dependents.length }
                });
            }
            res.json({ message: "success", data: saved, dependents: dependents.length });
        } catch (err) {
            sendError(res, err, "PUT /api/identities/:id");
        }
    });

    // 409 IDENTITY_IN_USE (details.dependents) while servers use it.
    router.delete("/api/identities/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            const before = id === null ? null : await identitiesRepo.getSummary(id);
            if (id === null || !before || !(await identitiesRepo.remove(id))) throw identityNotFound();
            await audit({ source: "identity", command: `delete identity "${before.name}"`, meta: { identityId: id, action: "delete" } });
            res.json({ message: "deleted", changes: 1 });
        } catch (err) {
            sendError(res, err, "DELETE /api/identities/:id");
        }
    });

    // Body: InstallKeyInput. SSE stream of InstallEvent.
    router.post("/api/identities/:id/install", (req, res) => {
        void streamRun(req, res, "POST /api/identities/:id/install", busy, async () => {
            const identity = await loadRecord(routeId(req.params.id));
            const servers = await sshServers(serverIds(jsonBody(req).serverIds));
            const key = await identityKeyPair(identity);
            return {
                identityId: identity.id,
                run: async (signal, emit) => {
                    emit({ type: "start", servers, fingerprint: key.info.fingerprint });
                    await installKey({ servers, key, identity, signal, emit, action: "install" });
                }
            };
        });
    });

    // Body: RotateKeyInput. SSE stream of InstallEvent, with "rotated" (and
    // the "removed" of each server) before "done".
    router.post("/api/identities/:id/rotate", (req, res) => {
        void streamRun(req, res, "POST /api/identities/:id/rotate", busy, async () => {
            const identity = await loadRecord(routeId(req.params.id));
            const body = jsonBody(req);
            if (body.passphrase !== undefined && (typeof body.passphrase !== "string" || body.passphrase.length > IDENTITY_LIMITS.secret)) {
                throw invalid("passphrase must be a string");
            }
            if (body.force !== undefined && typeof body.force !== "boolean") throw invalid("force must be a boolean");
            if (body.removeOld !== undefined && typeof body.removeOld !== "boolean") throw invalid("removeOld must be a boolean");
            assertRotatable(identity);
            const passphrase = typeof body.passphrase === "string" ? (body.passphrase.trim() ? body.passphrase : null) : identity.passphrase;
            const dependents = await identitiesRepo.dependents(identity.id);
            const servers = dependents.map((server) => ({ serverId: server.id, name: server.name }));
            return {
                identityId: identity.id,
                run: async (signal, emit) => {
                    await rotateKey(identity, { passphrase, force: body.force === true, removeOld: body.removeOld !== false, servers, signal, emit });
                }
            };
        });
    });

    return router;
}
