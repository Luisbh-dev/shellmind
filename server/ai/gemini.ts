import { ApiError, GoogleGenAI, HarmBlockThreshold, HarmCategory, type Content, type GenerateContentConfig } from "@google/genai";
import type { ChatStopReason } from "../../shared/chat";
import { findModel } from "../../shared/models";
import type { ChatTurn } from "../../shared/types";
import { AiProviderError, isRetryable, summarizeErrorText } from "./errors";
import type { GenerationResult } from "./minimax";
import { createUpstreamWatchdog, defaultTimeouts, type UpstreamTimeouts } from "./watchdog";

export type GeminiRequest = {
    apiKey: string;
    model: string;
    system: string;
    // Alternating turns, starting and ending with "user".
    turns: ChatTurn[];
    onDelta?: (text: string) => void;
    signal?: AbortSignal;
    timeouts?: UpstreamTimeouts;
    // Another API endpoint (tests).
    baseUrl?: string;
};

const SAFETY_SETTINGS = [
    HarmCategory.HARM_CATEGORY_HARASSMENT,
    HarmCategory.HARM_CATEGORY_HATE_SPEECH,
    HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT,
    HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT
].map((category) => ({ category, threshold: HarmBlockThreshold.BLOCK_NONE }));

function toStopReason(finishReason: string | undefined): ChatStopReason {
    if (finishReason === "STOP") return "end_turn";
    if (finishReason === "MAX_TOKENS") return "max_tokens";
    return "other";
}

// Gemma models reject systemInstruction, so for them the system prompt rides
// as an opening exchange instead.
export function buildGeminiContents(system: string, turns: ChatTurn[], useSystemInstruction: boolean): Content[] {
    const contents: Content[] = turns.map((turn) => ({
        role: turn.role === "assistant" ? "model" : "user",
        parts: [{ text: turn.content }]
    }));
    if (useSystemInstruction) return contents;
    return [
        { role: "user", parts: [{ text: system }] },
        { role: "model", parts: [{ text: "Understood. I will follow these rules and treat data blocks as data." }] },
        ...contents
    ];
}

function toProviderError(err: unknown): AiProviderError {
    if (err instanceof AiProviderError) return err;
    if (err instanceof ApiError) {
        return new AiProviderError("gemini", `${err.status} ${summarizeErrorText(err.message)}`, { status: err.status, cause: err });
    }
    const message = (err as Error)?.message || String(err);
    return new AiProviderError("gemini", summarizeErrorText(message), { retryable: isRetryable(undefined, message), cause: err });
}

export async function callGemini(request: GeminiRequest): Promise<GenerationResult> {
    const useSystemInstruction = findModel(request.model)?.systemInstruction !== false;
    const client = new GoogleGenAI({
        apiKey: request.apiKey,
        ...(request.baseUrl ? { httpOptions: { baseUrl: request.baseUrl } } : {})
    });
    const watchdog = createUpstreamWatchdog(request.signal, request.timeouts ?? defaultTimeouts(Boolean(request.onDelta)));
    const config: GenerateContentConfig = {
        abortSignal: watchdog.signal,
        safetySettings: SAFETY_SETTINGS,
        ...(useSystemInstruction ? { systemInstruction: request.system } : {})
    };
    const params = { model: request.model, contents: buildGeminiContents(request.system, request.turns, useSystemInstruction), config };

    let text = "";
    let finishReason: string | undefined;
    try {
        if (request.onDelta) {
            const stream = await client.models.generateContentStream(params);
            watchdog.connected();
            for await (const chunk of stream) {
                watchdog.activity();
                const delta = chunk.text;
                if (delta) {
                    text += delta;
                    request.onDelta(delta);
                }
                finishReason = chunk.candidates?.[0]?.finishReason ?? finishReason;
            }
        } else {
            const response = await client.models.generateContent(params);
            text = response.text ?? "";
            finishReason = response.candidates?.[0]?.finishReason;
        }
    } catch (err) {
        if (request.signal?.aborted) throw err;
        const timeout = watchdog.timeoutError();
        if (timeout) throw new AiProviderError("gemini", timeout.message, { retryable: true, type: "timeout", cause: err });
        throw toProviderError(err);
    } finally {
        watchdog.dispose();
    }

    if (!text.trim()) {
        throw new AiProviderError("gemini", `Gemini returned no text (finish reason: ${finishReason ?? "unknown"}).`, { retryable: false });
    }
    return { text, stopReason: toStopReason(finishReason) };
}
