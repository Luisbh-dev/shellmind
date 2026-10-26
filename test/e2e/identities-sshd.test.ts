import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { utils } from 'ssh2';
import { sshFingerprint } from '../../server/ssh/hostKeys';
import type { IdentitySummary, InstallEvent, InstallResult } from '../../shared/identities';
import type { ServerSummary } from '../../shared/types';
import { startFakeAgent, type FakeAgent } from '../helpers/fakeAgent';
import { generateKeyPair } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7-S2 identities against a real OpenSSH server in Docker (opt-in:
// SHELLMIND_E2E=1): the install script for real (authorized_keys, modes,
// StrictModes), signing in with the installed key alone, rotation, and the SSH
// agent with forwarding into a terminal (ssh-add -l on the remote host lists
// the local agent's key).

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-identities-sshd';
const CONTAINER = `shellmind-test-identities-${process.pid}`;
const CONTEXT = fileURLToPath(new URL('../fixtures/identities/e2e', import.meta.url));

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

let server: TestServer;
let agent: FakeAgent;
let port: number;
const agentKey = generateKeyPair();
const sockets: Socket[] = [];

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function sshBanner(target: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(target, '127.0.0.1');
        socket.once('data', (data) => {
            socket.destroy();
            resolve(data.toString().startsWith('SSH-'));
        });
        socket.once('error', () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json().catch(() => null)) as T };
}

async function stream(path: string, body: unknown): Promise<InstallEvent[]> {
    const res = await server.fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect(res.headers.get('content-type')).toContain('event-stream');
    const text = await res.text();
    return text.split('\n\n').filter((block) => block.startsWith('data: ')).map((block) => JSON.parse(block.slice(6)) as InstallEvent);
}

const resultsOf = (events: InstallEvent[]): InstallResult[] =>
    events.flatMap((event) => (event.type === 'result' ? [event.result] : []));

async function saveServer(body: Record<string, unknown>): Promise<ServerSummary> {
    const res = await api<{ data: ServerSummary }>('POST', '/api/servers', { name: `e2e-${Math.random().toString(36).slice(2, 7)}`, ip: '127.0.0.1', port, type: 'linux', ...body });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body.data;
}

async function status(serverId: number): Promise<number> {
    return (await server.fetch(`/api/servers/${serverId}/status`)).status;
}

// Opens a terminal on the server and returns what `command` printed.
async function terminalOutput(serverId: number, command: string, until: RegExp): Promise<string> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    let output = '';
    socket.on('ssh-output', (chunk: string) => { output += chunk; });
    await new Promise<void>((resolve, reject) => {
        socket.once('connect_error', reject);
        socket.once('ssh-error', (message: string) => reject(new Error(message)));
        socket.once('connection-ready', () => resolve());
        socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: 120, rows: 30 });
    });
    socket.emit('ssh-input', `${command}\n`);
    await waitFor(() => until.test(output), 15_000);
    socket.disconnect();
    return output;
}

describe.skipIf(!ENABLED)('identities against a real sshd (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        docker('run', '-d', '--name', CONTAINER, '-p', '127.0.0.1::22', IMAGE);
        port = Number(docker('port', CONTAINER, '22').split('\n')[0].split(':').pop());
        await waitFor(() => sshBanner(port), 30_000);
        agent = await startFakeAgent([agentKey.privateKey]);
        server = await bootTestServer({ env: { SHELLMIND_SSH_AGENT: agent.path } });
    });

    afterAll(async () => {
        while (sockets.length) sockets.pop()?.disconnect();
        await server?.close();
        await agent?.close();
        try {
            docker('rm', '-f', CONTAINER);
        } catch {
            // Already gone.
        }
    });

    it('installs a generated key, then the server signs in with it alone', async () => {
        const identity = (await api<{ data: IdentitySummary }>('POST', '/api/identities', { name: 'e2e-deploy', username: 'alice', generate_key: true })).body.data;
        const srv = await saveServer({ username: 'alice', password: 'alicepw' });

        const first = resultsOf(await stream(`/api/identities/${identity.id}/install`, { serverIds: [srv.id] }));
        expect(first).toEqual([{ serverId: srv.id, name: srv.name, status: 'installed', verified: true, file: '/home/alice/.ssh/authorized_keys' }]);
        expect(docker('exec', CONTAINER, 'cat', '/home/alice/.ssh/authorized_keys')).toBe(identity.public_key);
        expect(docker('exec', CONTAINER, 'stat', '-c', '%a %U', '/home/alice/.ssh', '/home/alice/.ssh/authorized_keys').split('\n')).toEqual(['700 alice', '600 alice']);
        // Idempotent.
        expect(resultsOf(await stream(`/api/identities/${identity.id}/install`, { serverIds: [srv.id] }))[0]).toMatchObject({ status: 'present', verified: true });
        expect(docker('exec', CONTAINER, 'grep', '-c', 'ssh-ed25519', '/home/alice/.ssh/authorized_keys')).toBe('1');

        // An administrator commented the key out: installing adds it again (BusyBox awk too).
        docker('exec', CONTAINER, 'sh', '-c', "sed -i 's/^/# /' /home/alice/.ssh/authorized_keys && chown alice /home/alice/.ssh/authorized_keys");
        expect(resultsOf(await stream(`/api/identities/${identity.id}/install`, { serverIds: [srv.id] }))[0]).toMatchObject({ status: 'installed', verified: true });
        expect(docker('exec', CONTAINER, 'cat', '/home/alice/.ssh/authorized_keys').split('\n')).toEqual([`# ${identity.public_key}`, identity.public_key]);

        // Moved onto the identity: no password left on the server.
        expect((await api('POST', '/api/identities/assign', { identityId: identity.id, serverIds: [srv.id], clearOwnCredentials: true })).status).toBe(200);
        expect((await api<{ data: ServerSummary[] }>('GET', '/api/servers')).body.data.find((row) => row.id === srv.id)).toMatchObject({ has_password: 0, identity_id: identity.id });
        expect(await status(srv.id)).toBe(200);

        // Rotation: installed with the current key, checked, then switched;
        // the previous key's line then goes (SEC-6), its commented-out copy stays.
        const rotation = await stream(`/api/identities/${identity.id}/rotate`, {});
        expect(rotation.find((event) => event.type === 'rotated')).toMatchObject({ replaced: true });
        expect(rotation.filter((event) => event.type === 'removed')).toMatchObject([
            { type: 'removed', result: { serverId: srv.id, status: 'removed', removed: 1, file: '/home/alice/.ssh/authorized_keys' } },
        ]);
        const rotated = (await api<{ data: IdentitySummary[] }>('GET', '/api/identities')).body.data.find((row) => row.id === identity.id)!;
        expect(rotated.public_key).not.toBe(identity.public_key);
        expect(docker('exec', CONTAINER, 'cat', '/home/alice/.ssh/authorized_keys').split('\n')).toEqual([`# ${identity.public_key}`, rotated.public_key]);
        expect(await status(srv.id)).toBe(200);
    });

    it('reports StrictModes trouble when the home directory is writable by others', async () => {
        docker('exec', CONTAINER, 'chmod', '777', '/home/bob');
        try {
            const identity = (await api<{ data: IdentitySummary }>('POST', '/api/identities', { name: 'e2e-bob', generate_key: true })).body.data;
            const srv = await saveServer({ username: 'bob', password: 'bobpw' });
            const [result] = resultsOf(await stream(`/api/identities/${identity.id}/install`, { serverIds: [srv.id] }));
            expect(result).toMatchObject({ status: 'installed', verified: false, warnings: ['home-writable'] });
        } finally {
            docker('exec', CONTAINER, 'chmod', '755', '/home/bob');
        }
    });

    it('signs in with the SSH agent and forwards it only to terminals of servers that turn it on', async () => {
        docker('exec', CONTAINER, 'sh', '-c', `mkdir -p /home/bob/.ssh && echo '${agentKey.publicKey}' >> /home/bob/.ssh/authorized_keys && chown -R bob /home/bob/.ssh && chmod 700 /home/bob/.ssh && chmod 600 /home/bob/.ssh/authorized_keys`);
        const identity = (await api<{ data: IdentitySummary }>('POST', '/api/identities', { name: 'e2e-agent', username: 'bob', use_agent: true })).body.data;
        const forwarding = await saveServer({ identity_id: identity.id, agent_forward: true });
        const plain = await saveServer({ identity_id: identity.id });

        expect(await status(plain.id)).toBe(200);
        const parsed = utils.parseKey(agentKey.publicKey);
        if (parsed instanceof Error) throw parsed;
        const fingerprint = sshFingerprint((Array.isArray(parsed) ? parsed[0] : parsed).getPublicSSH());
        const listed = await terminalOutput(forwarding.id, 'ssh-add -l', /\(ED25519\)|agent/i);
        expect(listed).toContain(`256 ${fingerprint}`);
        const none = await terminalOutput(plain.id, 'ssh-add -l; echo exit=$?', /exit=\d/);
        expect(none).toMatch(/Could not open a connection to your authentication agent|Error connecting to agent|exit=2/);
        expect(agent.log.filter((entry) => entry === 'identities').length).toBeGreaterThan(0);
    });
});
