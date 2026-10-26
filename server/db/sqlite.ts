import { AsyncLocalStorage } from "async_hooks";
import { createRequire } from "module";
import path from "path";
import type { Database } from "sqlite3";
import { DB_PATH } from "../config";
import { errorMessage } from "../errors";
import { findProjectRoot } from "../projectRoot";

// The one SQLite connection of the backend and its promise helpers. Opened by
// initDatabase() (server/db/init.ts) before the server listens.

export type RunResult = { lastID: number; changes: number };
export type SqlParams = unknown[];

// Query interface shared by the connection and an open transaction.
export interface DbClient {
    get<T>(sql: string, params?: SqlParams): Promise<T | undefined>;
    all<T>(sql: string, params?: SqlParams): Promise<T[]>;
    run(sql: string, params?: SqlParams): Promise<RunResult>;
}

// sqlite3 is a native module, built for one C library and Node ABI. A binary
// that cannot load here (built against a newer glibc, or for another Node)
// stops the backend with what to do about it, not a bare dlopen failure.
export function nativeLoadError(err: unknown, electron = Boolean(process.versions.electron)): Error | null {
    const message = errorMessage(err);
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code !== "ERR_DLOPEN_FAILED" && !/GLIBC|NODE_MODULE_VERSION/.test(message)) return null;
    const remedy = electron
        ? "This build of ShellMind cannot run on this system; use the package made for it."
        : "Run `npm run postinstall` to rebuild it for this system (that needs python3, make and a C++ compiler).";
    return new Error(`The SQLite native module could not be loaded: ${message}. ${remedy}`, { cause: err });
}

function loadSqlite(): typeof import("sqlite3") {
    try {
        return createRequire(__filename)("sqlite3") as typeof import("sqlite3");
    } catch (err) {
        throw nativeLoadError(err) ?? err;
    }
}

const sqlite3 = loadSqlite();

let db: Database | null = null;

// Default location: the repository root (where package.json is), whether
// run under tsx or compiled; never dist-server/, which every build wipes.
export function defaultDbPath(): string {
    return DB_PATH || path.join(findProjectRoot() ?? path.resolve(__dirname, "..", ".."), "shellmind.db");
}

export function getDb(): Database {
    if (!db) throw new Error("The database is not open (initDatabase() has not run)");
    return db;
}

export function setDb(handle: Database | null): void {
    db = handle;
}

export function openDatabase(file: string): Promise<Database> {
    return new Promise((resolve, reject) => {
        const handle = new sqlite3.Database(file, (err) => (err ? reject(err) : resolve(handle)));
    });
}

export function closeHandle(handle: Database): Promise<void> {
    return new Promise((resolve, reject) => handle.close((err) => (err ? reject(err) : resolve())));
}

export function execSql(handle: Database, sql: string): Promise<void> {
    return new Promise((resolve, reject) => handle.exec(sql, (err) => (err ? reject(err) : resolve())));
}

function clientFor(handle: () => Database): DbClient {
    return {
        get: <T>(sql: string, params: SqlParams = []) => new Promise<T | undefined>((resolve, reject) => {
            handle().get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T | undefined)));
        }),
        all: <T>(sql: string, params: SqlParams = []) => new Promise<T[]>((resolve, reject) => {
            handle().all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows as T[])));
        }),
        run: (sql: string, params: SqlParams = []) => new Promise<RunResult>((resolve, reject) => {
            handle().run(sql, params, function (err) {
                if (err) reject(err);
                else resolve({ lastID: this.lastID, changes: this.changes });
            });
        })
    };
}

const direct = clientFor(getDb);

// Statements and transactions take turns on the shared connection: a read
// issued while another caller's transaction is open would otherwise see its
// uncommitted rows, and a write would become part of it (and be rolled back
// with it).
let queue: Promise<unknown> = Promise.resolve();

function exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = queue.then(task, task);
    queue = result.catch(() => undefined);
    return result;
}

// Set for the code a transaction() callback runs, including what it awaits.
const transactionScope = new AsyncLocalStorage<{ open: boolean }>();

function insideTransaction(): boolean {
    return transactionScope.getStore()?.open === true;
}

// Inside a transaction callback reads see its own writes; waiting for the
// queue there would wait for the transaction itself.
export function dbGet<T>(sql: string, params?: SqlParams): Promise<T | undefined> {
    return insideTransaction() ? direct.get<T>(sql, params) : exclusive(() => direct.get<T>(sql, params));
}

export function dbAll<T>(sql: string, params?: SqlParams): Promise<T[]> {
    return insideTransaction() ? direct.all<T>(sql, params) : exclusive(() => direct.all<T>(sql, params));
}

// Writes inside a transaction callback go through its client (or a repo's
// *In(tx) variant), so it is explicit that they commit or roll back with it.
export function dbRun(sql: string, params?: SqlParams): Promise<RunResult> {
    if (insideTransaction()) {
        return Promise.reject(new Error("dbRun() was called inside transaction(): use the client the transaction passes"));
    }
    return exclusive(() => direct.run(sql, params));
}

// Runs `work` inside BEGIN IMMEDIATE ... COMMIT (ROLLBACK when it throws).
// Use the given client for every write of the transaction.
export function transaction<T>(work: (tx: DbClient) => Promise<T>): Promise<T> {
    if (insideTransaction()) {
        return Promise.reject(new Error("transaction() cannot be nested: use the client the outer transaction passes"));
    }
    return exclusive(() => {
        const scope = { open: true };
        return transactionScope.run(scope, async () => {
            await direct.run("BEGIN IMMEDIATE");
            try {
                const result = await work(direct);
                await direct.run("COMMIT");
                return result;
            } catch (err) {
                await direct.run("ROLLBACK").catch(() => undefined);
                throw err;
            } finally {
                // Callbacks it left behind (timers, unawaited promises) queue normally.
                scope.open = false;
            }
        });
    });
}
