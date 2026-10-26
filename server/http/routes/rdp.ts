import { Router } from "express";
import type { RdpCertificateState, RdpLaunchResult, RdpOptions, RdpOptionsInput, RdpSupport } from "../../../shared/rdp";
import { loadConnectionTarget } from "../../connections/target";
import { recordAudit } from "../../db/auditRepo";
import { AppError, errorMessage } from "../../errors";
import { detectRdpSupport, launchNativeRdp } from "../../local/rdp";
import { createLogger } from "../../logger";
import { rdpCertificates } from "../../rdp/certificates";
import { rdpOptions } from "../../rdp/options";
import { loadRdpEndpoint, loadRdpServer } from "../../rdp/route";
import { errorBody, jsonBody, routeId, sendError } from "../respond";

const log = createLogger("rdp");

// Native Remote Desktop: which client this computer has, and opening it for a
// saved Windows server (credentials come from the database only). The
// embedded client: the certificate pinned for a server and its options (its
// gateway runs on the WebSocket of server/rdp/gateway.ts).
export function createRdpRouter(): Router {
    const router = Router();

    router.get("/api/rdp/native", async (_req, res) => {
        try {
            const data: RdpSupport = await detectRdpSupport();
            res.json({ message: "success", data });
        } catch (err) {
            sendError(res, err, "GET /api/rdp/native");
        }
    });

    router.post("/api/rdp/launch", async (req, res) => {
        try {
            const target = await loadConnectionTarget(jsonBody(req).serverId, "rdp");
            const data: RdpLaunchResult = await launchNativeRdp(target);
            res.json({ message: "success", data });
        } catch (err) {
            // Unexpected errors may quote a command line that holds the
            // password: they are reduced to a generic message here.
            if (err instanceof AppError) {
                sendError(res, err, "POST /api/rdp/launch");
            } else {
                log.error("Native RDP launch failed unexpectedly");
                res.status(500).json(errorBody("RDP_LAUNCH_FAILED", "Could not open the Remote Desktop client."));
            }
        }
    });

    // Needs no credentials: a pin can be checked and forgotten while the
    // saved password cannot be decrypted.
    router.get("/api/rdp/certificate", async (req, res) => {
        try {
            const { host, port, via } = await loadRdpEndpoint(req.query.serverId);
            const data: RdpCertificateState = { host, port, via, pinned: await rdpCertificates.find(host, port, via) };
            res.json({ message: "success", data });
        } catch (err) {
            sendError(res, err, "GET /api/rdp/certificate");
        }
    });

    router.get("/api/rdp/options", async (req, res) => {
        try {
            const server = await loadRdpServer(req.query.serverId);
            const data: RdpOptions = await rdpOptions.get(server.id);
            res.json({ message: "success", data });
        } catch (err) {
            sendError(res, err, "GET /api/rdp/options");
        }
    });

    router.put("/api/rdp/options", async (req, res) => {
        try {
            const body = jsonBody(req) as Partial<Record<keyof RdpOptionsInput, unknown>>;
            if (typeof body.askPassword !== "boolean") throw new AppError("INVALID_REQUEST", "askPassword must be true or false.", 400);
            const server = await loadRdpServer(body.serverId);
            const before = await rdpOptions.get(server.id);
            const data: RdpOptions = await rdpOptions.set(server.id, { askPassword: body.askPassword });
            if (before.askPassword !== data.askPassword) {
                log.info(`Server #${server.id}: the embedded Remote Desktop client ${data.askPassword ? "asks for the password each time" : "may use the saved password"}`);
                void recordAudit({ serverId: server.id, source: "rdp", command: `rdp ask-password ${data.askPassword ? "on" : "off"}` })
                    .catch((err: unknown) => log.warn(`Could not record the Remote Desktop option in the audit log: ${errorMessage(err)}`));
            }
            res.json({ message: "success", data });
        } catch (err) {
            sendError(res, err, "PUT /api/rdp/options");
        }
    });

    // Forgets a pinned certificate: the next connection trusts the one it is shown.
    router.delete("/api/rdp/certificates/:id", async (req, res) => {
        try {
            const id = routeId(req.params.id);
            if (id === null || !(await rdpCertificates.remove(id))) throw new AppError("RDP_CERTIFICATE_NOT_FOUND", "Pinned certificate not found", 404);
            log.info(`Pinned RDP certificate #${id} forgotten`);
            res.json({ message: "deleted", changes: 1 });
        } catch (err) {
            sendError(res, err, "DELETE /api/rdp/certificates/:id");
        }
    });

    return router;
}
