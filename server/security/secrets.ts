import crypto from "crypto";
import fs from "fs";
import path from "path";
import { DATA_KEY } from "../config";

// Credentials at rest: AES-256-GCM, stored as
//   enc:v1:<iv>:<auth tag>:<ciphertext>   (each part base64)
// The 32-byte data key comes from SHELLMIND_DATA_KEY (base64) or from the key
// file next to the database, created on first start with mode 0600 (on
// Windows it inherits the folder's permissions: the user profile or app data).
// The key file must be backed up together with the database.

const PREFIX = "enc:v1:";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
export const KEY_FILE_NAME = "shellmind.key";

export class SecretDecryptionError extends Error {
    constructor(message = "A stored secret could not be decrypted (wrong data key or corrupted value). Re-enter it.") {
        super(message);
        this.name = "SecretDecryptionError";
    }
}

let activeKey: Buffer | null = null;

export function parseDataKey(encoded: string, source: string): Buffer {
    const key = Buffer.from(encoded.trim(), "base64");
    if (key.length !== KEY_BYTES) {
        throw new Error(`${source} must hold a base64-encoded ${KEY_BYTES}-byte key`);
    }
    return key;
}

function readKeyFile(file: string): Buffer | null {
    try {
        return parseDataKey(fs.readFileSync(file, "utf8"), file);
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
    }
}

export type DataKey = { key: Buffer; source: string };

// SHELLMIND_DATA_KEY when set, else <dir>/shellmind.key; null when neither
// exists yet.
export function findDataKey(dir: string, envKey: string = DATA_KEY): DataKey | null {
    if (envKey) return { key: parseDataKey(envKey, "SHELLMIND_DATA_KEY"), source: "SHELLMIND_DATA_KEY" };
    const file = path.join(dir, KEY_FILE_NAME);
    const existing = readKeyFile(file);
    return existing ? { key: existing, source: file } : null;
}

// Generates <dir>/shellmind.key. If another process created it first, that
// key is returned instead (`created` is false then).
export function createDataKeyFile(dir: string): DataKey & { created: boolean } {
    const file = path.join(dir, KEY_FILE_NAME);
    const key = crypto.randomBytes(KEY_BYTES);
    try {
        fs.writeFileSync(file, key.toString("base64") + "\n", { mode: 0o600, flag: "wx" });
    } catch (err) {
        // Another process created it first: use that one.
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
            const raced = readKeyFile(file);
            if (raced) return { key: raced, source: file, created: false };
        }
        throw err;
    }
    return { key, source: file, created: true };
}

export function setDataKey(key: Buffer): void {
    if (key.length !== KEY_BYTES) throw new Error(`The data key must be ${KEY_BYTES} bytes`);
    activeKey = key;
}

function requireKey(): Buffer {
    if (!activeKey) throw new Error("The data key is not loaded (initDatabase() has not run)");
    return activeKey;
}

export function isEncrypted(value: unknown): value is string {
    return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptWithKey(key: Buffer, plaintext: string): string {
    const iv = crypto.randomBytes(IV_BYTES);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${PREFIX}${iv.toString("base64")}:${tag.toString("base64")}:${ciphertext.toString("base64")}`;
}

export function decryptWithKey(key: Buffer, value: string): string {
    if (!isEncrypted(value)) throw new SecretDecryptionError("A stored secret is not in the encrypted format");

    const [ivPart, tagPart, dataPart, ...rest] = value.slice(PREFIX.length).split(":");
    const iv = Buffer.from(ivPart ?? "", "base64");
    const tag = Buffer.from(tagPart ?? "", "base64");
    if (rest.length > 0 || dataPart === undefined || iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
        throw new SecretDecryptionError("A stored secret is malformed");
    }

    try {
        const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(Buffer.from(dataPart, "base64")), decipher.final()]).toString("utf8");
    } catch {
        throw new SecretDecryptionError();
    }
}

export function encryptSecret(plaintext: string): string {
    return encryptWithKey(requireKey(), plaintext);
}

export function decryptSecret(value: string): string {
    return decryptWithKey(requireKey(), value);
}

// Column helpers: blank secrets are stored as NULL.
export function sealSecret(plaintext: string | null | undefined): string | null {
    return plaintext ? encryptSecret(plaintext) : null;
}

export function openSecret(stored: string | null | undefined): string | null {
    return stored ? decryptSecret(stored) : null;
}
