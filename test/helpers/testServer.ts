import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Database } from 'sqlite3';
import { clearBackendEnv } from '../setup/backendEnv';

export type TestServer = {
    baseUrl: string;
    port: number;
    db: Database;
    // Directory of the temp database (and its shellmind.key).
    dataDir: string;
    // Session token the backend requires (HTTP bearer / socket auth.token).
    token: string;
    authHeaders: Record<string, string>;
    // fetch() against baseUrl with the session token attached.
    fetch: (path: string, init?: RequestInit) => Promise<Response>;
    close: () => Promise<void>;
};

export type BootOptions = {
    // Extra backend environment, applied after every backend variable is cleared.
    env?: Record<string, string>;
};

// Boots the real backend (HTTP + socket.io) on a random loopback port with a
// fresh SQLite database in a temp directory. Each test file gets its own module
// graph, so call this at most once per file.
export async function bootTestServer(options: BootOptions = {}): Promise<TestServer> {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-test-'));
    clearBackendEnv();
    process.env.DB_PATH = path.join(tmpDir, 'shellmind.db');
    const token = randomBytes(24).toString('base64url');
    process.env.SHELLMIND_AUTH_TOKEN = token;
    Object.assign(process.env, options.env);

    const { initDatabase, closeDatabase } = await import('../../server/db/init');
    const db = await initDatabase();
    const { createShellMindServer } = await import('../../server/main');
    const { sshPool } = await import('../../server/ssh/pool');

    const { httpServer, io } = createShellMindServer();
    await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
    const { port } = httpServer.address() as AddressInfo;

    const close = async () => {
        await new Promise<void>((resolve) => io.close(() => resolve()));
        sshPool.closeAll();
        await closeDatabase();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    };

    const baseUrl = `http://127.0.0.1:${port}`;
    const authHeaders = { authorization: `Bearer ${token}` };
    const authFetch = (urlPath: string, init: RequestInit = {}) => {
        const headers = new Headers(init.headers);
        if (!headers.has('authorization')) headers.set('authorization', authHeaders.authorization);
        return fetch(`${baseUrl}${urlPath}`, { ...init, headers });
    };

    return { baseUrl, port, db, dataDir: tmpDir, token, authHeaders, fetch: authFetch, close };
}
