import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openTempDatabase } from '../helpers/tempDatabase';

// The promise helpers share one SQLite connection: other callers must not see
// a transaction's uncommitted rows, and misuse inside a transaction fails
// instead of deadlocking.

type Sqlite = typeof import('../../server/db/sqlite');

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let db: Sqlite;

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = await openTempDatabase();
    db = await import('../../server/db/sqlite');
});

afterAll(async () => {
    await database?.close();
    vi.restoreAllMocks();
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    return { promise, resolve };
}

describe('transaction()', () => {
    it('hides uncommitted rows from other callers and rolls them back on failure', async () => {
        const inserted = deferred();
        const proceed = deferred();
        const failing = db.transaction(async (tx) => {
            await tx.run("INSERT INTO settings (key, value) VALUES ('probe', 'uncommitted')");
            // Reads inside the transaction see its own rows.
            expect(await db.dbGet('SELECT value FROM settings WHERE key = ?', ['probe'])).toEqual({ value: 'uncommitted' });
            inserted.resolve();
            await proceed.promise;
            throw new Error('rolled back');
        });

        await inserted.promise;
        const outside = db.dbGet('SELECT value FROM settings WHERE key = ?', ['probe']);
        const outsideAll = db.dbAll("SELECT key FROM settings WHERE key = 'probe'");
        proceed.resolve();

        await expect(failing).rejects.toThrow('rolled back');
        expect(await outside).toBeUndefined();
        expect(await outsideAll).toEqual([]);
    });

    it('waits for the transaction before reading committed rows', async () => {
        const inserted = deferred();
        const proceed = deferred();
        const committing = db.transaction(async (tx) => {
            await tx.run("INSERT INTO settings (key, value) VALUES ('probe-2', 'committed')");
            inserted.resolve();
            await proceed.promise;
        });

        await inserted.promise;
        const outside = db.dbGet('SELECT value FROM settings WHERE key = ?', ['probe-2']);
        proceed.resolve();
        await committing;
        expect(await outside).toEqual({ value: 'committed' });
    });

    it('rejects writes and nested transactions that bypass its client instead of deadlocking', async () => {
        const result = await db.transaction(async (tx) => {
            await expect(db.dbRun("INSERT INTO settings (key, value) VALUES ('probe-3', 'x')")).rejects.toThrow(/inside transaction\(\)/);
            await expect(db.transaction(async () => undefined)).rejects.toThrow(/cannot be nested/);
            await tx.run("INSERT INTO settings (key, value) VALUES ('probe-3', 'via tx')");
            return 'done';
        });

        expect(result).toBe('done');
        expect(await db.dbGet('SELECT value FROM settings WHERE key = ?', ['probe-3'])).toEqual({ value: 'via tx' });
        // The queue keeps working afterwards.
        await db.dbRun("UPDATE settings SET value = 'after' WHERE key = 'probe-3'");
        expect(await db.dbGet('SELECT value FROM settings WHERE key = ?', ['probe-3'])).toEqual({ value: 'after' });
    });
});
