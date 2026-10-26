import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateKeyPair } from '../../test/helpers/sshServer';
import { startFakeAgent, type FakeAgent } from '../../test/helpers/fakeAgent';
import { agentStatus, locateAgent, PAGEANT, WINDOWS_AGENT_PIPE, type AgentEnvironment } from './agent';

const env = (patch: Partial<AgentEnvironment>): AgentEnvironment => ({
    override: '',
    authSock: '',
    host: '127.0.0.1',
    platform: 'linux',
    pipeExists: () => false,
    ...patch,
});

describe('locateAgent', () => {
    it('prefers SHELLMIND_SSH_AGENT, then SSH_AUTH_SOCK', () => {
        expect(locateAgent(env({ override: '/run/agent.sock', authSock: '/tmp/ssh-x/agent.1' }))).toEqual({ path: '/run/agent.sock', source: 'env' });
        expect(locateAgent(env({ authSock: '/tmp/ssh-x/agent.1' }))).toEqual({ path: '/tmp/ssh-x/agent.1', source: 'ssh-auth-sock' });
        expect(locateAgent(env({}))).toEqual({ path: null, reason: 'not-found' });
    });

    it('can be turned off, and names Pageant only on Windows', () => {
        for (const off of ['off', 'none', 'false', '0', 'OFF']) {
            expect(locateAgent(env({ override: off, authSock: '/tmp/a' }))).toEqual({ path: null, reason: 'disabled' });
        }
        expect(locateAgent(env({ override: 'pageant', platform: 'win32' }))).toEqual({ path: PAGEANT, source: 'env' });
        expect(locateAgent(env({ override: 'Pageant', platform: 'linux' }))).toEqual({ path: null, reason: 'not-found' });
    });

    it('uses the Windows OpenSSH agent pipe when it exists, else Pageant', () => {
        expect(locateAgent(env({ platform: 'win32', pipeExists: (pipe) => pipe === WINDOWS_AGENT_PIPE }))).toEqual({ path: WINDOWS_AGENT_PIPE, source: 'windows-openssh' });
        expect(locateAgent(env({ platform: 'win32' }))).toEqual({ path: PAGEANT, source: 'pageant' });
        // SSH_AUTH_SOCK (e.g. 1Password's agent) wins there too.
        expect(locateAgent(env({ platform: 'win32', authSock: '\\\\.\\pipe\\1password' }))).toMatchObject({ source: 'ssh-auth-sock' });
    });

    it('ignores the local agent when the backend serves other machines, unless it is named', () => {
        for (const host of ['0.0.0.0', '192.168.1.20', '::']) {
            expect(locateAgent(env({ host, authSock: '/tmp/a', platform: 'win32', pipeExists: () => true }))).toEqual({ path: null, reason: 'remote-backend' });
        }
        expect(locateAgent(env({ host: '0.0.0.0', override: '/srv/agent.sock' }))).toEqual({ path: '/srv/agent.sock', source: 'env' });
        expect(locateAgent(env({ host: 'localhost', authSock: '/tmp/a' }))).toMatchObject({ source: 'ssh-auth-sock' });
    });
});

describe('agentStatus', () => {
    let agent: FakeAgent;
    const key = generateKeyPair();

    beforeAll(async () => {
        agent = await startFakeAgent([key.privateKey]);
    });

    afterAll(async () => {
        await agent?.close();
    });

    it('lists the keys of an agent that answers', async () => {
        const status = await agentStatus(env({ override: agent.path, platform: process.platform }));
        expect(status).toEqual({
            available: true,
            source: 'env',
            keys: [{ type: 'ssh-ed25519', fingerprint: expect.stringMatching(/^SHA256:/), comment: expect.any(String) }],
        });
        expect(agent.log).toContain('identities');
    });

    // ssh2's helper runs through execFile (it must work from app.asar too) and
    // its exit code becomes the reason; this machine runs no Pageant.
    it.skipIf(process.platform !== 'win32')('asks Pageant through its helper and reports when it is not running', async () => {
        expect(await agentStatus(env({ override: 'pageant', platform: 'win32' }))).toEqual({ available: false, source: 'env', error: 'Pageant is not running', errorCode: 'not-running' });
    });

    it('says why there is no agent, or why it does not answer', async () => {
        expect(await agentStatus(env({ override: 'off' }))).toEqual({ available: false, source: null, reason: 'disabled' });
        const missing = process.platform === 'win32' ? '\\\\.\\pipe\\shellmind-test-no-agent' : '/nonexistent/shellmind/agent.sock';
        expect(await agentStatus(env({ override: missing, platform: process.platform }))).toEqual({ available: false, source: 'env', error: 'Failed to connect to agent', errorCode: 'unreachable' });
    });
});
