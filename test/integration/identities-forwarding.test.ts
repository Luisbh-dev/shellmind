import net from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Server, type ClientChannel, type Connection } from 'ssh2';
import { startFakeAgent, type FakeAgent } from '../helpers/fakeAgent';
import { generateKeyPair } from '../helpers/sshServer';
import { openTempDatabase } from '../helpers/tempDatabase';

// W7-S2: SSH agent forwarding is requested on interactive terminal shells of
// servers that turn it on, never on command channels, and a server refusing
// it still gets its terminal (ssh2 alone would fail the whole channel).

vi.setConfig({ testTimeout: 20_000 });

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let agent: FakeAgent;
let listener: net.Server;
let port: number;
let SshPool: typeof import('../../server/ssh/pool')['SshPool'];
let requestShellChannel: typeof import('../../server/ssh/agent')['requestShellChannel'];
let exec: typeof import('../../server/ssh/exec')['exec'];
let base: import('../../server/connections/target').SshTarget;

// What the server saw, and whether it allows forwarding.
let forwardRequests: string[];
let allowForwarding: boolean;

function startServer(): Promise<void> {
    const ssh = new Server({ hostKeys: [generateKeyPair().privateKey] }, (client: Connection) => {
        client.on('error', () => undefined);
        client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
        client.on('ready', () => {
            client.on('session', (accept) => {
                const session = accept();
                let kind = 'session';
                session.on('pty', (acceptPty) => acceptPty?.());
                session.on('auth-agent', (acceptForward, rejectForward) => {
                    forwardRequests.push(kind);
                    if (allowForwarding) acceptForward?.();
                    else rejectForward?.();
                });
                session.on('shell', (acceptShell) => {
                    kind = 'shell';
                    const channel = acceptShell();
                    channel.write('shell ready\r\n');
                });
                session.on('exec', (acceptExec, _reject, info) => {
                    const channel = acceptExec();
                    channel.write(`${info.command}\n`);
                    channel.exit(0);
                    channel.end();
                });
            });
        });
    });
    listener = net.createServer((socket) => ssh.injectSocket(socket));
    return new Promise((resolve) => listener.listen(0, '127.0.0.1', () => {
        port = (listener.address() as net.AddressInfo).port;
        resolve();
    }));
}

function openShell(pool: InstanceType<typeof SshPool>, agentForward: boolean): Promise<{ stream: ClientChannel; release: () => void }> {
    return pool.acquire(base.serverId).then((lease) => new Promise((resolve, reject) => {
        requestShellChannel(lease.client, { rows: 24, cols: 80, term: 'xterm-256color' }, { serverId: lease.serverId, agentForward }, (err, stream) => {
            if (err || !stream) reject(err ?? new Error('no stream'));
            else resolve({ stream, release: () => { stream.close(); lease.release(); } });
        });
    }));
}

const firstOutput = (stream: ClientChannel) => new Promise<string>((resolve) => stream.once('data', (data: Buffer) => resolve(data.toString())));

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = await openTempDatabase();
    SshPool = (await import('../../server/ssh/pool')).SshPool;
    requestShellChannel = (await import('../../server/ssh/agent')).requestShellChannel;
    exec = (await import('../../server/ssh/exec')).exec;
    const { serversRepo } = await import('../../server/db/serversRepo');
    const { loadSshTarget } = await import('../../server/connections/target');
    agent = await startFakeAgent([generateKeyPair().privateKey]);
    await startServer();
    base = await loadSshTarget(await serversRepo.create({ name: 'forwarding', ip: '127.0.0.1', port, type: 'linux', username: 'tester', password: 'secret' }));
});

beforeEach(() => {
    forwardRequests = [];
    allowForwarding = true;
});

afterAll(async () => {
    await agent?.close();
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    await database?.close();
    vi.restoreAllMocks();
});

describe('agent forwarding', () => {
    it('is requested by terminal shells of servers that turn it on, not by commands', async () => {
        const pool = new SshPool({ loadTarget: async () => ({ ...base, agent: agent.path, agentForward: true }) });
        const lease = await pool.acquire(base.serverId);
        expect((await exec(lease, 'uptime', { timeoutMs: 5000 })).stdout).toBe('uptime\n');
        lease.release();
        expect(forwardRequests).toEqual([]);

        const shell = await openShell(pool, true);
        expect(await firstOutput(shell.stream)).toContain('shell ready');
        expect(forwardRequests).toEqual(['session']);
        shell.release();
        pool.closeAll();
    });

    it('is not requested when the server leaves it off', async () => {
        const pool = new SshPool({ loadTarget: async () => ({ ...base, agent: agent.path, agentForward: false }) });
        const shell = await openShell(pool, false);
        expect(await firstOutput(shell.stream)).toContain('shell ready');
        expect(forwardRequests).toEqual([]);
        shell.release();
        pool.closeAll();
    });

    it('still opens the terminal when the server refuses forwarding', async () => {
        allowForwarding = false;
        const pool = new SshPool({ loadTarget: async () => ({ ...base, agent: agent.path, agentForward: true }) });
        const shell = await openShell(pool, true);
        expect(await firstOutput(shell.stream)).toContain('shell ready');
        expect(forwardRequests).toEqual(['session']);
        shell.release();
        pool.closeAll();
    });
});
