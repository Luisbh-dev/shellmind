import { createCipheriv, createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import { createRequire } from 'node:module';

// ed25519 keys for tests that paste a private key: the same key in every run,
// written as ssh-keygen writes it (OpenSSH's PROTOCOL.key), plain or with a
// passphrase. ssh2's generator cannot stand in for it: when the public key
// starts with a zero byte (about 1 key in 256) it drops that byte and then
// cannot read the key it wrote, which failed such tests at random.

// The KDF of encrypted OpenSSH keys, from ssh2's own dependency.
type Pbkdf = (pass: Buffer, passLength: number, salt: Buffer, saltLength: number, key: Buffer, keyLength: number, rounds: number) => number;
const { pbkdf } = createRequire(createRequire(import.meta.url).resolve('ssh2'))('bcrypt-pbkdf') as { pbkdf: Pbkdf };

// ssh-keygen's defaults for a key with a passphrase.
const CIPHER = 'aes256-ctr';
const KDF_ROUNDS = 16;

export type Ed25519TestKey = {
    // OpenSSH private key file ("-----BEGIN OPENSSH PRIVATE KEY-----").
    privateKey: string;
    // Its authorized_keys line: "ssh-ed25519 <base64>[ <comment>]".
    publicKey: string;
};

// The 32-byte public key of an ed25519 seed, from node:crypto.
function ed25519PublicKey(seed: Buffer): Buffer {
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const spki = createPublicKey(createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' })).export({ format: 'der', type: 'spki' });
    return spki.subarray(spki.length - 32);
}

// The first seed derived from `label` (SHA-256 of "<label>:<n>") that
// `accept` takes, e.g. one whose public key starts with a zero byte.
export function ed25519Seed(label: string, accept: (seed: Buffer, publicKey: Buffer) => boolean = () => true): Buffer {
    for (let n = 0; ; n += 1) {
        const seed = createHash('sha256').update(`${label}:${n}`).digest();
        if (accept(seed, ed25519PublicKey(seed))) return seed;
    }
}

function uint32(value: number): Buffer {
    const bytes = Buffer.alloc(4);
    bytes.writeUInt32BE(value);
    return bytes;
}

function sshString(value: Buffer | string): Buffer {
    const bytes = Buffer.from(value);
    return Buffer.concat([uint32(bytes.length), bytes]);
}

// The OpenSSH private key of `seed`, encrypted when a passphrase is given.
export function ed25519Key(seed: Buffer, options: { comment?: string; passphrase?: string } = {}): Ed25519TestKey {
    const { comment = '', passphrase } = options;
    const publicKey = ed25519PublicKey(seed);
    const publicBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(publicKey)]);
    // Random in ssh-keygen; derived from the seed here so that the file is fixed too.
    const nonce = createHash('sha256').update('openssh-key-v1').update(seed).digest();
    const checkInt = nonce.subarray(0, 4);
    const salt = nonce.subarray(4, 20);

    const keys = Buffer.concat([checkInt, checkInt, publicBlob, sshString(Buffer.concat([seed, publicKey])), sshString(comment)]);
    const blockSize = passphrase ? 16 : 8;
    const padding = Array.from({ length: (blockSize - (keys.length % blockSize)) % blockSize }, (_, i) => i + 1);
    let section = Buffer.concat([keys, Buffer.from(padding)]);
    let header = Buffer.concat([sshString('none'), sshString('none'), sshString('')]);
    if (passphrase) {
        const pass = Buffer.from(passphrase);
        const keyAndIv = Buffer.alloc(32 + 16);
        if (pbkdf(pass, pass.length, salt, salt.length, keyAndIv, keyAndIv.length, KDF_ROUNDS) !== 0) throw new Error('bcrypt_pbkdf failed');
        const cipher = createCipheriv('aes-256-ctr', keyAndIv.subarray(0, 32), keyAndIv.subarray(32));
        section = Buffer.concat([cipher.update(section), cipher.final()]);
        header = Buffer.concat([sshString(CIPHER), sshString('bcrypt'), sshString(Buffer.concat([sshString(salt), uint32(KDF_ROUNDS)]))]);
    }

    const file = Buffer.concat([Buffer.from('openssh-key-v1\0'), header, uint32(1), sshString(publicBlob), sshString(section)]);
    const base64 = file.toString('base64').replace(/.{70}/g, '$&\n').trimEnd();
    return {
        privateKey: `-----BEGIN OPENSSH PRIVATE KEY-----\n${base64}\n-----END OPENSSH PRIVATE KEY-----\n`,
        publicKey: `ssh-ed25519 ${publicBlob.toString('base64')}${comment ? ` ${comment}` : ''}`,
    };
}
