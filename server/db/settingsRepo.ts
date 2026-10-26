import { openSecret, sealSecret } from "../security/secrets";
import { dbGet, dbRun, type DbClient } from "./sqlite";

// Key/value settings. API keys are encrypted at rest; values are cached in
// memory because this process is the only writer.

export const SECRET_SETTING_KEYS: ReadonlySet<string> = new Set(["GEMINI_API_KEY", "MINIMAX_API_KEY"]);

export const cliHistoryKey = (serverId: number | string) => `cli_history:${serverId}`;
// "Ask for the password each time" of a Windows server's embedded RDP client.
export const rdpAskPasswordKey = (serverId: number) => `rdp_ask_password:${serverId}`;

const cache = new Map<string, string | null>();

function seal(key: string, value: string): string | null {
    return SECRET_SETTING_KEYS.has(key) ? sealSecret(value) : value;
}

export const settingsRepo = {
    async get(key: string): Promise<string | null> {
        if (cache.has(key)) return cache.get(key) ?? null;
        const row = await dbGet<{ value: string | null }>("SELECT value FROM settings WHERE key = ?", [key]);
        const stored = row?.value ?? null;
        const value = stored !== null && SECRET_SETTING_KEYS.has(key) ? openSecret(stored) : stored;
        cache.set(key, value);
        return value;
    },

    async set(key: string, value: string): Promise<void> {
        const stored = seal(key, value);
        await dbRun(
            "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            [key, stored]
        );
        cache.set(key, stored === null ? null : value);
    },

    // Returns the number of rows removed (0 or 1).
    async delete(key: string): Promise<number> {
        const { changes } = await dbRun("DELETE FROM settings WHERE key = ?", [key]);
        cache.set(key, null);
        return changes;
    },

    // Removes a key inside a caller's transaction.
    async deleteIn(tx: DbClient, key: string): Promise<void> {
        await tx.run("DELETE FROM settings WHERE key = ?", [key]);
        cache.delete(key);
    },

    clearCache(): void {
        cache.clear();
    }
};
