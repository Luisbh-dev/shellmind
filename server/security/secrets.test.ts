import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    KEY_FILE_NAME,
    SecretDecryptionError,
    createDataKeyFile,
    decryptWithKey,
    encryptWithKey,
    findDataKey,
    isEncrypted,
    parseDataKey,
} from './secrets';

const key = crypto.randomBytes(32);
const tmpDirs: string[] = [];

function tmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-secrets-'));
    tmpDirs.push(dir);
    return dir;
}

afterEach(() => {
    while (tmpDirs.length) fs.rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

describe('secret encryption', () => {
    it('round-trips text in the enc:v1 format with a fresh IV each time', () => {
        const plaintext = 'p@ss wörd 🔐\n-----BEGIN OPENSSH PRIVATE KEY-----';
        const first = encryptWithKey(key, plaintext);
        const second = encryptWithKey(key, plaintext);

        expect(first).toMatch(/^enc:v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/);
        expect(first).not.toContain('p@ss');
        expect(first).not.toBe(second);
        expect(isEncrypted(first)).toBe(true);
        expect(isEncrypted(plaintext)).toBe(false);
        expect(decryptWithKey(key, first)).toBe(plaintext);
        expect(decryptWithKey(key, second)).toBe(plaintext);
        expect(decryptWithKey(key, encryptWithKey(key, ''))).toBe('');
    });

    it('rejects a tampered ciphertext, tag or IV', () => {
        const sealed = encryptWithKey(key, 'top secret');
        const [, , iv, tag, data] = sealed.split(':');
        const flip = (part: string) => {
            const bytes = Buffer.from(part, 'base64');
            bytes[0] ^= 0x01;
            return bytes.toString('base64');
        };

        for (const tampered of [
            `enc:v1:${iv}:${tag}:${flip(data)}`,
            `enc:v1:${iv}:${flip(tag)}:${data}`,
            `enc:v1:${flip(iv)}:${tag}:${data}`,
        ]) {
            expect(() => decryptWithKey(key, tampered)).toThrow(SecretDecryptionError);
        }
    });

    it('rejects the wrong key, plaintext and malformed values', () => {
        const sealed = encryptWithKey(key, 'top secret');
        expect(() => decryptWithKey(crypto.randomBytes(32), sealed)).toThrow(SecretDecryptionError);
        expect(() => decryptWithKey(key, 'plain-password')).toThrow(SecretDecryptionError);
        expect(() => decryptWithKey(key, 'enc:v1:abc')).toThrow(SecretDecryptionError);
        expect(() => decryptWithKey(key, `${sealed}:extra`)).toThrow(SecretDecryptionError);
    });
});

describe('data key', () => {
    it('validates base64 32-byte keys', () => {
        expect(parseDataKey(key.toString('base64'), 'test')).toEqual(key);
        expect(() => parseDataKey(crypto.randomBytes(16).toString('base64'), 'SHELLMIND_DATA_KEY')).toThrow(/32-byte/);
        expect(() => parseDataKey('', 'SHELLMIND_DATA_KEY')).toThrow(/32-byte/);
    });

    it('prefers SHELLMIND_DATA_KEY over a key file', () => {
        const dir = tmpDir();
        createDataKeyFile(dir);
        expect(findDataKey(dir, key.toString('base64'))).toEqual({ key, source: 'SHELLMIND_DATA_KEY' });
    });

    it('finds no key until the key file is created (owner-only), then reuses it', () => {
        const dir = tmpDir();
        expect(findDataKey(dir, '')).toBeNull();

        const created = createDataKeyFile(dir);
        const file = path.join(dir, KEY_FILE_NAME);
        expect(created).toEqual({ key: expect.any(Buffer), source: file, created: true });
        expect(created.key).toHaveLength(32);
        if (process.platform !== 'win32') {
            expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        }

        expect(findDataKey(dir, '')).toEqual({ key: created.key, source: file });
        // A second creation (another process won the race) keeps the first key.
        expect(createDataKeyFile(dir)).toEqual({ key: created.key, source: file, created: false });
    });

    it('refuses a corrupted key file instead of replacing it', () => {
        const dir = tmpDir();
        fs.writeFileSync(path.join(dir, KEY_FILE_NAME), 'not-a-key');
        expect(() => findDataKey(dir, '')).toThrow(/32-byte/);
        expect(() => createDataKeyFile(dir)).toThrow(/32-byte/);
    });
});
