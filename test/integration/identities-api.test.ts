import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerChannel } from 'ssh2';
import type { IdentitySummary, InstallEvent } from '../../shared/identities';
import type { AuditEntry, ServerSummary } from '../../shared/types';
import { startFakeAgent, type FakeAgent } from '../helpers/fakeAgent';
import { generateKeyPair, startSshServer, type HarnessUser, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7-S2 identities end to end: the API, how servers take their credentials
// from an identity, the SSH agent, and installing / rotating keys against the
// in-process SSH server.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let harness: SshHarness;
let agent: FakeAgent;
let sshPool: typeof import('../../server/ssh/pool')['sshPool'];
let targets: typeof import('../../server/connections/target');
let exec: typeof import('../../server/ssh/exec')['exec'];
let user: HarnessUser;
const agentKey = generateKeyPair();

// What the harness does with the install script (`sh -s` on stdin).
let onInstallScript: (script: string, channel: ServerChannel) => void;
// The key data of each removal script the harness received.
const removals: string[] = [];

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

// The events of an SSE answer (the stream is read to its end).
async function stream(path: string, body: unknown): Promise<{ status: number; events: InstallEvent[]; body?: unknown }> {
    const res = await server.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const text = await res.text();
    if (!(res.headers.get('content-type') ?? '').includes('event-stream')) return { status: res.status, events: [], body: JSON.parse(text) };
    const events = text.split('\n\n').filter((block) => block.startsWith('data: ')).map((block) => JSON.parse(block.slice('data: '.length)) as InstallEvent);
    return { status: res.status, events: events.filter((event) => event.type !== 'ping') };
}

async function createIdentity(body: Record<string, unknown>): Promise<IdentitySummary> {
    const res = await api<{ data: IdentitySummary }>('POST', '/api/identities', body);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
}

async function createServer(body: Record<string, unknown>): Promise<ServerSummary> {
    const res = await api<{ data: ServerSummary }>('POST', '/api/servers', {
        name: `srv-${Math.random().toString(36).slice(2, 8)}`, ip: harness.host, port: harness.port, type: 'linux', ...body,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
}

async function rawRow(sql: string, params: unknown[] = []): Promise<Record<string, unknown> | undefined> {
    return new Promise((resolve, reject) => server.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row as Record<string, unknown> | undefined))));
}

async function auditOf(source: string): Promise<AuditEntry[]> {
    const res = await api<{ data: AuditEntry[] }>('GET', `/api/audit?source=${source}&limit=500`);
    return res.body.data;
}

// Answers the install script like a POSIX host would, after `apply` (e.g.
// making the harness accept the key it carried).
function scriptedInstall(apply: (publicKey: string) => void, outcome = 'installed') {
    return (script: string, channel: ServerChannel) => {
        // The removal of a rotated key's previous one.
        if (script.includes('@@SHELLMIND_KEY:removed:')) {
            removals.push(/^data='([^']+)'$/m.exec(script)?.[1] ?? '');
            channel.write('@@SHELLMIND_KEY:removed:1\n@@SHELLMIND_KEY:file:/home/tester/.ssh/authorized_keys\n');
            channel.exit(0);
            channel.end();
            return;
        }
        const publicKey = /^key='([^']+)'$/m.exec(script)?.[1] ?? '';
        apply(publicKey);
        channel.write(`@@SHELLMIND_KEY:file:/home/tester/.ssh/authorized_keys\n@@SHELLMIND_KEY:${outcome}\n`);
        channel.exit(0);
        channel.end();
    };
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    agent = await startFakeAgent([agentKey.privateKey]);
    server = await bootTestServer({ env: { SHELLMIND_SSH_AGENT: agent.path } });
    sshPool = (await import('../../server/ssh/pool')).sshPool;
    targets = await import('../../server/connections/target');
    exec = (await import('../../server/ssh/exec')).exec;
    user = { username: 'tester', password: 'secret' };
    harness = await startSshServer({
        users: [user],
        exec: (command, channel) => {
            if (command !== 'sh -s') return false;
            let script = '';
            channel.on('data', (chunk: Buffer) => { script += chunk.toString('utf8'); });
            channel.on('end', () => onInstallScript(script, channel));
            return true;
        },
    });
});

beforeEach(() => {
    user.password = 'secret';
    delete user.publicKey;
    onInstallScript = scriptedInstall((publicKey) => { user.publicKey = publicKey; });
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    await agent?.close();
    vi.restoreAllMocks();
});

describe('identities API', () => {
    it('creates, lists and edits identities without ever returning or storing a secret in clear', async () => {
        const created = await createIdentity({ name: 'deploy', username: 'deployer', password: 'pw-ident-3f1', use_agent: false });
        expect(created).toEqual({
            id: expect.any(Number), name: 'deploy', username: 'deployer', private_key_path: null, use_agent: 0, public_key: null,
            fingerprint: null, key_type: null, has_password: 1, has_private_key: 0, has_passphrase: 0, server_count: 0,
            created_at: expect.any(Number), updated_at: expect.any(Number),
        });
        const row = await rawRow('SELECT password FROM identities WHERE id = ?', [created.id]);
        expect(row?.password).toMatch(/^enc:v1:/);

        expect((await api('POST', '/api/identities', { name: 'DEPLOY' })).body).toMatchObject({ code: 'IDENTITY_NAME_TAKEN' });
        expect((await api('POST', '/api/identities', { name: '  ' })).body).toMatchObject({ code: 'INVALID_IDENTITY' });
        expect((await api('POST', '/api/identities', { name: 'bad key', privateKey: 'not a key' })).body).toMatchObject({ code: 'INVALID_PRIVATE_KEY' });

        // Blank keeps the password, clear_* removes it; the save bumps updated_at.
        const kept = await api<{ data: IdentitySummary; dependents: number }>('PUT', `/api/identities/${created.id}`, { name: 'deploy', username: 'ops', password: '' });
        expect(kept.body).toMatchObject({ data: { username: 'ops', has_password: 1 }, dependents: 0 });
        expect(kept.body.data.updated_at).toBeGreaterThan(created.updated_at);
        const cleared = await api<{ data: IdentitySummary }>('PUT', `/api/identities/${created.id}`, { name: 'deploy', clear_password: true });
        expect(cleared.body.data).toMatchObject({ username: null, has_password: 0 });

        const listed = await api<{ data: IdentitySummary[] }>('GET', '/api/identities');
        expect(listed.body.data.map((identity) => identity.name)).toContain('deploy');
        expect(JSON.stringify(listed.body)).not.toContain('pw-ident-3f1');
        expect((await api('PUT', '/api/identities/999999', { name: 'x' })).status).toBe(404);
    });

    it('generates an ed25519 key: stores the private key encrypted and answers only the public key', async () => {
        const identity = await createIdentity({ name: 'generated', generate_key: true, passphrase: 'key-pp-77' });
        expect(identity).toMatchObject({ key_type: 'ssh-ed25519', has_private_key: 1, has_passphrase: 1, fingerprint: expect.stringMatching(/^SHA256:/) });
        expect(identity.public_key).toMatch(/^ssh-ed25519 \S+ shellmind:generated$/);
        const row = await rawRow('SELECT privateKey, passphrase FROM identities WHERE id = ?', [identity.id]);
        expect(row?.privateKey).toMatch(/^enc:v1:/);
        expect(row?.passphrase).toMatch(/^enc:v1:/);

        // A stored key is rotated, not overwritten by another generated one.
        expect((await api('PUT', `/api/identities/${identity.id}`, { name: 'generated', generate_key: true })).body).toMatchObject({ code: 'IDENTITY_KEY_EXISTS' });
        // Key file and stored key are exclusive.
        expect((await api('PUT', `/api/identities/${identity.id}`, { name: 'generated', private_key_path: '~/.ssh/id' })).body).toMatchObject({ code: 'INVALID_IDENTITY' });
        // The stored key is never re-encrypted: its passphrase cannot change on its own.
        for (const change of [{ passphrase: 'another-pp' }, { clear_passphrase: true }]) {
            const refused = await api('PUT', `/api/identities/${identity.id}`, { name: 'generated', ...change });
            expect(refused).toMatchObject({ status: 400, body: { code: 'INVALID_PRIVATE_KEY', details: { field: 'passphrase' }, error: expect.stringMatching(/does not re-encrypt/) } });
        }
        expect((await rawRow('SELECT passphrase FROM identities WHERE id = ?', [identity.id]))?.passphrase).toBe(row?.passphrase);
    });

    it('lets SSH servers use an identity, and refuses to delete one in use', async () => {
        const identity = await createIdentity({ name: 'shared', password: 'x' });
        const linux = await createServer({ identity_id: identity.id, agent_forward: true });
        expect(linux).toMatchObject({ identity_id: identity.id, agent_forward: 1 });
        const ftp = await api<{ data: ServerSummary }>('POST', '/api/servers', { name: 'ftp-ident', ip: 'ftp.example', type: 'ftp', identity_id: identity.id, agent_forward: true });
        expect(ftp.body.data).toMatchObject({ identity_id: null, agent_forward: 0 });
        expect((await api('POST', '/api/servers', { name: 'nope', ip: 'h', type: 'linux', identity_id: 987654 })).body).toMatchObject({ code: 'INVALID_SERVER' });

        expect((await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data.find((row) => row.id === identity.id)?.server_count).toBe(1);
        const refused = await api<{ code: string; details: { dependents: Array<{ id: number; name: string }> } }>('DELETE', `/api/identities/${identity.id}`);
        expect(refused.status).toBe(409);
        expect(refused.body).toMatchObject({ code: 'IDENTITY_IN_USE', details: { dependents: [{ id: linux.id, name: linux.name }] } });

        expect((await api('POST', '/api/identities/assign', { identityId: null, serverIds: [linux.id] })).status).toBe(200);
        expect((await api('DELETE', `/api/identities/${identity.id}`)).status).toBe(200);
    });

    it('assigns an identity to several servers, optionally removing their own credentials', async () => {
        const identity = await createIdentity({ name: 'fleet', username: 'tester', password: 'secret' });
        const a = await createServer({ username: 'tester', password: 'own-a' });
        const b = await createServer({ privateKey: generateKeyPair().privateKey, private_key_path: null });
        const ftp = await api<{ data: ServerSummary }>('POST', '/api/servers', { name: 'ftp-assign', ip: 'ftp.example', type: 'ftp', password: 'f' });

        const res = await api<{ data: { updated: number[]; skipped: number[] } }>('POST', '/api/identities/assign', {
            identityId: identity.id, serverIds: [a.id, b.id, ftp.body.data.id], clearOwnCredentials: true,
        });
        expect(res.body.data).toEqual({ updated: [a.id, b.id], skipped: [ftp.body.data.id] });
        const servers = (await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data;
        expect(servers.find((row) => row.id === a.id)).toMatchObject({ identity_id: identity.id, has_password: 0, has_private_key: 0 });
        expect(servers.find((row) => row.id === ftp.body.data.id)).toMatchObject({ identity_id: null, has_password: 1 });

        const audit = await auditOf('identity');
        expect(audit.find((entry) => entry.server_id === a.id && entry.command.startsWith('assign identity'))).toMatchObject({ command: 'assign identity "fleet" (own credentials removed)' });
        expect((await api('POST', '/api/identities/assign', { identityId: 424242, serverIds: [a.id] })).status).toBe(404);
        expect((await api('POST', '/api/identities/assign', { identityId: identity.id, serverIds: [] })).body).toMatchObject({ code: 'INVALID_IDENTITY' });
        // Removing the identity and the own credentials would leave nothing to sign in with.
        const own = await createServer({ username: 'tester', password: 'keep-me' });
        expect(await api('POST', '/api/identities/assign', { identityId: null, serverIds: [own.id], clearOwnCredentials: true })).toMatchObject({ status: 400, body: { code: 'INVALID_IDENTITY' } });
        expect((await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data.find((row) => row.id === own.id)).toMatchObject({ has_password: 1 });
    });
});

describe('connection targets with an identity', () => {
    it('fills what the server leaves empty: a server field wins when it is set', async () => {
        const idKey = generateKeyPair();
        const ownKey = generateKeyPair();
        const identity = await createIdentity({ name: 'precedence', username: 'from-identity', password: 'identity-pw', privateKey: idKey.privateKey });
        const empty = await createServer({ identity_id: identity.id });
        const own = await createServer({ identity_id: identity.id, username: 'own-user', password: 'own-pw', privateKey: ownKey.privateKey, passphrase: 'own-pp' });

        expect(await targets.loadSshTarget(empty.id)).toMatchObject({
            username: 'from-identity', password: 'identity-pw', privateKey: idKey.privateKey, passphrase: undefined, identityId: identity.id,
            agent: undefined, agentForward: false, version: expect.stringMatching(new RegExp(`^${empty.id}@\\d+~${identity.id}@\\d+$`)),
        });
        // Own key with its own passphrase, never the identity's key.
        expect(await targets.loadSshTarget(own.id)).toMatchObject({ username: 'own-user', password: 'own-pw', privateKey: ownKey.privateKey, passphrase: 'own-pp' });

        // Windows: the identity's password is the RDP password too.
        const win = await api<{ data: ServerSummary }>('POST', '/api/servers', { name: 'win-ident', ip: '10.9.0.1', type: 'windows', identity_id: identity.id, domain: 'CORP' });
        expect(await targets.loadConnectionTarget(win.body.data.id, 'rdp')).toMatchObject({ username: 'from-identity', password: 'identity-pw', domain: 'CORP' });
    });

    it('signs in with the identity and reconnects with the new values once it is edited', async () => {
        const identity = await createIdentity({ name: 'rotating-password', username: 'tester', password: 'secret' });
        const srv = await createServer({ identity_id: identity.id });

        const lease = await sshPool.acquire(srv.id);
        expect((await exec(lease, 'echo via identity', { timeoutMs: 5000 })).stdout).toBe('via identity\n');
        lease.release();
        const before = harness.connections();

        // The password changed on the host and in the identity: one edit.
        user.password = 'rotated-pw';
        expect((await api('PUT', `/api/identities/${identity.id}`, { name: 'rotating-password', username: 'tester', password: 'rotated-pw' })).status).toBe(200);
        const again = await sshPool.acquire(srv.id);
        expect(harness.connections()).toBe(before + 1);
        again.release();

        await api('PUT', `/api/identities/${identity.id}`, { name: 'rotating-password', username: 'tester', password: 'wrong' });
        await expect(sshPool.acquire(srv.id)).rejects.toMatchObject({ level: 'client-authentication' });
    });

    it('signs in with the SSH agent, and reports what the agent offers', async () => {
        user.publicKey = agentKey.publicKey;
        const identity = await createIdentity({ name: 'agent', username: 'tester', use_agent: true });
        const srv = await createServer({ identity_id: identity.id });
        expect(await targets.loadSshTarget(srv.id)).toMatchObject({ agent: agent.path, password: undefined, privateKey: undefined });

        const lease = await sshPool.acquire(srv.id);
        expect((await exec(lease, 'echo signed by the agent', { timeoutMs: 5000 })).stdout).toBe('signed by the agent\n');
        lease.release();
        expect(agent.log).toContain('sign:ssh-ed25519');
        expect(harness.log).toContain('auth:publickey');

        const status = await api<{ available: boolean; source: string; keys: Array<{ fingerprint: string }> }>('GET', '/api/identities/agent');
        expect(status.body).toMatchObject({ available: true, source: 'env', keys: [{ fingerprint: expect.stringMatching(/^SHA256:/) }] });
    });
});

describe('install and rotate keys', () => {
    it('installs the public key with the server\'s current credentials and checks that it signs in alone', async () => {
        const identity = await createIdentity({ name: 'install-me', generate_key: true });
        const srv = await createServer({ username: 'tester', password: 'secret' });
        let installed = '';
        onInstallScript = scriptedInstall((publicKey) => { installed = publicKey; user.publicKey = publicKey; });

        const run = await stream(`/api/identities/${identity.id}/install`, { serverIds: [srv.id] });
        expect(run.status).toBe(200);
        expect(installed).toBe(identity.public_key);
        expect(run.events[0]).toEqual({ type: 'start', servers: [{ serverId: srv.id, name: srv.name }], fingerprint: identity.fingerprint });
        expect(run.events.find((event) => event.type === 'result')).toEqual({
            type: 'result',
            result: { serverId: srv.id, name: srv.name, status: 'installed', verified: true, file: '/home/tester/.ssh/authorized_keys' },
        });
        expect(run.events.at(-1)).toEqual({ type: 'done', cancelled: false });

        const entry = (await auditOf('identity')).find((row) => row.server_id === srv.id && row.command.startsWith('install public key'));
        expect(entry).toMatchObject({ exit_code: 0, command: `install public key ssh-ed25519 ${identity.fingerprint} (identity "install-me")`, meta: { status: 'installed', verified: true } });
        expect(JSON.stringify(entry)).not.toMatch(/PRIVATE KEY|secret/);
    });

    it('reports a key the server does not accept, and a script that fails, per server', async () => {
        const identity = await createIdentity({ name: 'install-fails', generate_key: true });
        const ok = await createServer({ username: 'tester', password: 'secret' });
        // The script said "installed" but sshd reads another file: the check fails.
        onInstallScript = scriptedInstall(() => undefined);
        const unverified = await stream(`/api/identities/${identity.id}/install`, { serverIds: [ok.id] });
        expect(unverified.events.find((event) => event.type === 'result')).toMatchObject({ result: { status: 'installed', verified: false, errorCode: 'AUTH_FAILED' } });

        onInstallScript = (_script, channel) => {
            channel.stderr.write('mkdir: cannot create directory: Permission denied\n');
            channel.exit(4);
            channel.end();
        };
        const denied = await stream(`/api/identities/${identity.id}/install`, { serverIds: [ok.id] });
        expect(denied.events.find((event) => event.type === 'result')).toMatchObject({ result: { status: 'failed', errorCode: 'OPS_PERMISSION_DENIED', error: expect.stringMatching(/Permission denied/) } });

        // Validation answers JSON before any stream starts.
        const ftp = await api<{ data: ServerSummary }>('POST', '/api/servers', { name: 'ftp-install', ip: 'ftp.example', type: 'ftp' });
        expect(await stream(`/api/identities/${identity.id}/install`, { serverIds: [ftp.body.data.id] })).toMatchObject({ status: 400, body: { code: 'INVALID_IDENTITY' } });
        const passwordOnly = await createIdentity({ name: 'no-key', password: 'p' });
        expect(await stream(`/api/identities/${passwordOnly.id}/install`, { serverIds: [ok.id] })).toMatchObject({ status: 409, body: { code: 'IDENTITY_NO_KEY' } });
    });

    it('rotates a key only once every server accepts the new one', async () => {
        const identity = await createIdentity({ name: 'rotate', username: 'tester', generate_key: true });
        user.publicKey = identity.public_key as string;
        const srv = await createServer({ identity_id: identity.id });

        // A failing server keeps the current key.
        onInstallScript = (_script, channel) => {
            channel.stderr.write('read-only file system\n');
            channel.exit(1);
            channel.end();
        };
        const refused = await stream(`/api/identities/${identity.id}/rotate`, {});
        expect(refused.events.find((event) => event.type === 'rotated')).toEqual({ type: 'rotated', replaced: false, fingerprint: null });
        const unchanged = (await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data.find((row) => row.id === identity.id);
        expect(unchanged?.fingerprint).toBe(identity.fingerprint);

        onInstallScript = scriptedInstall((publicKey) => { user.publicKey = publicKey; });
        const rotated = await stream(`/api/identities/${identity.id}/rotate`, {});
        const start = rotated.events.find((event) => event.type === 'start');
        expect(rotated.events.find((event) => event.type === 'result')).toMatchObject({ result: { serverId: srv.id, status: 'installed', verified: true } });
        expect(rotated.events.find((event) => event.type === 'rotated')).toEqual({ type: 'rotated', replaced: true, fingerprint: start?.type === 'start' ? start.fingerprint : 'missing' });

        const after = (await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data.find((row) => row.id === identity.id);
        expect(after?.fingerprint).not.toBe(identity.fingerprint);
        // The server now signs in with the new key (the harness only accepts it).
        const lease = await sshPool.acquire(srv.id);
        lease.release();
        expect((await auditOf('identity')).some((row) => row.command === `rotate key of identity "rotate" to ssh-ed25519 ${after?.fingerprint}`)).toBe(true);

        // SEC-6: then the previous key leaves the server's authorized_keys,
        // after "rotated", through a connection that signed in with the new key.
        const types = rotated.events.map((event) => event.type);
        expect(types.indexOf('removed')).toBeGreaterThan(types.indexOf('rotated'));
        expect(rotated.events.find((event) => event.type === 'removed')).toEqual({ type: 'removed', result: { serverId: srv.id, status: 'removed', removed: 1, file: '/home/tester/.ssh/authorized_keys' } });
        expect(removals).toEqual([(identity.public_key as string).split(' ')[1]]);
        expect((await auditOf('identity')).find((row) => row.meta?.action === 'rotate-remove')).toMatchObject({
            server_id: srv.id, exit_code: 0, command: `rotate key: remove previous public key ssh-ed25519 ${identity.fingerprint} (identity "rotate")`,
            meta: { status: 'removed', removed: 1, fingerprint: identity.fingerprint },
        });
    });

    it('keeps the previous key in authorized_keys when told to, or when a rotation is forced', async () => {
        const identity = await createIdentity({ name: 'rotate-keep', username: 'tester', generate_key: true });
        user.publicKey = identity.public_key as string;
        await createServer({ identity_id: identity.id });
        removals.length = 0;
        const kept = await stream(`/api/identities/${identity.id}/rotate`, { removeOld: false });
        expect(kept.events.find((event) => event.type === 'rotated')).toMatchObject({ replaced: true });
        expect(kept.events.some((event) => event.type === 'removed')).toBe(false);
        expect(removals).toEqual([]);
        expect(await stream(`/api/identities/${identity.id}/rotate`, { removeOld: 'yes' })).toMatchObject({ status: 400, body: { code: 'INVALID_IDENTITY' } });

        // Forced past a server that did not take the new key: that server
        // still signs in with the previous one only.
        onInstallScript = (_script, channel) => {
            channel.stderr.write('read-only file system\n');
            channel.exit(1);
            channel.end();
        };
        const forced = await stream(`/api/identities/${identity.id}/rotate`, { force: true });
        expect(forced.events.find((event) => event.type === 'rotated')).toMatchObject({ replaced: true });
        expect(forced.events.some((event) => event.type === 'removed')).toBe(false);
    });
});

describe('export and import', () => {
    it('carries identity names and their non-secret fields, never a secret', async () => {
        const identity = await createIdentity({ name: 'portable', username: 'portable-user', password: 'portable-pw-9', generate_key: true, use_agent: true });
        const srv = await createServer({ name: 'exported-with-identity', identity_id: identity.id });
        const bundle = (await api<Record<string, unknown> & { servers: Array<Record<string, unknown>>; identities: unknown[] }>('GET', '/api/export')).body;
        expect(bundle.identities).toContainEqual({ name: 'portable', username: 'portable-user', private_key_path: null, use_agent: true });
        expect(bundle.servers.find((row) => row.name === srv.name)).toMatchObject({ identity: 'portable' });
        const text = JSON.stringify(bundle);
        expect(text).not.toContain('portable-pw-9');
        expect(text).not.toMatch(/PRIVATE KEY|enc:v1:/);
        expect(text).not.toContain(identity.public_key as string);

        // Into another install: the identity is created without secrets and linked.
        const file = {
            ...bundle,
            identities: [{ name: 'imported-identity', username: 'imp', private_key_path: '~/.ssh/id_imported', use_agent: false, password: 'smuggled' }, { name: 'PORTABLE' }],
            servers: [
                { ref: 1, name: 'imported-a', ip: '10.20.0.1', type: 'linux', identity: 'imported-identity', agent_forward: true },
                { ref: 3, name: 'imported-c', ip: '10.20.0.3', type: 'linux', identity: 'unknown-one' },
            ],
            snippets: [],
            tunnels: [],
        };
        const imported = await api<{ identities: { created: Array<{ name: string }>; skipped: Array<{ name: string; reason: string }> }; credentials?: unknown }>('POST', '/api/import', file);
        expect(imported.status).toBe(200);
        expect(imported.body.identities).toMatchObject({ created: [{ name: 'imported-identity' }], skipped: [{ name: 'PORTABLE', reason: 'duplicate' }] });
        // Nothing of this computer's was asked for (forwarding needs an agent identity).
        expect(imported.body.credentials).toBeUndefined();
        const identities = (await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data;
        const created = identities.find((row) => row.name === 'imported-identity');
        expect(created).toMatchObject({ username: 'imp', private_key_path: '~/.ssh/id_imported', has_password: 0 });
        const servers = (await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data;
        expect(servers.find((row) => row.name === 'imported-a')).toMatchObject({ identity_id: created?.id, agent_forward: 0 });
        expect(servers.find((row) => row.name === 'imported-c')?.identity_id).toBeNull();
        const importedA = servers.find((row) => row.name === 'imported-a');
        expect((await auditOf('identity')).find((entry) => entry.server_id === importedA?.id)).toMatchObject({
            command: 'import: sign in with new identity "imported-identity"', meta: { action: 'import', saved: false, agentForward: false },
        });
    });

    it('gives an imported host the credentials of an identity saved here only with consent', async () => {
        const saved = await createIdentity({ name: 'prod-saved', username: 'root', password: 'Pr0d-S3cret!', use_agent: true });
        // A shared file that names the saved identity for a host it chooses.
        const file = (name: string) => ({
            format: 'shellmind-config', version: 1,
            servers: [{ ref: 1, name, ip: '127.0.0.1', port: 2299, type: 'linux', username: 'root', identity: 'prod-saved', agent_forward: true }],
            identities: [{ name: 'prod-saved', username: 'root', private_key_path: null, use_agent: false }],
            snippets: [], tunnels: [],
        });
        const review = { name: 'shared-build-box', host: '127.0.0.1:2299', identity: 'prod-saved', saved: true, uses: ['password', 'agent'], agent_forward: true };

        const preview = await api<{ review: { credentials?: unknown[] }; servers: { created: unknown[] } }>('POST', '/api/import/preview', file('shared-build-box'));
        expect(preview.body.review.credentials).toEqual([review]);
        expect(preview.body.servers.created).toEqual([{ name: 'shared-build-box' }]);

        // A consent field inside the file is not consent.
        const refused = await api<{ credentials: unknown }>('POST', '/api/import', { ...file('shared-build-box'), link_credentials: true });
        expect(refused.body.credentials).toEqual({ linked: false, servers: [review] });
        const withheld = (await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data.find((row) => row.name === 'shared-build-box');
        expect(withheld).toMatchObject({ identity_id: null, agent_forward: 0, has_password: 0 });
        const target = await targets.loadSshTarget(withheld?.id);
        expect(target).toMatchObject({ identityId: null, password: undefined, agent: undefined, agentForward: false });
        expect((await auditOf('identity')).some((entry) => entry.server_id === withheld?.id)).toBe(false);

        const consented = await api<{ credentials: unknown }>('POST', '/api/import?link_credentials=1', file('consented-box'));
        expect(consented.body.credentials).toEqual({ linked: true, servers: [{ ...review, name: 'consented-box' }] });
        const linked = (await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data.find((row) => row.name === 'consented-box');
        expect(linked).toMatchObject({ identity_id: saved.id, agent_forward: 1 });
        expect((await auditOf('identity')).find((entry) => entry.server_id === linked?.id)).toMatchObject({
            command: 'import: sign in with saved identity "prod-saved" (SSH agent forwarded)', meta: { action: 'import', identityId: saved.id, saved: true, agentForward: true },
        });
    });
});

describe('importing ~/.ssh/config', () => {
    type ApplyResult = { created: Array<{ name: string; id: number }>; skipped: Array<{ name: string; reason: string }>; identities?: { created: Array<{ name: string; id: number }>; skipped: Array<{ name: string; id: number; reason: string }> } };

    it('gives hosts that share a key file or the agent one identity, and reuses only a saved one that holds nothing else', async () => {
        const text = [
            'Host cfg-a', '  HostName 10.40.0.1', '  User deploy', '  IdentityFile ~/.ssh/cfg_shared',
            'Host cfg-b', '  HostName 10.40.0.2', '  User deploy', '  IdentityFile ~/.ssh/cfg_shared',
            'Host cfg-agent', '  HostName 10.40.0.3', '  User ops', '  IdentityAgent SSH_AUTH_SOCK',
            'Host cfg-plain', '  HostName 10.40.0.4', '  User ops', '  IdentityAgent none',
        ].join('\n');
        const preview = await api<{ entries: Array<Record<string, unknown>> }>('POST', '/api/import/ssh-config/preview', { text });
        expect(preview.body.entries.map((entry) => [entry.alias, entry.identityFile, entry.identityAgent])).toEqual([
            ['cfg-a', '~/.ssh/cfg_shared', false], ['cfg-b', '~/.ssh/cfg_shared', false], ['cfg-agent', null, true], ['cfg-plain', null, false],
        ]);
        // A saved identity with the same key file but also a password is never reused.
        const withPassword = await createIdentity({ name: 'cfg-with-password', password: 'never-for-imports', private_key_path: '~/.ssh/cfg_shared' });

        const applied = await api<ApplyResult>('POST', '/api/import/ssh-config/apply', { entries: preview.body.entries });
        expect(applied.body.created.map((outcome) => outcome.name)).toEqual(['cfg-a', 'cfg-b', 'cfg-agent', 'cfg-plain']);
        expect(applied.body.identities?.created.map((outcome) => outcome.name)).toEqual(['cfg_shared', 'ssh-agent']);
        const [shared, agentIdentity] = applied.body.identities?.created ?? [];
        const identities = (await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data;
        expect(identities.find((row) => row.id === shared.id)).toMatchObject({ private_key_path: '~/.ssh/cfg_shared', use_agent: 0, has_password: 0, username: null, server_count: 2 });
        expect(identities.find((row) => row.id === agentIdentity.id)).toMatchObject({ private_key_path: null, use_agent: 1, server_count: 1 });

        const servers = (await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data;
        const byName = (name: string) => servers.find((row) => row.name === name);
        expect(byName('cfg-a')).toMatchObject({ identity_id: shared.id, private_key_path: null });
        expect(byName('cfg-b')).toMatchObject({ identity_id: shared.id });
        expect(byName('cfg-agent')).toMatchObject({ identity_id: agentIdentity.id });
        expect(byName('cfg-plain')).toMatchObject({ identity_id: null });
        expect([byName('cfg-a'), byName('cfg-b')].map((row) => row?.identity_id)).not.toContain(withPassword.id);
        expect((await auditOf('identity')).find((entry) => entry.server_id === byName('cfg-a')?.id)).toMatchObject({ command: 'import: sign in with new identity "cfg_shared"' });

        // Another file with the same key file: the identity is reused, not duplicated.
        const again = await api<ApplyResult>('POST', '/api/import/ssh-config/apply', { entries: [{ alias: 'cfg-c', host: '10.40.0.5', user: 'deploy', identityFile: '~/.ssh/cfg_shared' }] });
        expect(again.body.identities).toEqual({ created: [], skipped: [{ name: 'cfg_shared', id: shared.id, reason: 'duplicate' }] });

        // A host that is refused does not leave an identity behind.
        const refused = await api<ApplyResult>('POST', '/api/import/ssh-config/apply', { entries: [{ alias: 'cfg-bad', host: '10.40.0.6', user: 'u', port: 70000, identityFile: '~/.ssh/cfg_orphan' }] });
        expect(refused.body.skipped).toMatchObject([{ name: 'cfg-bad', reason: 'invalid' }]);
        expect(refused.body.identities).toBeUndefined();
        expect((await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data.some((row) => row.private_key_path === '~/.ssh/cfg_orphan')).toBe(false);
    });
});

describe('secrets at rest', () => {
    it('encrypts identity secrets left in plaintext at startup', async () => {
        const { encryptPlaintextSecrets } = await import('../../server/db/init');
        await new Promise<void>((resolve, reject) => server.db.run(
            "INSERT INTO identities (name, password, created_at, updated_at) VALUES ('plaintext', 'plain-pw-55', 1, 1)",
            (err) => (err ? reject(err) : resolve())
        ));
        expect(await encryptPlaintextSecrets()).toMatchObject({ encrypted: 1 });
        expect((await rawRow("SELECT password FROM identities WHERE name = 'plaintext'"))?.password).toMatch(/^enc:v1:/);
    });
});
