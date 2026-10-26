import { describe, expect, it } from 'vitest';
import type { IdentitySummary } from '@shared/identities';
import { buildIdentityPayload, formFromIdentity, keyModes, validateIdentityForm, type IdentityForm } from './identityForm';
import { applyInstallEvent, startRun, summarize, verifiedServers } from './progress';

const STORED: IdentitySummary = {
    id: 3, name: 'deploy', username: 'deployer', private_key_path: null, use_agent: 0, public_key: 'ssh-ed25519 AAAA x', fingerprint: 'SHA256:x', key_type: 'ssh-ed25519',
    has_password: 1, has_private_key: 1, has_passphrase: 1, server_count: 2, created_at: 1, updated_at: 1,
};

const edit = (patch: Partial<IdentityForm>, identity: IdentitySummary = STORED) => ({ ...formFromIdentity(identity), ...patch });

describe('identity form', () => {
    it('starts from the saved identity; secrets stay blank and blank keeps them', () => {
        expect(formFromIdentity(STORED)).toMatchObject({ name: 'deploy', username: 'deployer', keyMode: 'keep', password: '', passphrase: '' });
        expect(formFromIdentity({ ...STORED, has_private_key: 0, private_key_path: '~/.ssh/id' })).toMatchObject({ keyMode: 'file', keyPath: '~/.ssh/id' });
        expect(formFromIdentity(null, 'generate').keyMode).toBe('generate');
        expect(buildIdentityPayload(edit({}), STORED)).toEqual({ name: 'deploy', username: 'deployer', use_agent: false, private_key_path: null });
    });

    it('offers rotation instead of generating over a stored key', () => {
        expect(keyModes(STORED)).toEqual(['keep', 'paste', 'file', 'none']);
        expect(keyModes(null)).toEqual(['none', 'generate', 'paste', 'file']);
    });

    it('replaces, removes or moves the key, and never gives a generated key an old passphrase', () => {
        expect(buildIdentityPayload(edit({ keyMode: 'paste', privateKey: 'KEY' }), STORED)).toMatchObject({ privateKey: 'KEY' });
        expect(buildIdentityPayload(edit({ keyMode: 'none' }), STORED)).toMatchObject({ clear_private_key: true, clear_passphrase: true });
        expect(buildIdentityPayload(edit({ keyMode: 'file', keyPath: ' ~/.ssh/id_ed25519 ' }), STORED)).toMatchObject({ private_key_path: '~/.ssh/id_ed25519', clear_private_key: true });

        const fromFile = { ...STORED, has_private_key: 0, private_key_path: '~/.ssh/old' };
        const generated = buildIdentityPayload(edit({ keyMode: 'generate', comment: ' me@laptop ' }, fromFile), fromFile);
        expect(generated).toMatchObject({ generate_key: true, key_comment: 'me@laptop', private_key_path: null, clear_passphrase: true });
        expect(buildIdentityPayload(edit({ keyMode: 'generate', passphrase: 'pp' }, fromFile), fromFile)).toMatchObject({ passphrase: 'pp' });
        expect(buildIdentityPayload(edit({ keyMode: 'file', keyPath: '~/.ssh/id', removePassword: true, removePassphrase: true }), STORED)).toMatchObject({ clear_password: true, clear_passphrase: true });
    });

    it('keeps a kept key\'s passphrase: the backend never re-encrypts a stored key', () => {
        // Even when the field was used in another key mode before switching back.
        const kept = buildIdentityPayload(edit({ passphrase: 'new-pp', removePassphrase: true, removePassword: true }), STORED);
        expect(kept).toEqual({ name: 'deploy', username: 'deployer', use_agent: false, private_key_path: null, clear_password: true });
        expect(buildIdentityPayload(edit({ keyMode: 'paste', privateKey: 'KEY', passphrase: 'pp' }), STORED)).toMatchObject({ privateKey: 'KEY', passphrase: 'pp' });
    });

    it('validates the name and the key it needs', () => {
        expect(validateIdentityForm(formFromIdentity(null))).toEqual({ name: 'identities.editor.errors.nameRequired' });
        expect(validateIdentityForm({ ...formFromIdentity(null), name: 'x', keyMode: 'paste' })).toEqual({ privateKey: 'identities.editor.errors.keyRequired' });
        expect(validateIdentityForm({ ...formFromIdentity(null), name: 'x', keyMode: 'file' })).toEqual({ keyPath: 'identities.editor.errors.keyPathRequired' });
        expect(validateIdentityForm({ ...formFromIdentity(null), name: 'x', keyMode: 'generate' })).toEqual({});
    });
});

describe('install progress', () => {
    it('follows each server through the stream and sums up how it went', () => {
        let run = startRun([{ serverId: 1, name: 'a' }, { serverId: 2, name: 'b' }, { serverId: 3, name: 'c' }]);
        run = applyInstallEvent(run, { type: 'start', servers: [{ serverId: 1, name: 'a' }, { serverId: 2, name: 'b' }, { serverId: 3, name: 'c' }], fingerprint: 'SHA256:new' });
        run = applyInstallEvent(run, { type: 'progress', serverId: 1, phase: 'verifying' });
        expect(run.rows[0].phase).toBe('verifying');
        run = applyInstallEvent(run, { type: 'result', result: { serverId: 1, name: 'a', status: 'installed', verified: true } });
        run = applyInstallEvent(run, { type: 'result', result: { serverId: 2, name: 'b', status: 'present', verified: false, errorCode: 'AUTH_FAILED' } });
        expect(summarize(run)).toEqual({ installed: 1, present: 0, unverified: 1, failed: 0, cancelled: 0, pending: 1 });
        run = applyInstallEvent(run, { type: 'result', result: { serverId: 3, name: 'c', status: 'failed', errorCode: 'CANCELLED' } });
        run = applyInstallEvent(run, { type: 'rotated', replaced: false, fingerprint: null });
        run = applyInstallEvent(run, { type: 'done', cancelled: true });
        expect(run).toMatchObject({ fingerprint: 'SHA256:new', done: true, cancelled: true, rotated: { replaced: false } });
        expect(summarize(run).cancelled).toBe(1);
        expect(verifiedServers(run)).toEqual([1]);
        expect(applyInstallEvent(run, { type: 'error', message: 'boom' })).toMatchObject({ done: true, error: 'boom' });
    });
});
