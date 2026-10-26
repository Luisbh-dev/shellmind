import type { Snippet } from "../../shared/types";
import type { SnippetImportResult } from "../../shared/snippets";
import { dbAll, dbGet, dbRun, transaction, type DbClient } from "../db/sqlite";
import { invalidSnippet, type ValidSnippet } from "./validate";

// Saved commands. A snippet is global (server_id NULL) or scoped to one
// server; scoped ones are deleted with their server (serversRepo.remove).

type SnippetRow = Omit<Snippet, "tags"> & { tags: string | null };

function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
    } catch {
        return [];
    }
}

function toSnippet(row: SnippetRow): Snippet {
    return { ...row, tags: parseTags(row.tags) };
}

async function assertServer(client: Pick<DbClient, "get">, serverId: number | null): Promise<void> {
    if (serverId === null) return;
    const row = await client.get<{ id: number }>("SELECT id FROM servers WHERE id = ?", [serverId]);
    if (!row) throw invalidSnippet(`server #${serverId} does not exist`, "serverNotFound");
}

const COLUMNS = "id, name, command, description, tags, server_id, created_at, updated_at";

async function insertSnippet(client: Pick<DbClient, "get" | "run">, input: ValidSnippet): Promise<Snippet> {
    await assertServer(client, input.server_id);
    const now = Date.now();
    const { lastID } = await client.run(
        "INSERT INTO snippets (name, command, description, tags, server_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [input.name, input.command, input.description, JSON.stringify(input.tags), input.server_id, now, now]
    );
    return { id: lastID, ...input, created_at: now, updated_at: now };
}

const directClient: Pick<DbClient, "get" | "run"> = { get: dbGet, run: dbRun };

export const snippetsRepo = {
    // Every snippet, or with `serverId` the ones usable on that server
    // (global + scoped to it). Sorted by name.
    async list(filter: { serverId?: number } = {}): Promise<Snippet[]> {
        const rows = filter.serverId === undefined
            ? await dbAll<SnippetRow>(`SELECT ${COLUMNS} FROM snippets ORDER BY name COLLATE NOCASE, id`)
            : await dbAll<SnippetRow>(
                `SELECT ${COLUMNS} FROM snippets WHERE server_id IS NULL OR server_id = ? ORDER BY name COLLATE NOCASE, id`,
                [filter.serverId]
            );
        return rows.map(toSnippet);
    },

    async get(id: number): Promise<Snippet | null> {
        const row = await dbGet<SnippetRow>(`SELECT ${COLUMNS} FROM snippets WHERE id = ?`, [id]);
        return row ? toSnippet(row) : null;
    },

    async create(input: ValidSnippet): Promise<Snippet> {
        return insertSnippet(directClient, input);
    },

    // The same inside a caller's transaction (the configuration import).
    createIn(tx: DbClient, input: ValidSnippet): Promise<Snippet> {
        return insertSnippet(tx, input);
    },

    // Replaces every field. Null when the snippet does not exist.
    async update(id: number, input: ValidSnippet): Promise<Snippet | null> {
        await assertServer(directClient, input.server_id);
        const { changes } = await dbRun(
            "UPDATE snippets SET name = ?, command = ?, description = ?, tags = ?, server_id = ?, updated_at = ? WHERE id = ?",
            [input.name, input.command, input.description, JSON.stringify(input.tags), input.server_id, Date.now(), id]
        );
        return changes > 0 ? this.get(id) : null;
    },

    async remove(id: number): Promise<boolean> {
        const { changes } = await dbRun("DELETE FROM snippets WHERE id = ?", [id]);
        return changes > 0;
    },

    // All or nothing: one invalid scope rejects the whole import.
    async importMany(inputs: ValidSnippet[]): Promise<SnippetImportResult> {
        return transaction(async (tx) => {
            let created = 0;
            let skipped = 0;
            const now = Date.now();
            for (const input of inputs) {
                await assertServer(tx, input.server_id);
                const existing = await tx.get<{ id: number }>(
                    "SELECT id FROM snippets WHERE name = ? AND command = ? AND server_id IS ?",
                    [input.name, input.command, input.server_id]
                );
                if (existing) {
                    skipped += 1;
                    continue;
                }
                await tx.run(
                    "INSERT INTO snippets (name, command, description, tags, server_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [input.name, input.command, input.description, JSON.stringify(input.tags), input.server_id, now, now]
                );
                created += 1;
            }
            return { created, skipped };
        });
    }
};
