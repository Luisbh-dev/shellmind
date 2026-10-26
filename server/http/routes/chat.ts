import { Router, type Request, type Response } from "express";
import {
    CHAT_ERROR_CODES,
    CHAT_PURPOSES,
    type ChatAttachment,
    type ChatCommandOutput,
    type ChatEvidenceResponse,
    type ChatJsonResponse,
    type ChatPurpose,
    type ChatStreamEvent,
    type ChatTerminalShell
} from "../../../shared/chat";
import { parseChatAttachment } from "../../../shared/chatEvidence";
import { isValidContainerRef } from "../../../shared/ops";
import {
    MAX_CHAT_MESSAGE_CHARS,
    MAX_COMMAND_OUTPUT_CHARS,
    MAX_CONTEXT_ISSUES,
    MAX_CONTEXT_ISSUE_CHARS,
    MAX_PERSISTED_CHAT_MESSAGES
} from "../../../shared/models";
import { prepareChat, type ChatInput } from "../../ai/chatService";
import { collectEvidence, verifyEvidence } from "../../ai/diagnose/collect";
import { isAiProviderError } from "../../ai/errors";
import { parsePodAttach } from "../../k8s/validate";
import { AppError, errorMessage } from "../../errors";
import { createLogger } from "../../logger";
import { abortOnClose, sendRemoteError } from "../remote";
import { jsonBody, sendError } from "../respond";
import { createSseStream } from "../sse";

const log = createLogger("chat");

// Untrusted context is capped again here (the UI already trims it).
const MAX_TERMINAL_OUTPUT_BODY_CHARS = 64_000;
const MAX_OS_DETAIL_CHARS = 200;
const MAX_COMMAND_CHARS = 8000;

// SSE comment lines sent while nothing else is: a model that thinks for a
// minute must not look idle to a reverse proxy (nginx cuts after 60 s).
export const CHAT_HEARTBEAT_MS = 15_000;

export type ChatRouterOptions = { heartbeatMs?: number };

const invalid = (message: string) => new AppError(CHAT_ERROR_CODES.invalidRequest, message, 400);

const optionalString = (value: unknown, name: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string") throw invalid(`${name} must be a string.`);
    return value;
};

function parseCommandOutput(value: unknown): ChatCommandOutput | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "object" || Array.isArray(value)) throw invalid("commandOutput must be an object.");
    const { command, output, truncated, stillRunning } = value as Record<string, unknown>;
    if (typeof command !== "string" || typeof output !== "string") throw invalid("commandOutput needs command and output strings.");
    return {
        command: command.slice(0, MAX_COMMAND_CHARS),
        // Keep the end: errors are usually printed last.
        output: output.slice(-MAX_COMMAND_OUTPUT_CHARS * 2),
        truncated: truncated === true || output.length > MAX_COMMAND_OUTPUT_CHARS * 2,
        stillRunning: stillRunning === true
    };
}

function parseServerId(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (!(typeof value === "number" && Number.isSafeInteger(value) && value > 0)) throw invalid("serverId must be a positive integer.");
    return value;
}

function requireAttachment(value: unknown): ChatAttachment {
    const attachment = parseChatAttachment(value);
    if (!attachment) throw invalid("attachment is missing or malformed.");
    return attachment;
}

// The container whose shell the focused terminal tab is (only its engine
// and a valid container name or id: the text reaches the model).
function parseTerminalShell(value: unknown): ChatTerminalShell | undefined {
    if (value === undefined || value === null) return undefined;
    // W8-T2: a shell inside a Kubernetes pod (validated names only).
    if (typeof value === "object" && (value as { kind?: unknown }).kind === "pod") {
        try {
            return parsePodAttach(value);
        } catch {
            throw invalid("terminalShell must name a pod shell (kind, context, namespace, pod, container).");
        }
    }
    const shell = value as Partial<Extract<ChatTerminalShell, { kind: "container" }>>;
    if (typeof value !== "object" || shell.kind !== "container" || (shell.engine !== "docker" && shell.engine !== "podman")
        || typeof shell.container !== "string" || !isValidContainerRef(shell.container)) {
        throw invalid("terminalShell must name a container shell (kind, engine, container).");
    }
    return { kind: "container", engine: shell.engine, container: shell.container };
}

const DIAGNOSE_UNSUPPORTED = "A diagnosis is only available for SSH-capable servers.";

// Validates the body of POST /api/chat (see ChatRequestBody).
export function parseChatRequest(req: Request): ChatInput & { stream: boolean } {
    const body = jsonBody(req);

    const purpose = (body.purpose ?? "chat") as ChatPurpose;
    if (!CHAT_PURPOSES.includes(purpose)) throw invalid(`Unknown purpose "${String(body.purpose)}".`);

    const message = optionalString(body.message, "message")?.trim() ?? "";
    if (purpose === "chat" && !message) throw invalid("message is required.");
    if (message.length > MAX_CHAT_MESSAGE_CHARS) throw invalid(`message is too long (max ${MAX_CHAT_MESSAGE_CHARS} characters).`);

    const commandOutput = parseCommandOutput(body.commandOutput);
    if (purpose === "autorun-step" && !commandOutput) throw invalid("commandOutput is required for an auto-run step.");

    if (body.history !== undefined && !Array.isArray(body.history)) throw invalid("history must be an array.");
    if (Array.isArray(body.history) && body.history.length > MAX_PERSISTED_CHAT_MESSAGES * 2) throw invalid("history is too long.");

    if (body.issues !== undefined && !Array.isArray(body.issues)) throw invalid("issues must be an array.");
    const issues = Array.isArray(body.issues)
        ? body.issues.filter((issue): issue is string => typeof issue === "string").slice(-MAX_CONTEXT_ISSUES).map((issue) => issue.slice(0, MAX_CONTEXT_ISSUE_CHARS))
        : undefined;

    const serverId = parseServerId(body.serverId);

    // A diagnosis names what it is about and carries the evidence the user
    // saw, which only counts as collected by ShellMind if its signature holds.
    let diagnosis: Pick<ChatInput, "attachment" | "evidence" | "language"> = {};
    if (purpose === "diagnose") {
        if (serverId === undefined) throw invalid("serverId is required for a diagnosis.");
        const attachment = requireAttachment(body.attachment);
        const language = optionalString(body.language, "language");
        diagnosis = {
            attachment,
            evidence: body.evidence === undefined || body.evidence === null ? undefined : verifyEvidence(body.evidence, serverId, attachment),
            language: language && /^[a-z]{2}$/.test(language) ? language : undefined
        };
    }

    return {
        purpose,
        message,
        ...diagnosis,
        model: optionalString(body.model, "model") || undefined,
        history: body.history,
        serverId,
        osDetail: optionalString(body.osDetail, "osDetail")?.slice(0, MAX_OS_DETAIL_CHARS),
        terminalOutput: optionalString(body.terminalOutput, "terminalOutput")?.slice(-MAX_TERMINAL_OUTPUT_BODY_CHARS),
        issues,
        commandOutput,
        terminalShell: parseTerminalShell(body.terminalShell),
        autoRun: body.autoRun === true,
        stream: body.stream === true
    };
}

// Writes a comment line every `intervalMs` until the response closes (clients
// ignore comments). Returns the function that stops it.
function startHeartbeat(res: Response, intervalMs: number): () => void {
    const timer = setInterval(() => {
        if (!res.writableEnded && !res.destroyed) res.write(": ping\n\n");
    }, intervalMs);
    const stop = () => clearInterval(timer);
    res.once("close", stop);
    return stop;
}

export function createChatRouter(options: ChatRouterOptions = {}): Router {
    const router = Router();
    const heartbeatMs = options.heartbeatMs ?? CHAT_HEARTBEAT_MS;

    // The evidence of a diagnosis (ChatEvidenceRequest -> ChatEvidenceResponse),
    // collected on the saved server with read-only commands built here from
    // the attachment's validated names. The client shows it to the user, who
    // then sends it with the question. Leaving cancels the collection.
    router.post("/api/chat/evidence", async (req, res) => {
        const request = abortOnClose(res);
        try {
            const body = jsonBody(req);
            const serverId = parseServerId(body.serverId);
            if (serverId === undefined) throw invalid("serverId is required.");
            const evidence = await collectEvidence(serverId, requireAttachment(body.attachment), { signal: request.signal });
            res.json({ evidence } satisfies ChatEvidenceResponse);
        } catch (err) {
            if (!request.signal.aborted) sendRemoteError(res, err, "POST /api/chat/evidence", DIAGNOSE_UNSUPPORTED);
        } finally {
            request.dispose();
        }
    });

    // Answers with one JSON payload ({response, usedModel, stopReason}), or with
    // `stream: true` as Server-Sent Events (shared/chat.ts ChatStreamEvent).
    // Validation and configuration errors are JSON ({error, code}) in both
    // modes; once the stream started, failures arrive as an "error" event.
    // Closing the connection aborts the upstream provider request.
    router.post("/api/chat", async (req, res) => {
        const upstreamAbort = new AbortController();
        const sse = createSseStream(res, () => upstreamAbort.abort());
        let stopHeartbeat = () => {};
        const startStream = () => {
            sse.start();
            stopHeartbeat = startHeartbeat(res, heartbeatMs);
        };
        // A JSON client that disconnects also cancels the generation.
        res.on("close", () => {
            if (!res.writableEnded) upstreamAbort.abort();
        });

        let wantsStream = false;
        let diagnosing = false;
        try {
            const input = parseChatRequest(req);
            wantsStream = input.stream;
            diagnosing = input.purpose === "diagnose";
            const prepared = await prepareChat(input, { signal: upstreamAbort.signal });

            if (prepared.kind === "canned") {
                if (!wantsStream) return void res.json({ response: prepared.text } satisfies ChatJsonResponse);
                sse.start();
                sse.send({ type: "delta", text: prepared.text } satisfies ChatStreamEvent);
                sse.send({ type: "done", usedModel: null, fullText: prepared.text } satisfies ChatStreamEvent);
                sse.end();
                return;
            }

            if (wantsStream) startStream();
            const result = await prepared.generate({
                signal: upstreamAbort.signal,
                onModel: wantsStream ? (model) => sse.send({ type: "model", model } satisfies ChatStreamEvent) : undefined,
                onDelta: wantsStream ? (text) => sse.send({ type: "delta", text } satisfies ChatStreamEvent) : undefined
            });

            if (!result) {
                sse.end();
                return;
            }

            const stopReason = result.stopReason === "end_turn" ? undefined : result.stopReason;
            if (wantsStream) {
                sse.send({ type: "done", usedModel: result.usedModel, fullText: result.text, ...(stopReason ? { stopReason } : {}) } satisfies ChatStreamEvent);
                sse.end();
                return;
            }
            res.json({ response: result.text, usedModel: result.usedModel, ...(stopReason ? { stopReason } : {}) } satisfies ChatJsonResponse);
        } catch (err) {
            if (upstreamAbort.signal.aborted) {
                sse.end();
                return;
            }

            const providerFailure = isAiProviderError(err);
            if (providerFailure) log.warn(`AI provider error: ${err.message}`);

            if (sse.started()) {
                const code = providerFailure ? CHAT_ERROR_CODES.provider : err instanceof AppError ? err.code : undefined;
                if (!providerFailure && !(err instanceof AppError)) log.error("Chat generation failed", err);
                sse.send({ type: "error", message: errorMessage(err), ...(code ? { code } : {}) } satisfies ChatStreamEvent);
                sse.end();
                return;
            }
            if (providerFailure) {
                res.status(502).json({ error: err.message, code: CHAT_ERROR_CODES.provider });
                return;
            }
            const context = `POST /api/chat${wantsStream ? " (stream)" : ""}`;
            // Collecting the evidence can fail like any remote command.
            if (diagnosing) sendRemoteError(res, err, context, DIAGNOSE_UNSUPPORTED);
            else sendError(res, err, context);
        } finally {
            stopHeartbeat();
        }
    });

    return router;
}
