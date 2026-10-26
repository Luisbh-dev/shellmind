import { describe, expect, it } from 'vitest';
import { utils } from 'ssh2';
import { generateKeyPair } from './sshServer';

describe('generateKeyPair', () => {
    it('only returns key pairs that ssh2 can parse back', () => {
        // About 1 in 250 raw ssh2 ed25519 keys fail to parse; 600 pairs would
        // almost surely include such a key without the retry.
        for (let i = 0; i < 600; i += 1) {
            const { privateKey, publicKey } = generateKeyPair();
            expect(utils.parseKey(privateKey)).not.toBeInstanceOf(Error);
            expect(utils.parseKey(publicKey)).not.toBeInstanceOf(Error);
        }
    });
});
