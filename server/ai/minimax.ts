import http from "http";
import https from "https";
import type { ChatStopReason } from "../../shared/chat";
import { findModel, maxTokensFor } from "../../shared/models";
import { createSseParser } from "../../shared/sse";
import type { ChatTurn } from "../../shared/types";
import {
    ALLOW_CLIENT_MINIMAX_KEY,
    MINIMAX_API_BASE_URL,
    MINIMAX_PROXY_API_KEY,
    MINIMAX_PROXY_BASE_URL,
    MINIMAX_PROXY_BEARER_TOKEN
} from "../config";
import { createLogger } from "../logger";
import { AiProviderError, summarizeErrorText } from "./errors";
import { createUpstreamWatchdog, defaultTimeouts, type UpstreamTimeouts, type UpstreamWatchdog } from "./watchdog";

// MiniMax models speak the Anthropic Messages API. With the user's own key
// they are called directly at MiniMax (MINIMAX_API_BASE_URL), so the key never
// reaches a third party; without one, through the ShellMind proxy
// (MINIMAX_PROXY_URL, by default https://ai-proxy.luisbh.com), which holds a
// managed key. Streaming and JSON answers share one attempt policy
// (nextMiniMaxStep), so a fix in one mode cannot miss the other.

const log = createLogger("minimax");

export type GenerationResult = { text: string; stopReason: ChatStopReason };

export type MiniMaxRequest = {
    model: string;
    system: string;
    // Alternating turns, starting and ending with "user".
    turns: ChatTurn[];
    // The user's own MiniMax key: requests go straight to MiniMax with it.
    clientApiKey: string | null;
    // Streams text deltas when given; otherwise the API answers in JSON.
    onDelta?: (text: string) => void;
    signal?: AbortSignal;
    timeouts?: UpstreamTimeouts;
    // Other endpoints (tests): the ShellMind proxy and MiniMax's own API.
    proxyBaseUrl?: string;
    apiBaseUrl?: string;
};

// direct: MiniMax's API with the user's key; otherwise the ShellMind proxy.
export type AttemptPlan = { direct: boolean; forceFinal: boolean };

export type AttemptOutcome =
    | { kind: "text"; text: string; stopReason: ChatStopReason }
    // The model finished with thinking only (no final text block).
    | { kind: "empty"; detail: string }
    | { kind: "http-error"; status: number; message: string; type?: string };

export type AttemptStep =
    | { action: "return"; result: GenerationResult }
    | { action: "retry"; plan: AttemptPlan; reason: string }
    | { action: "fail"; error: AiProviderError };

export const MAX_MINIMAX_ATTEMPTS = 3;

const FORCED_FINAL_SUFFIX = "\n\nIMPORTANT: Return a final user-facing answer as a text block. Do not return thinking only.";

// A rejected user key (and only that) is worth retrying through the proxy;
// input errors such as "prompt too long" are not.
export function isClientKeyRejection(status: number, message: string): boolean {
    if (status === 401 || status === 403) return true;
    return status >= 400 && status < 500 && /api[ _-]?key|unauthori[sz]ed|authenticat|forbidden/i.test(message);
}

// The attempt policy: what to do after an attempt ended with `outcome`.
export function nextMiniMaxStep(plan: AttemptPlan, outcome: AttemptOutcome, attempt: number): AttemptStep {
    const canRetry = attempt < MAX_MINIMAX_ATTEMPTS;

    if (outcome.kind === "text") {
        return { action: "return", result: { text: outcome.text, stopReason: outcome.stopReason } };
    }

    if (outcome.kind === "http-error") {
        if (canRetry && plan.direct && isClientKeyRejection(outcome.status, outcome.message)) {
            return { action: "retry", plan: { ...plan, direct: false }, reason: "MiniMax rejected the user's key; retrying through the ShellMind proxy" };
        }
        return {
            action: "fail",
            error: new AiProviderError("minimax", outcome.message, { status: outcome.status, type: outcome.type })
        };
    }

    // Thinking only: ask again on the same route for a final text block.
    if (canRetry && !plan.forceFinal) {
        return { action: "retry", plan: { ...plan, forceFinal: true }, reason: "no final text (thinking only)" };
    }
    return { action: "fail", error: new AiProviderError("minimax", `MiniMax returned no final text content (${outcome.detail}).`, { retryable: false }) };
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

// Prompts carry terminal output: refuse to send them in clear text anywhere
// but to an endpoint on this machine.
function messagesUrl(baseUrl: string, envName: string): URL {
    const url = new URL(baseUrl);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname))) {
        throw new AiProviderError("minimax", `${envName} must use https:// (http:// is only accepted on localhost).`, { retryable: false });
    }
    return url;
}

type Endpoints = { proxy: () => URL; direct: () => URL };

// Resolved lazily, so a bad URL fails only the route that is actually used.
function endpoints(request: MiniMaxRequest): Endpoints {
    return {
        proxy: () => messagesUrl(`${request.proxyBaseUrl ?? MINIMAX_PROXY_BASE_URL}/messages`, "MINIMAX_PROXY_URL"),
        direct: () => messagesUrl(`${request.apiBaseUrl ?? MINIMAX_API_BASE_URL}/v1/messages`, "MINIMAX_API_BASE_URL")
    };
}

function buildHeaders(request: MiniMaxRequest, direct: boolean, stream: boolean): Record<string, string> {
    const headers: Record<string, string> = {
        "content-type": "application/json",
        "anthropic-version": "2023-06-01",
        accept: stream ? "text/event-stream" : "application/json"
    };
    // The user's key goes to MiniMax only; the proxy gets its own credentials.
    if (direct && request.clientApiKey) {
        headers["x-api-key"] = request.clientApiKey;
        headers.authorization = `Bearer ${request.clientApiKey}`;
        return headers;
    }
    if (MINIMAX_PROXY_API_KEY) headers["x-api-key"] = MINIMAX_PROXY_API_KEY;
    if (MINIMAX_PROXY_BEARER_TOKEN) headers.authorization = `Bearer ${MINIMAX_PROXY_BEARER_TOKEN}`;
    return headers;
}

function buildBody(request: MiniMaxRequest, plan: AttemptPlan, stream: boolean): string {
    const turns = request.turns.map((turn) => ({ ...turn }));
    const last = turns[turns.length - 1];
    if (plan.forceFinal && last) last.content += FORCED_FINAL_SUFFIX;

    return JSON.stringify({
        model: request.model,
        max_tokens: maxTokensFor(request.model),
        system: request.system,
        messages: turns.map((turn) => ({ role: turn.role, content: [{ type: "text", text: turn.content }] })),
        ...(findModel(request.model)?.params ?? {}),
        ...(stream ? { stream: true } : {})
    });
}

function toStopReason(value: unknown): ChatStopReason {
    if (value === "end_turn" || value === "max_tokens" || value === "stop_sequence") return value;
    return "other";
}

type ProviderPayload = {
    content?: Array<{ type?: string; text?: string }>;
    stop_reason?: string;
    error?: { type?: string; message?: string };
    message?: string;
    type?: string;
};

function parsePayload(raw: string): ProviderPayload | null {
    try {
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        return parsed && typeof parsed === "object" ? parsed as ProviderPayload : null;
    } catch {
        return null;
    }
}

function payloadText(payload: ProviderPayload | null): string {
    return (Array.isArray(payload?.content) ? payload.content : [])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n")
        .trim();
}

function payloadSummary(payload: ProviderPayload | null, raw: string): string {
    if (!payload) return `non-JSON body: ${summarizeErrorText(raw) || "empty"}`;
    const types = Array.isArray(payload.content) ? payload.content.map((block) => block?.type || "unknown").join(",") : "none";
    return `stop_reason=${payload.stop_reason || "unknown"}; content_types=${types}`;
}

// A readable error for an upstream failure. An HTML page or a 404 from the
// proxy means the request never reached an API (the proxy is down or moved):
// say so, and how to keep working, instead of echoing the page.
function httpError(status: number, statusText: string, raw: string, route: { direct: boolean; host: string }): AttemptOutcome {
    const payload = parsePayload(raw);
    const type = payload?.error?.type;
    const apiMessage = payload?.error?.message || payload?.message;
    if (apiMessage) return { kind: "http-error", status, message: `${status} ${summarizeErrorText(apiMessage)}`, type };

    if (!route.direct && (/^\s*</.test(raw) || status === 404)) {
        return {
            kind: "http-error",
            status,
            message: `The ShellMind AI proxy (${route.host}) is not available (HTTP ${status}). Add your own MiniMax or Gemini API key in Settings to keep using the assistant.`,
            type
        };
    }
    const detail = summarizeErrorText(raw) || statusText || "Unknown MiniMax API error";
    return { kind: "http-error", status, message: `${status} ${detail}`, type };
}

// Sends the request and resolves with the response once its headers arrive.
// Every failure (network, abort, time limit) becomes a rejection.
function openUpstream(url: URL, headers: Record<string, string>, body: string, watchdog: UpstreamWatchdog): Promise<http.IncomingMessage> {
    return new Promise((resolve, reject) => {
        const transport = url.protocol === "http:" ? http : https;
        const request = transport.request(url, {
            method: "POST",
            headers: { ...headers, "content-length": Buffer.byteLength(body).toString() }
        }, (response) => {
            watchdog.connected();
            resolve(response);
        });

        const onAbort = () => request.destroy(watchdog.signal.reason instanceof Error ? watchdog.signal.reason : new Error("Request aborted"));
        if (watchdog.signal.aborted) onAbort();
        else watchdog.signal.addEventListener("abort", onAbort, { once: true });

        request.on("error", reject);
        request.on("close", () => watchdog.signal.removeEventListener("abort", onAbort));
        request.end(body);
    });
}

// Reads the whole body; rejects if the response is cut off.
function readBody(response: http.IncomingMessage, watchdog: UpstreamWatchdog): Promise<string> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => {
            watchdog.activity();
            chunks.push(chunk);
        });
        response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        response.on("error", reject);
        response.on("close", () => {
            if (!response.complete) reject(new Error("The MiniMax response was cut off."));
        });
    });
}

async function jsonAttempt(request: MiniMaxRequest, plan: AttemptPlan, url: URL, watchdog: UpstreamWatchdog): Promise<AttemptOutcome> {
    const response = await openUpstream(url, buildHeaders(request, plan.direct, false), buildBody(request, plan, false), watchdog);
    const raw = await readBody(response, watchdog);
    const status = response.statusCode || 0;
    if (status >= 400) return httpError(status, response.statusMessage || "", raw, { direct: plan.direct, host: url.host });

    const payload = parsePayload(raw);
    const text = payloadText(payload);
    if (!text) return { kind: "empty", detail: payloadSummary(payload, raw) };
    return { kind: "text", text, stopReason: toStopReason(payload?.stop_reason) };
}

type StreamEventPayload = {
    type?: string;
    delta?: { type?: string; text?: string; stop_reason?: string };
    error?: { type?: string; message?: string };
};

async function streamAttempt(request: MiniMaxRequest, plan: AttemptPlan, url: URL, watchdog: UpstreamWatchdog, onDelta: (text: string) => void): Promise<AttemptOutcome> {
    const response = await openUpstream(url, buildHeaders(request, plan.direct, true), buildBody(request, plan, true), watchdog);
    const status = response.statusCode || 0;
    const isEventStream = String(response.headers["content-type"] || "").includes("text/event-stream");

    if (status >= 400) return httpError(status, response.statusMessage || "", await readBody(response, watchdog), { direct: plan.direct, host: url.host });

    // A proxy that ignored `stream` answers with one JSON message.
    if (!isEventStream) {
        const raw = await readBody(response, watchdog);
        const payload = parsePayload(raw);
        const text = payloadText(payload);
        if (!text) return { kind: "empty", detail: payloadSummary(payload, raw) };
        onDelta(text);
        return { kind: "text", text, stopReason: toStopReason(payload?.stop_reason) };
    }

    return new Promise<AttemptOutcome>((resolve, reject) => {
        let text = "";
        let stopReason: ChatStopReason | null = null;
        let finished = false;
        let failure: AiProviderError | null = null;
        let settled = false;

        const settle = (outcome: AttemptOutcome | Error) => {
            if (settled) return;
            settled = true;
            if (outcome instanceof Error) reject(outcome);
            else resolve(outcome);
        };

        const parser = createSseParser(({ data }) => {
            if (failure || !data || data === "[DONE]") return;
            let event: StreamEventPayload;
            try {
                event = JSON.parse(data) as StreamEventPayload;
            } catch {
                return;
            }

            // Thinking deltas are skipped on purpose: only the final
            // user-facing text reaches the client.
            if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
                text += event.delta.text;
                onDelta(event.delta.text);
            } else if (event.type === "message_delta" && event.delta?.stop_reason) {
                stopReason = toStopReason(event.delta.stop_reason);
            } else if (event.type === "message_stop") {
                finished = true;
            } else if (event.type === "error") {
                const type = event.error?.type;
                failure = new AiProviderError("minimax", `MiniMax stream error${type ? ` (${type})` : ""}: ${summarizeErrorText(event.error?.message || "unknown error")}`, { type });
            }
        });

        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
            watchdog.activity();
            parser.push(chunk);
        });
        response.on("error", (err) => settle(err));
        response.on("end", () => {
            parser.end();
            if (failure) return settle(failure);
            if (!finished && stopReason === null) {
                return settle(new AiProviderError("minimax", "The MiniMax stream ended before the answer was complete.", { retryable: true }));
            }
            settle(text ? { kind: "text", text, stopReason: stopReason ?? "end_turn" } : { kind: "empty", detail: "stream without text blocks" });
        });
        response.on("close", () => {
            if (!response.complete) settle(new Error("The MiniMax stream was cut off."));
        });
    });
}

export async function callMiniMax(request: MiniMaxRequest): Promise<GenerationResult> {
    const urls = endpoints(request);
    let plan: AttemptPlan = { direct: ALLOW_CLIENT_MINIMAX_KEY && Boolean(request.clientApiKey), forceFinal: false };

    for (let attempt = 1; ; attempt++) {
        const url = plan.direct ? urls.direct() : urls.proxy();
        const watchdog = createUpstreamWatchdog(request.signal, request.timeouts ?? defaultTimeouts(Boolean(request.onDelta)));
        let outcome: AttemptOutcome;
        try {
            outcome = request.onDelta
                ? await streamAttempt(request, plan, url, watchdog, request.onDelta)
                : await jsonAttempt(request, plan, url, watchdog);
        } catch (err) {
            if (request.signal?.aborted) throw err;
            const timeout = watchdog.timeoutError();
            if (timeout) throw new AiProviderError("minimax", timeout.message, { retryable: true, type: "timeout", cause: err });
            if (err instanceof AiProviderError) throw err;
            const target = plan.direct ? `the MiniMax API (${url.host})` : `the ShellMind AI proxy (${url.host})`;
            throw new AiProviderError("minimax", `Could not reach ${target}: ${(err as Error)?.message || err}`, { retryable: true, cause: err });
        } finally {
            watchdog.dispose();
        }

        const step = nextMiniMaxStep(plan, outcome, attempt);
        if (step.action === "return") return step.result;
        if (step.action === "fail") throw step.error;
        log.warn(`Retrying ${request.model}: ${step.reason}.`);
        plan = step.plan;
    }
}
