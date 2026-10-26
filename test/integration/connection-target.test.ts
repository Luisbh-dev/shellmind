import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { openTempDatabase } from '../helpers/tempDatabase';

// Connection targets come only from the saved row: the client can name a
// server and a purpose, nothing else.

type TargetModule = typeof import('../../server/connections/target');
type ServersRepo = typeof import('../../server/db/serversRepo')['serversRepo'];
type DbRun = typeof import('../../server/db/sqlite')['dbRun'];

let database: Awaited<ReturnType<typeof openTempDatabase>>;
let targets: TargetModule;
let servers: ServersRepo;
let dbRun: DbRun;
let encryptWithKey: typeof import('../../server/security/secrets')['encryptWithKey'];

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    database = await openTempDatabase();
    targets = await import('../../server/connections/target');
    servers = (await import('../../server/db/serversRepo')).serversRepo;
    dbRun = (await import('../../server/db/sqlite')).dbRun;
    encryptWithKey = (await import('../../server/security/secrets')).encryptWithKey;
});

afterAll(async () => {
    await database?.close();
    vi.restoreAllMocks();
});

async function rejectsWith(promise: Promise<unknown>, code: string, message?: RegExp): Promise<void> {
    const err = await promise.then(() => null, (error: unknown) => error);
    expect(err).toBeInstanceOf(targets.ConnectionTargetError);
    expect(err).toMatchObject({ code });
    if (message) expect((err as Error).message).toMatch(message);
}

describe('loadConnectionTarget', () => {
    it('builds SSH targets from the row with decrypted credentials and default port/user', async () => {
        const id = await servers.create({ name: 'web', ip: ' 10.0.0.5 ', type: 'linux', password: 'pw-1' });

        for (const purpose of ['terminal', 'files', 'status', 'exec'] as const) {
            expect(await targets.loadConnectionTarget(id, purpose)).toEqual({
                kind: 'ssh',
                serverId: id,
                name: 'web',
                os: 'linux',
                host: '10.0.0.5',
                port: 22,
                username: 'root',
                password: 'pw-1',
                privateKey: undefined,
                passphrase: undefined,
                identityId: null,
                agent: undefined,
                agentForward: false,
                jump: null,
                version: expect.stringMatching(new RegExp(`^${id}@\\d+$`)),
            });
        }
        // Numeric strings (route params) are accepted too.
        expect(await targets.loadConnectionTarget(String(id), 'terminal')).toMatchObject({ serverId: id });
        await rejectsWith(targets.loadConnectionTarget(id, 'rdp'), 'UNSUPPORTED_PURPOSE');
    });

    it('uses ssh_port for SSH to Windows and port/domain for RDP', async () => {
        const id = await servers.create({
            name: 'win', ip: '10.0.0.6', type: 'windows', username: 'Administrator', password: 'pw-2', ssh_port: 2222, domain: 'CORP',
        });

        expect(await targets.loadConnectionTarget(id, 'terminal')).toMatchObject({ kind: 'ssh', os: 'windows', port: 2222, username: 'Administrator' });
        expect(await targets.loadConnectionTarget(id, 'rdp')).toEqual({
            kind: 'rdp',
            serverId: id,
            name: 'win',
            host: '10.0.0.6',
            port: 3389,
            username: 'Administrator',
            password: 'pw-2',
            domain: 'CORP',
        });
    });

    it('builds FTP, S3 and local targets only for the purposes they support', async () => {
        const ftp = await servers.create({ name: 'ftp', ip: '10.0.0.7', type: 'ftp', password: 'pw-3' });
        expect(await targets.loadConnectionTarget(ftp, 'files')).toEqual({
            kind: 'ftp', serverId: ftp, name: 'ftp', host: '10.0.0.7', port: 21, username: 'anonymous', password: 'pw-3',
        });
        await rejectsWith(targets.loadConnectionTarget(ftp, 'status'), 'UNSUPPORTED_PURPOSE');

        const s3 = await servers.create({
            name: 's3', type: 's3', s3_provider: 'other', s3_bucket: 'b', s3_region: 'eu-west-1', s3_endpoint: 'minio:9000', s3_access_key: 'AK', s3_secret_key: 'SK',
        });
        expect(await targets.loadConnectionTarget(s3, 'files')).toEqual({
            kind: 's3', serverId: s3, name: 's3', provider: 'other', bucket: 'b', region: 'eu-west-1', endpoint: 'minio:9000', accessKey: 'AK', secretKey: 'SK',
        });

        const local = await servers.create({ name: 'sh', ip: 'local', type: 'local', command: 'bash', cwd: '/tmp', initial_command: 'ls', cli_preset: 'custom' });
        expect(await targets.loadConnectionTarget(local, 'terminal')).toEqual({
            kind: 'local', serverId: local, name: 'sh', command: 'bash', cwd: '/tmp', initialCommand: 'ls', cliPreset: 'custom',
        });
        await rejectsWith(targets.loadConnectionTarget(local, 'files'), 'UNSUPPORTED_PURPOSE');
        await rejectsWith(targets.loadConnectionTarget(local, 'exec'), 'UNSUPPORTED_PURPOSE');
    });

    // arch-cli-preset-unvalidated: a row saved before presets were validated
    // used to open the full system shell for an unknown preset.
    it('refuses a local server whose saved CLI preset is unknown instead of opening a shell', async () => {
        const typo = await servers.create({ name: 'k8s', ip: 'local', type: 'local', cli_preset: 'kubectl' });
        await dbRun("UPDATE servers SET cli_preset = 'kubctl' WHERE id = ?", [typo]);
        await rejectsWith(targets.loadConnectionTarget(typo, 'terminal'), 'UNKNOWN_CLI_PRESET', /"kubctl", which ShellMind does not know/);

        // Known presets in another case still resolve, to the stored form; none means the shell.
        await dbRun("UPDATE servers SET cli_preset = ' Docker ' WHERE id = ?", [typo]);
        expect(await targets.loadConnectionTarget(typo, 'terminal')).toMatchObject({ kind: 'local', cliPreset: 'docker' });
        await dbRun("UPDATE servers SET cli_preset = '' WHERE id = ?", [typo]);
        expect(await targets.loadConnectionTarget(typo, 'terminal')).toMatchObject({ kind: 'local', cliPreset: null });
    });

    it('requires an existing saved server', async () => {
        for (const bad of [undefined, null, 'abc', -1, 0, 1.5, {}, '1; DROP TABLE servers']) {
            await rejectsWith(targets.loadConnectionTarget(bad, 'terminal'), 'INVALID_SERVER_ID', /saved server is required/);
        }
        await rejectsWith(targets.loadConnectionTarget(999999, 'terminal'), 'SERVER_NOT_FOUND');
    });

    it('changes the version when the row is edited', async () => {
        const id = await servers.create({ name: 'v', ip: '10.0.0.8', type: 'linux' });
        const before = await targets.loadSshTarget(id);
        await new Promise((resolve) => setTimeout(resolve, 5));
        await servers.update(id, { name: 'v2', ip: '10.0.0.8', type: 'linux' });
        const after = await targets.loadSshTarget(id);
        expect(after.version).not.toBe(before.version);
        expect(after.name).toBe('v2');
    });
});

describe('jump hosts', () => {
    it('resolves the whole chain from the database', async () => {
        const bastion = await servers.create({ name: 'bastion', ip: 'bastion.example', type: 'linux', username: 'jump', password: 'pw-b' });
        const middle = await servers.create({ name: 'middle', ip: '10.1.0.1', type: 'windows', ssh_port: 2200, jump_server_id: bastion });
        const inner = await servers.create({ name: 'inner', ip: '10.2.0.1', type: 'linux', jump_server_id: middle });

        const target = await targets.loadSshTarget(inner);
        expect(target.jump).toMatchObject({ serverId: middle, host: '10.1.0.1', port: 2200 });
        expect(target.jump?.jump).toMatchObject({ serverId: bastion, host: 'bastion.example', username: 'jump', password: 'pw-b', jump: null });
        expect(target.version).toMatch(new RegExp(`^${inner}@\\d+>${middle}@\\d+>${bastion}@\\d+$`));
    });

    it('detects loops and refuses non-SSH or too long chains', async () => {
        const a = await servers.create({ name: 'a', ip: '10.3.0.1', type: 'linux' });
        const b = await servers.create({ name: 'b', ip: '10.3.0.2', type: 'linux', jump_server_id: a });
        // The API refuses loops, so build one behind its back.
        await dbRun('UPDATE servers SET jump_server_id = ? WHERE id = ?', [b, a]);
        await rejectsWith(targets.loadSshTarget(b), 'JUMP_HOST', /loops back/);

        const ftp = await servers.create({ name: 'ftp-jump', ip: '10.3.0.3', type: 'ftp' });
        const c = await servers.create({ name: 'c', ip: '10.3.0.4', type: 'linux' });
        await dbRun('UPDATE servers SET jump_server_id = ? WHERE id = ?', [ftp, c]);
        await rejectsWith(targets.loadSshTarget(c), 'JUMP_HOST', /not an SSH server/);

        let previous = await servers.create({ name: 'hop-0', ip: '10.4.0.0', type: 'linux' });
        for (let hop = 1; hop <= 6; hop += 1) {
            previous = await servers.create({ name: `hop-${hop}`, ip: `10.4.0.${hop}`, type: 'linux', jump_server_id: previous });
        }
        await rejectsWith(targets.loadSshTarget(previous), 'JUMP_HOST', /longer than 5 hops/);
    });
});

describe('private_key_path', () => {
    it('reads the key file at connect time, expanding ~', async () => {
        const home = path.join(database.dir, 'home');
        fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
        fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'KEY-FROM-FILE-1');
        vi.stubEnv('HOME', home);
        vi.stubEnv('USERPROFILE', home);
        try {
            const id = await servers.create({ name: 'keyfile', ip: '10.5.0.1', type: 'linux', private_key_path: '~/.ssh/id_test', privateKey: 'STORED-KEY' });
            expect(await targets.loadSshTarget(id)).toMatchObject({ privateKey: 'KEY-FROM-FILE-1' });

            fs.writeFileSync(path.join(home, '.ssh', 'id_test'), 'KEY-FROM-FILE-2');
            expect(await targets.loadSshTarget(id)).toMatchObject({ privateKey: 'KEY-FROM-FILE-2' });

            fs.rmSync(path.join(home, '.ssh', 'id_test'));
            await rejectsWith(targets.loadSshTarget(id), 'PRIVATE_KEY_FILE', /ENOENT/);
        } finally {
            vi.unstubAllEnvs();
        }
    });

    it('only reads regular files of key size', async () => {
        const dir = path.join(database.dir, 'keys');
        fs.mkdirSync(dir, { recursive: true });
        const directory = await servers.create({ name: 'key-dir', ip: '10.5.0.2', type: 'linux', private_key_path: dir });
        await rejectsWith(targets.loadSshTarget(directory), 'PRIVATE_KEY_FILE', /not a regular file/);

        const big = path.join(dir, 'huge');
        fs.writeFileSync(big, Buffer.alloc(targets.MAX_PRIVATE_KEY_FILE_BYTES + 1));
        const huge = await servers.create({ name: 'key-huge', ip: '10.5.0.3', type: 'linux', private_key_path: big });
        await rejectsWith(targets.loadSshTarget(huge), 'PRIVATE_KEY_FILE', /larger than 64 KiB/);
    });
});

describe('secrets saved with another data key', () => {
    const foreign = (value: string) => encryptWithKey(crypto.randomBytes(32), value);

    it('leaves a stale secret out when the connection has other credentials', async () => {
        const id = await servers.create({ name: 'stale-key', ip: '10.6.0.1', type: 'linux', password: 'pw-new', privateKey: 'KEY-old' });
        await dbRun('UPDATE servers SET privateKey = ? WHERE id = ?', [foreign('KEY-old'), id]);

        expect(await targets.loadSshTarget(id)).toMatchObject({ password: 'pw-new', privateKey: undefined });

        await dbRun('UPDATE servers SET password = ? WHERE id = ?', [foreign('pw-old'), id]);
        await rejectsWith(targets.loadSshTarget(id), 'SECRET_UNREADABLE', /saved password and private key of "stale-key" cannot be decrypted/);
    });

    it('fails RDP, FTP and S3 connections whose secret cannot be read', async () => {
        const win = await servers.create({ name: 'win-stale', ip: '10.6.0.2', type: 'windows', password: 'pw' });
        const ftp = await servers.create({ name: 'ftp-stale', ip: '10.6.0.3', type: 'ftp', password: 'pw' });
        const s3 = await servers.create({ name: 's3-stale', type: 's3', s3_bucket: 'b', s3_access_key: 'AK', s3_secret_key: 'SK' });
        await dbRun('UPDATE servers SET password = ? WHERE id IN (?, ?)', [foreign('pw'), win, ftp]);
        await dbRun('UPDATE servers SET s3_secret_key = ? WHERE id = ?', [foreign('SK'), s3]);

        await rejectsWith(targets.loadConnectionTarget(win, 'rdp'), 'SECRET_UNREADABLE', /password/);
        await rejectsWith(targets.loadConnectionTarget(ftp, 'files'), 'SECRET_UNREADABLE', /password/);
        await rejectsWith(targets.loadConnectionTarget(s3, 'files'), 'SECRET_UNREADABLE', /S3 secret key/);
    });
});
