import type { AiProvider, ProviderStatus } from "../../shared/types";
import {
    ALLOW_CLIENT_MINIMAX_KEY,
    MINIMAX_API_BASE_URL,
    MINIMAX_PROXY_API_KEY,
    MINIMAX_PROXY_BASE_URL,
    MINIMAX_PROXY_BEARER_TOKEN
} from "../config";
import { settingsRepo } from "../db/settingsRepo";
import { createLogger } from "../logger";
import { SecretDecryptionError } from "../security/secrets";

const log = createLogger("ai");

export const AI_PROVIDER_CONFIG: Record<AiProvider, { envKey: string; settingKey: string; label: string }> = {
    gemini: {
        envKey: "GEMINI_API_KEY",
        settingKey: "GEMINI_API_KEY",
        label: "Gemini"
    },
    minimax: {
        envKey: "MINIMAX_API_KEY",
        settingKey: "MINIMAX_API_KEY",
        label: "MiniMax"
    }
};

export function isAiProvider(value: unknown): value is AiProvider {
    return value === "gemini" || value === "minimax";
}

// The key a provider is called with. `unreadable`: a key is saved but no
// longer decrypts (the database moved without its data key). It then counts as
// missing everywhere, as the Settings status reports it, so it can be entered
// again: MiniMax goes through the proxy, Gemini asks for the key.
export type ProviderKey = { apiKey: string | null; unreadable: boolean };

// Logged once per provider, not on every chat request.
const reportedUnreadable = new Set<AiProvider>();

export async function getProviderKey(provider: AiProvider): Promise<ProviderKey> {
    const config = AI_PROVIDER_CONFIG[provider];
    const envValue = process.env[config.envKey];
    if (envValue) return { apiKey: envValue, unreadable: false };
    try {
        return { apiKey: await settingsRepo.get(config.settingKey), unreadable: false };
    } catch (err) {
        if (!(err instanceof SecretDecryptionError)) throw err;
        if (!reportedUnreadable.has(provider)) {
            reportedUnreadable.add(provider);
            log.warn(`The saved ${config.label} API key cannot be decrypted (the data key changed); it is ignored until it is entered again in Settings.`);
        }
        return { apiKey: null, unreadable: true };
    }
}

export async function getProviderApiKey(provider: AiProvider): Promise<string | null> {
    return (await getProviderKey(provider)).apiKey;
}

export async function getProviderStatus(provider: AiProvider): Promise<ProviderStatus> {
    const { apiKey } = await getProviderKey(provider);
    if (!apiKey) return { configured: false, source: "none" };
    return { configured: true, source: process.env[AI_PROVIDER_CONFIG[provider].envKey] ? "env" : "db" };
}

// How MiniMax requests travel: straight to MiniMax's API (apiBaseUrl) when the
// user configured a key that may be used, else through the proxy (baseUrl).
// The chat discloses this route before the first MiniMax request.
export function getMiniMaxProxyStatus(providerStatus: ProviderStatus) {
    return {
        enabled: true,
        route: ALLOW_CLIENT_MINIMAX_KEY && providerStatus.configured ? "direct" as const : "proxy" as const,
        baseUrl: MINIMAX_PROXY_BASE_URL,
        apiBaseUrl: MINIMAX_API_BASE_URL,
        allowClientKey: ALLOW_CLIENT_MINIMAX_KEY,
        usesProxyAuth: Boolean(MINIMAX_PROXY_API_KEY || MINIMAX_PROXY_BEARER_TOKEN),
        localKeyConfigured: providerStatus.configured,
        localKeySource: providerStatus.source
    };
}
