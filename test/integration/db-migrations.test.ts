import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sqlite3 from 'sqlite3';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Upgrading a database written by v0.3.3: versioned migrations, plaintext
// secrets encrypted at rest (and still usable), idempotent restarts.

type Init = typeof import('../../server/db/init');
type Repos = {
    servers: typeof import('../../server/db/serversRepo').serversRepo;
    settings: typeof import('../../server/db/settingsRepo').settingsRepo;
    getDb: typeof import('../../server/db/sqlite').getDb;
    encryptWithKey: typeof import('../../server/security/secrets').encryptWithKey;
};

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-migrate-'));
let init: Init;
let repos: Repos;
let SCHEMA_VERSION: number;

const PLAINTEXT = ['pw-linux-7f1', 'KEY-DATA-9c2', 'pp-3d4', 'pw-win-5e6', 'pw-ftp-8a0', 's3-secret-1b2', 'gem-key-4c3', 'mm-key-6d5'];

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
    return new Promise((resolve, reject) => db.run(sql, params, (err) => (err ? reject(err) : resolve())));
}

function rawAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => {
        repos.getDb().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
    });
}

async function withRawDb(file: string, work: (db: sqlite3.Database) => Promise<void>): Promise<void> {
    const db = await new Promise<sqlite3.Database>((resolve, reject) => {
        const handle = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(handle)));
    });
    try {
        await work(db);
    } finally {
        await new Promise<void>((resolve) => db.close(() => resolve()));
    }
}

// The schema exactly as v0.3.3 left it (rollback journal, user_version 0).
async function createV033Database(file: string): Promise<void> {
    await withRawDb(file, async (db) => {
        await run(db, `CREATE TABLE servers (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, type TEXT NOT NULL,
            username TEXT, password TEXT, port INTEGER DEFAULT 22, os_detail TEXT)`);
        for (const column of ['ssh_port INTEGER', 's3_provider TEXT', 's3_bucket TEXT', 's3_region TEXT', 's3_endpoint TEXT',
            's3_access_key TEXT', 's3_secret_key TEXT', 'privateKey TEXT', 'passphrase TEXT', 'command TEXT', 'cwd TEXT',
            'initial_command TEXT', 'cli_preset TEXT']) {
            await run(db, `ALTER TABLE servers ADD COLUMN ${column}`);
        }
        await run(db, 'CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT)');
        await run(db, 'CREATE TABLE chat_history (server_id TEXT PRIMARY KEY, messages TEXT NOT NULL, updated_at INTEGER)');

        const insert = 'INSERT INTO servers (name, ip, type, username, password, port, ssh_port, privateKey, passphrase, s3_bucket, s3_secret_key, os_detail) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)';
        await run(db, insert, ['web', ' 10.0.0.5\u00A0', 'linux', 'root', 'pw-linux-7f1', 22, 22, 'KEY-DATA-9c2', 'pp-3d4', null, null, 'Ubuntu 22.04']);
        await run(db, insert, ['win', '10.0.0. 6', 'windows', 'Administrator', 'pw-win-5e6', 3389, 22, null, null, null, null, null]);
        await run(db, insert, ['ftp', '10.0.0.7', 'ftp', 'ftpuser', 'pw-ftp-8a0', 22, 22, null, null, null, null, null]);
        await run(db, insert, ['bucket', 's3', 's3', null, '', 22, 22, null, null, 'backups', 's3-secret-1b2', null]);
        await run(db, insert, ['shell', 'local', 'local', null, null, 22, 22, null, null, null, null, null]);

        await run(db, "INSERT INTO settings (key, value) VALUES ('GEMINI_API_KEY', 'gem-key-4c3'), ('MINIMAX_API_KEY', 'mm-key-6d5'), ('PREFERRED_MODEL', 'gemini-2.5-flash'), ('cli_history:5', '[\"ps\"]')");
        await run(db, "INSERT INTO chat_history (server_id, messages, updated_at) VALUES ('1', '[{\"role\":\"user\",\"content\":\"hi\"}]', 1)");
    });
}

function dbFileText(file: string): string {
    return [file, `${file}-wal`, `${file}-journal`]
        .filter((candidate) => fs.existsSync(candidate))
        .map((candidate) => fs.readFileSync(candidate).toString('latin1'))
        .join('');
}

beforeAll(async () => {
    process.env.DOTENV_CONFIG_PATH = path.join(tmpDir, 'missing.env');
    process.env.DOTENV_CONFIG_QUIET = 'true';
    delete process.env.SHELLMIND_DATA_KEY;
    delete process.env.DB_PATH;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    init = await import('../../server/db/init');
    SCHEMA_VERSION = (await import('../../server/db/migrations')).SCHEMA_VERSION;
    repos = {
        servers: (await import('../../server/db/serversRepo')).serversRepo,
        settings: (await import('../../server/db/settingsRepo')).settingsRepo,
        getDb: (await import('../../server/db/sqlite')).getDb,
        encryptWithKey: (await import('../../server/security/secrets')).encryptWithKey,
    };
});

afterAll(async () => {
    await init?.closeDatabase();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('upgrading a v0.3.3 database', () => {
    const file = path.join(tmpDir, 'v033', 'shellmind.db');

    beforeAll(async () => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await createV033Database(file);
        await init.initDatabase(file);
    });

    it('applies every migration and records the schema version', async () => {
        expect(await rawAll('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
        expect(await rawAll('PRAGMA journal_mode')).toEqual([{ journal_mode: 'wal' }]);
        expect(await rawAll('PRAGMA foreign_keys')).toEqual([{ foreign_keys: 1 }]);

        const tables = (await rawAll<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map((t) => t.name);
        expect(tables).toEqual(expect.arrayContaining(['servers', 'settings', 'chat_history', 'known_hosts', 'snippets', 'tunnels', 'audit_log']));
        const columns = (await rawAll<{ name: string }>('PRAGMA table_info(servers)')).map((c) => c.name);
        expect(columns).toEqual(expect.arrayContaining(['group_name', 'tags', 'color', 'notes', 'sort_order', 'jump_server_id', 'private_key_path', 'domain', 'updated_at', 'ftp_secure', 'favorite']));
    });

    it('encrypts every stored secret and leaves no plaintext in the file', async () => {
        const rows = await rawAll<Record<string, string | null>>('SELECT password, privateKey, passphrase, s3_secret_key FROM servers ORDER BY id');
        expect(rows).toEqual([
            { password: expect.stringMatching(/^enc:v1:/), privateKey: expect.stringMatching(/^enc:v1:/), passphrase: expect.stringMatching(/^enc:v1:/), s3_secret_key: null },
            { password: expect.stringMatching(/^enc:v1:/), privateKey: null, passphrase: null, s3_secret_key: null },
            { password: expect.stringMatching(/^enc:v1:/), privateKey: null, passphrase: null, s3_secret_key: null },
            // A blank v0.3 password stays blank.
            { password: '', privateKey: null, passphrase: null, s3_secret_key: expect.stringMatching(/^enc:v1:/) },
            { password: null, privateKey: null, passphrase: null, s3_secret_key: null },
        ]);
        const settings = await rawAll<{ key: string; value: string }>('SELECT key, value FROM settings ORDER BY key');
        expect(Object.fromEntries(settings.map((s) => [s.key, s.value]))).toEqual({
            GEMINI_API_KEY: expect.stringMatching(/^enc:v1:/),
            MINIMAX_API_KEY: expect.stringMatching(/^enc:v1:/),
            PREFERRED_MODEL: 'gemini-2.5-flash',
            'cli_history:5': '["ps"]',
        });

        const onDisk = dbFileText(file);
        for (const secret of PLAINTEXT) expect(onDisk).not.toContain(secret);
        expect(fs.existsSync(path.join(path.dirname(file), 'shellmind.key'))).toBe(true);
    });

    it('still serves the secrets to server-side code', async () => {
        const web = await repos.servers.getRecord(1);
        expect(web).toMatchObject({ password: 'pw-linux-7f1', privateKey: 'KEY-DATA-9c2', passphrase: 'pp-3d4' });
        expect(await repos.servers.getRecord(4)).toMatchObject({ s3_secret_key: 's3-secret-1b2', password: null });
        expect(await repos.settings.get('GEMINI_API_KEY')).toBe('gem-key-4c3');
        expect(await repos.settings.get('MINIMAX_API_KEY')).toBe('mm-key-6d5');
        expect(await repos.settings.get('PREFERRED_MODEL')).toBe('gemini-2.5-flash');

        const summaries = await repos.servers.listSummaries();
        expect(summaries.find((s) => s.id === 1)).toMatchObject({ has_password: 1, has_private_key: 1, has_passphrase: 1, os_detail: 'Ubuntu 22.04' });
        const listed = JSON.stringify(summaries);
        for (const secret of PLAINTEXT) expect(listed).not.toContain(secret);
        expect(listed).not.toContain('enc:v1:');
    });

    it('normalizes hosts and the ports v0.3 stored by mistake', async () => {
        const rows = await rawAll<{ name: string; ip: string; port: number | null; ssh_port: number | null }>('SELECT name, ip, port, ssh_port FROM servers ORDER BY id');
        expect(rows).toEqual([
            { name: 'web', ip: '10.0.0.5', port: 22, ssh_port: null },
            { name: 'win', ip: '10.0.0.6', port: 3389, ssh_port: 22 },
            { name: 'ftp', ip: '10.0.0.7', port: null, ssh_port: null },
            { name: 'bucket', ip: 's3', port: null, ssh_port: null },
            { name: 'shell', ip: 'local', port: null, ssh_port: null },
        ]);

        // Normalized like the API does: editing the row (as the UI sends it
        // back) is not mistaken for a new target that needs the secrets again.
        await expect(repos.servers.update(2, {
            name: 'win-renamed', ip: '10.0.0.6', type: 'windows', username: 'Administrator', port: 3389, ssh_port: 22,
        })).resolves.toBe(true);
    });

    it('is idempotent across restarts', async () => {
        const before = await rawAll('SELECT id, password, privateKey, passphrase, s3_secret_key FROM servers ORDER BY id');
        const settingsBefore = await rawAll('SELECT key, value FROM settings ORDER BY key');

        await init.closeDatabase();
        await init.initDatabase(file);

        expect(await rawAll('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
        expect(await rawAll('SELECT id, password, privateKey, passphrase, s3_secret_key FROM servers ORDER BY id')).toEqual(before);
        expect(await rawAll('SELECT key, value FROM settings ORDER BY key')).toEqual(settingsBefore);
        expect(await init.encryptPlaintextSecrets()).toEqual({ encrypted: 0, unreadable: 0, cleared: 0 });
        expect((await repos.servers.getRecord(1))?.password).toBe('pw-linux-7f1');
    });

    it('refuses to start when the key that sealed the credentials is missing', async () => {
        const keyFile = path.join(path.dirname(file), 'shellmind.key');
        await init.closeDatabase();
        fs.renameSync(keyFile, `${keyFile}.bak`);

        // A new key would split the database between two keys.
        await expect(init.initDatabase(file)).rejects.toThrow(/holds 8 encrypted credential\(s\) but its data key is missing.*SHELLMIND_RESET_DATA_KEY/s);
        expect(fs.existsSync(keyFile)).toBe(false);

        fs.renameSync(`${keyFile}.bak`, keyFile);
        await init.initDatabase(file);
        expect((await repos.servers.getRecord(1))?.password).toBe('pw-linux-7f1');
    });

    it('decrypts each secret on its own and warns about the ones sealed with another key', async () => {
        const foreign = repos.encryptWithKey(crypto.randomBytes(32), 'stale-key');
        await rawAll('UPDATE servers SET privateKey = ? WHERE id = 1', [foreign]);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(await init.encryptPlaintextSecrets()).toEqual({ encrypted: 0, unreadable: 1, cleared: 0 });
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/1 stored secret\(s\) cannot be decrypted/));
        // The stale key does not hide the password.
        expect(await repos.servers.getRecord(1)).toMatchObject({
            password: 'pw-linux-7f1', privateKey: null, passphrase: 'pp-3d4', unreadable: ['privateKey'],
        });
        warn.mockRestore();
    });

    it('starts over with a new key only when asked to, clearing what the old key sealed', async () => {
        const keyFile = path.join(path.dirname(file), 'shellmind.key');
        const oldKey = fs.readFileSync(keyFile, 'utf8');
        await init.closeDatabase();
        fs.rmSync(keyFile);
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

        await init.initDatabase(file, { resetDataKey: true });

        expect(fs.readFileSync(keyFile, 'utf8')).not.toBe(oldKey);
        expect(warn).toHaveBeenCalledWith(expect.stringMatching(/Cleared 8 stored secret\(s\)/));
        expect(await rawAll('SELECT password, privateKey, passphrase, s3_secret_key FROM servers ORDER BY id')).toEqual([
            { password: null, privateKey: null, passphrase: null, s3_secret_key: null },
            { password: null, privateKey: null, passphrase: null, s3_secret_key: null },
            { password: null, privateKey: null, passphrase: null, s3_secret_key: null },
            { password: '', privateKey: null, passphrase: null, s3_secret_key: null },
            { password: null, privateKey: null, passphrase: null, s3_secret_key: null },
        ]);
        expect(await repos.settings.get('GEMINI_API_KEY')).toBeNull();
        // Listing never needed the secrets.
        expect(await repos.servers.listSummaries()).toHaveLength(5);

        // Nothing sealed with the old key is left: a normal restart works.
        await init.closeDatabase();
        await init.initDatabase(file);
        expect(await init.encryptPlaintextSecrets()).toEqual({ encrypted: 0, unreadable: 0, cleared: 0 });
        warn.mockRestore();
    });

    it('refuses a database written by a newer version', async () => {
        await init.closeDatabase();
        await withRawDb(file, (db) => run(db, 'PRAGMA user_version = 99'));

        await expect(init.initDatabase(file)).rejects.toThrow(/newer than this version/);

        await withRawDb(file, (db) => run(db, 'PRAGMA user_version = 2'));
        await init.initDatabase(file);
        expect(await rawAll('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
    });
});

describe('upgrading an older (pre-S3) database', () => {
    it('adds every missing v0.3 column', async () => {
        await init.closeDatabase();
        const file = path.join(tmpDir, 'v01', 'shellmind.db');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await withRawDb(file, async (db) => {
            await run(db, 'CREATE TABLE servers (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, ip TEXT NOT NULL, type TEXT NOT NULL, username TEXT, password TEXT, port INTEGER DEFAULT 22)');
            await run(db, "INSERT INTO servers (name, ip, type, password) VALUES ('old', '10.1.1.1', 'linux', 'pw-old')");
        });

        await init.initDatabase(file);

        const columns = (await rawAll<{ name: string }>('PRAGMA table_info(servers)')).map((c) => c.name);
        expect(columns).toEqual(expect.arrayContaining(['os_detail', 'ssh_port', 's3_secret_key', 'privateKey', 'cli_preset', 'jump_server_id', 'updated_at']));
        expect((await repos.servers.getRecord(1))?.password).toBe('pw-old');
    });
});

describe('upgrading a v7 database (a 1.0 pre-release before favourites)', () => {
    it('adds the favourite flag, off for every saved server, and keeps the rows', async () => {
        await init.closeDatabase();
        const file = path.join(tmpDir, 'v7', 'shellmind.db');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // A database as schema v7 left it: the current schema without the
        // column migration 8 adds.
        await init.initDatabase(file);
        const web = await repos.servers.create({ name: 'web', ip: '10.7.0.1', type: 'linux', username: 'ops', password: 'pw-v7', group_name: 'Prod' });
        const bucket = await repos.servers.create({ name: 'bucket', ip: 's3', type: 's3', s3_bucket: 'logs' });
        await init.closeDatabase();
        await withRawDb(file, async (db) => {
            await run(db, 'ALTER TABLE servers DROP COLUMN favorite');
            await run(db, 'PRAGMA user_version = 7');
        });

        await init.initDatabase(file);

        expect(await rawAll('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
        const column = (await rawAll<{ name: string; dflt_value: string; notnull: number }>('PRAGMA table_info(servers)'))
            .find((entry) => entry.name === 'favorite');
        expect(column).toMatchObject({ dflt_value: '0', notnull: 1 });
        const rows = await repos.servers.listSummaries();
        expect(rows.map((row) => [row.name, row.favorite, row.group_name])).toEqual([['web', 0, 'Prod'], ['bucket', 0, null]]);
        expect((await repos.servers.getRecord(web))?.password).toBe('pw-v7');

        expect(await repos.servers.setFavorite(bucket, true)).toBe(true);
        expect((await repos.servers.getSummary(bucket))?.favorite).toBe(1);

        // Restarting on the upgraded file changes nothing.
        await init.closeDatabase();
        await init.initDatabase(file);
        expect((await repos.servers.getSummary(bucket))?.favorite).toBe(1);
        expect((await repos.servers.getSummary(web))?.favorite).toBe(0);
    });
});

describe('upgrading a v8 database (a 1.0 pre-release before migration 10)', () => {
    it('normalizes the saved CLI presets and indexes the audit log written so far', async () => {
        await init.closeDatabase();
        const file = path.join(tmpDir, 'v8', 'shellmind.db');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await init.initDatabase(file);
        await init.closeDatabase();
        // Schema v8: rows saved verbatim (no preset validation) and no search index.
        await withRawDb(file, async (db) => {
            for (const name of ['insert', 'delete', 'update']) await run(db, `DROP TRIGGER audit_log_search_${name}`);
            await run(db, 'DROP TABLE audit_log_search');
            const insert = 'INSERT INTO servers (name, ip, type, cli_preset) VALUES (?, ?, ?, ?)';
            for (const [name, type, preset] of [['cased', 'local', ' Docker'], ['upper', 'local', 'KUBECTL'], ['typo', 'local', 'kubctl'],
                ['blank', 'local', '  '], ['shell', 'local', null], ['ssh', 'linux', 'docker']] as const) {
                await run(db, insert, [name, type === 'local' ? 'local' : '10.8.0.1', type, preset]);
            }
            await run(db, "INSERT INTO audit_log (ts, server_name, source, command) VALUES (1, 'db-01', 'ops', 'systemctl restart postgresql')");
            await run(db, 'PRAGMA user_version = 8');
        });

        await init.initDatabase(file);

        expect(await rawAll('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
        expect(await rawAll('SELECT name, cli_preset FROM servers ORDER BY id')).toEqual([
            { name: 'cased', cli_preset: 'docker' },
            { name: 'upper', cli_preset: 'kubectl' },
            // Unknown: kept, and refused at connect time rather than opened as a shell.
            { name: 'typo', cli_preset: 'kubctl' },
            { name: 'blank', cli_preset: null },
            { name: 'shell', cli_preset: null },
            { name: 'ssh', cli_preset: null },
        ]);

        const { auditRepo, recordAudit } = await import('../../server/db/auditRepo');
        await recordAudit({ source: 'ops', command: 'docker restart web-proxy' });
        expect((await auditRepo.list({ search: 'RESTART POSTGRES' })).map((entry) => entry.command)).toEqual(['systemctl restart postgresql']);
        expect((await auditRepo.list({ search: 'restart' })).map((entry) => entry.command)).toEqual(['docker restart web-proxy', 'systemctl restart postgresql']);
        expect(await rawAll("SELECT rowid FROM audit_log_search WHERE audit_log_search MATCH '\"db-01\"'")).toHaveLength(1);
    });
});

describe('upgrading a v8 database (host keys pinned per host and port)', () => {
    it('moves the pins of hosts reached through jump hosts to their routes, trusting nothing anew (BC-02)', async () => {
        await init.closeDatabase();
        const file = path.join(tmpDir, 'v8-routes', 'shellmind.db');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        await init.initDatabase(file);
        const bastionA = await repos.servers.create({ name: 'bastion-a', ip: '203.0.113.10', type: 'linux', username: 'ops', password: 'pw' });
        const bastionB = await repos.servers.create({ name: 'bastion-b', ip: '203.0.113.20', port: 2222, type: 'linux', username: 'ops', password: 'pw' });
        const inner = await repos.servers.create({ name: 'inner', ip: '10.0.0.9', type: 'linux', username: 'ops', password: 'pw', jump_server_id: bastionA });
        // The same private address behind both bastions, and once directly.
        for (const jump of [bastionA, bastionB, null]) {
            await repos.servers.create({ name: `db-${jump ?? 'direct'}`, ip: '10.0.0.5', type: 'linux', username: 'ops', password: 'pw', jump_server_id: jump });
        }
        // Two hops: behind `inner`, which is behind bastion A.
        await repos.servers.create({ name: 'deep', ip: '10.9.9.9', type: 'windows', ssh_port: 2200, username: 'ops', password: 'pw', jump_server_id: inner });
        await init.closeDatabase();

        // known_hosts as schema v8 had it, one pin per host and port.
        await withRawDb(file, async (db) => {
            await run(db, 'DROP TABLE known_hosts');
            await run(db, `CREATE TABLE known_hosts (id INTEGER PRIMARY KEY AUTOINCREMENT, host TEXT NOT NULL, port INTEGER NOT NULL,
                key_type TEXT NOT NULL, fingerprint TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (host, port))`);
            const pin = 'INSERT INTO known_hosts (host, port, key_type, fingerprint, created_at) VALUES (?, ?, ?, ?, 1)';
            await run(db, pin, ['203.0.113.10', 22, 'ssh-ed25519', 'SHA256:bastion']);
            await run(db, pin, ['10.0.0.9', 22, 'ssh-ed25519', 'SHA256:inner']);
            await run(db, pin, ['10.0.0.5', 22, 'ssh-ed25519', 'SHA256:db']);
            await run(db, pin, ['10.9.9.9', 2200, 'ssh-rsa', 'SHA256:deep']);
            await run(db, pin, ['198.51.100.7', 22, 'ssh-ed25519', 'SHA256:orphan']);
            await run(db, 'PRAGMA user_version = 8');
        });

        await init.initDatabase(file);

        expect(await rawAll('PRAGMA user_version')).toEqual([{ user_version: SCHEMA_VERSION }]);
        const rows = await rawAll<{ host: string; port: number; via: string; fingerprint: string }>(
            'SELECT host, port, via, fingerprint FROM known_hosts ORDER BY host, port, via'
        );
        expect(rows).toEqual([
            { host: '10.0.0.5', port: 22, via: '', fingerprint: 'SHA256:db' },
            { host: '10.0.0.5', port: 22, via: '203.0.113.10:22', fingerprint: 'SHA256:db' },
            { host: '10.0.0.5', port: 22, via: '203.0.113.20:2222', fingerprint: 'SHA256:db' },
            { host: '10.0.0.9', port: 22, via: '203.0.113.10:22', fingerprint: 'SHA256:inner' },
            { host: '10.9.9.9', port: 2200, via: '203.0.113.10:22>10.0.0.9:22', fingerprint: 'SHA256:deep' },
            { host: '198.51.100.7', port: 22, via: '', fingerprint: 'SHA256:orphan' },
            { host: '203.0.113.10', port: 22, via: '', fingerprint: 'SHA256:bastion' },
        ]);
        // One pin per host, port and route from now on.
        await expect(rawAll("INSERT INTO known_hosts (host, port, via, key_type, fingerprint, created_at) VALUES ('10.0.0.5', 22, '', 'x', 'y', 1)"))
            .rejects.toThrow(/UNIQUE/);

        // Restarting on the upgraded file changes nothing.
        await init.closeDatabase();
        await init.initDatabase(file);
        expect(await rawAll('SELECT host, port, via, fingerprint FROM known_hosts ORDER BY host, port, via')).toEqual(rows);
    });
});
