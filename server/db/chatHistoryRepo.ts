import type { ChatTurn } from "../../shared/types";
import { dbGet, dbRun } from "./sqlite";

// Per-server AI chat history, stored as one JSON array per server.
export const chatHistoryRepo = {
    async get(serverId: string): Promise<ChatTurn[]> {
        const row = await dbGet<{ messages: string }>("SELECT messages FROM chat_history WHERE server_id = ?", [serverId]);
        if (!row?.messages) return [];
        try {
            const messages = JSON.parse(row.messages);
            return Array.isArray(messages) ? messages : [];
        } catch {
            return [];
        }
    },

    async save(serverId: string, messages: ChatTurn[]): Promise<void> {
        await dbRun(
            `INSERT INTO chat_history (server_id, messages, updated_at) VALUES (?, ?, ?)
             ON CONFLICT(server_id) DO UPDATE SET messages = excluded.messages, updated_at = excluded.updated_at`,
            [serverId, JSON.stringify(messages), Date.now()]
        );
    },

    // Returns the number of rows removed (0 or 1).
    async delete(serverId: string): Promise<number> {
        const { changes } = await dbRun("DELETE FROM chat_history WHERE server_id = ?", [serverId]);
        return changes;
    }
};
