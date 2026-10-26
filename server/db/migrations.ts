import { normalizeCliPreset } from "../../shared/cliPresets";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import { effectivePort } from "../../shared/ports";
import type { ServerType } from "../../shared/types";
import { normalizeHost } from "./serversRepo";
import { dbGet, transaction, type DbClient } from "./sqlite";

// Ordered schema migrations, tracked with PRAGMA user_version. Each one runs
// in its own transaction together with the version bump, so a failure leaves
// the database at the previous version and stops the server from starting.

const log = createLogger("db");

type Migration = {
    version: number;
    name: string;
    up: (tx: DbClient) => Promise<void>;
};

async function addMissingColumns(tx: DbClient, table: string, columns: string[]): Promise<void> {
    const existing = new Set((await tx.all<{ name: string }>(`PRAGMA table_info(${table})`)).map((column) => column.name));
    for (const definition of columns) {
        const name = definition.split(/\s+/)[0];
        if (!existing.has(name)) await tx.run(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
    }
}

export const MIGRATIONS: Migration[] = [
    {
        // The v0.3.x schema. Databases created by v0.3 have user_version 0 and
        // any subset of these columns, so every step is idempotent.
        version: 1,
        name: "v0.3 schema",
        up: async (tx) => {
            await tx.run(`CREATE TABLE IF NOT EXISTS servers (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                ip TEXT NOT NULL,
                type TEXT NOT NULL,
                username TEXT,
                password TEXT,
                port INTEGER DEFAULT 22,
                os_detail TEXT
            )`);
            await addMissingColumns(tx, "servers", [
                "os_detail TEXT",
                "ssh_port INTEGER",
                "s3_provider TEXT",
                "s3_bucket TEXT",
                "s3_region TEXT",
                "s3_endpoint TEXT",
                "s3_access_key TEXT",
                "s3_secret_key TEXT",
                "privateKey TEXT",
                "passphrase TEXT",
                "command TEXT",
                "cwd TEXT",
                "initial_command TEXT",
                "cli_preset TEXT"
            ]);
            await tx.run(`CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            )`);
            await tx.run(`CREATE TABLE IF NOT EXISTS chat_history (
                server_id TEXT PRIMARY KEY,
                messages TEXT NOT NULL,
                updated_at INTEGER
            )`);
        }
    },
    {
        version: 2,
        name: "v1.0 organization, jump hosts, known hosts, snippets, tunnels, audit log",
        up: async (tx) => {
            await addMissingColumns(tx, "servers", [
                "group_name TEXT",
                "tags TEXT",
                "color TEXT",
                "notes TEXT",
                "sort_order INTEGER NOT NULL DEFAULT 0",
                // A jump host in use cannot be deleted (serversRepo.remove explains why).
                "jump_server_id INTEGER REFERENCES servers(id) ON DELETE RESTRICT",
                "private_key_path TEXT",
                "domain TEXT",
                "updated_at INTEGER"
            ]);
            await tx.run("UPDATE servers SET updated_at = ? WHERE updated_at IS NULL", [Date.now()]);
            // Hosts pasted with stray (non-breaking) spaces only worked in the
            // terminal. Normalized like the API does, so an edit of the row is
            // not mistaken for a new target.
            const hosts = await tx.all<{ id: number; ip: string | null }>("SELECT id, ip FROM servers");
            for (const { id, ip } of hosts) {
                const normalized = normalizeHost(ip ?? "");
                if (normalized !== ip) await tx.run("UPDATE servers SET ip = ? WHERE id = ?", [normalized, id]);
            }
            // Blank ports are stored as NULL and resolved per type at connect time
            // (shared/ports.ts). v0.3 saved FTP, S3 and local rows with port 22.
            await tx.run("UPDATE servers SET port = NULL WHERE type IN ('s3', 'local') OR (type = 'ftp' AND port = 22)");
            await tx.run("UPDATE servers SET ssh_port = NULL WHERE type <> 'windows'");

            await tx.run(`CREATE TABLE IF NOT EXISTS known_hosts (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                key_type TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE (host, port)
            )`);
            await tx.run(`CREATE TABLE IF NOT EXISTS snippets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                command TEXT NOT NULL,
                description TEXT,
                tags TEXT,
                server_id INTEGER REFERENCES servers(id) ON DELETE CASCADE,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )`);
            await tx.run(`CREATE TABLE IF NOT EXISTS tunnels (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                server_id INTEGER NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
                name TEXT,
                local_host TEXT NOT NULL DEFAULT '127.0.0.1',
                local_port INTEGER NOT NULL,
                remote_host TEXT NOT NULL,
                remote_port INTEGER NOT NULL,
                auto_start INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            )`);
            // No foreign key: audit entries outlive the server (server_name keeps it readable).
            await tx.run(`CREATE TABLE IF NOT EXISTS audit_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                ts INTEGER NOT NULL,
                server_id INTEGER,
                server_name TEXT,
                source TEXT NOT NULL,
                command TEXT NOT NULL,
                exit_code INTEGER,
                meta TEXT
            )`);

            await tx.run("CREATE INDEX IF NOT EXISTS idx_servers_jump_server ON servers (jump_server_id)");
            await tx.run("CREATE INDEX IF NOT EXISTS idx_snippets_server ON snippets (server_id)");
            await tx.run("CREATE INDEX IF NOT EXISTS idx_tunnels_server ON tunnels (server_id)");
            await tx.run("CREATE INDEX IF NOT EXISTS idx_audit_log_ts ON audit_log (ts)");
            await tx.run("CREATE INDEX IF NOT EXISTS idx_audit_log_server ON audit_log (server_id, id)");
        }
    },
    {
        // FTP over explicit TLS (FTPS). Off for existing rows: they connect as before.
        version: 7,
        name: "v1.0 FTPS flag",
        up: async (tx) => {
            await addMissingColumns(tx, "servers", ["ftp_secure INTEGER NOT NULL DEFAULT 0"]);
        }
    },
    {
        // Favourites pinned at the top of the sidebar.
        version: 8,
        name: "v1.0 favourite servers",
        up: async (tx) => {
            await addMissingColumns(tx, "servers", ["favorite INTEGER NOT NULL DEFAULT 0"]);
        }
    },
    {
        // slice V4b.
        version: 10,
        name: "v1.0 known CLI presets, audit log search index",
        up: async (tx) => {
            // Presets are stored lowercase and only on local servers, as the
            // API now saves them. A value ShellMind does not know is left as
            // it is: the terminal refuses it (instead of opening the system
            // shell) until the connection is edited.
            await tx.run("UPDATE servers SET cli_preset = NULL WHERE type <> 'local' OR TRIM(cli_preset) = ''");
            const presets = await tx.all<{ id: number; cli_preset: string }>("SELECT id, cli_preset FROM servers WHERE cli_preset IS NOT NULL");
            for (const { id, cli_preset } of presets) {
                const known = normalizeCliPreset(cli_preset);
                if (known && known !== cli_preset) await tx.run("UPDATE servers SET cli_preset = ? WHERE id = ?", [known, id]);
            }
            await createAuditSearchIndex(tx);
        }
    },
    {
        // V1 (BC-02): host keys are pinned per host, port and jump route
        // (server/ssh/hostKeys.ts routeVia), so the same private address
        // behind two bastions no longer shares one pin. Numbered after 10:
        // development databases already carried 10 when this was merged, and
        // a 9 would have been skipped on them.
        version: 11,
        name: "v1.0 host keys pinned per jump route",
        up: async (tx) => {
            // A development database that ran this as migration 9 already has it.
            const columns = await tx.all<{ name: string }>("PRAGMA table_info(known_hosts)");
            if (columns.some((column) => column.name === "via")) return;
            await tx.run(`CREATE TABLE known_hosts_by_route (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                via TEXT NOT NULL DEFAULT '',
                key_type TEXT NOT NULL,
                fingerprint TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE (host, port, via)
            )`);
            await tx.run(`INSERT INTO known_hosts_by_route (id, host, port, via, key_type, fingerprint, created_at)
                SELECT id, host, port, '', key_type, fingerprint, created_at FROM known_hosts`);
            await tx.run("DROP TABLE known_hosts");
            await tx.run("ALTER TABLE known_hosts_by_route RENAME TO known_hosts");

            // Existing pins carry over to the routes that use them, so nothing
            // is trusted on first use again: a pin of an address saved behind
            // jump hosts moves to (or is copied to) each of those routes.
            const routes = await savedSshRoutes(tx);
            const pins = await tx.all<{ id: number; host: string; port: number; key_type: string; fingerprint: string; created_at: number }>(
                "SELECT id, host, port, key_type, fingerprint, created_at FROM known_hosts"
            );
            for (const pin of pins) {
                const vias = routes.get(`${pin.host}:${pin.port}`);
                if (!vias) continue;
                const jumped = [...vias].filter((via) => via !== "");
                if (jumped.length === 0) continue;
                const [first, ...rest] = jumped;
                const copies = vias.has("") ? jumped : rest;
                if (!vias.has("")) await tx.run("UPDATE known_hosts SET via = ? WHERE id = ?", [first, pin.id]);
                for (const via of copies) {
                    await tx.run(
                        "INSERT INTO known_hosts (host, port, via, key_type, fingerprint, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                        [pin.host, pin.port, via, pin.key_type, pin.fingerprint, pin.created_at]
                    );
                }
            }
        }
    },
    // --- W7-S1 fleet board ---
    {
        // The latest health check of each SSH server (server/fleet), so the
        // fleet board is filled as soon as the backend starts. `data` is the
        // rest of the snapshot as JSON; a deleted server takes its row along.
        version: 12,
        name: "v1.0 fleet health snapshots",
        up: async (tx) => {
            await tx.run(`CREATE TABLE IF NOT EXISTS health_snapshots (
                server_id INTEGER PRIMARY KEY REFERENCES servers(id) ON DELETE CASCADE,
                collected_at INTEGER NOT NULL,
                state TEXT NOT NULL,
                data TEXT NOT NULL,
                error_code TEXT
            )`);
        }
    },
    // --- W7-S2 identities ---
    {
        // Credentials several servers share (Settings > Keychain). Secrets are
        // stored like the servers' (enc:v1, server/db/identitiesRepo.ts). An
        // identity in use cannot be deleted (409 IDENTITY_IN_USE).
        version: 13,
        name: "v1.0 identities, SSH agent forwarding",
        up: async (tx) => {
            await tx.run(`CREATE TABLE IF NOT EXISTS identities (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                username TEXT,
                password TEXT,
                privateKey TEXT,
                passphrase TEXT,
                private_key_path TEXT,
                use_agent INTEGER NOT NULL DEFAULT 0,
                public_key TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL
            )`);
            await addMissingColumns(tx, "servers", [
                "identity_id INTEGER REFERENCES identities(id) ON DELETE RESTRICT",
                "agent_forward INTEGER NOT NULL DEFAULT 0"
            ]);
            await tx.run("CREATE INDEX IF NOT EXISTS idx_servers_identity ON servers (identity_id)");
        }
    },
    // --- W7-S4 multi-exec jobs ---------------------------------------------
    {
        // Multi-exec runs become background jobs with a history: the job
        // (command as recorded, strategy, state) and one row per server with
        // its result and the start of its output (gzipped JSON). Secret values
        // are never stored (server/multiexec/request.ts).
        version: 14,
        name: "v1.0 multi-exec jobs and their results",
        up: async (tx) => {
            await tx.run(`CREATE TABLE IF NOT EXISTS multiexec_jobs (
                id TEXT PRIMARY KEY,
                command TEXT NOT NULL,
                masked INTEGER NOT NULL DEFAULT 0,
                template TEXT,
                template_masked INTEGER NOT NULL DEFAULT 0,
                variables TEXT,
                secret_variables TEXT,
                snippet_id INTEGER,
                snippet_name TEXT,
                timeout_sec INTEGER NOT NULL,
                strategy TEXT NOT NULL,
                status TEXT NOT NULL,
                pause TEXT,
                stop_reason TEXT,
                batch INTEGER,
                batches INTEGER NOT NULL,
                danger TEXT,
                rerun_of TEXT,
                total INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                finished_at INTEGER
            )`);
            await tx.run("CREATE INDEX IF NOT EXISTS multiexec_jobs_created ON multiexec_jobs (created_at)");
            await tx.run(`CREATE TABLE IF NOT EXISTS multiexec_job_results (
                job_id TEXT NOT NULL REFERENCES multiexec_jobs(id) ON DELETE CASCADE,
                position INTEGER NOT NULL,
                server_id INTEGER NOT NULL,
                server_name TEXT NOT NULL,
                host TEXT NOT NULL,
                server_type TEXT NOT NULL,
                batch INTEGER NOT NULL,
                status TEXT NOT NULL,
                exit_code INTEGER,
                signal TEXT,
                error TEXT,
                error_code TEXT,
                started_at INTEGER,
                finished_at INTEGER,
                duration_ms INTEGER,
                truncated INTEGER NOT NULL DEFAULT 0,
                output_hash TEXT,
                normalized_hash TEXT,
                output BLOB,
                output_trimmed INTEGER NOT NULL DEFAULT 0,
                PRIMARY KEY (job_id, position)
            )`);
        }
    },
    // --- end W7-S4 ---------------------------------------------------------
    // --- W7-S6 embedded RDP ---
    {
        // TLS certificates of RDP servers, pinned on first use by the
        // embedded client's gateway (server/rdp/certificates.ts), per host,
        // port and jump route like SSH host keys.
        version: 15,
        name: "v1.0 RDP certificate pins",
        up: async (tx) => {
            await tx.run(`CREATE TABLE IF NOT EXISTS rdp_certificates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                host TEXT NOT NULL,
                port INTEGER NOT NULL,
                via TEXT NOT NULL DEFAULT '',
                fingerprint TEXT NOT NULL,
                thumbprint TEXT NOT NULL,
                subject TEXT NOT NULL DEFAULT '',
                issuer TEXT NOT NULL DEFAULT '',
                valid_from INTEGER,
                valid_to INTEGER,
                created_at INTEGER NOT NULL,
                UNIQUE (host, port, via)
            )`);
        }
    }
];

// Text search of the audit log (command or server name, any substring) is a
// trigram full-text index kept in sync by triggers; a LIKE '%text%' scan of
// the whole table would hold the database for every search. Without FTS5
// trigram support in the linked SQLite the search falls back to that scan.
export const AUDIT_SEARCH_TABLE = "audit_log_search";

async function createAuditSearchIndex(tx: DbClient): Promise<void> {
    try {
        await tx.run(`CREATE VIRTUAL TABLE IF NOT EXISTS ${AUDIT_SEARCH_TABLE} USING fts5(
            command, server_name, content='audit_log', content_rowid='id', tokenize='trigram'
        )`);
    } catch (err) {
        log.warn(`The audit log search index is not available (${errorMessage(err)}); searches scan the table.`);
        return;
    }
    await tx.run(`CREATE TRIGGER IF NOT EXISTS ${AUDIT_SEARCH_TABLE}_insert AFTER INSERT ON audit_log BEGIN
        INSERT INTO ${AUDIT_SEARCH_TABLE} (rowid, command, server_name) VALUES (new.id, new.command, new.server_name);
    END`);
    await tx.run(`CREATE TRIGGER IF NOT EXISTS ${AUDIT_SEARCH_TABLE}_delete AFTER DELETE ON audit_log BEGIN
        INSERT INTO ${AUDIT_SEARCH_TABLE} (${AUDIT_SEARCH_TABLE}, rowid, command, server_name) VALUES ('delete', old.id, old.command, old.server_name);
    END`);
    await tx.run(`CREATE TRIGGER IF NOT EXISTS ${AUDIT_SEARCH_TABLE}_update AFTER UPDATE ON audit_log BEGIN
        INSERT INTO ${AUDIT_SEARCH_TABLE} (${AUDIT_SEARCH_TABLE}, rowid, command, server_name) VALUES ('delete', old.id, old.command, old.server_name);
        INSERT INTO ${AUDIT_SEARCH_TABLE} (rowid, command, server_name) VALUES (new.id, new.command, new.server_name);
    END`);
    await tx.run(`INSERT INTO ${AUDIT_SEARCH_TABLE} (${AUDIT_SEARCH_TABLE}) VALUES ('rebuild')`);
}

// host:port of every saved SSH server -> the jump routes it is reached
// through, computed like server/ssh/hostKeys.ts routeVia does at connect time.
async function savedSshRoutes(tx: DbClient): Promise<Map<string, Set<string>>> {
    type Row = { id: number; ip: string | null; type: ServerType; port: number | null; ssh_port: number | null; jump_server_id: number | null };
    const rows = await tx.all<Row>("SELECT id, ip, type, port, ssh_port, jump_server_id FROM servers WHERE type IN ('linux', 'windows')");
    const byId = new Map(rows.map((row) => [row.id, row]));
    const endpoint = (row: Row) => `${normalizeHost(row.ip ?? "")}:${effectivePort(row, "terminal")}`;
    const jumpOf = (row: Row) => (row.jump_server_id === null ? undefined : byId.get(row.jump_server_id));
    const routes = new Map<string, Set<string>>();
    for (const row of rows) {
        const hops: string[] = [];
        const seen = new Set([row.id]);
        // A broken chain (loop, missing or non-SSH jump) never connects.
        for (let jump = jumpOf(row); jump && !seen.has(jump.id); jump = jumpOf(jump)) {
            seen.add(jump.id);
            hops.unshift(endpoint(jump));
        }
        const key = endpoint(row);
        const vias = routes.get(key) ?? new Set<string>();
        vias.add(hops.join(">"));
        routes.set(key, vias);
    }
    return routes;
}

// Applied in version order whatever their order in the array (feature
// branches add theirs side by side).
const ORDERED = [...MIGRATIONS].sort((a, b) => a.version - b.version);

export const SCHEMA_VERSION = ORDERED[ORDERED.length - 1].version;

export async function getSchemaVersion(): Promise<number> {
    const row = await dbGet<{ user_version: number }>("PRAGMA user_version");
    return row?.user_version ?? 0;
}

export async function runMigrations(): Promise<{ from: number; to: number }> {
    const from = await getSchemaVersion();
    if (from > SCHEMA_VERSION) {
        throw new Error(`The database schema (v${from}) is newer than this version of ShellMind supports (v${SCHEMA_VERSION}).`);
    }

    for (const migration of ORDERED) {
        if (migration.version <= from) continue;
        await transaction(async (tx) => {
            await migration.up(tx);
            await tx.run(`PRAGMA user_version = ${migration.version}`);
        });
        log.info(`Database migrated to v${migration.version} (${migration.name})`);
    }

    return { from, to: SCHEMA_VERSION };
}
