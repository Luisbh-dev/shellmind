import fs from 'node:fs';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ServerChannel } from 'ssh2';
import { channelOpen, generateKeyPair, HARNESS_OS, startSshServer, type SshHarness, type SshHarnessOptions } from '../helpers/sshServer';
import { openTempDatabase } from '../helpers/tempDatabase';

// The SSH pool and exec helpers against the in-process ssh2 test server.

// SSH handshakes are CPU-bound and slow down when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

type PoolModule = typeof import('../../server/ssh/pool');
type ExecModule = typeof import('../../server/ssh/exec');
type ServersRepo = typeof import('../../server/db/serversRepo')['serversRepo'];
type KnownHostsRepo = typeof import('../../server/db/knownHostsRepo')['knownHostsRepo'];
type HostKeyMismatchErrorClass = typeof import('../../server/ssh/hostKeys')['HostKeyMismatchError'];

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let poolModule: PoolModule;
let execModule: ExecModule;
let servers: ServersRepo;
let knownHosts: KnownHostsRepo;
let HostKeyMismatchError: HostKeyMismatchErrorClass;
let dbRun: typeof import('../../server/db/sqlite')['dbRun'];

const harnesses: SshHarness[] = [];
const pools: InstanceType<PoolModule['SshPool']>[] = [];

async function harness(options?: SshHarnessOptions): Promise<SshHarness> {
    const server = await startSshServer(options);
    harnesses.push(server);
    return server;
}

function pool(options: ConstructorParameters<PoolModule['SshPool']>[0] = {}) {
    const instance = new poolModule.SshPool({ idleTimeoutMs: 200, ...options });
    pools.push(instance);
    return instance;
}

async function saveServer(target: SshHarness, extra: Record<string, unknown> = {}): Promise<number> {
    return servers.create({ name: `h${target.port}`, ip: target.host, port: target.port, type: 'linux', username: 'tester', password: 'secret', ...extra });
}

async function waitFor(check: () => boolean, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = await openTempDatabase();
    poolModule = await import('../../server/ssh/pool');
    execModule = await import('../../server/ssh/exec');
    servers = (await import('../../server/db/serversRepo')).serversRepo;
    knownHosts = (await import('../../server/db/knownHostsRepo')).knownHostsRepo;
    HostKeyMismatchError = (await import('../../server/ssh/hostKeys')).HostKeyMismatchError;
    dbRun = (await import('../../server/db/sqlite')).dbRun;
});

afterEach(async () => {
    while (pools.length) pools.pop()!.closeAll();
    while (harnesses.length) await harnesses.pop()!.close();
    // A later harness may get a closed one's port, with a different host key.
    await dbRun('DELETE FROM known_hosts');
});

afterAll(async () => {
    await database?.close();
    vi.restoreAllMocks();
});

describe('SshPool', () => {
    it('uses keepalive, handshake and idle defaults that detect dead links', () => {
        expect(new poolModule.SshPool().options).toEqual({
            idleTimeoutMs: 60_000,
            keepaliveInterval: 15_000,
            keepaliveCountMax: 4,
            readyTimeout: 20_000,
        });
    });

    it('shares one ref-counted connection and closes it after the idle timeout', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool();

        const [first, second] = await Promise.all([sshPool.acquire(id), sshPool.acquire(id)]);
        expect(first.client).toBe(second.client);
        expect(server.connections()).toBe(1);
        expect(sshPool.inspect(id)).toEqual({ connections: 1, refs: 2 });

        first.release();
        first.release(); // idempotent
        expect(sshPool.inspect(id)).toEqual({ connections: 1, refs: 1 });
        second.release();
        expect(sshPool.inspect(id)).toEqual({ connections: 1, refs: 0 });

        // Leased again before the idle timeout: same connection.
        const third = await sshPool.acquire(id);
        expect(third.client).toBe(first.client);
        expect(server.connections()).toBe(1);
        third.release();

        await waitFor(() => sshPool.inspect(id).connections === 0);
        await waitFor(() => server.openConnections() === 0);

        const fourth = await sshPool.acquire(id);
        expect(server.connections()).toBe(2);
        fourth.release();
    });

    it('opens a new connection after the server row changes and retires the old one', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool();

        const old = await sshPool.acquire(id);
        const closed = vi.fn();
        old.onClose(closed);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await servers.update(id, { name: 'renamed', ip: server.host, port: server.port, type: 'linux', username: 'tester' });

        const fresh = await sshPool.acquire(id);
        expect(fresh.client).not.toBe(old.client);
        expect(server.connections()).toBe(2);
        expect(sshPool.inspect(id)).toEqual({ connections: 2, refs: 2 });

        // The replaced connection stays up for its holder, then closes on release.
        expect(closed).not.toHaveBeenCalled();
        old.release();
        await waitFor(() => sshPool.inspect(id).connections === 1);
        fresh.release();
    });

    it('notifies holders and evicts the connection when it drops', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool();

        const lease = await sshPool.acquire(id);
        const closed = new Promise<Error | undefined>((resolve) => lease.onClose(resolve));
        sshPool.invalidate(id, { close: true });
        await closed;
        expect(sshPool.inspect(id).connections).toBe(0);
        lease.release();

        const next = await sshPool.acquire(id);
        expect(next.client).not.toBe(lease.client);
        next.release();
    });

    it('detects a dead link through keepalives', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool({ keepaliveInterval: 100, keepaliveCountMax: 2 });

        const lease = await sshPool.acquire(id);
        const closed = new Promise<Error | undefined>((resolve) => lease.onClose(resolve));
        server.freeze();

        const err = await closed;
        expect(err?.message).toMatch(/Keepalive timeout/);
        expect(sshPool.inspect(id).connections).toBe(0);
        lease.release();
    });

    it('authenticates with a stored private key, a key file and keyboard-interactive', async () => {
        const { privateKey, publicKey } = generateKeyPair();
        const keyServer = await harness({ users: [{ username: 'tester', publicKey }] });
        const sshPool = pool();

        const stored = await saveServer(keyServer, { password: '', privateKey });
        const lease = await sshPool.acquire(stored);
        expect(keyServer.log).toContain('auth:publickey');
        lease.release();

        const keyFile = path.join(database.dir, 'id_test');
        fs.writeFileSync(keyFile, privateKey);
        const fromFile = await saveServer(keyServer, { password: '', private_key_path: keyFile });
        (await sshPool.acquire(fromFile)).release();

        const kbdServer = await harness({ keyboardInteractiveOnly: true });
        const kbd = await saveServer(kbdServer);
        (await sshPool.acquire(kbd)).release();
        expect(kbdServer.log).toContain('auth:keyboard-interactive');
    });

    it('answers a hidden keyboard-interactive prompt in any language, never an echoed one', async () => {
        const sshPool = pool();
        const spanish = await harness({ keyboardInteractiveOnly: true, keyboardInteractivePrompt: { prompt: 'Contraseña: ', echo: false } });
        (await sshPool.acquire(await saveServer(spanish))).release();

        // An echoed prompt asks for a one-time code, not the password.
        const otp = await harness({ keyboardInteractiveOnly: true, keyboardInteractivePrompt: { prompt: 'Verification code: ', echo: true } });
        const err = await sshPool.acquire(await saveServer(otp)).catch((error: unknown) => error);
        expect(poolModule.describeSshError(err)).toMatch(/^Auth failed/);
    });

    it('reports rejected credentials and unparseable keys', async () => {
        const server = await harness();
        const sshPool = pool();

        const wrong = await saveServer(server, { password: 'nope' });
        const authError = await sshPool.acquire(wrong).catch((err: unknown) => err);
        expect(poolModule.describeSshError(authError)).toMatch(/^Auth failed/);
        expect(sshPool.inspect(wrong).connections).toBe(0);

        const badKey = await saveServer(server, { password: '', privateKey: 'PuTTY-User-Key-File-3: not a key' });
        await expect(sshPool.acquire(badKey)).rejects.toThrow(/Cannot parse privateKey/);
        expect(sshPool.inspect(badKey).connections).toBe(0);
    });
});

describe('host key pinning (TOFU)', () => {
    it('pins an unknown host key on first use and accepts it afterwards', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool();
        const trusted = vi.fn();
        sshPool.onHostKeyTrusted(trusted);

        (await sshPool.acquire(id)).release();
        expect(trusted).toHaveBeenCalledWith({ serverId: id, host: server.host, port: server.port, via: '', keyType: 'ssh-ed25519', fingerprint: server.fingerprint });
        expect(await knownHosts.find(server.host, server.port)).toMatchObject({ key_type: 'ssh-ed25519', fingerprint: server.fingerprint });
        expect(server.fingerprint).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);

        sshPool.invalidate(id, { close: true });
        (await sshPool.acquire(id)).release();
        expect(trusted).toHaveBeenCalledTimes(1);
    });

    it('refuses a changed host key with both fingerprints', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const pinned = 'SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
        await knownHosts.pin({ host: server.host, port: server.port, key_type: 'ssh-ed25519', fingerprint: pinned });
        const sshPool = pool();

        const err = await sshPool.acquire(id).catch((error: unknown) => error);
        expect(err).toBeInstanceOf(HostKeyMismatchError);
        expect(err).toMatchObject({ code: 'HOST_KEY_MISMATCH', host: server.host, port: server.port, expected: pinned, actual: server.fingerprint });
        expect(server.log.filter((entry) => entry.startsWith('auth:'))).toEqual([]);
        expect(sshPool.inspect(id).connections).toBe(0);
    });

    it('asks for the pinned key type first, so a server that gained another key type still matches', async () => {
        // The default preference picks ed25519; the RSA key was pinned first.
        const server = await harness({ extraHostKeys: [generateKeyPair('rsa').privateKey] });
        await knownHosts.pin({ host: server.host, port: server.port, key_type: 'ssh-rsa', fingerprint: server.fingerprints['ssh-rsa'] });
        const id = await saveServer(server);
        const sshPool = pool();

        const lease = await sshPool.acquire(id);
        expect((await execModule.exec(lease, 'echo pinned')).stdout).toBe('pinned\n');
        lease.release();

        // A changed key of the pinned type is still refused.
        await dbRun('UPDATE known_hosts SET fingerprint = ? WHERE port = ?', ['SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', server.port]);
        sshPool.invalidate(id, { close: true });
        await expect(sshPool.acquire(id)).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH', keyType: 'ssh-rsa', actual: server.fingerprints['ssh-rsa'] });
    });
});

describe('jump hosts', () => {
    it('reaches the target through a leased jump connection', async () => {
        const bastion = await harness();
        const inner = await harness();
        const bastionId = await saveServer(bastion);
        const innerId = await saveServer(inner, { jump_server_id: bastionId });
        const sshPool = pool();

        const lease = await sshPool.acquire(innerId);
        expect(bastion.log).toContain(`tcpip:${inner.host}:${inner.port}`);
        expect(sshPool.inspect(bastionId)).toEqual({ connections: 1, refs: 1 });
        expect((await execModule.exec(lease, 'echo through the bastion')).stdout).toBe('through the bastion\n');
        // Pinned for its route: the address is the one the bastion sees.
        expect(await knownHosts.find(inner.host, inner.port, `${bastion.host}:${bastion.port}`)).toMatchObject({ fingerprint: inner.fingerprint });
        expect(await knownHosts.find(inner.host, inner.port)).toBeNull();

        // The jump connection is shared, not reopened, by a second target.
        const second = await saveServer(inner, { jump_server_id: bastionId, name: 'second' });
        const secondLease = await sshPool.acquire(second);
        expect(bastion.connections()).toBe(1);
        expect(sshPool.inspect(bastionId).refs).toBe(2);

        lease.release();
        secondLease.release();
        await waitFor(() => sshPool.inspect(innerId).connections === 0 && sshPool.inspect(second).connections === 0);
        await waitFor(() => sshPool.inspect(bastionId).connections === 0);
    });

    it('pins the same private address behind two bastions as two machines (BC-02)', async () => {
        // 10.0.0.5:22 is another machine on each site.
        const siteA = await harness();
        const siteB = await harness();
        const bastionA = await harness({ forward: () => ({ host: siteA.host, port: siteA.port }) });
        const bastionB = await harness({ forward: () => ({ host: siteB.host, port: siteB.port }) });
        const a = await saveServer(bastionA, { name: 'bastion-a' });
        const b = await saveServer(bastionB, { name: 'bastion-b' });
        const behindA = await servers.create({ name: 'db-a', ip: '10.0.0.5', port: 22, type: 'linux', username: 'tester', password: 'secret', jump_server_id: a });
        const behindB = await servers.create({ name: 'db-b', ip: '10.0.0.5', port: 22, type: 'linux', username: 'tester', password: 'secret', jump_server_id: b });
        const sshPool = pool();

        (await sshPool.acquire(behindA)).release();
        // Without the route in the pin this was HOST_KEY_MISMATCH.
        (await sshPool.acquire(behindB)).release();
        expect(await knownHosts.find('10.0.0.5', 22, `${bastionA.host}:${bastionA.port}`)).toMatchObject({ fingerprint: siteA.fingerprint });
        expect(await knownHosts.find('10.0.0.5', 22, `${bastionB.host}:${bastionB.port}`)).toMatchObject({ fingerprint: siteB.fingerprint });

        // Each pin still guards its own route.
        await dbRun('UPDATE known_hosts SET fingerprint = ? WHERE via = ?', ['SHA256:CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC', `${bastionB.host}:${bastionB.port}`]);
        sshPool.invalidate(behindB, { close: true });
        await expect(sshPool.acquire(behindB)).rejects.toMatchObject({ code: 'HOST_KEY_MISMATCH', via: `${bastionB.host}:${bastionB.port}`, actual: siteB.fingerprint });
        (await sshPool.acquire(behindA)).release();
    });

    it('gives up on a target the bastion cannot reach within the handshake timeout (BC-01)', async () => {
        const bastion = await harness({ forward: () => 'hang' });
        const bastionId = await saveServer(bastion);
        const target = await servers.create({ name: 'down', ip: '10.255.255.1', port: 22, type: 'linux', username: 'tester', password: 'secret', jump_server_id: bastionId });
        const sshPool = pool({ readyTimeout: 800 });

        const started = Date.now();
        const err = await sshPool.acquire(target).catch((error: unknown) => error);
        expect(err).toMatchObject({ code: 'JUMP_TIMEOUT', message: expect.stringMatching(/could not reach 10\.255\.255\.1:22 within 1s/) });
        expect(Date.now() - started).toBeLessThan(5000);
        expect(sshPool.inspect(target)).toEqual({ connections: 0, refs: 0 });
        // The jump connection was handed back.
        expect(sshPool.inspect(bastionId).refs).toBe(0);
    });

    it('stops waiting for the bastion when the connection is closed meanwhile (BC-01)', async () => {
        const bastion = await harness({ forward: () => 'hang' });
        const bastionId = await saveServer(bastion);
        const target = await servers.create({ name: 'down', ip: '10.255.255.1', port: 22, type: 'linux', username: 'tester', password: 'secret', jump_server_id: bastionId });
        const sshPool = pool({ readyTimeout: 20_000 });

        const pending = sshPool.acquire(target).catch((error: unknown) => error);
        await waitFor(() => bastion.log.some((entry) => entry.startsWith('tcpip:')));
        const started = Date.now();
        // What deleting the server does.
        sshPool.invalidate(target, { close: true });
        expect(await pending).toMatchObject({ message: 'The SSH connection was cancelled' });
        expect(Date.now() - started).toBeLessThan(2000);
    });
});

describe('exec', () => {
    it('returns stdout, stderr and the exit code, decoding UTF-8 across packets', async () => {
        const server = await harness();
        const sshPool = pool();
        const lease = await sshPool.acquire(await saveServer(server));

        expect(await execModule.exec(lease, 'grep PRETTY_NAME /etc/os-release || uname -sr')).toEqual({
            stdout: `PRETTY_NAME="${HARNESS_OS}"\n`, stderr: '', code: 0, signal: null,
        });
        expect(await execModule.exec(lease, 'fail')).toEqual({ stdout: '', stderr: 'boom\n', code: 3, signal: null });
        expect((await execModule.exec(lease, 'utf8-split')).stdout).toBe('ñandú €');
        await expect(execModule.execOutput(lease, 'fail')).rejects.toThrow('boom');
        expect(await execModule.execOutputSafe(lease, 'fail')).toBe('');
        lease.release();
    });

    it('kills commands that exceed their timeout or are aborted', async () => {
        const server = await harness();
        const sshPool = pool();
        const lease = await sshPool.acquire(await saveServer(server));

        const timedOut = await execModule.exec(lease, 'hang', { timeoutMs: 200 }).catch((err: unknown) => err);
        expect(timedOut).toBeInstanceOf(execModule.ExecTimeoutError);
        expect(timedOut).toMatchObject({ code: 'EXEC_TIMEOUT' });
        await waitFor(() => server.log.includes('exec-closed:hang'));
        expect(server.log).toContain('signal:KILL');

        const controller = new AbortController();
        const chunks: string[] = [];
        const streaming = execModule.execStream(lease, 'hang', { signal: controller.signal, onData: (text) => chunks.push(text) });
        setTimeout(() => controller.abort(), 100);
        await expect(streaming).rejects.toMatchObject({ code: 'EXEC_ABORTED' });
        lease.release();
    });

    it('caps concurrent exec channels per connection', async () => {
        const server = await harness();
        const sshPool = pool();
        const lease = await sshPool.acquire(await saveServer(server));

        const results = await Promise.all(Array.from({ length: 8 }, () => execModule.exec(lease, 'sleep-ms 100')));
        expect(results.every((result) => result.stdout === 'slept\n')).toBe(true);
        expect(server.maxActiveExecs()).toBe(execModule.MAX_EXEC_CHANNELS);
        lease.release();
    });

    it('bounds the wait for a channel slot by the timeout and the abort signal', async () => {
        const server = await harness();
        const sshPool = pool();
        const lease = await sshPool.acquire(await saveServer(server));

        const holders = Array.from({ length: execModule.MAX_EXEC_CHANNELS }, () => new AbortController());
        const busy = holders.map((controller) => execModule.exec(lease, 'hang', { signal: controller.signal }).catch((err: unknown) => err));
        await waitFor(() => server.activeExecs() === execModule.MAX_EXEC_CHANNELS);

        const started = Date.now();
        await expect(execModule.exec(lease, 'echo queued', { timeoutMs: 300 })).rejects.toMatchObject({ code: 'EXEC_TIMEOUT' });
        expect(Date.now() - started).toBeLessThan(3000);

        const controller = new AbortController();
        const queued = execModule.exec(lease, 'echo queued', { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        await expect(queued).rejects.toMatchObject({ code: 'EXEC_ABORTED' });

        for (const holder of holders) holder.abort();
        for (const result of await Promise.all(busy)) expect(result).toMatchObject({ code: 'EXEC_ABORTED' });

        // Cancelled waiters gave their place up: the slots are all free again.
        const after = await Promise.all(Array.from({ length: execModule.MAX_EXEC_CHANNELS }, () => execModule.exec(lease, 'echo after', { timeoutMs: 5000 })));
        expect(after.map((result) => result.stdout)).toEqual(Array(execModule.MAX_EXEC_CHANNELS).fill('after\n'));
        expect(server.log.filter((entry) => entry === 'exec:echo queued')).toEqual([]);
        lease.release();
    });

    it('stops a command whose output passes the cap, and the connection stays up (SEC-1, BC-13)', async () => {
        const flood = (command: string, channel: ServerChannel) => {
            const match = /^flood (\d+)$/.exec(command);
            if (!match) return false;
            const chunk = Buffer.alloc(16 * 1024, 'y');
            let left = Number(match[1]);
            const pump = () => {
                while (left > 0) {
                    // The client closes the channel at its cap.
                    if (!channelOpen(channel)) return;
                    left -= chunk.length;
                    if (!channel.write(chunk)) {
                        channel.once('drain', pump);
                        return;
                    }
                }
                channel.exit(0);
                channel.end();
            };
            pump();
            return true;
        };
        const server = await harness({ exec: flood });
        const sshPool = pool();
        const lease = await sshPool.acquire(await saveServer(server));
        expect(execModule.EXEC_MAX_OUTPUT_BYTES).toBeLessThanOrEqual(16 * 1024 * 1024);

        // An endless printer is stopped at the cap instead of filling the memory.
        const tooLarge = await execModule.exec(lease, 'flood 100000000', { maxOutputBytes: 256 * 1024, timeoutMs: 15_000 }).catch((err: unknown) => err);
        expect(tooLarge).toBeInstanceOf(execModule.ExecOutputTooLargeError);
        expect(tooLarge).toMatchObject({ code: 'EXEC_OUTPUT_TOO_LARGE', status: 502 });
        await waitFor(() => server.log.includes('exec-closed:flood 100000000'));

        // Or cut, keeping what came before.
        const cut = await execModule.exec(lease, 'flood 100000000', { maxOutputBytes: 256 * 1024, truncateOutput: true, timeoutMs: 15_000 });
        expect(cut.truncated).toBe(true);
        expect(cut.stdout.length).toBeLessThanOrEqual(256 * 1024);
        expect(cut.stdout.length).toBeGreaterThan(0);

        // Under the cap: everything, no flag.
        const small = await execModule.exec(lease, 'flood 65536', { maxOutputBytes: 256 * 1024 });
        expect(small.stdout).toHaveLength(65536);
        expect(small).not.toHaveProperty('truncated');

        // A consumer that throws fails its command, not the pooled connection.
        const thrown = await execModule.execStream(lease, 'flood 65536', { onData: () => { throw new Error('consumer broke'); } }).catch((err: unknown) => err);
        expect(thrown).toMatchObject({ message: 'consumer broke' });
        expect((await execModule.exec(lease, 'echo still up')).stdout).toBe('still up\n');
        expect(server.connections()).toBe(1);
        lease.release();
    });

    it('moves a command to a spare connection when the server refuses its channel (BC-03)', async () => {
        const server = await harness({ maxSessions: 1 });
        const id = await saveServer(server);
        const sshPool = pool();
        const lease = await sshPool.acquire(id);
        // A terminal holds the connection's only session.
        const shell = await new Promise<import('ssh2').ClientChannel>((resolve, reject) => {
            lease.client.shell({ term: 'xterm' }, (err, stream) => (err ? reject(err) : resolve(stream)));
        });

        expect((await execModule.exec(lease, 'echo on a spare')).stdout).toBe('on a spare\n');
        const chunks: string[] = [];
        await execModule.execStream(lease, 'echo streamed', { onData: (text) => chunks.push(text) });
        expect(chunks.join('')).toBe('streamed\n');
        expect(server.connections()).toBe(2);
        // The spare was handed back once the commands ended.
        expect(sshPool.inspect(id).refs).toBe(1);

        // Without a pool to find spares in: refused, naming the likely cause.
        const bare = { client: lease.client };
        const refused = await execModule.exec(bare, 'echo nowhere').catch((err: unknown) => err);
        expect(refused).toMatchObject({ code: 'SSH_CHANNEL_REFUSED', message: expect.stringMatching(/MaxSessions/) });
        shell.close();
        lease.release();
    });

    it('stops handing out a connection on which a channel request went unanswered (BC-04)', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool();
        const held = await sshPool.acquire(id);
        // The link is dead but nobody noticed yet (keepalives take a while).
        server.freeze();

        await expect(execModule.exec(held, 'echo lost', { timeoutMs: 1000 })).rejects.toMatchObject({ code: 'EXEC_TIMEOUT' });
        const fresh = await sshPool.acquire(id);
        expect(fresh.client).not.toBe(held.client);
        expect(server.connections()).toBe(2);
        expect((await execModule.exec(fresh, 'echo fresh')).stdout).toBe('fresh\n');
        fresh.release();
        held.release();
    });

    it('keeps a connection whose command only timed out while running', async () => {
        const server = await harness();
        const id = await saveServer(server);
        const sshPool = pool();
        const lease = await sshPool.acquire(id);
        await expect(execModule.exec(lease, 'hang', { timeoutMs: 300 })).rejects.toMatchObject({ code: 'EXEC_TIMEOUT' });
        const again = await sshPool.acquire(id);
        expect(again.client).toBe(lease.client);
        again.release();
        lease.release();
    });

    it('runs live streams on their own budget so commands never wait behind them', async () => {
        const server = await harness();
        const sshPool = pool();
        const lease = await sshPool.acquire(await saveServer(server));

        const controller = new AbortController();
        const streams = Array.from({ length: execModule.MAX_STREAM_CHANNELS }, () =>
            execModule.execStream(lease, 'hang', { signal: controller.signal, onData: () => undefined }).catch((err: unknown) => err));
        await waitFor(() => server.activeExecs() === execModule.MAX_STREAM_CHANNELS);

        expect((await execModule.exec(lease, 'echo not blocked', { timeoutMs: 5000 })).stdout).toBe('not blocked\n');
        await expect(execModule.execStream(lease, 'hang', { onData: () => undefined })).rejects.toMatchObject({ code: 'EXEC_STREAMS_BUSY' });

        controller.abort();
        for (const result of await Promise.all(streams)) expect(result).toMatchObject({ code: 'EXEC_ABORTED' });

        const chunks: string[] = [];
        expect(await execModule.execStream(lease, 'echo streamed', { onData: (text) => chunks.push(text) })).toEqual({ code: 0, signal: null });
        expect(chunks.join('')).toBe('streamed\n');
        lease.release();
    });
});
