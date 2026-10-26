import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The HTTP API end to end: the servers CRUD with its secret semantics, AI
// chat, configuration and the error shapes.

let server: TestServer;

// API answers, which the assertions read field by field.
interface JsonBody { [key: string]: JsonBody }
type JsonResponse = { status: number; headers: Headers; body: JsonBody; text: string };

async function request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<JsonResponse> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? headers : { 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: unknown = null;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, headers: res.headers, body: parsed as JsonBody, text };
}

function dbGet<T>(sql: string, params: unknown[] = []): Promise<T> {
    return new Promise((resolve, reject) => {
        server.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as T)));
    });
}

const SECRETS = {
    password: 'pw-9f3a1c',
    privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nkey-7d2e\n-----END OPENSSH PRIVATE KEY-----',
    passphrase: 'pp-4b8e',
    s3_secret_key: 's3sk-0c6d',
};

const EMPTY_ROW = {
    ssh_port: null,
    os_detail: null,
    s3_provider: null,
    s3_bucket: null,
    s3_region: null,
    s3_endpoint: null,
    s3_access_key: null,
    command: null,
    cwd: null,
    initial_command: null,
    cli_preset: null,
    domain: null,
    private_key_path: null,
    jump_server_id: null,
    group_name: null,
    tags: [],
    color: null,
    notes: null,
    sort_order: 0,
    updated_at: expect.any(Number),
    ftp_secure: 0,
    favorite: 0,
    identity_id: null,
    agent_forward: 0,
    has_password: 0,
    has_private_key: 0,
    has_passphrase: 0,
    has_s3_secret_key: 0,
};

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
});

afterAll(async () => {
    await server?.close();
    vi.restoreAllMocks();
});

describe('servers API', () => {
    it('creates, lists, updates and deletes a server without ever returning secrets', async () => {
        const created = await request('POST', '/api/servers', {
            name: 'web01',
            ip: '10.0.0.5',
            type: 'linux',
            username: 'root',
            port: 2222,
            ...SECRETS,
        });
        expect(created.status).toBe(200);
        const id = created.body.data.id;
        // The POST response is the saved summary.
        expect(created.body).toEqual({
            message: 'success',
            data: {
                ...EMPTY_ROW,
                id: expect.any(Number),
                name: 'web01',
                ip: '10.0.0.5',
                type: 'linux',
                username: 'root',
                port: 2222,
                has_password: 1,
                has_private_key: 1,
                has_passphrase: 1,
                has_s3_secret_key: 1,
            },
        });

        const listed = await request('GET', '/api/servers');
        expect(listed.status).toBe(200);
        expect(listed.body).toEqual({
            message: 'success',
            data: [{
                ...EMPTY_ROW,
                id,
                name: 'web01',
                ip: '10.0.0.5',
                type: 'linux',
                username: 'root',
                port: 2222,
                has_password: 1,
                has_private_key: 1,
                has_passphrase: 1,
                has_s3_secret_key: 1,
            }],
        });

        const patched = await request('PATCH', `/api/servers/${id}/os`, { os_detail: 'Ubuntu 24.04 LTS' });
        expect(patched.status).toBe(200);
        expect(patched.body).toEqual({ message: 'success' });

        // Pointing the server elsewhere while keeping its stored secrets needs
        // an explicit confirmation (security/put-server-retarget-keeps-secrets).
        const retarget = { name: 'web01-renamed', ip: '10.0.0.6', type: 'linux', username: 'admin', password: '', privateKey: '   ' };
        const refused = await request('PUT', `/api/servers/${id}`, retarget);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'SECRETS_RETARGET', details: { kept: ['password', 'privateKey', 'passphrase', 's3_secret_key'] } });

        // Blank secret fields keep the stored values.
        const updated = await request('PUT', `/api/servers/${id}`, { ...retarget, keep_secrets: true });
        expect(updated.status).toBe(200);
        expect(updated.body).toEqual({ message: 'success', changes: 1, data: expect.objectContaining({ id, ip: '10.0.0.6' }) });

        const afterUpdate = await request('GET', '/api/servers');
        expect(afterUpdate.body.data).toEqual([{
            ...EMPTY_ROW,
            id,
            name: 'web01-renamed',
            ip: '10.0.0.6',
            type: 'linux',
            username: 'admin',
            // A blank port means the default of the type (resolved at connect time).
            port: null,
            // The edit form does not send os_detail: the detected OS is kept.
            os_detail: 'Ubuntu 24.04 LTS',
            has_password: 1,
            has_private_key: 1,
            has_passphrase: 1,
            has_s3_secret_key: 1,
        }]);
        // Secrets are encrypted at rest.
        const stored = await dbGet<Record<string, string>>('SELECT password, privateKey, passphrase FROM servers WHERE id = ?', [id]);
        for (const value of Object.values(stored)) expect(value).toMatch(/^enc:v1:/);

        const newPassword = await request('PUT', `/api/servers/${id}`, {
            name: 'web01-renamed', ip: '10.0.0.6', type: 'linux', username: 'admin', password: 'pw-new',
        });
        expect(newPassword.body).toMatchObject({ message: 'success', changes: 1 });
        const rotated = await dbGet<{ password: string }>('SELECT password FROM servers WHERE id = ?', [id]);
        expect(rotated.password).toMatch(/^enc:v1:/);
        expect(rotated.password).not.toBe(stored.password);

        const deleted = await request('DELETE', `/api/servers/${id}`);
        expect(deleted.status).toBe(200);
        expect(deleted.body).toEqual({ message: 'deleted', changes: 1 });

        const deletedAgain = await request('DELETE', `/api/servers/${id}`);
        expect(deletedAgain.status).toBe(404);
        expect(deletedAgain.body).toEqual({ error: 'Server not found', code: 'SERVER_NOT_FOUND' });

        const empty = await request('GET', '/api/servers');
        expect(empty.body).toEqual({ message: 'success', data: [] });

        for (const response of [created, listed, patched, refused, updated, afterUpdate, newPassword, deleted, empty]) {
            for (const secret of [...Object.values(SECRETS), 'pw-new']) {
                expect(response.text).not.toContain(secret);
            }
        }
    });

    it('applies the port defaults of each server type', async () => {
        const windows = await request('POST', '/api/servers', { name: 'win', ip: '10.0.0.7', type: 'windows', username: 'Administrator' });
        const ftp = await request('POST', '/api/servers', { name: 'ftp', ip: '10.0.0.8', type: 'ftp', username: 'ftpuser', password: SECRETS.password });
        const s3 = await request('POST', '/api/servers', {
            name: 'bucket',
            ip: 's3',
            type: 's3',
            s3_provider: 'other',
            s3_bucket: 'backups',
            s3_region: 'eu-west-1',
            s3_endpoint: 'minio.local:9000',
            s3_access_key: 'AKIATEST',
            s3_secret_key: SECRETS.s3_secret_key,
        });
        // The POST response is the saved summary (secrets only as has_* flags).
        expect(s3.body.data).toEqual({
            ...EMPTY_ROW,
            id: expect.any(Number),
            name: 'bucket',
            ip: 's3',
            type: 's3',
            username: null,
            port: null,
            s3_provider: 'other',
            s3_bucket: 'backups',
            s3_region: 'eu-west-1',
            s3_endpoint: 'minio.local:9000',
            s3_access_key: 'AKIATEST',
            has_s3_secret_key: 1,
            // New servers go after the saved ones in the manual order.
            sort_order: Number(windows.body.data.sort_order) + 2,
        });

        // Blank ports are stored as NULL; shared/ports.ts resolves the default
        // per type and purpose at connect time (FTP 21, RDP 3389, SSH 22).
        const { body } = await request('GET', '/api/servers');
        const byName = Object.fromEntries((body.data as unknown as Array<{ name: string }>).map((row) => [row.name, row]));
        expect(byName.win).toMatchObject({ port: null, ssh_port: null, has_password: 0 });
        expect(byName.ftp).toMatchObject({ port: null, ssh_port: null, has_password: 1 });
        expect(byName.bucket).toMatchObject({
            port: null,
            s3_bucket: 'backups',
            s3_access_key: 'AKIATEST',
            has_s3_secret_key: 1,
        });
        expect(JSON.stringify(body)).not.toContain(SECRETS.s3_secret_key);
        expect(JSON.stringify(body)).not.toContain(SECRETS.password);

        for (const created of [windows, ftp, s3]) {
            await request('DELETE', `/api/servers/${created.body.data.id}`);
        }
    });

    it('reports validation errors and unknown ids', async () => {
        const missingName = await request('POST', '/api/servers', { ip: '10.0.0.9', type: 'linux' });
        expect(missingName.status).toBe(400);
        expect(missingName.body).toEqual({ error: 'name is required', code: 'INVALID_SERVER' });

        const updateMissing = await request('PUT', '/api/servers/999999', { name: 'x', ip: 'y', type: 'linux' });
        expect(updateMissing.status).toBe(404);
        expect(updateMissing.body).toEqual({ error: 'Server not found', code: 'SERVER_NOT_FOUND' });

        const statusMissing = await request('GET', '/api/servers/999999/status');
        expect(statusMissing.status).toBe(404);
        // The same code (and status) as every other route that names a missing server.
        expect(statusMissing.body).toEqual({ error: 'Server #999999 does not exist (it may have been deleted).', code: 'SERVER_NOT_FOUND' });
    });

    it('refuses the status dashboard for FTP and S3 servers', async () => {
        const ftp = await request('POST', '/api/servers', { name: 'ftp-status', ip: '10.0.0.10', type: 'ftp' });
        const status = await request('GET', `/api/servers/${ftp.body.data.id}/status`);
        expect(status.status).toBe(400);
        expect(status.body).toEqual({ error: 'Status dashboard is only available for SSH-capable servers.', code: 'UNSUPPORTED_PURPOSE' });
        await request('DELETE', `/api/servers/${ftp.body.data.id}`);
    });
});

describe('chat API (no provider call)', () => {
    const outOfScope = 'Write me a poem about cats';

    it('answers out-of-scope first turns with the canned refusal', async () => {
        const res = await request('POST', '/api/chat', { message: outOfScope });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ response: expect.stringMatching(/^I can only help with SysAdmin/) });
    });

    it('streams the canned refusal as Server-Sent Events', async () => {
        const json = await request('POST', '/api/chat', { message: outOfScope });
        const res = await request('POST', '/api/chat', { message: outOfScope, stream: true });
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toBe('text/event-stream');
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(res.text).toBe(
            `data: ${JSON.stringify({ type: 'delta', text: json.body.response })}\n\n` +
            `data: ${JSON.stringify({ type: 'done', usedModel: null, fullText: json.body.response })}\n\n`
        );
    });

    // A configuration error, not an answer: it must not be saved as history.
    it('asks for a Gemini key when none is configured', async () => {
        const expected = {
            error: 'Please set your GEMINI_API_KEY in Settings or Environment variables.',
            code: 'AI_KEY_MISSING',
            details: { provider: 'gemini' },
        };
        const res = await request('POST', '/api/chat', { message: 'restart nginx', model: 'gemini-3.8-flash' });
        expect(res.status).toBe(409);
        expect(res.body).toEqual(expected);

        const streamed = await request('POST', '/api/chat', { message: 'restart nginx', model: 'gemini-3.8-flash', stream: true });
        expect(streamed.status).toBe(409);
        expect(streamed.body).toEqual(expected);
    });
});

describe('config API', () => {
    it('reports provider status', async () => {
        const res = await request('GET', '/api/config/status');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({
            configured: false,
            source: 'none',
            providers: {
                gemini: { configured: false, source: 'none' },
                minimax: { configured: false, source: 'none' },
            },
            features: {
                minimaxProxy: {
                    enabled: true,
                    route: 'proxy',
                    baseUrl: 'https://ai-proxy.luisbh.com/anthropic/v1',
                    apiBaseUrl: 'https://api.minimax.io/anthropic',
                    allowClientKey: true,
                    usesProxyAuth: false,
                    localKeyConfigured: false,
                    localKeySource: 'none',
                },
            },
        });
    });

    it('saves and deletes API keys', async () => {
        expect((await request('POST', '/api/config/apikey', { provider: 'gemini' })).body).toEqual({ error: 'Key is required', code: 'INVALID_CONFIG', details: { field: 'key' } });

        const saved = await request('POST', '/api/config/apikey', { provider: 'unknown-defaults-to-gemini', key: 'g-key' });
        expect(saved.status).toBe(200);
        expect(saved.body).toEqual({ message: 'success' });

        const status = await request('GET', '/api/config/status');
        expect(status.body).toMatchObject({
            configured: true,
            source: 'db',
            providers: { gemini: { configured: true, source: 'db' } },
        });
        expect(status.text).not.toContain('g-key');

        const minimax = await request('POST', '/api/config/apikey', { provider: 'minimax', key: 'mm-key' });
        expect(minimax.body).toEqual({ message: 'success' });
        // With the user's own key, MiniMax is called directly.
        expect((await request('GET', '/api/config/status')).body.features.minimaxProxy).toMatchObject({
            route: 'direct',
            localKeyConfigured: true,
            localKeySource: 'db',
        });

        expect((await request('DELETE', '/api/config/apikey', { provider: 'gemini' })).body).toEqual({ message: 'success', changes: 1 });
        expect((await request('DELETE', '/api/config/apikey', { provider: 'minimax' })).body).toEqual({ message: 'success', changes: 1 });
        expect((await request('DELETE', '/api/config/apikey')).body).toEqual({ message: 'success', changes: 0 });
        expect((await request('GET', '/api/config/status')).body.configured).toBe(false);
    });

    it('stores the preferred model', async () => {
        expect((await request('GET', '/api/config/model')).body).toEqual({ model: 'MiniMax-M3' });

        const missing = await request('POST', '/api/config/model', {});
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({ error: 'Model is required', code: 'INVALID_CONFIG', details: { field: 'model' } });

        const unknown = await request('POST', '/api/config/model', { model: 'gpt-1' });
        expect(unknown.status).toBe(400);

        expect((await request('POST', '/api/config/model', { model: 'gemini-3.8-flash' })).body).toEqual({ message: 'success' });
        expect((await request('GET', '/api/config/model')).body).toEqual({ model: 'gemini-3.8-flash' });
    });

    it('maps a retired preferred model saved by an older version to its successor', async () => {
        const { settingsRepo } = await import('../../server/db/settingsRepo');
        await settingsRepo.set('PREFERRED_MODEL', 'MiniMax-M2.7');
        expect((await request('GET', '/api/config/model')).body).toEqual({ model: 'MiniMax-M3' });
        await settingsRepo.set('PREFERRED_MODEL', 'gemini-2.5-flash');
        expect((await request('GET', '/api/config/model')).body).toEqual({ model: 'gemini-3.8-flash' });
    });
});

describe('chat history API', () => {
    it('stores, filters, trims and deletes per-server history', async () => {
        expect((await request('GET', '/api/chat/history/42')).body).toEqual({ messages: [] });

        const missing = await request('PUT', '/api/chat/history/42', { messages: 'nope' });
        expect(missing.status).toBe(400);
        expect(missing.body).toEqual({ error: 'messages array is required', code: 'INVALID_CHAT_REQUEST', details: { field: 'messages' } });

        const saved = await request('PUT', '/api/chat/history/42', {
            messages: [
                { role: 'user', content: ' hi ', id: 'u1' },
                { role: 'system', content: 'dropped' },
                { role: 'assistant', content: '   ' },
                { role: 'assistant', content: 'hello', id: 'a1' },
            ],
        });
        expect(saved.body).toEqual({ message: 'success', count: 2 });
        expect((await request('GET', '/api/chat/history/42')).body).toEqual({
            messages: [{ role: 'user', content: ' hi ' }, { role: 'assistant', content: 'hello' }],
        });

        const many = Array.from({ length: 105 }, (_, i) => ({ role: 'user', content: `m${i}` }));
        expect((await request('PUT', '/api/chat/history/42', { messages: many })).body).toEqual({ message: 'success', count: 100 });
        const kept = (await request('GET', '/api/chat/history/42')).body.messages;
        expect(kept[0]).toEqual({ role: 'user', content: 'm5' });
        expect(kept).toHaveLength(100);

        expect((await request('DELETE', '/api/chat/history/42')).body).toEqual({ message: 'deleted', changes: 1 });
        expect((await request('GET', '/api/chat/history/42')).body).toEqual({ messages: [] });
    });

    it('accepts conversations beyond the old 100 kB JSON limit', async () => {
        const messages = [{ role: 'user', content: 'x'.repeat(150_000) }];
        const res = await request('PUT', '/api/chat/history/43', { messages });
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ message: 'success', count: 1 });
    });

    it('deletes the history of a deleted server', async () => {
        const created = await request('POST', '/api/servers', { name: 'tmp', ip: '10.0.0.11', type: 'linux' });
        const id = created.body.data.id;
        await request('PUT', `/api/chat/history/${id}`, { messages: [{ role: 'user', content: 'remember me' }] });
        await request('DELETE', `/api/servers/${id}`);

        expect((await request('GET', `/api/chat/history/${id}`)).body).toEqual({ messages: [] });
    });
});

describe('CORS', () => {
    it('adds CORS headers for loopback origins', async () => {
        const res = await request('GET', '/api/servers', undefined, { origin: 'http://localhost:5173' });
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    });

    it('rejects disallowed origins with 403', async () => {
        const res = await request('GET', '/api/servers', undefined, { origin: 'https://evil.example' });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
        expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('returns 404 for unknown routes', async () => {
        expect((await request('GET', '/api/does-not-exist')).status).toBe(404);
    });
});
