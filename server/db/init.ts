import fs from "fs";
import path from "path";
import type sqlite3 from "sqlite3";
import { RESET_DATA_KEY } from "../config";
import { createLogger } from "../logger";
import { createDataKeyFile, decryptSecret, encryptSecret, findDataKey, isEncrypted, KEY_FILE_NAME, setDataKey, type DataKey } from "../security/secrets";
import { IDENTITY_SECRET_COLUMNS } from "./identitiesRepo";
import { runMigrations } from "./migrations";
import { SERVER_SECRET_COLUMNS } from "./serversRepo";
import { SECRET_SETTING_KEYS, settingsRepo } from "./settingsRepo";
import { closeHandle, dbGet, defaultDbPath, execSql, openDatabase, setDb, transaction } from "./sqlite";

export type InitOptions = {
    // SHELLMIND_RESET_DATA_KEY: see loadKey().
    resetDataKey?: boolean;
};

const log = createLogger("db");

let current: Promise<sqlite3.Database> | null = null;

// Opens the database, applies the pending migrations, loads the data key and
// encrypts any secret still stored in plaintext. Must finish before the
// server handles requests; rejects (and leaves nothing open) on failure.
export function initDatabase(file: string = defaultDbPath(), options: InitOptions = {}): Promise<sqlite3.Database> {
    current ??= open(file, options).catch((err) => {
        current = null;
        throw err;
    });
    return current;
}

// The database holds credentials: keep it private to this user. SQLite
// creates the -wal and -shm files with the database file's mode.
function restrictToOwner(file: string): void {
    if (process.platform === "win32") return;
    fs.closeSync(fs.openSync(file, "a", 0o600));
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
        if (fs.existsSync(candidate)) fs.chmodSync(candidate, 0o600);
    }
}

async function open(file: string, options: InitOptions): Promise<sqlite3.Database> {
    const dir = path.dirname(file);
    fs.mkdirSync(dir, { recursive: true });
    log.info(`Opening database at ${file}`);
    restrictToOwner(file);

    const handle = await openDatabase(file);
    try {
        handle.configure("busyTimeout", 5000);
        // secure_delete zeroes deleted content, e.g. replaced credentials.
        await execSql(handle, "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;");

        setDb(handle);
        const { from } = await runMigrations();

        const { key, reset } = await loadKey(dir, options.resetDataKey ?? RESET_DATA_KEY);
        setDataKey(key);
        const { encrypted, cleared } = await encryptPlaintextSecrets({ clearUnreadable: reset });
        // Rewrite the file so replaced plaintext does not linger in free pages,
        // including rows a v0.3 database (schema 0) deleted or overwrote.
        if (encrypted > 0 || cleared > 0 || from === 0) await execSql(handle, "VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
        return handle;
    } catch (err) {
        setDb(null);
        await closeHandle(handle).catch(() => undefined);
        throw err;
    }
}

export async function closeDatabase(): Promise<void> {
    const pending = current;
    current = null;
    if (!pending) return;
    const handle = await pending.catch(() => null);
    if (!handle) return;
    setDb(null);
    settingsRepo.clearCache();
    await closeHandle(handle);
}

// Tables whose rows hold encrypted secret columns (W7-S2: identities).
const SECRET_TABLES: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
    { table: "servers", columns: SERVER_SECRET_COLUMNS },
    { table: "identities", columns: IDENTITY_SECRET_COLUMNS }
];

async function countEncryptedSecrets(): Promise<number> {
    const sealed = (column: string) => `COALESCE(${column} GLOB 'enc:v1:*', 0)`;
    let count = 0;
    for (const { table, columns } of SECRET_TABLES) {
        const rows = await dbGet<{ count: number }>(`SELECT COALESCE(SUM(${columns.map(sealed).join(" + ")}), 0) AS count FROM ${table}`);
        count += rows?.count ?? 0;
    }
    const keys = [...SECRET_SETTING_KEYS];
    const settings = await dbGet<{ count: number }>(
        `SELECT COUNT(*) AS count FROM settings WHERE key IN (${keys.map(() => "?").join(", ")}) AND ${sealed("value")}`,
        keys
    );
    return count + (settings?.count ?? 0);
}

// The data key of this database. A key file is only generated for a database
// without encrypted credentials: otherwise the key that sealed them is
// missing (lost, not copied with the database, or given through
// SHELLMIND_DATA_KEY on other runs), and a new key would leave the database
// split between two keys. `resetDataKey` accepts a new key anyway; `reset`
// then tells the caller to clear the credentials it cannot read.
async function loadKey(dir: string, resetDataKey: boolean): Promise<DataKey & { reset: boolean }> {
    const found = findDataKey(dir);
    if (found) return { ...found, reset: false };

    const sealed = await countEncryptedSecrets();
    if (sealed > 0 && !resetDataKey) {
        throw new Error(
            `The database holds ${sealed} encrypted credential(s) but its data key is missing. ` +
            `Restore ${path.join(dir, KEY_FILE_NAME)} (back it up together with the database) or set SHELLMIND_DATA_KEY to the key it was saved with. ` +
            "To start over with a new key instead, set SHELLMIND_RESET_DATA_KEY=1: those credentials are then cleared and must be entered again."
        );
    }

    const created = createDataKeyFile(dir);
    if (created.created) {
        log.info(`Created a new data key at ${created.source}. Back it up together with the database: the saved credentials cannot be read without it.`);
    }
    return { key: created.key, source: created.source, reset: sealed > 0 };
}

// Startup migration from v0.3 (plaintext columns). Idempotent: encrypted
// values are left alone. Warns about secrets the current key cannot decrypt,
// or clears them with `clearUnreadable` (after a data key reset).
export async function encryptPlaintextSecrets(options: { clearUnreadable?: boolean } = {}): Promise<{ encrypted: number; unreadable: number; cleared: number }> {
    let encrypted = 0;
    let unreadable = 0;
    let cleared = 0;

    await transaction(async (tx) => {
        // The value to store instead, or undefined to keep it.
        const replacement = (value: string | null): string | null | undefined => {
            if (!value) return undefined;
            if (!isEncrypted(value)) {
                encrypted += 1;
                return encryptSecret(value);
            }
            try {
                decryptSecret(value);
                return undefined;
            } catch {
                if (!options.clearUnreadable) {
                    unreadable += 1;
                    return undefined;
                }
                cleared += 1;
                return null;
            }
        };

        for (const { table, columns } of SECRET_TABLES) {
            const rows = await tx.all<Record<string, string | number | null>>(`SELECT id, ${columns.join(", ")} FROM ${table}`);
            for (const row of rows) {
                for (const column of columns) {
                    const value = replacement(row[column] as string | null);
                    if (value !== undefined) await tx.run(`UPDATE ${table} SET ${column} = ? WHERE id = ?`, [value, row.id]);
                }
            }
        }

        for (const key of SECRET_SETTING_KEYS) {
            const row = await tx.get<{ value: string | null }>("SELECT value FROM settings WHERE key = ?", [key]);
            const value = replacement(row?.value ?? null);
            if (value !== undefined) await tx.run("UPDATE settings SET value = ? WHERE key = ?", [value, key]);
        }
    });

    if (encrypted > 0) log.info(`Encrypted ${encrypted} stored secret(s) that were in plaintext.`);
    if (cleared > 0) log.warn(`Cleared ${cleared} stored secret(s) saved with the previous data key; enter them again in the affected connections/settings.`);
    if (unreadable > 0) {
        log.warn(`${unreadable} stored secret(s) cannot be decrypted with the current data key; re-enter them in the affected connections/settings.`);
    }
    return { encrypted, unreadable, cleared };
}
