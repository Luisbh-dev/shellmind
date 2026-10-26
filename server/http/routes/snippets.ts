import { Router } from "express";
import { SNIPPET_LIMITS } from "../../../shared/snippets";
import { AppError } from "../../errors";
import { snippetsRepo } from "../../snippets/repo";
import { invalidSnippet, parseSnippetInput } from "../../snippets/validate";
import { jsonBody, routeId, sendError } from "../respond";

const snippetNotFound = () => new AppError("SNIPPET_NOT_FOUND", "Snippet not found", 404);

export function createSnippetsRouter(): Router {
    const router = Router();

    // ?serverId=<id>: only the snippets usable on that server (global + its own).
    router.get("/api/snippets", async (req, res) => {
        try {
            let serverId: number | undefined;
            if (req.query.serverId !== undefined) {
                const id = routeId(req.query.serverId);
                if (id === null) throw invalidSnippet("serverId must be a positive integer");
                serverId = id;
            }
            res.json({ message: "success", data: await snippetsRepo.list({ serverId }) });
        } catch (err) {
            sendError(res, err, "GET /api/snippets");
        }
    });

    router.post("/api/snippets", async (req, res) => {
        try {
            const snippet = await snippetsRepo.create(parseSnippetInput(jsonBody(req)));
            res.status(201).json({ message: "success", data: snippet });
        } catch (err) {
            sendError(res, err, "POST /api/snippets");
        }
    });

    // { snippets: SnippetInput[] } -> { created, skipped }
    router.post("/api/snippets/import", async (req, res) => {
        try {
            const { snippets } = jsonBody(req);
            if (!Array.isArray(snippets) || snippets.length === 0) throw invalidSnippet("snippets must be a non-empty array");
            if (snippets.length > SNIPPET_LIMITS.import) throw invalidSnippet(`at most ${SNIPPET_LIMITS.import} snippets can be imported at once`);
            const inputs = snippets.map((item, index) => {
                if (!item || typeof item !== "object" || Array.isArray(item)) throw invalidSnippet(`snippet #${index + 1} must be an object`);
                try {
                    return parseSnippetInput(item as Record<string, unknown>);
                } catch (err) {
                    if (err instanceof AppError) throw new AppError(err.code, `snippet #${index + 1}: ${err.message}`, err.status, err.details);
                    throw err;
                }
            });
            res.json({ message: "success", data: await snippetsRepo.importMany(inputs) });
        } catch (err) {
            sendError(res, err, "POST /api/snippets/import");
        }
    });

    router.get("/api/snippets/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            const snippet = id === null ? null : await snippetsRepo.get(id);
            if (!snippet) throw snippetNotFound();
            res.json({ message: "success", data: snippet });
        } catch (err) {
            sendError(res, err, "GET /api/snippets/:id");
        }
    });

    router.put("/api/snippets/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            if (id === null) throw snippetNotFound();
            const snippet = await snippetsRepo.update(id, parseSnippetInput(jsonBody(req)));
            if (!snippet) throw snippetNotFound();
            res.json({ message: "success", data: snippet });
        } catch (err) {
            sendError(res, err, "PUT /api/snippets/:id");
        }
    });

    router.delete("/api/snippets/:id", async (req, res) => {
        const id = routeId(req.params.id);
        try {
            if (id === null || !(await snippetsRepo.remove(id))) throw snippetNotFound();
            res.json({ message: "deleted", changes: 1 });
        } catch (err) {
            sendError(res, err, "DELETE /api/snippets/:id");
        }
    });

    return router;
}
