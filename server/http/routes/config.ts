import { Router } from "express";
import type { AiProvider } from "../../../shared/types";
import { isKnownModel, resolveModelId } from "../../../shared/models";
import { ALLOW_CLIENT_MINIMAX_KEY } from "../../config";
import { settingsRepo } from "../../db/settingsRepo";
import { AI_PROVIDER_CONFIG, getMiniMaxProxyStatus, getProviderStatus, isAiProvider } from "../../ai/providers";
import { AppError } from "../../errors";
import { jsonBody, sendError } from "../respond";

// Why a provider key cannot be changed from the UI, or null when it can.
function keyLockedReason(provider: AiProvider): AppError | null {
    if (provider === "minimax" && !ALLOW_CLIENT_MINIMAX_KEY) {
        return new AppError(
            "CLIENT_KEY_DISABLED",
            "MiniMax client keys are disabled. This app sends MiniMax traffic through the managed proxy.",
            403
        );
    }
    const providerConfig = AI_PROVIDER_CONFIG[provider];
    if (process.env[providerConfig.envKey]) {
        return new AppError("KEY_FROM_ENVIRONMENT", `${providerConfig.label} API Key is already set via Environment Variables.`, 403);
    }
    return null;
}

export function createConfigRouter(): Router {
    const router = Router();

    // Check if API Key is configured
    router.get("/api/config/status", async (req, res) => {
        try {
            const providers = {
                gemini: await getProviderStatus("gemini"),
                minimax: await getProviderStatus("minimax")
            };

            res.json({
                configured: providers.gemini.configured,
                source: providers.gemini.source,
                providers,
                features: {
                    minimaxProxy: getMiniMaxProxyStatus(providers.minimax)
                }
            });
        } catch (err) {
            sendError(res, err, "GET /api/config/status");
        }
    });

    // Set API Key (only if not in env). Stored encrypted.
    router.post("/api/config/apikey", async (req, res) => {
        try {
            const body = jsonBody(req);
            const provider: AiProvider = isAiProvider(body.provider) ? body.provider : "gemini";
            const locked = keyLockedReason(provider);
            if (locked) throw locked;
            const { key } = body;
            if (!key || typeof key !== "string") throw new AppError("INVALID_CONFIG", "Key is required", 400, { field: "key" });
            await settingsRepo.set(AI_PROVIDER_CONFIG[provider].settingKey, key);
            res.json({ message: "success" });
        } catch (err) {
            sendError(res, err, "POST /api/config/apikey");
        }
    });

    // Delete API Key (only if not in env)
    router.delete("/api/config/apikey", async (req, res) => {
        try {
            const body = jsonBody(req);
            const provider: AiProvider = isAiProvider(body.provider) ? body.provider : "gemini";
            const locked = keyLockedReason(provider);
            if (locked) throw locked;
            res.json({ message: "success", changes: await settingsRepo.delete(AI_PROVIDER_CONFIG[provider].settingKey) });
        } catch (err) {
            sendError(res, err, "DELETE /api/config/apikey");
        }
    });

    // Get Preferred Model (a stale saved id reads as the default model)
    router.get("/api/config/model", async (req, res) => {
        try {
            res.json({ model: resolveModelId(await settingsRepo.get("PREFERRED_MODEL")) });
        } catch (err) {
            sendError(res, err, "GET /api/config/model");
        }
    });

    // Set Preferred Model (one of shared/models.ts)
    router.post("/api/config/model", async (req, res) => {
        try {
            const { model } = jsonBody(req);
            if (!model || typeof model !== "string") throw new AppError("INVALID_CONFIG", "Model is required", 400, { field: "model" });
            if (!isKnownModel(model)) throw new AppError("UNKNOWN_MODEL", `Unknown model: ${model.slice(0, 80)}`, 400);
            await settingsRepo.set("PREFERRED_MODEL", resolveModelId(model));
            res.json({ message: "success" });
        } catch (err) {
            sendError(res, err, "POST /api/config/model");
        }
    });

    return router;
}
