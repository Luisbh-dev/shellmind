import type sqlite3 from "sqlite3";
import type { AuditEntry, AuditInput, AuditSource } from "../../shared/types";
import { AUDIT_SEARCH_TABLE } from "./migrations";
import { dbAll, dbGet, dbRun, getDb } from "./sqlite";

// Commands run through the app (AI, snippets, multi-exec, ops panels).

type AuditRow = Omit<AuditEntry, "meta"> & { meta: string | null };

export type AuditQuery = {
    serverId?: number;
    source?: AuditSource;
    // Page size (newest first).
    limit?: number;
    // Only entries older than this entry id (the last id of the previous page).
    before?: number;
    // Case-insensitive text in the command or the server name.
    search?: string;
    // Time range (epoch ms, both ends inclusive).
    from?: number;
    to?: number;
};

// LIKE pattern that matches `text` literally anywhere (ESCAPE '\').
function containsPattern(text: string): string {
    return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

// An FTS5 phrase that matches `text` literally: with the trigram tokenizer a
// phrase of three or more characters matches any substring, case-insensitively.
function substringPhrase(text: string): string {
    return `"${text.replace(/"/g, '""')}"`;
}

// The trigram index cannot look up fewer than three characters.
const MIN_INDEXED_SEARCH = 3;

export const AUDIT_PAGE_DEFAULT = 100;
export const AUDIT_PAGE_MAX = 500;

// Rows deleted per statement while pruning, so other queries get their turn
// on the shared connection between batches.
const PRUNE_BATCH = 2000;

// Whether the database has the search index (see AUDIT_SEARCH_TABLE), per connection.
const searchIndexed = new WeakMap<sqlite3.Database, Promise<boolean>>();

function hasSearchIndex(): Promise<boolean> {
    const handle = getDb();
    let known = searchIndexed.get(handle);
    if (!known) {
        known = dbGet<{ found: number }>("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?", [AUDIT_SEARCH_TABLE])
            .then((row) => row?.found === 1);
        searchIndexed.set(handle, known);
    }
    return known;
}

function toEntry(row: AuditRow): AuditEntry {
    let meta: Record<string, unknown> | null = null;
    if (row.meta) {
        try {
            const parsed = JSON.parse(row.meta);
            meta = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
        } catch {
            meta = null;
        }
    }
    return { ...row, meta };
}

// The statement auditRepo.list() runs (exported so tests can check its plan).
export async function auditListQuery(query: AuditQuery): Promise<{ sql: string; params: unknown[] }> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.serverId !== undefined) { where.push("server_id = ?"); params.push(query.serverId); }
    if (query.source !== undefined) { where.push("source = ?"); params.push(query.source); }
    if (query.before !== undefined) { where.push("id < ?"); params.push(query.before); }
    if (query.from !== undefined) { where.push("ts >= ?"); params.push(query.from); }
    if (query.to !== undefined) { where.push("ts <= ?"); params.push(query.to); }
    if (query.search) {
        if ([...query.search].length >= MIN_INDEXED_SEARCH && await hasSearchIndex()) {
            where.push(`id IN (SELECT rowid FROM ${AUDIT_SEARCH_TABLE} WHERE ${AUDIT_SEARCH_TABLE} MATCH ?)`);
            params.push(substringPhrase(query.search));
        } else {
            const pattern = containsPattern(query.search);
            where.push("(command LIKE ? ESCAPE '\\' OR server_name LIKE ? ESCAPE '\\')");
            params.push(pattern, pattern);
        }
    }
    const limit = Math.min(Math.max(query.limit ?? AUDIT_PAGE_DEFAULT, 1), AUDIT_PAGE_MAX);
    return {
        sql: `SELECT * FROM audit_log ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
        params: [...params, limit]
    };
}

// Deletes the rows `selectIds` picks (an id subquery taking one parameter,
// the batch size), a batch at a time. Returns how many went.
async function deleteInBatches(selectIds: string, params: unknown[]): Promise<number> {
    let removed = 0;
    for (;;) {
        const { changes } = await dbRun(`DELETE FROM audit_log WHERE id IN (${selectIds})`, [...params, PRUNE_BATCH]);
        removed += changes;
        if (changes < PRUNE_BATCH) return removed;
    }
}

export const auditRepo = {
    async insert(entry: Omit<AuditEntry, "id">): Promise<AuditEntry> {
        const { lastID } = await dbRun(
            "INSERT INTO audit_log (ts, server_id, server_name, source, command, exit_code, meta) VALUES (?, ?, ?, ?, ?, ?, ?)",
            [entry.ts, entry.server_id, entry.server_name, entry.source, entry.command, entry.exit_code, entry.meta ? JSON.stringify(entry.meta) : null]
        );
        return { id: lastID, ...entry };
    },

    async list(query: AuditQuery = {}): Promise<AuditEntry[]> {
        const { sql, params } = await auditListQuery(query);
        return (await dbAll<AuditRow>(sql, params)).map(toEntry);
    },

    // Deletes the entries recorded before `before` (epoch ms).
    pruneOlderThan(before: number): Promise<number> {
        return deleteInBatches("SELECT id FROM audit_log WHERE ts < ? ORDER BY id LIMIT ?", [before]);
    },

    // Keeps the newest `keep` entries and deletes the rest.
    async pruneBeyond(keep: number): Promise<number> {
        const oldestKept = await dbGet<{ id: number }>("SELECT id FROM audit_log ORDER BY id DESC LIMIT 1 OFFSET ?", [Math.max(0, keep - 1)]);
        if (!oldestKept) return 0;
        return deleteInBatches("SELECT id FROM audit_log WHERE id < ? ORDER BY id LIMIT ?", [oldestKept.id]);
    },

    async count(): Promise<number> {
        return (await dbGet<{ count: number }>("SELECT COUNT(*) AS count FROM audit_log"))?.count ?? 0;
    }
};

// Records a command in the audit log. The server name is looked up here so an
// entry stays readable after the server is deleted.
export async function recordAudit(input: AuditInput): Promise<AuditEntry> {
    const serverId = input.serverId ?? null;
    const server = serverId === null
        ? undefined
        : await dbGet<{ name: string }>("SELECT name FROM servers WHERE id = ?", [serverId]);

    return auditRepo.insert({
        ts: Date.now(),
        server_id: serverId,
        server_name: server?.name ?? null,
        source: input.source,
        command: input.command,
        exit_code: input.exitCode ?? null,
        meta: input.meta ?? null
    });
}

// What a command that was recorded when it was sent (exit code unknown,
// meta.status "running") ended with: its exit code and its final meta. A
// backend that stops in between leaves the entry that says it was sent.
export type AuditCompletion = { exitCode: number | null; meta: Record<string, unknown> };

export async function completeAudit(id: number, completion: AuditCompletion): Promise<void> {
    await dbRun("UPDATE audit_log SET exit_code = ?, meta = ? WHERE id = ?", [completion.exitCode, JSON.stringify(completion.meta), id]);
}

// The id of what recordAudit (or a test's stand-in) returned, if any.
export function auditEntryId(entry: unknown): number | null {
    const id = (entry as { id?: unknown } | null | undefined)?.id;
    return typeof id === "number" && Number.isSafeInteger(id) ? id : null;
}
