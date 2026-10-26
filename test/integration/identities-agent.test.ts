import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { openTempDatabase } from '../helpers/tempDatabase';

// W7-S2: identities that sign in with the SSH agent when there is none
// (SHELLMIND_SSH_AGENT=off here), or when the agent cannot be used.

vi.setConfig({ testTimeout: 20_000 });

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let harness: SshHarness;
let targets: typeof import('../../server/connections/target');
let identities: typeof import('../../server/db/identitiesRepo')['identitiesRepo'];
let servers: typeof import('../../server/db/serversRepo')['serversRepo'];
let SshPool: typeof import('../../server/ssh/pool')['SshPool'];

const missingAgent = process.platform === 'win32' ? '\\\\.\\pipe\\shellmind-test-agent-gone' : '/nonexistent/shellmind-agent.sock';

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    process.env.SHELLMIND_SSH_AGENT = 'off';
    database = await openTempDatabase();
    targets = await import('../../server/connections/target');
    identities = (await import('../../server/db/identitiesRepo')).identitiesRepo;
    servers = (await import('../../server/db/serversRepo')).serversRepo;
    SshPool = (await import('../../server/ssh/pool')).SshPool;
    harness = await startSshServer();
});

afterAll(async () => {
    delete process.env.SHELLMIND_SSH_AGENT;
    await harness?.close();
    await database?.close();
    vi.restoreAllMocks();
});

describe('identities using the SSH agent', () => {
    it('says there is no agent when nothing else can sign in, and falls back otherwise', async () => {
        const agentOnly = await identities.create({ name: 'agent only', use_agent: true });
        const withPassword = await identities.create({ name: 'agent or password', use_agent: true, password: 'pw' });
        const a = await servers.create({ name: 'needs-agent', ip: '10.0.0.1', type: 'linux', identity_id: agentOnly });
        const b = await servers.create({ name: 'has-fallback', ip: '10.0.0.2', type: 'linux', identity_id: withPassword, agent_forward: true });

        await expect(targets.loadSshTarget(a)).rejects.toMatchObject({
            code: 'AGENT_UNAVAILABLE',
            message: expect.stringMatching(/"needs-agent" signs in with the SSH agent \(identity "agent only"\).*SHELLMIND_SSH_AGENT is set to off/),
        });
        // No agent: no forwarding either.
        expect(await targets.loadSshTarget(b)).toMatchObject({ agent: undefined, agentForward: false, password: 'pw' });
    });

    it('goes on with the next method when the agent does not answer, and blames it when nothing signed in', async () => {
        const base = await targets.loadSshTarget(await servers.create({ name: 'harness', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' }));
        const pool = (password: string | undefined) => new SshPool({ loadTarget: async () => ({ ...base, agent: missingAgent, password, version: `${password}` }) });

        const fallback = pool('secret');
        const lease = await fallback.acquire(base.serverId);
        lease.release();
        fallback.closeAll();

        const agentOnly = pool(undefined);
        await expect(agentOnly.acquire(base.serverId)).rejects.toMatchObject({
            code: 'AGENT_FAILED',
            message: expect.stringMatching(/^Auth failed: the SSH agent could not be used \(.+\)\./),
            details: { reason: expect.any(String) },
        });
        agentOnly.closeAll();
    });
});
