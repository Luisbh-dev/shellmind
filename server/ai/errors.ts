import type { AiProvider } from "../../shared/types";

const MAX_DETAIL_LENGTH = 300;

// Upstream error bodies can be HTML pages (proxy errors) or very long JSON:
// keep a short readable line for logs and the chat.
export function summarizeErrorText(text: string): string {
    const plain = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    return plain.length > MAX_DETAIL_LENGTH ? `${plain.slice(0, MAX_DETAIL_LENGTH)}…` : plain;
}

// A failed call to an AI provider. `retryable` says whether trying another
// model can help (rate limits, overload, timeouts, 5xx), as opposed to a bad
// request or a rejected key.
export class AiProviderError extends Error {
    readonly provider: AiProvider;
    readonly status?: number;
    // Provider error type, e.g. "overloaded_error" or "RESOURCE_EXHAUSTED".
    readonly type?: string;
    readonly retryable: boolean;

    constructor(provider: AiProvider, message: string, options: { status?: number; type?: string; retryable?: boolean; cause?: unknown } = {}) {
        super(message, options.cause === undefined ? undefined : { cause: options.cause });
        this.name = "AiProviderError";
        this.provider = provider;
        this.status = options.status;
        this.type = options.type;
        this.retryable = options.retryable ?? isRetryable(options.status, `${options.type ?? ""} ${message}`);
    }
}

// Rate limits, overload and server-side failures; never 4xx input errors.
export function isRetryable(status: number | undefined, text: string): boolean {
    if (status === 429 || status === 408 || status === 529) return true;
    if (status !== undefined && status >= 500) return true;
    if (status !== undefined && status >= 400) return false;
    return /overloaded|rate[ _-]?limit|quota|resource[ _]exhausted|unavailable|timeout|timed out/i.test(text);
}

export function isAiProviderError(err: unknown): err is AiProviderError {
    return err instanceof AiProviderError;
}

export function isAbortError(err: unknown): boolean {
    return err instanceof Error && (err.name === "AbortError" || (err as { code?: unknown }).code === "ABORT_ERR");
}
