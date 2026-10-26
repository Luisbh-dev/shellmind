// The AI models ShellMind offers, their fallbacks and token budgets, plus the
// conversation limits. One list, used by the backend (routing, fallback,
// validation) and by the chat UI (model picker).
import type { AiProvider } from "./types";

export type ModelInfo = {
    id: string;
    label: string;
    provider: AiProvider;
    // Tried once when this model fails with a retryable error (rate limit,
    // overload, timeout) before any text was streamed. Never the model itself.
    fallback?: string;
    // Anthropic-style max_tokens (includes reasoning tokens).
    maxTokens?: number;
    // Extra fields of an Anthropic-style (MiniMax) request body.
    params?: Readonly<Record<string, unknown>>;
    // Models that reject systemInstruction get the prompt in the first turn.
    systemInstruction?: boolean;
    recommended?: boolean;
};

// MiniMax M2.5/M2.7 were closed to new users on 2026-10-19 and retire on
// 2026-11-18; Gemini 3 Flash preview and Gemma were superseded by the Gemini
// 3.x stable line.
export const MODELS: readonly ModelInfo[] = [
    { id: "MiniMax-M3", label: "MiniMax M3", provider: "minimax", fallback: "MiniMax-M3.1-Flash", recommended: true },
    // Always thinks: a larger budget (reasoning counts against max_tokens) and
    // a low effort keep it responsive in an interactive console.
    {
        id: "MiniMax-M3.1-Flash",
        label: "MiniMax M3.1 Flash",
        provider: "minimax",
        fallback: "MiniMax-M3",
        maxTokens: 16384,
        params: { output_config: { effort: "low" } }
    },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash", provider: "gemini", fallback: "gemini-3.5-flash-lite" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite", provider: "gemini", fallback: "gemini-3.8-flash" },
    { id: "gemini-4-argon", label: "Gemini 4 Argon", provider: "gemini", fallback: "gemini-3.8-flash" }
];

export const DEFAULT_MODEL = "MiniMax-M3";
export const DEFAULT_MAX_TOKENS = 8192;

// Retired or renamed ids that older versions may have saved as the preferred
// model, mapped to their successor.
export const MODEL_ALIASES: Readonly<Record<string, string>> = {
    "MiniMax-M2.7": "MiniMax-M3",
    "MiniMax-M2.7-highspeed": "MiniMax-M3.1-Flash",
    "MiniMax-M2.5": "MiniMax-M3",
    "MiniMax-M2.5-highspeed": "MiniMax-M3.1-Flash",
    "gemini-3-flash-preview": "gemini-3.8-flash",
    "gemini-2.5-flash": "gemini-3.8-flash",
    "gemma-3-27b-it": "gemini-3.5-flash-lite"
};

export function findModel(id: string | null | undefined): ModelInfo | undefined {
    if (!id) return undefined;
    const canonical = MODEL_ALIASES[id] ?? id;
    return MODELS.find((model) => model.id === canonical);
}

// A model the chat offers, or a retired id that maps onto one.
export function isKnownModel(id: unknown): boolean {
    return typeof id === "string" && findModel(id) !== undefined;
}

// A served model id for `id`: its successor when it was retired, or the
// default model when it is missing or unknown (e.g. a stale saved preference).
export function resolveModelId(id: string | null | undefined): string {
    return findModel(id)?.id ?? DEFAULT_MODEL;
}

export function fallbackModelFor(id: string): string | undefined {
    const model = findModel(id);
    const fallback = model?.fallback;
    return fallback && fallback !== model.id ? fallback : undefined;
}

export function maxTokensFor(id: string): number {
    return findModel(id)?.maxTokens ?? DEFAULT_MAX_TOKENS;
}

// Conversation history sent with each chat request (the server enforces it
// too; the client trims first so requests stay small).
export const MAX_HISTORY_TURNS = 12;
export const MAX_HISTORY_TURN_CHARS = 4000;

// Messages kept per server by the chat history API, and the size of each.
export const MAX_PERSISTED_CHAT_MESSAGES = 100;
export const MAX_PERSISTED_MESSAGE_CHARS = 20_000;

// A single chat message typed (or pasted) by the user.
export const MAX_CHAT_MESSAGE_CHARS = 48_000;

// Untrusted context sent with a request: recent terminal output, the output
// of an auto-run command, and the latest terminal issues.
export const MAX_TERMINAL_CONTEXT_CHARS = 6000;
export const MAX_TERMINAL_CONTEXT_LINES = 50;
export const MAX_COMMAND_OUTPUT_CHARS = 8000;
export const MAX_CONTEXT_ISSUES = 8;
export const MAX_CONTEXT_ISSUE_CHARS = 600;
