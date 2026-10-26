import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Opens the backend's database layer (no HTTP server) on a fresh temp
// database. Import server modules only after this resolved, and call it at
// most once per test file (each file has its own module graph).
export async function openTempDatabase(): Promise<{ dir: string; close: () => Promise<void> }> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-db-'));
    process.env.DOTENV_CONFIG_PATH = path.join(dir, 'missing.env');
    process.env.DOTENV_CONFIG_QUIET = 'true';
    delete process.env.SHELLMIND_DATA_KEY;
    delete process.env.SHELLMIND_DEBUG;

    const { initDatabase, closeDatabase } = await import('../../server/db/init');
    await initDatabase(path.join(dir, 'shellmind.db'));

    return {
        dir,
        close: async () => {
            await closeDatabase();
            fs.rmSync(dir, { recursive: true, force: true });
        },
    };
}
