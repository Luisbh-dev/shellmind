import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { startBackend, type Backend } from '../../electron/backend';
import { BACKEND_KEY_FILE, DATABASE_FILE, DataKeySession, ENCRYPTED_KEY_FILE, type SecretStore } from '../../electron/dataKey';

// The desktop data key against the real backend (server.ts under tsx), forked
// the way electron/main.ts forks the compiled one: a database that holds
// encrypted credentials but lost its data-key.enc must not start on a new key
// (the backend refuses), and starting over clears those credentials and moves
// the backend's new key into the keychain.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN = 'data-key-recovery-token';

// Reversible stand-in for safeStorage.
const store: SecretStore = {
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (plain) => Buffer.from(`sealed:${Buffer.from(plain).toString('hex')}`),
    decryptStringAsync: async (encrypted) => {
        const match = /^sealed:([0-9a-f]+)$/.exec(encrypted.toString());
        if (!match) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.');
        return { result: Buffer.from(match[1]!, 'hex').toString(), shouldReEncrypt: false };
    },
};

let dir: string;
let entry: string;
const running: Backend[] = [];

beforeAll(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-desktop-key-'));
    // server.ts through tsx's require hook, so fork() keeps the IPC channel.
    entry = path.join(dir, 'backend-entry.cjs');
    fs.writeFileSync(entry, [
        `process.env.TSX_TSCONFIG_PATH = ${JSON.stringify(path.join(repoRoot, 'tsconfig.server.json'))};`,
        `require(${JSON.stringify(path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cjs', 'api', 'index.cjs'))}).register();`,
        `require(${JSON.stringify(path.join(repoRoot, 'server.ts'))});`,
    ].join('\n'));
});

afterEach(async () => {
    await Promise.all(running.splice(0).map((backend) => backend.stop(2_000)));
});

afterAll(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

async function launch(dataDir: string, session: DataKeySession): Promise<Backend> {
    const keyEnv = await session.backendEnv();
    const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: '0',
        SHELLMIND_AUTH_TOKEN: TOKEN,
        DB_PATH: path.join(dataDir, DATABASE_FILE),
        DOTENV_CONFIG_PATH: path.join(dataDir, 'missing.env'),
        DOTENV_CONFIG_QUIET: 'true',
    };
    for (const [name, value] of Object.entries(keyEnv)) {
        if (value === undefined) delete env[name];
        else env[name] = value;
    }
    const backend = await startBackend({ entry, env, cwd: repoRoot, readyTimeoutMs: 60_000, onOutput: () => {} });
    running.push(backend);
    await session.started();
    return backend;
}

const api = (backend: Backend, urlPath: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${backend.port}${urlPath}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json', ...init.headers },
});

async function savedServers(backend: Backend) {
    const body = (await (await api(backend, '/api/servers')).json()) as { data: Array<{ id: number; name: string; has_password: number | boolean }> };
    return body.data;
}

describe('desktop data key with the real backend', () => {
    it('refuses a database whose key was lost, and starting over clears its credentials only', async () => {
        const dataDir = fs.mkdtempSync(path.join(dir, 'user-data-'));
        const first = new DataKeySession(dataDir, store, () => {});
        let backend = await launch(dataDir, first);
        expect(fs.readdirSync(dataDir)).toContain(ENCRYPTED_KEY_FILE);
        const created = await api(backend, '/api/servers', {
            method: 'POST',
            body: JSON.stringify({ name: 'web', ip: '10.0.0.5', port: 22, type: 'linux', username: 'root', password: 'pw-1' }),
        });
        expect(created.status).toBeLessThan(300);
        const { id } = ((await created.json()) as { data: { id: number } }).data;
        await backend.stop();
        running.splice(0);

        // data-key.enc is gone (deleted to get past an unreadable one, or not copied).
        fs.rmSync(path.join(dataDir, ENCRYPTED_KEY_FILE));
        const next = new DataKeySession(dataDir, store, () => {});
        const refused = await launch(dataDir, next).catch((error: unknown) => error);
        expect(refused).toBeInstanceOf(Error);
        expect((refused as Error).message).toMatch(/data key is missing/);
        expect(next.isKeyFailure(refused)).toBe(true);
        // Nothing was minted behind the user's back.
        expect(fs.readdirSync(dataDir)).not.toContain(ENCRYPTED_KEY_FILE);

        next.startOver();
        backend = await launch(dataDir, next);
        expect(await savedServers(backend)).toEqual([expect.objectContaining({ name: 'web', has_password: expect.anything() })]);
        expect(Boolean((await savedServers(backend))[0]!.has_password)).toBe(false);
        // The backend's new key now lives in the keychain, and later starts use it.
        expect(fs.readdirSync(dataDir)).toContain(ENCRYPTED_KEY_FILE);
        expect(fs.readdirSync(dataDir)).not.toContain(BACKEND_KEY_FILE);
        expect(await next.backendEnv()).toEqual({ SHELLMIND_DATA_KEY: expect.any(String), SHELLMIND_RESET_DATA_KEY: undefined });
        await backend.stop();
        running.splice(0);

        const later = new DataKeySession(dataDir, store, () => {});
        backend = await launch(dataDir, later);
        const saved = await api(backend, `/api/servers/${id}`, { method: 'PUT', body: JSON.stringify({ name: 'web', ip: '10.0.0.5', port: 22, type: 'linux', username: 'root', password: 'pw-2' }) });
        expect(saved.status).toBeLessThan(300);
        expect(Boolean((await savedServers(backend))[0]!.has_password)).toBe(true);
    }, 120_000);
});
