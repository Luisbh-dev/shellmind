import { describe, expect, it } from 'vitest';
import type { ServerSummary } from '@shared/types';
import { EMPTY_FORM, NO_REMOVALS, buildPayload, formFromServer, secretsToClear, validateForm, type ServerForm } from './serverForm';

const form = (patch: Partial<ServerForm>): ServerForm => ({ ...EMPTY_FORM, name: 'srv', ip: '10.0.0.1', username: 'root', ...patch });

const SAVED_KEY_SERVER: ServerSummary = {
    id: 7, name: 'srv', ip: '10.0.0.1', type: 'linux', username: 'root',
    has_password: 0, has_private_key: 1, has_passphrase: 1, has_s3_secret_key: 0,
};

describe('server form payload', () => {
    it('leaves a blank port empty so the backend applies the type default (FTP is 21, not 22)', () => {
        const payload = buildPayload(form({ type: 'ftp', port: '', password: 'pw' }), null, NO_REMOVALS);
        expect(payload).toMatchObject({ type: 'ftp', port: null, password: 'pw' });
        expect(payload.privateKey).toBeUndefined();
        expect(buildPayload(form({ type: 'ftp', port: '2121' }), null, NO_REMOVALS)).toMatchObject({ port: 2121 });
    });

    it('makes new FTP connections secure by default and keeps the setting of saved ones', () => {
        expect(EMPTY_FORM.ftp_secure).toBe(true);
        expect(buildPayload(form({ type: 'ftp' }), null, NO_REMOVALS).ftp_secure).toBe(true);
        expect(buildPayload(form({ type: 'ftp', ftp_secure: false }), null, NO_REMOVALS).ftp_secure).toBe(false);
        expect(buildPayload(form({ type: 'linux' }), null, NO_REMOVALS).ftp_secure).toBe(false);

        const plainFtp: ServerSummary = { id: 3, name: 'old', ip: '10.0.0.3', type: 'ftp', ftp_secure: 0 };
        expect(formFromServer(plainFtp).ftp_secure).toBe(false);
        expect(formFromServer({ ...plainFtp, ftp_secure: 1 }).ftp_secure).toBe(true);
        // Another type switched to FTP starts secure.
        expect(formFromServer(SAVED_KEY_SERVER).ftp_secure).toBe(true);
    });

    it('never drops the password of a Windows server whose SSH uses a key: it is the RDP password', () => {
        const windows: ServerSummary = { ...SAVED_KEY_SERVER, type: 'windows', has_password: 1 };
        const edit = { ...formFromServer(windows), name: 'renamed' };
        expect(edit.auth).toBe('key');
        expect(secretsToClear(edit, windows, NO_REMOVALS)).toEqual([]);
        const payload = buildPayload(edit, windows, NO_REMOVALS);
        expect(payload.clear_password).toBeUndefined();
        expect(payload.clear_private_key).toBeUndefined();

        expect(buildPayload({ ...edit, auth: 'keyFile', private_key_path: '~/.ssh/id', password: 'rdp-pw' }, windows, NO_REMOVALS))
            .toMatchObject({ password: 'rdp-pw', clear_private_key: true });
        // Only an explicit removal clears it.
        expect(buildPayload(edit, windows, { ...NO_REMOVALS, password: true })).toMatchObject({ clear_password: true });
        // A Linux server signing in with a key has no use for a password.
        expect(buildPayload(formFromServer({ ...SAVED_KEY_SERVER, has_password: 1 }), { ...SAVED_KEY_SERVER, has_password: 1 }, NO_REMOVALS))
            .toMatchObject({ clear_password: true });
    });

    it('never sends key fields for FTP, whatever auth method was picked before', () => {
        const payload = buildPayload(form({ type: 'ftp', auth: 'key', privateKey: 'KEY', passphrase: 'pp', password: 'pw' }), null, NO_REMOVALS);
        expect(payload).toMatchObject({ password: 'pw', private_key_path: null, jump_server_id: null });
        expect(payload.privateKey).toBeUndefined();
        expect(payload.passphrase).toBeUndefined();
    });

    it('switching an existing key server to password auth clears the stored key and passphrase', () => {
        const edit = { ...formFromServer(SAVED_KEY_SERVER), auth: 'password' as const, password: 'new-pw' };
        expect(secretsToClear(edit, SAVED_KEY_SERVER, NO_REMOVALS)).toEqual(['privateKey', 'passphrase']);
        expect(buildPayload(edit, SAVED_KEY_SERVER, NO_REMOVALS)).toMatchObject({
            password: 'new-pw', clear_private_key: true, clear_passphrase: true,
        });
    });

    it('keeps stored secrets when their fields stay blank, and clears them on request', () => {
        const edit = formFromServer(SAVED_KEY_SERVER);
        expect(edit.auth).toBe('key');
        const kept = buildPayload(edit, SAVED_KEY_SERVER, NO_REMOVALS);
        expect(kept.privateKey).toBeUndefined();
        expect(kept.clear_private_key).toBeUndefined();

        const removed = buildPayload(edit, SAVED_KEY_SERVER, { ...NO_REMOVALS, passphrase: true });
        expect(removed).toMatchObject({ clear_passphrase: true });
        expect(removed.clear_private_key).toBeUndefined();
    });

    it('sends the key file path for key-file auth and the jump host for SSH only', () => {
        expect(buildPayload(form({ auth: 'keyFile', private_key_path: ' ~/.ssh/id ', jump_server_id: '3' }), null, NO_REMOVALS))
            .toMatchObject({ private_key_path: '~/.ssh/id', jump_server_id: 3 });
        expect(buildPayload(form({ type: 'ftp', jump_server_id: '3' }), null, NO_REMOVALS).jump_server_id).toBeNull();
    });

    it('fills the per-type fields and the organization', () => {
        const windows = buildPayload(form({ type: 'windows', port: '', ssh_port: '2222', domain: 'CORP' }), null, NO_REMOVALS);
        expect(windows).toMatchObject({ port: null, ssh_port: 2222, domain: 'CORP' });
        const local = buildPayload(form({ type: 'local', cli_preset: 'custom', command: 'wsl', group_name: ' Lab ', tags: ['a'], color: 'violet', notes: ' n ' }), null, NO_REMOVALS);
        expect(local).toMatchObject({ ip: 'local', username: null, port: null, command: 'wsl', group_name: 'Lab', tags: ['a'], color: 'violet', notes: 'n' });
        const s3 = buildPayload(form({ type: 's3', s3_provider: 'other', s3_endpoint: 'https://minio', s3_bucket: 'b', s3_access_key: 'AK', s3_secret_key: 'SK' }), null, NO_REMOVALS);
        expect(s3).toMatchObject({ ip: '', s3_endpoint: 'https://minio', s3_region: null, s3_secret_key: 'SK' });
    });
});

describe('server form validation', () => {
    it('requires what each type needs', () => {
        expect(validateForm(form({ name: ' ', ip: '' }), null, NO_REMOVALS)).toEqual({
            name: 'addServer.errors.nameRequired',
            ip: 'addServer.errors.hostRequired',
        });
        expect(validateForm(form({ username: '' }), null, NO_REMOVALS)).toEqual({ username: 'addServer.errors.usernameRequired' });
        expect(validateForm(form({ type: 'ftp', username: '' }), null, NO_REMOVALS)).toEqual({});
        expect(validateForm(form({ auth: 'key' }), null, NO_REMOVALS)).toEqual({ privateKey: 'addServer.errors.keyRequired' });
        expect(validateForm(formFromServer(SAVED_KEY_SERVER), SAVED_KEY_SERVER, NO_REMOVALS)).toEqual({});
        expect(validateForm(form({ auth: 'keyFile' }), null, NO_REMOVALS)).toEqual({ private_key_path: 'addServer.errors.keyPathRequired' });
        expect(Object.keys(validateForm(form({ type: 's3', s3_provider: 'other' }), null, NO_REMOVALS)).sort())
            .toEqual(['s3_access_key', 's3_bucket', 's3_endpoint', 's3_secret_key']);
    });

    it('accepts blank or valid ports only', () => {
        for (const port of ['0', '65536', '-1', '22a', '1.5']) {
            expect(validateForm(form({ port }), null, NO_REMOVALS).port, port).toBe('addServer.errors.port');
        }
        for (const port of ['', '1', '65535']) expect(validateForm(form({ port }), null, NO_REMOVALS).port).toBeUndefined();
        expect(validateForm(form({ type: 'windows', ssh_port: '70000' }), null, NO_REMOVALS).ssh_port).toBe('addServer.errors.port');
    });
});
