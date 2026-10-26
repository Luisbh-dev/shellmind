import express from "express";
import cors from "cors";
import { getSessionToken } from "../auth";
import { SERVE_WEB } from "../config";
import { networkGuard } from "./network";
import { corsOriginCheck } from "./origin";
import { errorHandler, jsonBodyParser, notFound, requireAuth, securityHeaders } from "./security";
import { serveWebUi } from "./static";
import { createChatRouter } from "./routes/chat";
import { createChatHistoryRouter } from "./routes/chatHistory";
import { createConfigRouter } from "./routes/config";
import { createHealthRouter, createSessionRouter } from "./routes/health";
import { createServersRouter } from "./routes/servers";
import { createKnownHostsRouter } from "./routes/knownHosts";
import { createAuditRouter } from "./routes/audit";
import { createImportExportRouter } from "./routes/importExport";
import { createRdpRouter } from "./routes/rdp";
import { createSnippetsRouter } from "./routes/snippets";
import { createMultiExecRouter } from "./routes/multiexec";
import { createTunnelsRouter } from "./routes/tunnels";
import { createStatusRouter } from "./routes/status";
import { createOpsRouter } from "./routes/ops";
// --- W7-S1 fleet board ---
import { createFleetRouter } from "./routes/fleet";
// --- W7-S2 identities ---
import { createIdentitiesRouter } from "./routes/identities";
// --- W8-T4 disk toolkit ---
import { createDiskRouter } from "./routes/disk";
// --- W8-T3 patch center ---
import { createPatchRouter } from "./routes/patch";
// --- W8-T2 Kubernetes ---
import { createK8sRouter } from "./routes/k8s";

export type AppOptions = {
    // Defaults to the process-wide session token.
    authToken?: string;
};

export function createApp(options: AppOptions = {}): express.Express {
    const authToken = options.authToken ?? getSessionToken().value;
    const app = express();
    app.disable("x-powered-by");

    // Order matters: foreign Host/Origin is refused before anything runs, the
    // static UI and the health probe are public, CORS answers preflights
    // (which carry no token), and bodies are only parsed once authenticated.
    app.use(securityHeaders());
    app.use(networkGuard());
    if (SERVE_WEB) app.use(serveWebUi());
    app.use(cors({ origin: corsOriginCheck }));
    app.use(createHealthRouter());
    app.use(requireAuth(authToken));
    app.use(jsonBodyParser());

    app.use(createSessionRouter());
    app.use(createServersRouter());
    app.use(createConfigRouter());
    app.use(createChatHistoryRouter());
    app.use(createChatRouter());
    app.use(createKnownHostsRouter());
    app.use(createAuditRouter());
    app.use(createImportExportRouter());
    app.use(createRdpRouter());
    app.use(createSnippetsRouter());
    app.use(createMultiExecRouter());
    app.use(createTunnelsRouter());
    app.use(createStatusRouter());
    app.use(createOpsRouter());
    // --- W7-S1 fleet board ---
    app.use(createFleetRouter());
    // --- W7-S2 identities ---
    app.use(createIdentitiesRouter());
    // --- W8-T4 disk toolkit ---
    app.use(createDiskRouter());
    // --- W8-T3 patch center ---
    app.use(createPatchRouter());
    // --- W8-T2 Kubernetes ---
    app.use(createK8sRouter());

    app.use(notFound);
    app.use(errorHandler);

    return app;
}
