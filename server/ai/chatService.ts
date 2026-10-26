import { CHAT_ERROR_CODES, type ChatAttachment, type ChatCommandOutput, type ChatEvidence, type ChatPurpose, type ChatStopReason, type ChatTerminalShell } from "../../shared/chat";
import { findModel, isKnownModel, resolveModelId } from "../../shared/models";
import { serversRepo } from "../db/serversRepo";
import { settingsRepo } from "../db/settingsRepo";
import { AppError } from "../errors";
import { createLogger } from "../logger";
import { buildConversation, type Conversation } from "./conversation";
import { collectEvidence } from "./diagnose/collect";
import { resolveChatEnvironment, type ChatEnvironment } from "./environment";
import { AiProviderError } from "./errors";
import { generateWithFallback } from "./fallback";
import { callGemini } from "./gemini";
import { sanitizeChatHistory } from "./history";
import { callMiniMax, type GenerationResult } from "./minimax";
import { AI_PROVIDER_CONFIG, getProviderApiKey, getProviderKey } from "./providers";
import { buildOutOfScopeResponse, isOutOfScopeAiRequest } from "./scope";
import { newDataId } from "./untrusted";

// One chat answer, independent of the HTTP transport: the route adapts it to
// JSON or Server-Sent Events.

const log = createLogger("chat");

export type ChatInput = {
    purpose: ChatPurpose;
    message: string;
    model?: string;
    history?: unknown;
    serverId?: number;
    osDetail?: string;
    terminalOutput?: string;
    issues?: string[];
    commandOutput?: ChatCommandOutput;
    // The focused terminal tab is a shell inside this container.
    terminalShell?: ChatTerminalShell;
    autoRun?: boolean;
    // Purpose "diagnose": what to diagnose, and the (verified) evidence the
    // user was shown; without it the evidence is collected first.
    attachment?: ChatAttachment;
    evidence?: ChatEvidence;
    // The UI language ("en", "es").
    language?: string;
};

export type PrepareOptions = {
    // Cancels the evidence collection of a diagnosis sent without evidence.
    signal?: AbortSignal;
};

export type ChatHooks = {
    onModel?: (model: string) => void;
    onDelta?: (text: string) => void;
    signal: AbortSignal;
};

export type ChatResult = { text: string; usedModel: string; stopReason: ChatStopReason };

export type PreparedChat =
    // Answered without a model (out-of-scope first message).
    | { kind: "canned"; text: string }
    | { kind: "generate"; model: string; environment: ChatEnvironment; generate: (hooks: ChatHooks) => Promise<ChatResult | null> };

// The requested model, else the saved preference, else the default. Unknown
// ids (a stale preference, an old client) fall back to the default model.
export async function resolveChatModel(requested: string | undefined): Promise<string> {
    if (requested) {
        if (!isKnownModel(requested)) log.warn(`Unknown model "${requested}" requested; using the default model.`);
        return resolveModelId(requested);
    }
    const preferred = await settingsRepo.get("PREFERRED_MODEL").catch(() => null);
    if (preferred && !isKnownModel(preferred)) log.warn(`Saved model preference "${preferred}" is unknown; using the default model.`);
    return resolveModelId(preferred);
}

function scopeContext(environment: ChatEnvironment): string {
    return environment.kind === "none" ? "" : `${environment.serverType ?? ""} server ${environment.kind} shell`;
}

async function runModel(modelId: string, conversation: Conversation, hooks: ChatHooks): Promise<GenerationResult> {
    hooks.onModel?.(modelId);
    const provider = findModel(modelId)?.provider ?? "gemini";
    const apiKey = await getProviderApiKey(provider);
    const common = { model: modelId, system: conversation.system, turns: conversation.turns, onDelta: hooks.onDelta, signal: hooks.signal };

    if (provider === "minimax") return callMiniMax({ ...common, clientApiKey: apiKey });
    if (!apiKey) throw new AiProviderError("gemini", `${AI_PROVIDER_CONFIG.gemini.envKey} is not configured.`, { retryable: false });
    return callGemini({ ...common, apiKey });
}

export async function prepareChat(input: ChatInput, options: PrepareOptions = {}): Promise<PreparedChat> {
    const server = input.serverId ? await serversRepo.getSummary(input.serverId) : null;
    const environment = resolveChatEnvironment({ server, osDetail: input.osDetail, terminalOutput: input.terminalOutput });

    // The keyword pre-filter is blunt (e.g. "code"/"api" trip it), so it only
    // gates the first message; ongoing conversations are governed by the scope
    // rules of the system prompt.
    if (input.purpose === "chat" && sanitizeChatHistory(input.history, "").length === 0 && isOutOfScopeAiRequest(input.message, scopeContext(environment))) {
        return { kind: "canned", text: buildOutOfScopeResponse(input.message) };
    }

    const model = await resolveChatModel(input.model);
    const provider = findModel(model)?.provider ?? "gemini";
    const key = provider === "gemini" ? await getProviderKey(provider) : null;
    if (key?.unreadable) {
        throw new AppError(
            CHAT_ERROR_CODES.keyUnreadable,
            `The saved ${AI_PROVIDER_CONFIG.gemini.label} API key cannot be decrypted (the data key changed). Enter it again in Settings.`,
            409,
            { provider }
        );
    }
    if (key && !key.apiKey) {
        throw new AppError(
            CHAT_ERROR_CODES.keyMissing,
            `Please set your ${AI_PROVIDER_CONFIG.gemini.envKey} in Settings or Environment variables.`,
            409,
            { provider }
        );
    }

    // A diagnosis without the evidence the user saw (API clients): collect it now.
    const evidence = input.purpose === "diagnose" && input.attachment && input.serverId && !input.evidence
        ? await collectEvidence(input.serverId, input.attachment, { signal: options.signal })
        : input.evidence;

    const generate = async (hooks: ChatHooks): Promise<ChatResult | null> => {
        const conversation = buildConversation({ ...input, evidence, environment, dataId: newDataId() });
        let streamed = false;
        const onDelta = hooks.onDelta
            ? (text: string) => {
                streamed = true;
                hooks.onDelta?.(text);
            }
            : undefined;

        log.debug(`Generating with ${model} (${provider}, ${environment.kind} environment, purpose ${input.purpose}).`);
        const result = await generateWithFallback(
            (modelId) => runModel(modelId, conversation, { ...hooks, onDelta }),
            model,
            { signal: hooks.signal, hasStreamed: () => streamed }
        );
        if (!result) return null;
        return { text: result.text, usedModel: result.usedModel, stopReason: result.stopReason };
    };

    return { kind: "generate", model, environment, generate };
}
