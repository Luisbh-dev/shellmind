import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    BACKEND_KEY_FILE,
    DATABASE_FILE,
    DataKeyError,
    DataKeySession,
    ENCRYPTED_KEY_FILE,
    loadDataKey,
    PLAIN_KEY_FILE,
    type SecretStore,
} from '../../electron/dataKey';

// A reversible stand-in for Electron's safeStorage. `version` mimics the OS
// keychain rotating its own key (decrypting old data asks for re-encryption).
function fakeStore(available: boolean, version = 1): SecretStore {
    return {
        isAsyncEncryptionAvailable: async () => available,
        encryptStringAsync: async (plain) => Buffer.from(`v${version}:${Buffer.from(plain).toString('hex')}`),
        decryptStringAsync: async (encrypted) => {
            const match = /^v(\d+):([0-9a-f]+)$/.exec(encrypted.toString());
            if (!match) throw new Error('Error while decrypting the ciphertext provided');
            return { result: Buffer.from(match[2], 'hex').toString(), shouldReEncrypt: Number(match[1]) !== version };
        },
    };
}

let dir: string;

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-key-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

const isKey = (key: string | null) => key !== null && Buffer.from(key, 'base64').length === 32;
const stored = (file: string) => fs.readFileSync(path.join(dir, file), 'utf8');

describe('loadDataKey', () => {
    it('creates a key protected by the keychain and returns the same one later', async () => {
        const warn = vi.fn();
        const key = await loadDataKey(dir, fakeStore(true), warn);
        expect(isKey(key)).toBe(true);
        expect(fs.readdirSync(dir)).toEqual([ENCRYPTED_KEY_FILE]);
        expect(stored(ENCRYPTED_KEY_FILE)).not.toContain(key);
        expect(await loadDataKey(dir, fakeStore(true), warn)).toBe(key);
        expect(warn).not.toHaveBeenCalled();
    });

    it('re-encrypts the key when the keychain asks for it', async () => {
        const key = await loadDataKey(dir, fakeStore(true, 1), () => {});
        expect(await loadDataKey(dir, fakeStore(true, 2), () => {})).toBe(key);
        expect(stored(ENCRYPTED_KEY_FILE)).toMatch(/^v2:/);
    });

    it('falls back to a private plain file with a warning when there is no keychain', async () => {
        const warn = vi.fn();
        const key = await loadDataKey(dir, fakeStore(false), warn);
        expect(stored(PLAIN_KEY_FILE)).toBe(key);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
        if (process.platform !== 'win32') {
            expect(fs.statSync(path.join(dir, PLAIN_KEY_FILE)).mode & 0o777).toBe(0o600);
        }
        expect(await loadDataKey(dir, fakeStore(false), warn)).toBe(key);
    });

    it('moves a plain key into the keychain once one is available', async () => {
        const key = await loadDataKey(dir, fakeStore(false), () => {});
        expect(await loadDataKey(dir, fakeStore(true), () => {})).toBe(key);
        expect(fs.readdirSync(dir)).toEqual([ENCRYPTED_KEY_FILE]);
    });

    it('refuses to replace a keychain-protected key it cannot read', async () => {
        await loadDataKey(dir, fakeStore(true), () => {});
        await expect(loadDataKey(dir, fakeStore(false), () => {})).rejects.toThrow(/keychain/);
        fs.writeFileSync(path.join(dir, ENCRYPTED_KEY_FILE), 'garbage');
        await expect(loadDataKey(dir, fakeStore(true), () => {})).rejects.toThrow(/decrypting/);
        expect(fs.readdirSync(dir)).toEqual([ENCRYPTED_KEY_FILE]);
    });

    it('rejects a corrupt key instead of using it', async () => {
        fs.writeFileSync(path.join(dir, PLAIN_KEY_FILE), 'c2hvcnQ=');
        await expect(loadDataKey(dir, fakeStore(false), () => {})).rejects.toThrow(/corrupt/);
    });

    it('tells why a key cannot be used', async () => {
        await loadDataKey(dir, fakeStore(true), () => {});
        const file = path.join(dir, ENCRYPTED_KEY_FILE);
        await expect(loadDataKey(dir, fakeStore(false), () => {})).rejects.toMatchObject({ problem: 'keychain-unavailable', file });
        fs.writeFileSync(file, 'garbage');
        await expect(loadDataKey(dir, fakeStore(true), () => {})).rejects.toMatchObject({ problem: 'unreadable', file });
        await expect(loadDataKey(dir, fakeStore(true), () => {})).rejects.toBeInstanceOf(DataKeyError);
    });

    it('leaves a database without a key of ours to the backend instead of minting a key for it', async () => {
        // v0.3 left its database here; or data-key.enc of a database with
        // encrypted credentials was lost. A new key would bypass the backend's
        // refusal to start without the key those credentials were sealed with.
        fs.writeFileSync(path.join(dir, DATABASE_FILE), '');
        expect(await loadDataKey(dir, fakeStore(true), () => {})).toBeNull();
        expect(fs.readdirSync(dir)).toEqual([DATABASE_FILE]);
    });

    it('moves the key file a backend created for itself into the keychain', async () => {
        fs.writeFileSync(path.join(dir, DATABASE_FILE), '');
        const key = randomKey();
        fs.writeFileSync(path.join(dir, BACKEND_KEY_FILE), `${key}\n`);
        expect(await loadDataKey(dir, fakeStore(true), () => {})).toBe(key);
        expect(fs.readdirSync(dir).sort()).toEqual([ENCRYPTED_KEY_FILE, DATABASE_FILE].sort());
        expect(await loadDataKey(dir, fakeStore(true), () => {})).toBe(key);
    });

    it('keeps such a key in the private plain file when there is no keychain', async () => {
        const key = randomKey();
        fs.writeFileSync(path.join(dir, BACKEND_KEY_FILE), key);
        const warn = vi.fn();
        expect(await loadDataKey(dir, fakeStore(false), warn)).toBe(key);
        expect(stored(PLAIN_KEY_FILE)).toBe(key);
        expect(fs.existsSync(path.join(dir, BACKEND_KEY_FILE))).toBe(false);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('unencrypted'));
    });
});

const randomKey = () => Buffer.alloc(32, 7).toString('base64');
const MISSING_KEY_FATAL = 'Could not open the database: The database holds 2 encrypted credential(s) but its data key is missing. Restore ...';

describe('DataKeySession', () => {
    it('passes the stored key and nothing else on every start', async () => {
        const session = new DataKeySession(dir, fakeStore(true), () => {});
        const first = await session.backendEnv();
        expect(isKey(first.SHELLMIND_DATA_KEY ?? '')).toBe(true);
        expect(first.SHELLMIND_RESET_DATA_KEY).toBeUndefined();
        await session.started();
        expect(await session.backendEnv()).toEqual(first);
        // A start that failed for another reason offers no way to start over.
        expect(session.isKeyFailure(new Error(MISSING_KEY_FATAL))).toBe(false);
        expect(session.isKeyFailure(new Error('Port 127.0.0.1:3001 is already in use.'))).toBe(false);
    });

    it('starts over from an unreadable key: backs it up, resets once, then keeps the new key', async () => {
        await loadDataKey(dir, fakeStore(true), () => {});
        fs.writeFileSync(path.join(dir, ENCRYPTED_KEY_FILE), 'copied from another computer');
        fs.writeFileSync(path.join(dir, DATABASE_FILE), '');
        const session = new DataKeySession(dir, fakeStore(true), () => {});

        const failure = await session.backendEnv().catch((error: unknown) => error);
        expect(session.isKeyFailure(failure)).toBe(true);
        // Retrying reads the file again (it may have been restored meanwhile).
        session.retry();
        await expect(session.backendEnv()).rejects.toBeInstanceOf(DataKeyError);

        const backups = session.startOver(new Date('2026-10-24T08:00:00Z'));
        expect(backups).toEqual([path.join(dir, `${ENCRYPTED_KEY_FILE}.bak-2026-10-24T08-00-00-000Z`)]);
        expect(fs.readFileSync(backups[0]!, 'utf8')).toBe('copied from another computer');
        // The backend creates its own key and clears what it cannot read.
        expect(await session.backendEnv()).toEqual({ SHELLMIND_DATA_KEY: undefined, SHELLMIND_RESET_DATA_KEY: '1' });
        // A failed start for another reason keeps the reset for the next try.
        session.retry();
        expect(await session.backendEnv()).toEqual({ SHELLMIND_DATA_KEY: undefined, SHELLMIND_RESET_DATA_KEY: '1' });

        const created = randomKey();
        fs.writeFileSync(path.join(dir, BACKEND_KEY_FILE), created);
        await session.started();
        expect(await session.backendEnv()).toEqual({ SHELLMIND_DATA_KEY: created, SHELLMIND_RESET_DATA_KEY: undefined });
        expect(fs.existsSync(path.join(dir, BACKEND_KEY_FILE))).toBe(false);
        expect(fs.existsSync(path.join(dir, ENCRYPTED_KEY_FILE))).toBe(true);
    });

    it('recognizes the backend refusing a database whose key is missing, and only then', async () => {
        fs.writeFileSync(path.join(dir, DATABASE_FILE), '');
        const session = new DataKeySession(dir, fakeStore(true), () => {});
        expect(await session.backendEnv()).toEqual({ SHELLMIND_DATA_KEY: undefined, SHELLMIND_RESET_DATA_KEY: undefined });
        expect(session.isKeyFailure(new Error(MISSING_KEY_FATAL))).toBe(true);
        expect(session.isKeyFailure(new Error('The backend did not report ready within 30 s.'))).toBe(false);
        expect(session.keyFile).toBe(path.join(dir, ENCRYPTED_KEY_FILE));
        expect(session.startOver()).toEqual([]);
    });

    it('keeps the backend on its own key file when the keychain refuses to take it', async () => {
        fs.writeFileSync(path.join(dir, DATABASE_FILE), '');
        const store = fakeStore(true);
        const warn = vi.fn();
        const session = new DataKeySession(dir, { ...store, encryptStringAsync: async () => { throw new Error('keychain locked'); } }, warn);
        await session.backendEnv();
        fs.writeFileSync(path.join(dir, BACKEND_KEY_FILE), randomKey());
        await session.started();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('keychain locked'));
        expect(await session.backendEnv()).toEqual({ SHELLMIND_DATA_KEY: undefined, SHELLMIND_RESET_DATA_KEY: undefined });
        expect(fs.existsSync(path.join(dir, BACKEND_KEY_FILE))).toBe(true);
    });
});
