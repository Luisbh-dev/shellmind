import { fallbackModelFor } from "../../shared/models";
import { createLogger } from "../logger";
import { AiProviderError, isAiProviderError } from "./errors";
import type { GenerationResult } from "./minimax";

const log = createLogger("chat");

export type FallbackResult = GenerationResult & { usedModel: string };

// Runs `targetModel` and, when it fails with a retryable error before any text
// was streamed, its fallback model once. Input errors, rejected keys and
// failures after text reached the client are reported as they are (switching
// models then would duplicate or hide the answer). Resolves null when the
// client aborted.
export async function generateWithFallback(
    tryGenerate: (modelName: string) => Promise<GenerationResult>,
    targetModel: string,
    options: { signal: AbortSignal; hasStreamed: () => boolean }
): Promise<FallbackResult | null> {
    try {
        return { ...(await tryGenerate(targetModel)), usedModel: targetModel };
    } catch (err) {
        if (options.signal.aborted) return null;

        const fallbackModel = fallbackModelFor(targetModel);
        log.warn(`${targetModel} failed: ${(err as Error)?.message || err}`);

        if (!isAiProviderError(err) || !err.retryable || !fallbackModel || options.hasStreamed()) throw err;

        log.info(`Falling back from ${targetModel} to ${fallbackModel}.`);
        try {
            return { ...(await tryGenerate(fallbackModel)), usedModel: fallbackModel };
        } catch (fallbackErr) {
            if (options.signal.aborted) return null;
            if (options.hasStreamed()) throw fallbackErr;
            const secondary = (fallbackErr as Error)?.message || String(fallbackErr);
            throw new AiProviderError(
                isAiProviderError(fallbackErr) ? fallbackErr.provider : err.provider,
                `All models failed. ${targetModel}: ${err.message} ${fallbackModel}: ${secondary}`,
                { retryable: false, cause: fallbackErr }
            );
        }
    }
}
