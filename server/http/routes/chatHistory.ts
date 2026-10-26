import { Router } from "express";
import { CHAT_ERROR_CODES, MAX_EVIDENCE_CHARS, type StoredChatMessage } from "../../../shared/chat";
import { evidenceChars, parseChatEvidence } from "../../../shared/chatEvidence";
import { MAX_PERSISTED_CHAT_MESSAGES, MAX_PERSISTED_MESSAGE_CHARS } from "../../../shared/models";
import { chatHistoryRepo } from "../../db/chatHistoryRepo";
import { AppError } from "../../errors";
import { sendError } from "../respond";

type RawMessage = { role?: unknown; content?: unknown; kind?: unknown; command?: unknown; partial?: unknown; evidence?: unknown };

// The section headers and clipping marks push evidence a little past the
// limit its text is fitted to.
const MAX_STORED_EVIDENCE_CHARS = MAX_EVIDENCE_CHARS + 2000;

// Keeps valid turns only; a "command-output" turn (the output of an Auto-Run
// command) keeps its kind and command, a stopped or cut-off answer its
// `partial` mark, the question of a diagnosis its (well-formed) evidence.
function toStoredMessage(value: unknown): StoredChatMessage | null {
    const raw = (value && typeof value === "object" ? value : {}) as RawMessage;
    if ((raw.role !== "user" && raw.role !== "assistant") || typeof raw.content !== "string" || raw.content.trim() === "") return null;

    const message: StoredChatMessage = { role: raw.role, content: raw.content.slice(0, MAX_PERSISTED_MESSAGE_CHARS) };
    if (raw.kind === "command-output" && raw.role === "user") {
        message.kind = "command-output";
        if (typeof raw.command === "string") message.command = raw.command.slice(0, MAX_PERSISTED_MESSAGE_CHARS);
    }
    if (raw.partial === true && raw.role === "assistant") message.partial = true;
    if (raw.role === "user" && raw.evidence !== undefined) {
        const evidence = parseChatEvidence(raw.evidence);
        if (evidence && evidenceChars(evidence) <= MAX_STORED_EVIDENCE_CHARS) message.evidence = evidence;
    }
    return message;
}

// Per-server chat history (so conversations survive reloads/switches).
export function createChatHistoryRouter(): Router {
    const router = Router();

    router.get("/api/chat/history/:serverId", async (req, res) => {
        try {
            res.json({ messages: await chatHistoryRepo.get(String(req.params.serverId)) });
        } catch (err) {
            sendError(res, err, "GET /api/chat/history");
        }
    });

    router.put("/api/chat/history/:serverId", async (req, res) => {
        const incoming: unknown[] | null = Array.isArray(req.body?.messages) ? req.body.messages : null;
        if (!incoming) {
            sendError(res, new AppError(CHAT_ERROR_CODES.invalidRequest, "messages array is required", 400, { field: "messages" }), "PUT /api/chat/history");
            return;
        }

        const messages = incoming
            .map(toStoredMessage)
            .filter((message): message is StoredChatMessage => message !== null)
            .slice(-MAX_PERSISTED_CHAT_MESSAGES);

        try {
            await chatHistoryRepo.save(String(req.params.serverId), messages);
            res.json({ message: "success", count: messages.length });
        } catch (err) {
            sendError(res, err, "PUT /api/chat/history");
        }
    });

    router.delete("/api/chat/history/:serverId", async (req, res) => {
        try {
            res.json({ message: "deleted", changes: await chatHistoryRepo.delete(String(req.params.serverId)) });
        } catch (err) {
            sendError(res, err, "DELETE /api/chat/history");
        }
    });

    return router;
}
