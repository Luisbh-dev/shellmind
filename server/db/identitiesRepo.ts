import { IDENTITY_LIMITS, type AssignIdentityResult, type IdentityDependent, type IdentitySummary } from "../../shared/identities";
import type { ImportReviewCredential } from "../../shared/organization";
import { AppError } from "../errors";
import { describePublicKey, generateEd25519, InvalidKeyError, publicKeyOf } from "../identities/keys";
import { encryptSecret, openSecret, SecretDecryptionError } from "../security/secrets";
import { dbAll, dbGet, transaction, type DbClient } from "./sqlite";

// The identities table (W7-S2): credentials several SSH servers connect with.
// Secrets are encrypted on write like the servers' and decrypted only by
// getRecord() for server-side connection code; summaries never contain them.

export const IDENTITY_SECRET_COLUMNS = ["password", "privateKey", "passphrase"] as const;
export type IdentitySecretColumn = typeof IDENTITY_SECRET_COLUMNS[number];

const CLEAR_FLAGS: Record<IdentitySecretColumn, string> = {
    password: "clear_password",
    privateKey: "clear_private_key",
    passphrase: "clear_passphrase"
};

type IdentityRow = {
    id: number;
    name: string;
    username: string | null;
    private_key_path: string | null;
    use_agent: number;
    public_key: string | null;
    created_at: number;
    updated_at: number;
} & Record<IdentitySecretColumn, string | null>;

// An identity with its secrets decrypted. Server-side only. A secret sealed
// with another data key reads as null and is listed in `unreadable`.
export type IdentityRecord = IdentityRow & { unreadable: IdentitySecretColumn[] };

// What an identity signs in with, without its secrets.
export type IdentityUses = { id: number; name: string; uses: ImportReviewCredential["uses"] };

const SUMMARY_SQL = `
    SELECT i.id, i.name, i.username, i.private_key_path, i.use_agent, i.public_key, i.created_at, i.updated_at,
        (i.password IS NOT NULL AND i.password != '') AS has_password,
        (i.privateKey IS NOT NULL AND i.privateKey != '') AS has_private_key,
        (i.passphrase IS NOT NULL AND i.passphrase != '') AS has_passphrase,
        (SELECT COUNT(*) FROM servers s WHERE s.identity_id = i.id) AS server_count
    FROM identities i`;

type SummaryRow = Omit<IdentitySummary, "fingerprint" | "key_type">;

// The public key only describes a key still stored (a data key reset clears
// unreadable secrets, not the derived column).
function toSummary(row: SummaryRow): IdentitySummary {
    const key = row.has_private_key ? describePublicKey(row.public_key) : null;
    return { ...row, public_key: key ? row.public_key : null, fingerprint: key?.fingerprint ?? null, key_type: key?.type ?? null };
}

// --- Input validation ---------------------------------------------------------

type Body = Record<string, unknown>;

function invalid(message: string, field?: string): AppError {
    return new AppError("INVALID_IDENTITY", message, 400, field ? { field } : undefined);
}

// Trimmed text; blank and null become null.
function text(body: Body, key: string, max: number): string | null {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid(`${key} must be a string`, key);
    const trimmed = value.trim();
    if (trimmed.length > max) throw invalid(`${key} is too long`, key);
    return trimmed || null;
}

function flag(body: Body, key: string): boolean {
    const value = body[key];
    if (value === undefined || value === null || value === false || value === 0) return false;
    if (value === true || value === 1) return true;
    throw invalid(`${key} must be a boolean`, key);
}

// A secret as typed: kept verbatim, blank means "not given".
function secret(body: Body, key: IdentitySecretColumn): string | null {
    const value = body[key];
    if (value === undefined || value === null) return null;
    if (typeof value !== "string") throw invalid(`${key} must be a string`, key);
    if (value.length > IDENTITY_LIMITS.secret) throw invalid(`${key} is too long`, key);
    return value.trim() ? value : null;
}

function name(body: Body): string {
    const value = text(body, "name", IDENTITY_LIMITS.name);
    if (!value) throw invalid("name is required", "name");
    return value;
}

async function assertNameFree(tx: DbClient, value: string, selfId: number | null): Promise<void> {
    const taken = await tx.get<{ id: number }>("SELECT id FROM identities WHERE name = ? COLLATE NOCASE AND id IS NOT ?", [value, selfId]);
    if (taken) throw new AppError("IDENTITY_NAME_TAKEN", `An identity named "${value}" already exists.`, 409, { field: "name" });
}

// The values to write for `body` over `current` (null on create): plaintext
// secrets (encrypted by the caller), the derived public key, and what the
// stored key is checked against.
type Plan = {
    fields: { name: string; username: string | null; private_key_path: string | null; use_agent: number; public_key: string | null };
    secrets: Partial<Record<IdentitySecretColumn, string | null>>;
};

function plan(body: Body, current: IdentityRecord | null): Plan {
    const generate = flag(body, "generate_key");
    const typed = Object.fromEntries(IDENTITY_SECRET_COLUMNS.map((column) => [column, secret(body, column)])) as Record<IdentitySecretColumn, string | null>;
    const clear = (column: IdentitySecretColumn) => body[CLEAR_FLAGS[column]] === true;
    const keyPath = text(body, "private_key_path", IDENTITY_LIMITS.privateKeyPath);

    if (generate && (typed.privateKey || keyPath)) throw invalid("generate_key cannot be combined with a private key or a key file", "privateKey");
    if (generate && current?.privateKey && !clear("privateKey")) {
        throw new AppError("IDENTITY_KEY_EXISTS", "This identity already holds a private key: rotate it instead, or remove it first.", 409);
    }

    // Like a server's: a clear_* flag wins over a typed value.
    const secrets: Plan["secrets"] = {};
    for (const column of IDENTITY_SECRET_COLUMNS) {
        if (clear(column)) secrets[column] = null;
        else if (typed[column]) secrets[column] = typed[column];
    }

    const next = (column: IdentitySecretColumn): string | null => (column in secrets ? secrets[column] ?? null : current?.[column] ?? null);
    let publicKey = current?.public_key ?? null;
    if (generate) {
        const comment = text(body, "key_comment", IDENTITY_LIMITS.comment) ?? `shellmind:${name(body)}`;
        const pair = generateEd25519(comment, next("passphrase") ?? undefined);
        secrets.privateKey = pair.privateKey;
        publicKey = pair.publicKey;
    } else if ("privateKey" in secrets || "passphrase" in secrets) {
        const key = next("privateKey");
        // A new key, or a new passphrase for the stored one: it must open.
        // ShellMind never re-encrypts a stored key, so the passphrase of an
        // encrypted one cannot be changed or removed on its own.
        try {
            publicKey = key ? publicKeyOf(key, next("passphrase")).publicKey : null;
        } catch (err) {
            if (!(err instanceof InvalidKeyError) || "privateKey" in secrets) throw err;
            throw new AppError(
                "INVALID_PRIVATE_KEY",
                "The stored key does not open with this passphrase, and ShellMind does not re-encrypt a stored key. Rotate the key, or paste it again with its passphrase.",
                400,
                { field: "passphrase" }
            );
        }
    }
    if (next("privateKey") && keyPath) {
        throw invalid("An identity uses either a stored private key or a key file: remove one of them", "private_key_path");
    }

    return {
        fields: {
            name: name(body),
            username: text(body, "username", IDENTITY_LIMITS.username),
            private_key_path: keyPath,
            use_agent: flag(body, "use_agent") ? 1 : 0,
            public_key: next("privateKey") ? publicKey : null
        },
        secrets
    };
}

function sealed(secrets: Plan["secrets"]): Record<string, string | null> {
    return Object.fromEntries(Object.entries(secrets).map(([column, value]) => [column, value ? encryptSecret(value) : null]));
}

function open(row: IdentityRow): IdentityRecord {
    const unreadable: IdentitySecretColumn[] = [];
    const read = (column: IdentitySecretColumn): string | null => {
        try {
            return openSecret(row[column]);
        } catch (err) {
            if (!(err instanceof SecretDecryptionError)) throw err;
            unreadable.push(column);
            return null;
        }
    };
    return { ...row, password: read("password"), privateKey: read("privateKey"), passphrase: read("passphrase"), unreadable };
}

async function recordIn(tx: DbClient, id: number): Promise<IdentityRecord | null> {
    const row = await tx.get<IdentityRow>("SELECT * FROM identities WHERE id = ?", [id]);
    return row ? open(row) : null;
}

const isSshType = (type: string) => type === "linux" || type === "windows";

// --- Repository ---------------------------------------------------------------

export const identitiesRepo = {
    async listSummaries(): Promise<IdentitySummary[]> {
        return (await dbAll<SummaryRow>(`${SUMMARY_SQL} ORDER BY i.name COLLATE NOCASE, i.id`)).map(toSummary);
    },

    async getSummary(id: number): Promise<IdentitySummary | null> {
        const row = await dbGet<SummaryRow>(`${SUMMARY_SQL} WHERE i.id = ?`, [id]);
        return row ? toSummary(row) : null;
    },

    // The full row with decrypted secrets, for connecting. Like a server's,
    // each secret is decrypted on its own.
    async getRecord(id: number): Promise<IdentityRecord | null> {
        const row = await dbGet<IdentityRow>("SELECT * FROM identities WHERE id = ?", [id]);
        return row ? open(row) : null;
    },

    // By name, case-insensitively (imports match identities by name), with
    // what it signs in with (no secret).
    async findByNameIn(tx: DbClient, identityName: string): Promise<IdentityUses | null> {
        const row = await tx.get<{ id: number; name: string; has_password: number; has_private_key: number; private_key_path: string | null; use_agent: number }>(
            `SELECT id, name, private_key_path, use_agent,
                (password IS NOT NULL AND password != '') AS has_password,
                (privateKey IS NOT NULL AND privateKey != '') AS has_private_key
            FROM identities WHERE name = ? COLLATE NOCASE`,
            [identityName.trim()]
        );
        if (!row) return null;
        return {
            id: row.id,
            name: row.name,
            uses: [
                ...(row.has_password ? ["password" as const] : []),
                ...(row.has_private_key ? ["key" as const] : []),
                ...(row.private_key_path ? ["keyFile" as const] : []),
                ...(row.use_agent ? ["agent" as const] : [])
            ]
        };
    },

    // ssh-config import: a saved identity that holds nothing but this key
    // file and agent use (no password, stored key or username), so giving it
    // to the hosts a pasted config names hands them nothing more than the
    // file itself would.
    async findKeyFileOnly(keyPath: string | null, useAgent: boolean): Promise<{ id: number; name: string } | null> {
        const row = await dbGet<{ id: number; name: string }>(
            `SELECT id, name FROM identities
            WHERE COALESCE(private_key_path, '') = ? AND use_agent = ?
                AND COALESCE(password, '') = '' AND COALESCE(privateKey, '') = '' AND COALESCE(username, '') = ''
            ORDER BY id LIMIT 1`,
            [keyPath ?? "", useAgent ? 1 : 0]
        );
        return row ?? null;
    },

    // `base`, or "base (2)", "base (3)"... whichever no identity has yet.
    async freeName(base: string): Promise<string> {
        const stem = base.trim().slice(0, IDENTITY_LIMITS.name - 8) || "identity";
        for (let index = 1; index < 1000; index += 1) {
            const candidate = index === 1 ? stem : `${stem} (${index})`;
            if (!(await dbGet("SELECT id FROM identities WHERE name = ? COLLATE NOCASE", [candidate]))) return candidate;
        }
        return `${stem} (${Date.now()})`;
    },

    async create(body: Body): Promise<number> {
        return transaction((tx) => this.createIn(tx, body));
    },

    async createIn(tx: DbClient, body: Body): Promise<number> {
        const { fields, secrets } = plan(body, null);
        await assertNameFree(tx, fields.name, null);
        const now = Date.now();
        const values: Record<string, unknown> = { ...fields, ...sealed(secrets), created_at: now, updated_at: now };
        const columns = Object.keys(values);
        const { lastID } = await tx.run(
            `INSERT INTO identities (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
            columns.map((column) => values[column])
        );
        return lastID;
    },

    // PUT semantics (IdentityInput in shared/identities.ts). Returns false
    // when it does not exist. Every save bumps updated_at, which is part of
    // the connection version of the servers using it.
    async update(id: number, body: Body): Promise<boolean> {
        return transaction(async (tx) => {
            const current = await recordIn(tx, id);
            if (!current) return false;
            const { fields, secrets } = plan(body, current);
            await assertNameFree(tx, fields.name, id);
            const values: Record<string, unknown> = { ...fields, ...sealed(secrets), updated_at: Math.max(Date.now(), current.updated_at + 1) };
            const columns = Object.keys(values);
            await tx.run(
                `UPDATE identities SET ${columns.map((column) => `${column} = ?`).join(", ")} WHERE id = ?`,
                [...columns.map((column) => values[column]), id]
            );
            return true;
        });
    },

    // Replaces the stored key pair (rotation, after the new public key was
    // installed). The passphrase goes with the new key.
    async replaceKey(id: number, privateKey: string, passphrase: string | null, publicKey: string): Promise<boolean> {
        return transaction(async (tx) => {
            const current = await tx.get<{ updated_at: number }>("SELECT updated_at FROM identities WHERE id = ?", [id]);
            if (!current) return false;
            await tx.run(
                "UPDATE identities SET privateKey = ?, passphrase = ?, public_key = ?, private_key_path = NULL, updated_at = ? WHERE id = ?",
                [encryptSecret(privateKey), passphrase ? encryptSecret(passphrase) : null, publicKey, Math.max(Date.now(), current.updated_at + 1), id]
            );
            return true;
        });
    },

    async dependents(id: number): Promise<IdentityDependent[]> {
        return dbAll<IdentityDependent>("SELECT id, name FROM servers WHERE identity_id = ? ORDER BY sort_order, id", [id]);
    },

    // Refused while servers use it (409 IDENTITY_IN_USE, details.dependents).
    async remove(id: number): Promise<boolean> {
        return transaction(async (tx) => {
            const row = await tx.get<{ name: string }>("SELECT name FROM identities WHERE id = ?", [id]);
            if (!row) return false;
            const dependents = await tx.all<IdentityDependent>("SELECT id, name FROM servers WHERE identity_id = ? ORDER BY sort_order, id", [id]);
            if (dependents.length > 0) {
                throw new AppError(
                    "IDENTITY_IN_USE",
                    `"${row.name}" is used by ${dependents.map((server) => `"${server.name}"`).join(", ")}. Assign them another identity (or none) first.`,
                    409,
                    { dependents }
                );
            }
            await tx.run("DELETE FROM identities WHERE id = ?", [id]);
            return true;
        });
    },

    // Points SSH servers at an identity (or none). With `clearOwn` their own
    // credentials go, so the identity's are used. Other server types are
    // skipped. Each changed server counts as edited (updated_at).
    async assign(identityId: number | null, serverIds: number[], clearOwn: boolean): Promise<AssignIdentityResult> {
        return transaction(async (tx) => {
            if (identityId !== null && !(await tx.get("SELECT id FROM identities WHERE id = ?", [identityId]))) {
                throw new AppError("IDENTITY_NOT_FOUND", "Identity not found", 404);
            }
            const result: AssignIdentityResult = { updated: [], skipped: [] };
            const now = Date.now();
            for (const serverId of serverIds) {
                const server = await tx.get<{ type: string }>("SELECT type FROM servers WHERE id = ?", [serverId]);
                if (!server || !isSshType(server.type)) {
                    result.skipped.push(serverId);
                    continue;
                }
                const clearing = clearOwn ? ", password = NULL, privateKey = NULL, passphrase = NULL, private_key_path = NULL" : "";
                await tx.run(`UPDATE servers SET identity_id = ?, updated_at = ?${clearing} WHERE id = ?`, [identityId, now, serverId]);
                result.updated.push(serverId);
            }
            return result;
        });
    }
};

// Whether `id` names an identity (servers repo validation).
export async function identityExistsIn(tx: DbClient, id: number): Promise<boolean> {
    return Boolean(await tx.get("SELECT id FROM identities WHERE id = ?", [id]));
}
