import { Router } from "express";
import { effectivePort } from "../../../shared/ports";
import { supportsTunnels, type ServerHostKey, type TunnelView } from "../../../shared/tunnels";
import type { ServerSummary, Tunnel } from "../../../shared/types";
import { knownHostsRepo } from "../../db/knownHostsRepo";
import { normalizeHost, serversRepo } from "../../db/serversRepo";
import { AppError, errorMessage } from "../../errors";
import { HostKeyMismatchError } from "../../ssh/hostKeys";
import { savedRouteVia } from "../../ssh/savedRoute";
import { auditTunnel } from "../../tunnels/audit";
import { tunnelManager, type TunnelManager } from "../../tunnels/manager";
import { tunnelsRepo } from "../../tunnels/repo";
import { parseTunnelInput } from "../../tunnels/validate";
import { jsonBody, routeId, sendError, serverNotFound } from "../respond";

// SSH tunnels (local port forwards) of saved servers with their live status,
// and the host key pinned for a server. Every change and every start/stop is
// recorded in the audit log (source "ops").

const tunnelNotFound = () => new AppError("TUNNEL_NOT_FOUND", "Tunnel not found", 404);

async function loadSshServer(rawId: unknown): Promise<ServerSummary> {
    const id = routeId(rawId);
    const server = id === null ? null : await serversRepo.getSummary(id);
    if (!server) throw serverNotFound();
    if (!supportsTunnels(server.type)) {
        throw new AppError("UNSUPPORTED_SERVER", "Tunnels and host keys are only available for SSH servers (Linux or Windows).");
    }
    return server;
}

async function loadTunnel(rawId: unknown): Promise<Tunnel> {
    const id = routeId(rawId);
    const tunnel = id === null ? null : await tunnelsRepo.get(id);
    if (!tunnel) throw tunnelNotFound();
    return tunnel;
}

function failureOf(err: unknown): { code: string; message: string } {
    const code = err instanceof AppError || err instanceof HostKeyMismatchError ? err.code : "ERROR";
    return { code, message: errorMessage(err) };
}

export function createTunnelsRouter(manager: TunnelManager = tunnelManager): Router {
    const router = Router();
    const view = (tunnel: Tunnel): TunnelView => manager.view(tunnel);

    router.get("/api/servers/:id/tunnels", async (req, res) => {
        try {
            const server = await loadSshServer(req.params.id);
            const tunnels = await tunnelsRepo.listByServer(server.id);
            res.json({ message: "success", data: tunnels.map(view) });
        } catch (err) {
            sendError(res, err, "GET /api/servers/:id/tunnels");
        }
    });

    router.post("/api/servers/:id/tunnels", async (req, res) => {
        try {
            const server = await loadSshServer(req.params.id);
            const tunnel = await tunnelsRepo.create(server.id, parseTunnelInput(jsonBody(req)));
            await auditTunnel("create", tunnel);
            res.status(201).json({ message: "success", data: view(tunnel) });
        } catch (err) {
            sendError(res, err, "POST /api/servers/:id/tunnels");
        }
    });

    // Changes the fields present in the body. A running tunnel whose
    // endpoints changed restarts; if that fails, the answer is still 200 and
    // its status says why.
    router.put("/api/tunnels/:id", async (req, res) => {
        try {
            const existing = await loadTunnel(req.params.id);
            const updated = await tunnelsRepo.update(existing.id, parseTunnelInput(jsonBody(req), existing));
            if (!updated) throw tunnelNotFound();
            await auditTunnel("update", updated);
            await manager.reconfigure(updated).catch(() => undefined);
            res.json({ message: "success", data: view(updated) });
        } catch (err) {
            sendError(res, err, "PUT /api/tunnels/:id");
        }
    });

    router.delete("/api/tunnels/:id", async (req, res) => {
        try {
            const tunnel = await loadTunnel(req.params.id);
            await manager.forget(tunnel.id);
            if (!(await tunnelsRepo.remove(tunnel.id))) throw tunnelNotFound();
            await auditTunnel("delete", tunnel);
            res.json({ message: "deleted", changes: 1 });
        } catch (err) {
            sendError(res, err, "DELETE /api/tunnels/:id");
        }
    });

    // Answers once the tunnel listens. Errors: 409 PORT_IN_USE /
    // PORT_ACCESS_DENIED / BIND_ADDRESS_UNAVAILABLE / HOST_KEY_MISMATCH /
    // TUNNEL_START_CANCELLED (stopped or edited meanwhile), 502
    // SSH_CONNECT_FAILED, connection target codes; each audited as exit 1.
    router.post("/api/tunnels/:id/start", async (req, res) => {
        let tunnel: Tunnel | null = null;
        try {
            tunnel = await loadTunnel(req.params.id);
            await manager.start(tunnel);
            await auditTunnel("start", tunnel);
            res.json({ message: "success", data: view(tunnel) });
        } catch (err) {
            if (tunnel) await auditTunnel("start", tunnel, failureOf(err));
            sendError(res, err, "POST /api/tunnels/:id/start");
        }
    });

    router.post("/api/tunnels/:id/stop", async (req, res) => {
        try {
            const tunnel = await loadTunnel(req.params.id);
            const wasRunning = manager.isRunning(tunnel.id);
            await manager.stop(tunnel.id);
            if (wasRunning) await auditTunnel("stop", tunnel);
            res.json({ message: "success", data: view(tunnel) });
        } catch (err) {
            sendError(res, err, "POST /api/tunnels/:id/stop");
        }
    });

    // Removing the pinned key is DELETE /api/known-hosts/:id.
    router.get("/api/servers/:id/host-key", async (req, res) => {
        try {
            const server = await loadSshServer(req.params.id);
            const host = normalizeHost(server.ip);
            const port = effectivePort(server, "terminal") ?? 22;
            // V1 (BC-02): the key pinned for the server's own jump route.
            const via = await savedRouteVia(server);
            const data: ServerHostKey = { host, port, knownHost: via === null ? null : await knownHostsRepo.find(host, port, via) };
            res.json({ message: "success", data });
        } catch (err) {
            sendError(res, err, "GET /api/servers/:id/host-key");
        }
    });

    return router;
}
