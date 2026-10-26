import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { CreateBucketCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import type { CountResult, DeleteResult, FileSessionInfo, ListResult, ReadResult, StatResult } from '../../shared/files';
import { downloadBytes, ok, openFileSession, request, uploadBytes, type FileSocket } from '../helpers/fileClient';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The file manager against real servers in Docker: OpenSSH's sftp-server,
// vsftpd with explicit FTPS and MinIO. Opt-in (SHELLMIND_E2E=1): it pulls
// Alpine packages. Containers are named shellmind-test-files-* and removed.

const enabled = process.env.SHELLMIND_E2E === '1';
const suffix = randomBytes(3).toString('hex');
const containers: string[] = [];

vi.setConfig({ testTimeout: 60_000, hookTimeout: 240_000 });

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function run(name: string, ports: string[], env: Record<string, string>, script: string): string {
    const full = `shellmind-test-files-${name}-${suffix}`;
    docker('run', '-d', '--name', full, ...ports.flatMap((port) => ['-p', port]), ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), 'alpine:3', 'sh', '-c', script);
    containers.push(full);
    return full;
}

function hostPort(container: string, port: number): number {
    return Number(docker('port', container, `${port}/tcp`).split('\n')[0].split(':').pop());
}

async function waitFor(check: () => Promise<boolean>, what: string, timeoutMs = 180_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (await check().catch(() => false)) return;
        await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    throw new Error(`${what} did not start`);
}

// A line starting with `prefix` arrives on a fresh TCP connection. Docker's
// port proxy accepts connections before the service listens, then closes them.
function banner(port: number, prefix: string): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.setTimeout(2000, () => socket.destroy());
        socket.once('data', (data) => {
            resolve(data.toString().startsWith(prefix));
            socket.destroy();
        });
        socket.once('error', () => resolve(false));
        socket.once('close', () => resolve(false));
    });
}

let server: TestServer;
const sockets: FileSocket[] = [];

async function save(body: Record<string, unknown>): Promise<number> {
    const res = await server.fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const json = await res.json() as { data: { id: number } };
    return json.data.id;
}

async function session(serverId: number): Promise<FileSocket> {
    const socket = await openFileSession(server, serverId);
    sockets.push(socket);
    return socket;
}

const sha256 = (data: Buffer) => createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
    if (!enabled) return;
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const sshd = run('sshd', ['127.0.0.1::22'], {}, [
        'apk add --no-cache openssh-server openssh-sftp-server >/dev/null',
        'ssh-keygen -A >/dev/null',
        'adduser -D demo && echo demo:demo-pass | chpasswd',
        "sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config",
        'mkdir -p /home/demo/many /home/demo/target/inside && touch /home/demo/target/inside/keep.txt',
        'for i in $(seq 1 2000); do : > /home/demo/many/f$i; done',
        'head -c 5000000 /dev/urandom > /home/demo/random.bin',
        'echo secret > /home/demo/private.conf && chmod 600 /home/demo/private.conf',
        'ln -s /home/demo/target /home/demo/link-to-target',
        'chown -R demo:demo /home/demo',
        'exec /usr/sbin/sshd -D -e',
    ].join(' && '));

    const pasvBase = 42000 + Math.floor(Math.random() * 200) * 10;
    const vsftpd = run('ftps', ['127.0.0.1::21', `127.0.0.1:${pasvBase}-${pasvBase + 9}:${pasvBase}-${pasvBase + 9}`], {}, [
        'apk add --no-cache vsftpd openssl >/dev/null',
        'adduser -D ftpuser && echo ftpuser:ftp-pass | chpasswd',
        'mkdir -p /home/ftpuser/docs && echo hello > /home/ftpuser/docs/readme.txt && chown -R ftpuser:ftpuser /home/ftpuser',
        "openssl req -x509 -newkey rsa:2048 -nodes -keyout /etc/vsftpd/key.pem -out /etc/vsftpd/cert.pem -days 2 -subj /CN=127.0.0.1 -addext subjectAltName=IP:127.0.0.1 -addext basicConstraints=critical,CA:TRUE 2>/dev/null",
        `printf '%s\\n' listen=YES anonymous_enable=NO local_enable=YES write_enable=YES local_umask=022 pasv_enable=YES pasv_min_port=${pasvBase} pasv_max_port=${pasvBase + 9} pasv_address=127.0.0.1 ssl_enable=YES force_local_logins_ssl=YES force_local_data_ssl=YES require_ssl_reuse=NO rsa_cert_file=/etc/vsftpd/cert.pem rsa_private_key_file=/etc/vsftpd/key.pem seccomp_sandbox=NO background=NO > /etc/vsftpd/vsftpd.conf`,
        'exec vsftpd /etc/vsftpd/vsftpd.conf',
    ].join(' && '));

    const minio = run('minio', ['127.0.0.1::9000'], { MINIO_ROOT_USER: 'shellmind', MINIO_ROOT_PASSWORD: 'shellmind-secret' }, [
        'apk add --no-cache minio >/dev/null',
        'exec minio server /data --address :9000 --quiet',
    ].join(' && '));

    const sshPort = hostPort(sshd, 22);
    const ftpPort = hostPort(vsftpd, 21);
    const s3Port = hostPort(minio, 9000);
    const progress = (what: string) => process.stderr.write(`[e2e] ${what}\n`);
    progress('containers started');
    await waitFor(() => banner(sshPort, 'SSH-'), 'sshd');
    progress('sshd up');
    await waitFor(() => banner(ftpPort, '220'), 'vsftpd');
    progress('vsftpd up');
    await waitFor(async () => (await fetch(`http://127.0.0.1:${s3Port}/minio/health/live`)).ok, 'minio');
    progress('minio up');

    // Trust the FTPS server's self-signed certificate, as a CA would be.
    const cert = docker('exec', vsftpd, 'cat', '/etc/vsftpd/cert.pem');
    tls.setDefaultCACertificates([...tls.getCACertificates('default'), cert]);

    const s3 = new S3Client({ region: 'us-east-1', endpoint: `http://127.0.0.1:${s3Port}`, forcePathStyle: true, credentials: { accessKeyId: 'shellmind', secretAccessKey: 'shellmind-secret' } });
    await s3.send(new CreateBucketCommand({ Bucket: 'e2e' }));
    await Promise.all(Array.from({ length: 1200 }, (_, i) => s3.send(new PutObjectCommand({ Bucket: 'e2e', Key: `logs/${String(i).padStart(4, '0')}.log`, Body: `line ${i}\n` }))));
    await s3.send(new PutObjectCommand({ Bucket: 'e2e', Key: 'empty.keep', Body: '' }));
    s3.destroy();
    progress('bucket filled');

    server = await bootTestServer();
    // The FTPS setting comes with the shell slice's migration 007; add the
    // column only where that migration is not there yet.
    const columns = await new Promise<Array<{ name: string }>>((resolve, reject) => server.db.all('PRAGMA table_info(servers)', (err, rows: Array<{ name: string }>) => (err ? reject(err) : resolve(rows))));
    if (!columns.some((column) => column.name === 'ftp_secure')) {
        await new Promise<void>((resolve, reject) => server.db.run('ALTER TABLE servers ADD COLUMN ftp_secure INTEGER', (err) => (err ? reject(err) : resolve())));
    }

    const ids = {
        sftp: await save({ name: 'e2e-sftp', ip: '127.0.0.1', port: sshPort, type: 'linux', username: 'demo', password: 'demo-pass' }),
        ftps: await save({ name: 'e2e-ftps', ip: '127.0.0.1', port: ftpPort, type: 'ftp', username: 'ftpuser', password: 'ftp-pass' }),
        s3: await save({
            name: 'e2e-s3', ip: '', type: 's3', s3_provider: 'other', s3_endpoint: `http://127.0.0.1:${s3Port}`, s3_bucket: 'e2e',
            s3_region: 'us-east-1', s3_access_key: 'shellmind', s3_secret_key: 'shellmind-secret',
        }),
    };
    await new Promise<void>((resolve, reject) => server.db.run('UPDATE servers SET ftp_secure = 1 WHERE id = ?', [ids.ftps], (err) => (err ? reject(err) : resolve())));
    Object.assign(state, ids);
}, 300_000);

const state = { sftp: 0, ftps: 0, s3: 0 };

afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await server?.close();
    for (const container of containers) {
        try { docker('rm', '-f', container); } catch { /* already gone */ }
    }
    vi.restoreAllMocks();
});

describe.skipIf(!enabled)('OpenSSH sftp-server', () => {
    it('starts in the home folder and lists large folders', async () => {
        const socket = await session(state.sftp);
        expect(await ok<FileSessionInfo>(socket, 'files-session')).toMatchObject({ protocol: 'sftp', home: '/home/demo', secure: true });
        const many = await ok<ListResult>(socket, 'files-list', { path: '/home/demo/many' });
        expect(many.entries).toHaveLength(2000);
        expect(many.entries.slice(0, 3).map((e) => e.name)).toEqual(['f1', 'f2', 'f3']);
    });

    it('shows a link to a folder as a folder and deletes only the link', async () => {
        const socket = await session(state.sftp);
        const home = await ok<ListResult>(socket, 'files-list', { path: '/home/demo' });
        expect(home.entries.find((e) => e.name === 'link-to-target')).toMatchObject({ isDir: true, isLink: true });
        const result = await ok<DeleteResult>(socket, 'files-delete', { items: [{ path: '/home/demo/link-to-target', isDir: true, isLink: true }] });
        expect(result).toEqual({ deleted: 1, failures: [], failureCount: 0 });
        expect(await ok<StatResult>(socket, 'files-stat', { path: '/home/demo/target/inside/keep.txt' })).toMatchObject({ stat: { isDir: false } });
    });

    it('streams downloads intact and refuses devices, reads procfs within the limit', async () => {
        const socket = await session(state.sftp);
        const result = await downloadBytes(socket, '/home/demo/random.bin');
        const remote = docker('exec', containers[0], 'sha256sum', '/home/demo/random.bin').split(' ')[0];
        expect(sha256(result.data)).toBe(remote);
        expect((await downloadBytes(socket, '/dev/zero')).error).toMatchObject({ code: 'NOT_A_FILE' });
        const proc = await ok<ReadResult>(socket, 'files-read', { path: '/proc/version' });
        expect(Buffer.from(proc.data as Uint8Array).toString()).toMatch(/Linux version/);
    });

    it('replaces files atomically and keeps their permissions', async () => {
        const socket = await session(state.sftp);
        const data = randomBytes(700_000);
        expect(await uploadBytes(socket, '/home/demo/private.conf', data, { overwrite: true })).toMatchObject({ ok: true });
        const stat = await ok<StatResult>(socket, 'files-stat', { path: '/home/demo/private.conf' });
        expect(stat.stat).toMatchObject({ size: 700_000, permissions: 0o600 });
        const listing = await ok<ListResult>(socket, 'files-list', { path: '/home/demo' });
        expect(listing.entries.filter((e) => e.name.endsWith('.part'))).toEqual([]);
    });

    it('deletes trees recursively after counting them', async () => {
        const socket = await session(state.sftp);
        const items = [{ path: '/home/demo/many', isDir: true }];
        expect(await ok<CountResult>(socket, 'files-count', { items })).toMatchObject({ files: 2000, dirs: 1 });
        expect(await ok<DeleteResult>(socket, 'files-delete', { items })).toEqual({ deleted: 2001, failures: [], failureCount: 0 });
    });
});

describe.skipIf(!enabled)('vsftpd with explicit FTPS', () => {
    it('connects over TLS and works through the queue', async () => {
        const socket = await session(state.ftps);
        expect(await ok<FileSessionInfo>(socket, 'files-session')).toMatchObject({ protocol: 'ftp', transport: 'ftps', secure: true, home: '/home/ftpuser' });
        const [listing, read] = await Promise.all([
            ok<ListResult>(socket, 'files-list', { path: '/home/ftpuser/docs' }),
            ok<ReadResult>(socket, 'files-read', { path: '/home/ftpuser/docs/readme.txt' }),
        ]);
        expect(listing.entries.map((e) => e.name)).toEqual(['readme.txt']);
        expect(listing.entries[0].mtime).toBeGreaterThan(Date.now() / 1000 - 3600);
        expect(Buffer.from(read.data as Uint8Array).toString()).toBe('hello\n');

        const data = randomBytes(1_500_000);
        expect(await uploadBytes(socket, '/home/ftpuser/docs/upload.bin', data)).toMatchObject({ ok: true });
        expect((await downloadBytes(socket, '/home/ftpuser/docs/upload.bin')).data.equals(data)).toBe(true);
        await ok(socket, 'files-rename', { from: '/home/ftpuser/docs/upload.bin', to: '/home/ftpuser/docs/renamed.bin', isDir: false });
        expect(await ok<DeleteResult>(socket, 'files-delete', { items: [{ path: '/home/ftpuser/docs', isDir: true }] })).toEqual({ deleted: 3, failures: [], failureCount: 0 });
    });
});

describe.skipIf(!enabled)('MinIO', () => {
    it('lists past the first page, reads empty objects and warns about http', async () => {
        const socket = await session(state.s3);
        expect(await ok<FileSessionInfo>(socket, 'files-session')).toMatchObject({ protocol: 's3', transport: 'http', secure: false, home: '/' });
        const logs = await ok<ListResult>(socket, 'files-list', { path: '/logs' });
        expect(logs.entries).toHaveLength(1200);
        const empty = await ok<ReadResult>(socket, 'files-read', { path: '/empty.keep' });
        expect(Buffer.from(empty.data as Uint8Array).length).toBe(0);
    });

    it('uploads in parts, renames and deletes whole prefixes', async () => {
        const socket = await session(state.s3);
        const data = randomBytes(12 * 1024 * 1024);
        expect(await uploadBytes(socket, '/big/archive.bin', data)).toMatchObject({ ok: true });
        expect((await downloadBytes(socket, '/big/archive.bin')).data.equals(data)).toBe(true);
        expect(await request(socket, 'files-upload-start', { path: '/big/archive.bin', size: 1, overwrite: false })).toMatchObject({ ok: false, error: { code: 'EXISTS' } });

        await ok(socket, 'files-rename', { from: '/logs', to: '/archive/logs', isDir: true });
        expect((await ok<ListResult>(socket, 'files-list', { path: '/archive/logs' })).entries).toHaveLength(1200);
        expect(await request(socket, 'files-list', { path: '/logs' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(await ok<CountResult>(socket, 'files-count', { items: [{ path: '/archive', isDir: true }] })).toMatchObject({ files: 1200 });
        expect(await ok<DeleteResult>(socket, 'files-delete', { items: [{ path: '/archive', isDir: true }, { path: '/big', isDir: true }] }))
            .toEqual({ deleted: 1201, failures: [], failureCount: 0 });
    });
});
