import { CLI_PRESET_KEYS, normalizeCliPreset } from "../../shared/cliPresets";
import { normalizeHost } from "../../shared/hostRoutes";
import { effectivePort } from "../../shared/ports";
import { SERVER_TYPES, type ServerSummary, type ServerType } from "../../shared/types";
import { AppError } from "../errors";
import { encryptSecret, openSecret, SecretDecryptionError } from "../security/secrets";
import { identityExistsIn } from "./identitiesRepo";
import { cliHistoryKey, rdpAskPasswordKey, settingsRepo } from "./settingsRepo";
import { dbAll, dbGet, dbRun, transaction, type DbClient } from "./sqlite";

// The servers table. Secrets are encrypted on write and decrypted only by
// getRecord() for server-side connection code; summaries never contain them.

export const SERVER_SECRET_COLUMNS = ["password", "privateKey", "passphrase", "s3_secret_key"] as const;
export type SecretColumn = typeof SERVER_SECRET_COLUMNS[number];

const CLEAR_FLAGS: Record<SecretColumn, string> = {
    password: "clear_password",
    privateKey: "clear_private_key",
    passphrase: "clear_passphrase",
    s3_secret_key: "clear_s3_secret_key"
};

type ServerRow = {
    id: number;
    name: string;
    ip: string;
    type: string;
    username: string | null;
    port: number | null;
    ssh_port: number | null;
    os_detail: string | null;
    s3_provider: string | null;
    s3_bucket: string | null;
    s3_region: string | null;
    s3_endpoint: string | null;
    s3_access_key: string | null;
    command: string | null;
    cwd: string | null;
    initial_command: string | null;
    cli_preset: string | null;
    domain: string | null;
    private_key_path: string | null;
    jump_server_id: number | null;
    group_name: string | null;
    tags: string | null;
    color: string | null;
    notes: string | null;
    sort_order: number;
    updated_at: number | null;
    // FTP over explicit TLS (0/1).
    ftp_secure: number;
    // Pinned at the top of the sidebar (0/1).
    favorite: number;
    // W7-S2: the identity it connects with (Settings > Keychain), and SSH
    // agent forwarding on its terminal sessions (0/1).
    identity_id: number | null;
    agent_forward: number;
} & Record<SecretColumn, string | null>;

// A server row with its secrets decrypted. Server-side only. A secret sealed
// with another data key reads as null and is listed in `unreadable`.
export type ServerRecord = Omit<ServerRow, "type" | "tags"> & { type: ServerType; tags: string[]; unreadable: SecretColumn[] };

const SUMMARY_COLUMNS = `
    id, name, ip, type, username, port, ssh_port, os_detail,
    s3_provider, s3_bucket, s3_region, s3_endpoint, s3_access_key,
    command, cwd, initial_command, cli_preset,
    domain, private_key_path, jump_server_id,
    group_name, tags, color, notes, sort_order, updated_at, ftp_secure, favorite,
    identity_id, agent_forward,
    (password IS NOT NULL AND password != '') AS has_password,
    (privateKey IS NOT NULL AND privateKey != '') AS has_private_key,
    (passphrase IS NOT NULL AND passphrase != '') AS has_passphrase,
    (s3_secret_key IS NOT NULL AND s3_secret_key != '') AS has_s3_secret_key`;

function parseTags(raw: string | null): string[] {
    if (!raw) return [];
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((tag): tag is string => typeof tag === "string") : [];
    } catch {
        return [];
    }
}

function toSummary(row: Omit<ServerSummary, "tags"> & { tags: string | null }): ServerSummary {
    return { ...row, tags: parseTags(row.tags) };
}

// --- Input validation ---------------------------------------------------------

type Body = Record<string, unknown>;

const MAX_TEXT = 4096;
const MAX_SECRET = 65536;
const MAX_TAGS = 32;

function invalid(message: string): AppError {
    return new AppError("INVALID_SERVER", message, 400);
}

export { normalizeHost };

// Trimmed text; blank and null become null. Throws on non-strings.
function text(body: Body, key: string, max = MAX_TEXT): string | null {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid(`${key} must be a string`);
    const trimmed = value.trim();
    if (trimmed.length > max) throw invalid(`${key} is too long`);
    return trimmed || null;
}

function port(body: Body, key: string): number | null {
    const value = body[key];
    if (value === undefined || value === null || value === "") return null;
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
        throw invalid(`${key} must be a port number (1-65535)`);
    }
    return parsed;
}

function integer(body: Body, key: string): number | null {
    const value = body[key];
    if (value === undefined || value === null || value === "") return null;
    const parsed = typeof value === "string" ? Number(value) : value;
    if (typeof parsed !== "number" || !Number.isSafeInteger(parsed)) throw invalid(`${key} must be an integer`);
    return parsed;
}

function flag(body: Body, key: string): number {
    const value = body[key];
    if (value === undefined || value === null || value === false || value === 0) return 0;
    if (value === true || value === 1) return 1;
    throw invalid(`${key} must be a boolean`);
}

function tags(body: Body): string | null {
    const value = body.tags;
    if (value === undefined || value === null) return null;
    if (!Array.isArray(value) || value.some((tag) => typeof tag !== "string")) throw invalid("tags must be an array of strings");
    const cleaned = [...new Set(value.map((tag: string) => tag.trim()).filter(Boolean))];
    if (cleaned.length > MAX_TAGS || cleaned.some((tag) => tag.length > 64)) throw invalid("too many or too long tags");
    return cleaned.length ? JSON.stringify(cleaned) : null;
}

// A secret as typed: kept verbatim (spaces can be part of a password), blank means "not given".
function secret(body: Body, key: SecretColumn): string | null {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid(`${key} must be a string`);
    if (value.length > MAX_SECRET) throw invalid(`${key} is too long`);
    return value.trim() ? value : null;
}

// A local server's preset, in its stored (lowercase) form; other types have
// none. An unknown one is refused rather than saved: the terminal would have
// nothing to scope the console to.
function cliPreset(body: Body, type: string): string | null {
    const value = text(body, "cli_preset", 64);
    if (value === null || type !== "local") return null;
    const preset = normalizeCliPreset(value);
    if (!preset) {
        throw new AppError("INVALID_SERVER", `cli_preset must be one of: ${CLI_PRESET_KEYS.join(", ")}`, 400, { field: "cli_preset" });
    }
    return preset;
}

// Fields every POST/PUT carries (the edit form always sends the whole connection).
function connectionFields(body: Body): Record<string, unknown> {
    const type = body.type;
    if (typeof type !== "string" || !SERVER_TYPES.includes(type as ServerType)) {
        throw invalid(`type must be one of: ${SERVER_TYPES.join(", ")}`);
    }
    const name = text(body, "name", 200);
    if (!name) throw invalid("name is required");

    const rawIp = text(body, "ip", 255);
    const ip = rawIp ? normalizeHost(rawIp) : "";
    if (!ip && (type === "linux" || type === "windows" || type === "ftp")) throw invalid("ip (host) is required");

    return {
        name,
        ip,
        type,
        username: text(body, "username", 255),
        port: port(body, "port"),
        ssh_port: port(body, "ssh_port"),
        s3_provider: text(body, "s3_provider", 64),
        s3_bucket: text(body, "s3_bucket", 255),
        s3_region: text(body, "s3_region", 64),
        s3_endpoint: text(body, "s3_endpoint", 1024),
        s3_access_key: text(body, "s3_access_key", 1024),
        command: text(body, "command"),
        cwd: text(body, "cwd"),
        initial_command: text(body, "initial_command"),
        cli_preset: cliPreset(body, type)
    };
}

// Fields older clients do not know about: only written when present.
const OPTIONAL_FIELDS: Record<string, (body: Body) => unknown> = {
    os_detail: (body) => text(body, "os_detail", 255),
    domain: (body) => text(body, "domain", 255),
    private_key_path: (body) => text(body, "private_key_path", 1024),
    jump_server_id: (body) => integer(body, "jump_server_id"),
    group_name: (body) => text(body, "group_name", 128),
    tags,
    color: (body) => text(body, "color", 32),
    notes: (body) => text(body, "notes", 16384),
    // null: at the end on create, unchanged on update.
    sort_order: (body) => integer(body, "sort_order"),
    ftp_secure: (body) => flag(body, "ftp_secure"),
    favorite: (body) => flag(body, "favorite"),
    identity_id: (body) => integer(body, "identity_id"),
    agent_forward: (body) => flag(body, "agent_forward")
};

function optionalFields(body: Body): Record<string, unknown> {
    const fields: Record<string, unknown> = {};
    for (const [key, parse] of Object.entries(OPTIONAL_FIELDS)) {
        if (key in body) fields[key] = parse(body);
    }
    return fields;
}

// The jump server must exist, speak SSH and not lead back to `selfId`.
async function assertJumpServer(tx: DbClient, jumpId: number, selfId: number | null): Promise<void> {
    const seen = new Set<number>(selfId === null ? [] : [selfId]);
    let current: number | null = jumpId;
    let first = true;
    while (current !== null) {
        if (seen.has(current)) throw invalid("jump_server_id would create a jump host loop");
        seen.add(current);
        const row: { type: string; jump_server_id: number | null } | undefined =
            await tx.get("SELECT type, jump_server_id FROM servers WHERE id = ?", [current]);
        if (!row) throw invalid(`jump server #${current} does not exist`);
        if (first && row.type !== "linux" && row.type !== "windows") throw invalid("the jump server must be an SSH server (linux or windows)");
        first = false;
        current = row.jump_server_id;
    }
}

// W7-S2: an identity (and agent forwarding) only applies to SSH servers; the
// identity named must exist.
async function checkIdentity(tx: DbClient, values: Record<string, unknown>): Promise<void> {
    if (values.type !== "linux" && values.type !== "windows") {
        values.identity_id = null;
        values.agent_forward = 0;
        return;
    }
    if (typeof values.identity_id === "number" && !(await identityExistsIn(tx, values.identity_id))) {
        throw new AppError("INVALID_SERVER", `identity #${values.identity_id} does not exist`, 400, { field: "identity_id" });
    }
}

// A kept identity sends its credentials to the new target too (agent-only
// identities hold none).
async function identityHoldsSecretsIn(tx: DbClient, id: number): Promise<boolean> {
    const row = await tx.get<{ held: number }>(
        "SELECT (COALESCE(password, '') != '' OR COALESCE(privateKey, '') != '' OR COALESCE(private_key_path, '') != '') AS held FROM identities WHERE id = ?",
        [id]
    );
    return row?.held === 1;
}

// Where a row points: changing any of these sends its credentials elsewhere.
function targetIdentity(row: Pick<ServerRow, "ip" | "type" | "port" | "ssh_port" | "s3_endpoint" | "s3_provider" | "jump_server_id">): string {
    const type = row.type as ServerType;
    return JSON.stringify([
        normalizeHost(row.ip),
        row.type,
        effectivePort({ type, port: row.port, ssh_port: row.ssh_port }, "terminal"),
        effectivePort({ type, port: row.port, ssh_port: row.ssh_port }, "rdp"),
        row.s3_endpoint,
        row.s3_provider,
        row.jump_server_id
    ]);
}

// Turning FTPS off would send the saved FTP password in clear text.
function tlsDowngrade(current: Pick<ServerRow, "type" | "ftp_secure">, next: Pick<ServerRow, "type" | "ftp_secure">): boolean {
    return current.type === "ftp" && next.type === "ftp" && current.ftp_secure === 1 && next.ftp_secure !== 1;
}

// The sort_order after every saved server: reorder() numbers them from 0, so
// a new server without its own place goes last instead of tying with the first.
export async function nextSortOrderIn(tx: DbClient): Promise<number> {
    const row = await tx.get<{ next: number }>("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next FROM servers");
    return row?.next ?? 0;
}

async function insertServer(tx: DbClient, body: Body): Promise<number> {
    const values: Record<string, unknown> = { ...connectionFields(body), ...optionalFields(body) };
    if (typeof values.jump_server_id === "number") await assertJumpServer(tx, values.jump_server_id, null);
    await checkIdentity(tx, values);
    if (typeof values.sort_order !== "number") values.sort_order = await nextSortOrderIn(tx);
    for (const column of SERVER_SECRET_COLUMNS) {
        const value = secret(body, column);
        values[column] = value ? encryptSecret(value) : null;
    }
    values.updated_at = Date.now();

    const columns = Object.keys(values);
    const { lastID } = await tx.run(
        `INSERT INTO servers (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
        columns.map((column) => values[column])
    );
    return lastID;
}

// --- Repository ---------------------------------------------------------------

export const serversRepo = {
    async listSummaries(): Promise<ServerSummary[]> {
        const rows = await dbAll<Omit<ServerSummary, "tags"> & { tags: string | null }>(
            `SELECT ${SUMMARY_COLUMNS} FROM servers ORDER BY sort_order, id`
        );
        return rows.map(toSummary);
    },

    async getSummary(id: number): Promise<ServerSummary | null> {
        const row = await dbGet<Omit<ServerSummary, "tags"> & { tags: string | null }>(
            `SELECT ${SUMMARY_COLUMNS} FROM servers WHERE id = ?`,
            [id]
        );
        return row ? toSummary(row) : null;
    },

    // The full row with decrypted secrets, for connecting. Each secret is
    // decrypted on its own, so a stale one (e.g. a key no longer used, saved
    // before the data key was replaced) does not hide the others; the
    // connection code decides whether it needed it.
    async getRecord(id: number): Promise<ServerRecord | null> {
        const row = await dbGet<ServerRow>("SELECT * FROM servers WHERE id = ?", [id]);
        if (!row) return null;
        const unreadable: SecretColumn[] = [];
        const open = (column: SecretColumn): string | null => {
            try {
                return openSecret(row[column]);
            } catch (err) {
                if (!(err instanceof SecretDecryptionError)) throw err;
                unreadable.push(column);
                return null;
            }
        };
        return {
            ...row,
            type: row.type as ServerType,
            tags: parseTags(row.tags),
            password: open("password"),
            privateKey: open("privateKey"),
            passphrase: open("passphrase"),
            s3_secret_key: open("s3_secret_key"),
            unreadable
        };
    },

    async create(body: Body): Promise<number> {
        return transaction((tx) => insertServer(tx, body));
    },

    // create() inside the caller's transaction (imports).
    createIn(tx: DbClient, body: Body): Promise<number> {
        return insertServer(tx, body);
    },

    // PUT semantics (see ServerInput in shared/types.ts). Returns false when
    // the server does not exist.
    async update(id: number, body: Body): Promise<boolean> {
        return transaction(async (tx) => {
            const current = await tx.get<ServerRow>("SELECT * FROM servers WHERE id = ?", [id]);
            if (!current) return false;

            const changes: Record<string, unknown> = { ...connectionFields(body), ...optionalFields(body) };
            if (changes.sort_order === null) delete changes.sort_order;
            if (typeof changes.jump_server_id === "number") await assertJumpServer(tx, changes.jump_server_id, id);
            await checkIdentity(tx, changes);

            const kept: Array<SecretColumn | "identity"> = [];
            for (const column of SERVER_SECRET_COLUMNS) {
                const value = secret(body, column);
                if (body[CLEAR_FLAGS[column]] === true) changes[column] = null;
                else if (value) changes[column] = encryptSecret(value);
                else if (current[column]) kept.push(column);
            }

            const next = { ...current, ...changes } as ServerRow;
            if (current.identity_id !== null && next.identity_id === current.identity_id && await identityHoldsSecretsIn(tx, current.identity_id)) {
                kept.push("identity");
            }
            const retargeted = targetIdentity(current) !== targetIdentity(next) || tlsDowngrade(current, next);
            if (retargeted && kept.length > 0 && body.keep_secrets !== true) {
                throw new AppError(
                    "SECRETS_RETARGET",
                    "This change points the connection at a different target (or turns off FTPS), so its saved credentials are not reused automatically. Enter the password or key again (or clear them) to save it.",
                    409,
                    { kept }
                );
            }

            changes.updated_at = Date.now();
            const columns = Object.keys(changes);
            await tx.run(
                `UPDATE servers SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
                [...columns.map((column) => changes[column]), id]
            );
            return true;
        });
    },

    // The manual order of the sidebar: the given servers get sort_order 0..n-1
    // in that order (ids that do not exist are ignored). Not an edit either.
    async reorder(ids: number[]): Promise<number> {
        return transaction(async (tx) => {
            let changed = 0;
            for (const [index, id] of ids.entries()) {
                changed += (await tx.run("UPDATE servers SET sort_order = ? WHERE id = ?", [index, id])).changes;
            }
            return changed;
        });
    },

    // The OS detected by a live session. Not an edit: updated_at is unchanged.
    async setOsDetail(id: number, osDetail: string | null): Promise<boolean> {
        const { changes } = await dbRun("UPDATE servers SET os_detail = ? WHERE id = ?", [osDetail, id]);
        return changes > 0;
    },

    // Pins or unpins a server at the top of the sidebar. Not an edit either.
    async setFavorite(id: number, favorite: boolean): Promise<boolean> {
        const { changes } = await dbRun("UPDATE servers SET favorite = ? WHERE id = ?", [favorite ? 1 : 0, id]);
        return changes > 0;
    },

    // Deletes the server and everything scoped to it. Returns false when it
    // does not exist. A jump host still used by other servers is refused:
    // unlinking it would point their saved credentials straight at their own
    // (usually private) addresses, a retarget that update() only allows on
    // confirmation.
    async remove(id: number): Promise<boolean> {
        return transaction(async (tx) => {
            const row = await tx.get<{ id: number }>("SELECT id FROM servers WHERE id = ?", [id]);
            if (!row) return false;
            const dependents = await tx.all<{ id: number; name: string }>(
                "SELECT id, name FROM servers WHERE jump_server_id = ? ORDER BY id",
                [id]
            );
            if (dependents.length > 0) {
                throw new AppError(
                    "JUMP_HOST_IN_USE",
                    `This server is the jump host of ${dependents.map((server) => `"${server.name}"`).join(", ")}. Change their jump host first.`,
                    409,
                    { dependents }
                );
            }
            await tx.run("DELETE FROM chat_history WHERE server_id = ?", [String(id)]);
            await settingsRepo.deleteIn(tx, cliHistoryKey(id));
            await settingsRepo.deleteIn(tx, rdpAskPasswordKey(id));
            await tx.run("DELETE FROM tunnels WHERE server_id = ?", [id]);
            await tx.run("DELETE FROM snippets WHERE server_id = ?", [id]);
            await tx.run("DELETE FROM servers WHERE id = ?", [id]);
            return true;
        });
    }
};
