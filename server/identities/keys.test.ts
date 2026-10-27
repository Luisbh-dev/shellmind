import { describe, expect, it } from 'vitest';
import { utils } from 'ssh2';
import { ed25519Key, ed25519Seed } from '../../test/helpers/sshKeys';
import { describePublicKey, generateEd25519, InvalidKeyError, publicKeyOf, safeComment } from './keys';

describe('identity keys', () => {
    it('generates ed25519 pairs that read back, with and without a passphrase', () => {
        const plain = generateEd25519('shellmind:deploy');
        expect(plain.type).toBe('ssh-ed25519');
        expect(plain.publicKey).toMatch(/^ssh-ed25519 [A-Za-z0-9+/]+=* shellmind:deploy$/);
        expect(plain.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
        expect(plain.privateKey).toContain('BEGIN OPENSSH PRIVATE KEY');
        expect(publicKeyOf(plain.privateKey).blob).toBe(plain.blob);

        const sealed = generateEd25519('ops key', 'correct horse');
        expect(sealed.publicKey.endsWith(' ops-key')).toBe(true);
        expect(utils.parseKey(sealed.privateKey)).toBeInstanceOf(Error);
        expect(publicKeyOf(sealed.privateKey, 'correct horse').fingerprint).toBe(sealed.fingerprint);
    });

    it('derives the public key of a pasted private key and explains what it cannot read', () => {
        const pair = ed25519Key(ed25519Seed('pasted'), { comment: 'me@laptop', passphrase: 'pp' });
        expect(publicKeyOf(pair.privateKey, 'pp')).toMatchObject({ type: 'ssh-ed25519', publicKey: expect.stringMatching(/ me@laptop$/) });
        // The comment of the file is kept unless another one is given.
        expect(publicKeyOf(pair.privateKey, 'pp', 'shellmind:x').publicKey).toMatch(/ shellmind:x$/);

        expect(() => publicKeyOf(pair.privateKey)).toThrow(/passphrase is missing or wrong/);
        expect(() => publicKeyOf(pair.privateKey, 'nope')).toThrow(InvalidKeyError);
        expect(() => publicKeyOf(pair.publicKey)).toThrow(/public key/);
        expect(() => publicKeyOf('not a key')).toThrow(/not a private key/);
    });

    it('reads pasted ed25519 keys whose public key or seed starts with a zero byte, with and without a passphrase', () => {
        // ssh-keygen writes each of these about once in 256 keys. ssh2's
        // generator cannot write one whose public key starts with a zero
        // byte (see generateEd25519).
        const seeds = [
            ed25519Seed('zero public key', (seed, publicKey) => publicKey[0] === 0),
            ed25519Seed('zero seed', (seed) => seed[0] === 0),
        ];
        for (const seed of seeds) {
            for (const passphrase of [undefined, 'pp']) {
                const pasted = ed25519Key(seed, { comment: 'me@laptop', passphrase });
                expect(publicKeyOf(pasted.privateKey, passphrase)).toEqual(describePublicKey(pasted.publicKey));
            }
        }
    });

    it('describes OpenSSH public key lines and rejects anything else', () => {
        const pair = generateEd25519('a');
        expect(describePublicKey(pair.publicKey)).toEqual({ publicKey: pair.publicKey, type: 'ssh-ed25519', fingerprint: pair.fingerprint, blob: pair.blob });
        expect(describePublicKey(`  ${pair.blob}  `)?.fingerprint).toBe(pair.fingerprint);
        expect(describePublicKey(null)).toBeNull();
        expect(describePublicKey('ssh-ed25519')).toBeNull();
        expect(describePublicKey('rm -rf / AAAA')).toBeNull();
        expect(describePublicKey(`${pair.blob}\nssh-rsa AAAA`)).toBeNull();
    });

    it('keeps comments to characters that are inert in authorized_keys, sh and PowerShell', () => {
        expect(safeComment("deploy key ' $(reboot) `x` \"y\"\nz")).toBe('deploy-key--reboot-x-y-z');
        expect(safeComment('josé@prod.example')).toBe('jose@prod.example');
        expect(safeComment('x'.repeat(300))).toHaveLength(128);
    });
});
