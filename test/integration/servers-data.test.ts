import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerSummary } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Saved servers through the HTTP API: write-only secrets with explicit
// clearing, fields older clients do not send, validation and deletion of
// everything scoped to a server.

let server: TestServer;

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T; text: string }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, body: parsed as T, text };
}

function sql<T = unknown>(query: string, params: unknown[] = []): Promise<T[]> {
    return new Promise((resolve, reject) => server.db.all(query, params, (err, rows) => (err ? reject(err) : resolve(rows as T[]))));
}

async function create(body: Record<string, unknown>): Promise<ServerSummary> {
    const res = await api<{ data: ServerSummary }>('POST', '/api/servers', body);
    expect(res.status).toBe(200);
    return res.body.data;
}

async function summary(id: number): Promise<ServerSummary | undefined> {
    const res = await api<{ data: ServerSummary[] }>('GET', '/api/servers');
    return res.body.data.find((row) => row.id === id);
}

const LINUX = { name: 'db01', ip: '10.9.0.1', type: 'linux', username: 'root' };

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('secrets on PUT', () => {
    it('keeps omitted or blank secrets and clears them only on request', async () => {
        const { id } = await create({ ...LINUX, password: 'pw-a1', privateKey: 'KEY-a1', passphrase: 'pp-a1' });

        await api('PUT', `/api/servers/${id}`, { ...LINUX, password: '  ', privateKey: '' });
        expect(await summary(id)).toMatchObject({ has_password: 1, has_private_key: 1, has_passphrase: 1 });

        // Switching to password auth: drop the key and its passphrase.
        const cleared = await api('PUT', `/api/servers/${id}`, { ...LINUX, clear_private_key: true, clear_passphrase: true });
        expect(cleared.status).toBe(200);
        expect(await summary(id)).toMatchObject({ has_password: 1, has_private_key: 0, has_passphrase: 0 });
        expect(await sql('SELECT privateKey, passphrase FROM servers WHERE id = ?', [id])).toEqual([{ privateKey: null, passphrase: null }]);

        // Switching to key auth: a new key and no password.
        await api('PUT', `/api/servers/${id}`, { ...LINUX, clear_password: true, privateKey: 'KEY-b2' });
        expect(await summary(id)).toMatchObject({ has_password: 0, has_private_key: 1 });
        const [row] = await sql<{ password: string | null; privateKey: string }>('SELECT password, privateKey FROM servers WHERE id = ?', [id]);
        expect(row.password).toBeNull();
        expect(row.privateKey).toMatch(/^enc:v1:/);
        expect(row.privateKey).not.toContain('KEY-b2');
    });

    it('refuses to send kept secrets to a new target without confirmation', async () => {
        const { id } = await create({ ...LINUX, name: 'retarget', password: 'pw-c3' });

        // Name and user changes are not a new target.
        expect((await api('PUT', `/api/servers/${id}`, { ...LINUX, name: 'renamed', username: 'admin' })).status).toBe(200);

        for (const change of [{ ip: '10.9.0.99' }, { port: 2222 }, { type: 'ftp' }]) {
            const res = await api<{ code: string; error: string }>('PUT', `/api/servers/${id}`, { ...LINUX, ...change });
            expect(res.status).toBe(409);
            expect(res.body).toMatchObject({ code: 'SECRETS_RETARGET' });
        }
        expect((await summary(id))?.ip).toBe('10.9.0.1');

        // Re-entering the secret, clearing it or confirming are all accepted.
        expect((await api('PUT', `/api/servers/${id}`, { ...LINUX, ip: '10.9.0.2', password: 'pw-new' })).status).toBe(200);
        expect((await api('PUT', `/api/servers/${id}`, { ...LINUX, ip: '10.9.0.3', keep_secrets: true })).status).toBe(200);
        expect((await api('PUT', `/api/servers/${id}`, { ...LINUX, ip: '10.9.0.4', clear_password: true })).status).toBe(200);
        expect(await summary(id)).toMatchObject({ ip: '10.9.0.4', has_password: 0 });
        // Nothing left to protect.
        expect((await api('PUT', `/api/servers/${id}`, { ...LINUX, ip: '10.9.0.5' })).status).toBe(200);
    });

    it('never returns secrets', async () => {
        const created = await api('POST', '/api/servers', { ...LINUX, name: 'quiet', password: 'pw-d4-secret', s3_secret_key: 'sk-d4-secret' });
        const listed = await api('GET', '/api/servers');
        const updated = await api('PUT', `/api/servers/${(created.body as { data: { id: number } }).data.id}`, { ...LINUX, name: 'quiet', password: 'pw-e5-secret' });
        for (const res of [created, listed, updated]) {
            for (const secret of ['pw-d4-secret', 'sk-d4-secret', 'pw-e5-secret', 'enc:v1:']) expect(res.text).not.toContain(secret);
        }
    });
});

describe('fields older clients do not send', () => {
    it('keeps os_detail and organization fields unless the body sets them', async () => {
        const { id } = await create({
            ...LINUX, name: 'org', group_name: 'prod', tags: ['db', ' eu ', 'db', ''], color: '#ff0000', notes: 'primary', sort_order: 3,
            domain: 'CORP', private_key_path: '~/.ssh/id_ed25519',
        });
        expect((await api('PATCH', `/api/servers/${id}/os`, { os_detail: 'Debian 12' })).status).toBe(200);

        // The v0.3 edit form: only the connection fields.
        await api('PUT', `/api/servers/${id}`, { ...LINUX, name: 'org' });
        expect(await summary(id)).toMatchObject({
            os_detail: 'Debian 12', group_name: 'prod', tags: ['db', 'eu'], color: '#ff0000', notes: 'primary', sort_order: 3,
            domain: 'CORP', private_key_path: '~/.ssh/id_ed25519',
        });

        await api('PUT', `/api/servers/${id}`, { ...LINUX, name: 'org', tags: [], group_name: null, os_detail: 'Debian 13' });
        expect(await summary(id)).toMatchObject({ tags: [], group_name: null, os_detail: 'Debian 13', color: '#ff0000' });
    });

    it('validates the OS detail patch', async () => {
        const { id } = await create({ ...LINUX, name: 'os' });
        expect((await api('PATCH', `/api/servers/${id}/os`, { os_detail: '' })).status).toBe(400);
        expect((await api('PATCH', `/api/servers/${id}/os`, { os_detail: 42 })).status).toBe(400);
        expect((await api('PATCH', `/api/servers/${id}/os`, { os_detail: null })).status).toBe(200);
        expect((await api('PATCH', '/api/servers/999999/os', { os_detail: 'x' })).status).toBe(404);
    });
});

describe('validation', () => {
    it('rejects malformed servers with 400', async () => {
        for (const body of [
            { ...LINUX, type: 'telnet' },
            { ...LINUX, name: '   ' },
            { ...LINUX, ip: '' },
            { ...LINUX, port: 70000 },
            { ...LINUX, port: 'twenty-two' },
            { ...LINUX, tags: 'db' },
            { ...LINUX, password: 42 },
            { ...LINUX, jump_server_id: 999999 },
        ]) {
            const res = await api<{ code: string }>('POST', '/api/servers', body);
            expect(res.status, JSON.stringify(body)).toBe(400);
            expect(res.body.code).toBe('INVALID_SERVER');
        }
    });

    it('accepts SSH jump servers and refuses loops or non-SSH jumps', async () => {
        const bastion = await create({ ...LINUX, name: 'bastion' });
        const ftp = await create({ name: 'ftp', ip: '10.9.0.20', type: 'ftp' });
        const inner = await create({ ...LINUX, name: 'inner', jump_server_id: bastion.id });
        expect(inner.jump_server_id).toBe(bastion.id);

        expect((await api('POST', '/api/servers', { ...LINUX, jump_server_id: ftp.id })).status).toBe(400);
        // bastion -> inner -> bastion
        expect((await api('PUT', `/api/servers/${bastion.id}`, { ...LINUX, name: 'bastion', jump_server_id: inner.id })).status).toBe(400);
        expect((await api('PUT', `/api/servers/${inner.id}`, { ...LINUX, name: 'inner', jump_server_id: inner.id })).status).toBe(400);
    });

    // arch-cli-preset-unvalidated: the preset used to be stored verbatim.
    it('stores only the CLI presets ShellMind knows, lowercase and on local servers', async () => {
        const LOCAL = { name: 'console', ip: 'local', type: 'local' };
        expect((await create({ ...LOCAL, cli_preset: ' Docker ' })).cli_preset).toBe('docker');
        for (const preset of ['shell', 'azure', 'aws', 'gcloud', 'kubectl', 'docker', 'custom']) {
            expect((await create({ ...LOCAL, cli_preset: preset })).cli_preset).toBe(preset);
        }
        expect((await create({ ...LOCAL, cli_preset: '' })).cli_preset).toBeNull();
        expect((await create({ ...LINUX, name: 'not-local', cli_preset: 'docker' })).cli_preset).toBeNull();

        const typo = await api<{ code: string; details: unknown; error: string }>('POST', '/api/servers', { ...LOCAL, cli_preset: 'kubctl' });
        expect(typo).toMatchObject({ status: 400, body: { code: 'INVALID_SERVER', details: { field: 'cli_preset' } } });
        expect(typo.body.error).toMatch(/^cli_preset must be one of: shell, azure, aws, gcloud, kubectl, docker, custom$/);

        const saved = await create({ ...LOCAL, cli_preset: 'kubectl' });
        expect((await api('PUT', `/api/servers/${saved.id}`, { ...LOCAL, cli_preset: 'kubctl' })).status).toBe(400);
        expect((await summary(saved.id))?.cli_preset).toBe('kubectl');
    });

    it('skips imported local servers with an unknown CLI preset', async () => {
        const res = await api<{ servers: { created: unknown[]; skipped: Array<{ name: string; reason: string; detail?: string }> } }>('POST', '/api/import', {
            format: 'shellmind-config',
            version: 1,
            servers: [
                { ref: 1, name: 'typo', ip: 'local', type: 'local', cli_preset: 'Kubctl' },
                { ref: 2, name: 'cased', ip: 'local', type: 'local', cli_preset: 'AWS' },
            ],
        });
        expect(res.status).toBe(200);
        expect(res.body.servers.skipped).toEqual([{ name: 'typo', reason: 'invalid', detail: expect.stringContaining('cli_preset must be one of') }]);
        const rows = await sql<{ name: string; cli_preset: string }>("SELECT name, cli_preset FROM servers WHERE name IN ('typo', 'cased')");
        expect(rows).toEqual([{ name: 'cased', cli_preset: 'aws' }]);
    });
});

describe('DELETE /api/servers/:id', () => {
    it('refuses to delete a jump host in use, then removes everything scoped to the server', async () => {
        const target = await create({ ...LINUX, name: 'doomed', password: 'pw-f6' });
        const dependent = await create({ ...LINUX, name: 'via-doomed', jump_server_id: target.id });
        const now = Date.now();

        await api('PUT', `/api/chat/history/${target.id}`, { messages: [{ role: 'user', content: 'hello' }] });
        await sql("INSERT INTO settings (key, value) VALUES (?, '[\"ls\"]')", [`cli_history:${target.id}`]);
        await sql('INSERT INTO tunnels (server_id, name, local_port, remote_host, remote_port, created_at) VALUES (?, ?, ?, ?, ?, ?)', [target.id, 'db', 15432, '127.0.0.1', 5432, now]);
        await sql('INSERT INTO snippets (name, command, server_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)', ['restart', 'systemctl restart app', target.id, now, now]);
        await sql('INSERT INTO snippets (name, command, server_id, created_at, updated_at) VALUES (?, ?, NULL, ?, ?)', ['global', 'uptime', now, now]);
        await api('POST', '/api/audit', { serverId: target.id, source: 'terminal', command: 'uptime' });

        // Still a jump host: unlinking it would send the dependent's
        // credentials straight to its own address.
        const refused = await api<{ code: string; details: { dependents: unknown[] } }>('DELETE', `/api/servers/${target.id}`);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'JUMP_HOST_IN_USE', details: { dependents: [{ id: dependent.id, name: 'via-doomed' }] } });
        expect(await sql('SELECT id FROM servers WHERE id = ?', [target.id])).toEqual([{ id: target.id }]);
        expect(await sql('SELECT * FROM tunnels WHERE server_id = ?', [target.id])).toHaveLength(1);
        // The foreign key refuses it too.
        await expect(sql('DELETE FROM servers WHERE id = ?', [target.id])).rejects.toThrow(/FOREIGN KEY/);

        expect((await api('PUT', `/api/servers/${dependent.id}`, { ...LINUX, name: 'via-doomed', jump_server_id: null })).status).toBe(200);
        expect((await api('DELETE', `/api/servers/${target.id}`)).status).toBe(200);

        expect(await sql('SELECT * FROM servers WHERE id = ?', [target.id])).toEqual([]);
        expect(await sql('SELECT * FROM chat_history WHERE server_id = ?', [String(target.id)])).toEqual([]);
        expect(await sql('SELECT * FROM settings WHERE key = ?', [`cli_history:${target.id}`])).toEqual([]);
        expect(await sql('SELECT * FROM tunnels WHERE server_id = ?', [target.id])).toEqual([]);
        expect(await sql('SELECT name FROM snippets')).toEqual([{ name: 'global' }]);
        // The audit trail outlives the server.
        expect(await sql('SELECT server_id, server_name FROM audit_log WHERE server_id = ?', [target.id])).toEqual([{ server_id: target.id, server_name: 'doomed' }]);

        expect((await api('DELETE', `/api/servers/${target.id}`)).status).toBe(404);
        expect((await api('DELETE', '/api/servers/not-a-number')).status).toBe(404);
    });
});
