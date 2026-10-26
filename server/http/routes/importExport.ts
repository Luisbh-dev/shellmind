import { Router } from "express";
import { serversRepo } from "../../db/serversRepo";
import { exportConfig, importConfig, previewConfigImport } from "../../importers/configBundle";
import { applySshConfigImport, pastedSshConfig, readUserSshConfig, resolveSshConfig } from "../../importers/sshConfig";
import { AppError } from "../../errors";
import { jsonBody, sendError } from "../respond";

// Importing hosts from ~/.ssh/config, and exporting / importing the
// configuration as JSON (servers without secrets, snippets, tunnels).
export function createImportExportRouter(): Router {
    const router = Router();

    // Without `text` the backend reads the ~/.ssh/config of the user it runs
    // as (the desktop app's user). Nothing is saved.
    router.post("/api/import/ssh-config/preview", async (req, res) => {
        try {
            const { text } = jsonBody(req);
            if (text !== undefined && typeof text !== "string") throw new AppError("INVALID_IMPORT", "text must be a string", 400);
            const source = typeof text === "string" ? pastedSshConfig(text) : readUserSshConfig();
            res.json(resolveSshConfig(source, await serversRepo.listSummaries()));
        } catch (err) {
            sendError(res, err, "POST /api/import/ssh-config/preview");
        }
    });

    router.post("/api/import/ssh-config/apply", async (req, res) => {
        try {
            res.json(await applySshConfigImport(jsonBody(req)));
        } catch (err) {
            sendError(res, err, "POST /api/import/ssh-config/apply");
        }
    });

    router.get("/api/export", async (_req, res) => {
        try {
            res.json(await exportConfig());
        } catch (err) {
            sendError(res, err, "GET /api/export");
        }
    });

    // The UI previews first and shows the local commands and tunnels a file
    // would add before it applies it (POST /api/import, same body).
    router.post("/api/import/preview", async (req, res) => {
        try {
            res.json(await previewConfigImport(jsonBody(req)));
        } catch (err) {
            sendError(res, err, "POST /api/import/preview");
        }
    });

    // W7-S2: ?link_credentials=1 is the user's consent to what the preview
    // listed in review.credentials. It is a query parameter so that the file
    // (the body) cannot give it.
    router.post("/api/import", async (req, res) => {
        try {
            const consent = req.query.link_credentials;
            res.json(await importConfig(jsonBody(req), { linkCredentials: consent === "1" || consent === "true" }));
        } catch (err) {
            sendError(res, err, "POST /api/import");
        }
    });

    return router;
}
