import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

// The 32-byte key the backend encrypts stored credentials with
// (SHELLMIND_DATA_KEY, base64). It lives in userData encrypted with the OS
// keychain through Electron's safeStorage; without a keychain it falls back to
// a plain file only the user can read.

// The slice of Electron's safeStorage used here.
export interface SecretStore {
    isAsyncEncryptionAvailable(): Promise<boolean>;
    encryptStringAsync(plainText: string): Promise<Buffer>;
    decryptStringAsync(encrypted: Buffer): Promise<{ result: string; shouldReEncrypt: boolean }>;
}

export const ENCRYPTED_KEY_FILE = 'data-key.enc';
export const PLAIN_KEY_FILE = 'data-key';
// The backend's own files in the same folder (DB_PATH, and the key file
// server/security/secrets.ts creates next to the database when it is started
// without SHELLMIND_DATA_KEY).
export const DATABASE_FILE = 'shellmind.db';
export const BACKEND_KEY_FILE = 'shellmind.key';

export type DataKeyProblem = 'keychain-unavailable' | 'unreadable' | 'corrupt';

// The key exists but cannot be used. Retrying only helps once the cause is
// gone (the keychain unlocked, the original file restored).
export class DataKeyError extends Error {
    constructor(readonly problem: DataKeyProblem, message: string, readonly file: string) {
        super(message);
        this.name = 'DataKeyError';
    }
}

function checkedKey(base64: string, file: string): string {
    const key = base64.trim();
    if (Buffer.from(key, 'base64').length !== 32) throw new DataKeyError('corrupt', 'The stored credentials key is corrupt.', file);
    return key;
}

function writePrivate(file: string, data: string | Buffer) {
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
}

// Puts `key` in the keychain, or in the plain file without one.
async function storeKey(dir: string, key: string, store: SecretStore, canEncrypt: boolean, warn: (message: string) => void) {
    if (canEncrypt) {
        writePrivate(path.join(dir, ENCRYPTED_KEY_FILE), await store.encryptStringAsync(key));
        return;
    }
    const plainFile = path.join(dir, PLAIN_KEY_FILE);
    warn(`OS keychain unavailable: storing the credentials key unencrypted in ${plainFile} (readable only by this user).`);
    writePrivate(plainFile, key);
}

// The data key of the folder `dir`, or null when the backend has to decide:
// a database is there but no key of ours (a v0.3 database, whose secrets are
// still in plaintext, or one whose key file was lost). The backend then
// creates its own key file only if the database holds no encrypted
// credentials, and refuses to start otherwise, instead of a new key silently
// leaving them unreadable. The next call moves such a key file into the
// keychain.
export async function loadDataKey(dir: string, store: SecretStore, warn: (message: string) => void): Promise<string | null> {
    const encryptedFile = path.join(dir, ENCRYPTED_KEY_FILE);
    const plainFile = path.join(dir, PLAIN_KEY_FILE);
    const backendFile = path.join(dir, BACKEND_KEY_FILE);
    const canEncrypt = await store.isAsyncEncryptionAvailable();

    if (fs.existsSync(encryptedFile)) {
        if (!canEncrypt) {
            throw new DataKeyError('keychain-unavailable', 'The credentials key is protected by the OS keychain, which is not available right now.', encryptedFile);
        }
        let decrypted: { result: string; shouldReEncrypt: boolean };
        try {
            decrypted = await store.decryptStringAsync(fs.readFileSync(encryptedFile));
        } catch (error) {
            const reason = error instanceof Error ? error.message : String(error);
            throw new DataKeyError('unreadable', `The OS keychain could not decrypt the credentials key: ${reason}`, encryptedFile);
        }
        const key = checkedKey(decrypted.result, encryptedFile);
        // The keychain rotated its own key: store ours under the new one.
        if (decrypted.shouldReEncrypt) writePrivate(encryptedFile, await store.encryptStringAsync(key));
        return key;
    }

    if (fs.existsSync(plainFile)) {
        const key = checkedKey(fs.readFileSync(plainFile, 'utf8'), plainFile);
        if (canEncrypt) {
            // A keychain became available: move the key into it.
            writePrivate(encryptedFile, await store.encryptStringAsync(key));
            fs.rmSync(plainFile, { force: true });
        } else {
            warn(`OS keychain unavailable: the credentials key is stored unencrypted in ${plainFile}.`);
        }
        return key;
    }

    if (fs.existsSync(backendFile)) {
        // Created by a backend started without our key: it becomes ours.
        const key = checkedKey(fs.readFileSync(backendFile, 'utf8'), backendFile);
        await storeKey(dir, key, store, canEncrypt, warn);
        fs.rmSync(backendFile, { force: true });
        return key;
    }

    if (fs.existsSync(path.join(dir, DATABASE_FILE))) return null;

    const key = randomBytes(32).toString('base64');
    await storeKey(dir, key, store, canEncrypt, warn);
    return key;
}

// The backend's fatal message when the database holds encrypted credentials
// but was started without their key (server/db/init.ts).
const MISSING_KEY = /data key is missing/i;

export type DataKeyEnv = {
    SHELLMIND_DATA_KEY: string | undefined;
    SHELLMIND_RESET_DATA_KEY: string | undefined;
};

// The data key across the backend starts of one app session, including the
// way out when it cannot be used: starting over with a new key, which clears
// the credentials saved under the old one (the servers and everything else
// stay).
export class DataKeySession {
    // undefined: not loaded yet; null: the backend uses a key file of its own.
    private key: string | null | undefined;
    private resetPending = false;

    constructor(
        private readonly dir: string,
        private readonly store: SecretStore,
        private readonly warn: (message: string) => void
    ) {}

    // The key variables of the next backend start (undefined: leave unset).
    // Throws a DataKeyError when the key cannot be loaded.
    async backendEnv(): Promise<DataKeyEnv> {
        if (this.key === undefined) this.key = await loadDataKey(this.dir, this.store, this.warn);
        return {
            SHELLMIND_DATA_KEY: this.key ?? undefined,
            SHELLMIND_RESET_DATA_KEY: this.resetPending ? '1' : undefined
        };
    }

    // The backend is up. A key file it created for itself moves into the
    // keychain, and later starts pass that key.
    async started(): Promise<void> {
        this.resetPending = false;
        if (this.key !== null) return;
        try {
            this.key = await loadDataKey(this.dir, this.store, this.warn);
        } catch (error) {
            // The backend keeps using its own key file.
            this.warn(`Could not move the backend's key file into the OS keychain: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    // Whether a failed start is about the data key, so that starting over is
    // a way out.
    isKeyFailure(error: unknown): boolean {
        if (error instanceof DataKeyError) return true;
        return this.key === null && MISSING_KEY.test(error instanceof Error ? error.message : String(error));
    }

    // The file the user would restore to keep the saved credentials.
    get keyFile(): string {
        return path.join(this.dir, ENCRYPTED_KEY_FILE);
    }

    // Keeps the unusable key files as backups (<name>.bak-<time>) and has the
    // next start create a new key and clear the credentials it cannot read.
    // Returns the backups.
    startOver(now: Date = new Date()): string[] {
        const stamp = now.toISOString().replace(/[:.]/g, '-');
        const backups: string[] = [];
        for (const name of [ENCRYPTED_KEY_FILE, PLAIN_KEY_FILE, BACKEND_KEY_FILE]) {
            const file = path.join(this.dir, name);
            if (!fs.existsSync(file)) continue;
            const backup = `${file}.bak-${stamp}`;
            fs.renameSync(file, backup);
            backups.push(backup);
        }
        this.key = null;
        this.resetPending = true;
        return backups;
    }

    // Loads the key again on the next start: the user may have restored the
    // file or unlocked the keychain meanwhile.
    retry(): void {
        if (!this.resetPending) this.key = undefined;
    }
}
