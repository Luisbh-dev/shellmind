import { utils, type ParsedKey } from "ssh2";
import { AppError } from "../errors";
import { sshFingerprint } from "../ssh/hostKeys";

// Key pairs of identities: generating ed25519 keys, and the public key and
// fingerprint of a stored private key (shown in Settings > Keychain and
// written to authorized_keys). Private keys never leave this process.

export type PublicKeyInfo = {
    // One authorized_keys line: "<type> <base64>[ <comment>]".
    publicKey: string;
    type: string;
    fingerprint: string;
    // "<type> <base64>": what identifies the key inside authorized_keys.
    blob: string;
};

export class InvalidKeyError extends AppError {
    constructor(message: string) {
        super("INVALID_PRIVATE_KEY", message, 400, { field: "privateKey" });
        this.name = "InvalidKeyError";
    }
}

const PUBLIC_KEY_LINE = /^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)|sk-ssh-ed25519@openssh\.com|sk-ecdsa-sha2-nistp256@openssh\.com|ssh-dss) ([A-Za-z0-9+/]+={0,3})(?: (.*))?$/;

// A comment that is safe on one authorized_keys line and in a shell or
// PowerShell string: printable ASCII without quotes, at most 128 characters.
export function safeComment(comment: string): string {
    return comment
        .normalize("NFKD")
        .replace(/\s+/g, "-")
        .replace(/[^A-Za-z0-9._@:+=,-]/g, "")
        .slice(0, 128);
}

function single(parsed: ParsedKey | ParsedKey[] | Error): ParsedKey | Error {
    return Array.isArray(parsed) ? parsed[0] ?? new Error("No key found") : parsed;
}

// The public half of a private key (decrypted with `passphrase`). Throws
// InvalidKeyError when it is not a private key it can read.
export function publicKeyOf(privateKey: string, passphrase?: string | null, comment?: string): PublicKeyInfo {
    const parsed = single(utils.parseKey(privateKey, passphrase || undefined));
    if (parsed instanceof Error) {
        const encrypted = /encrypted|passphrase|bad decrypt/i.test(parsed.message);
        throw new InvalidKeyError(encrypted
            ? "The private key is encrypted and the passphrase is missing or wrong."
            : "This is not a private key ShellMind can read (OpenSSH, PEM or PuTTY format).");
    }
    if (!parsed.isPrivateKey()) throw new InvalidKeyError("This is a public key: paste the private key instead.");
    const base64 = parsed.getPublicSSH().toString("base64");
    const label = safeComment(comment ?? parsed.comment ?? "");
    return {
        publicKey: `${parsed.type} ${base64}${label ? ` ${label}` : ""}`,
        type: parsed.type,
        fingerprint: sshFingerprint(parsed.getPublicSSH()),
        blob: `${parsed.type} ${base64}`
    };
}

// The type, fingerprint and blob of an OpenSSH public key line, or null.
export function describePublicKey(line: string | null | undefined): PublicKeyInfo | null {
    const match = PUBLIC_KEY_LINE.exec((line ?? "").trim());
    if (!match) return null;
    const [, type, base64] = match;
    const blob = Buffer.from(base64, "base64");
    if (!blob.length) return null;
    return { publicKey: match[0], type, fingerprint: sshFingerprint(blob), blob: `${type} ${base64}` };
}

export type GeneratedKeyPair = { privateKey: string } & PublicKeyInfo;

// A new ed25519 key pair in OpenSSH format, the private key encrypted
// (aes256-ctr, bcrypt KDF) when a passphrase is given.
export function generateEd25519(comment: string, passphrase?: string): GeneratedKeyPair {
    const label = safeComment(comment);
    // ssh2 drops a leading zero byte of about 1 in 250 ed25519 keys and then
    // cannot read the key it wrote: only a pair that reads back is kept.
    for (let attempt = 0; attempt < 20; attempt += 1) {
        const pair = passphrase
            ? utils.generateKeyPairSync("ed25519", { comment: label, passphrase, cipher: "aes256-ctr" })
            : utils.generateKeyPairSync("ed25519", { comment: label });
        try {
            const info = publicKeyOf(pair.private, passphrase, label);
            const published = describePublicKey(pair.public);
            if (published && published.blob === info.blob) return { privateKey: pair.private, ...info };
        } catch {
            // Try again with another pair.
        }
    }
    throw new AppError("KEY_GENERATION_FAILED", "Could not generate a usable ed25519 key pair.", 500);
}
