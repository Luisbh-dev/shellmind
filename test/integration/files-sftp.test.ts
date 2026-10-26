import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { CountResult, DeleteResult, FileSessionInfo, ListResult, ReadResult, StatResult, WriteResult } from '../../shared/files';
import { downloadBytes, ok, openFileSession, request, uploadBytes, type FileSocket } from '../helpers/fileClient';
import { serveSftpDirectory, type SftpDirectoryLog } from '../helpers/sftpDirectory';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The file manager protocol over SFTP, end to end: socket -> pooled SSH
// connection -> a directory-backed SFTP server.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let harness: SshHarness;
let root: string;
let serverId: number;
let socket: FileSocket;
const sftpLog: SftpDirectoryLog = [];
// Writes to paths containing this marker fail like a full disk.
const FULL_DISK = 'full-disk';
// No new files can be created in folders with this name.
const LOCKED = 'locked-dir';

const local = (remote: string) => path.join(root, ...remote.split('/').filter(Boolean));
const write = (remote: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(local(remote)), { recursive: true });
    fs.writeFileSync(local(remote), content);
};

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-sftp-'));
    write('/home/tester/notes.txt', 'hello world\n');
    write('/home/tester/file10.log', 'ten');
    write('/home/tester/file2.log', 'two');
    write('/home/tester/.hidden', 'secret');
    fs.mkdirSync(local('/home/tester/projects/app/src'), { recursive: true });
    write('/home/tester/projects/app/src/index.ts', 'export {};\n');
    write('/home/tester/projects/app/README.md', '# app\n');
    write('/home/tester/big.bin', randomBytes(2 * 1024 * 1024 + 1));

    server = await bootTestServer();
    harness = await startSshServer({
        sftp: (sftp) => serveSftpDirectory(sftp, root, {
            home: '/home/tester',
            failWrite: (remote, offset) => remote.includes(FULL_DISK) && offset >= 64 * 1024,
            denyCreate: (remote) => remote.includes(`/${LOCKED}/`),
            nameMax: 255,
        }, sftpLog),
    });
    const created = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'sftp', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' }),
    }).then((res) => res.json() as Promise<{ data: { id: number } }>);
    serverId = created.data.id;
    socket = await openFileSession(server, serverId);
});

afterEach(() => {
    sftpLog.length = 0;
});

afterAll(async () => {
    socket?.disconnect();
    await server?.close();
    await harness?.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

const partFiles = (dir: string) => fs.readdirSync(local(dir)).filter((name) => name.endsWith('.part'));

describe('file session', () => {
    it('starts in the login directory and reports a secure transport', async () => {
        expect(await ok<FileSessionInfo>(socket, 'files-session')).toEqual({
            protocol: 'sftp', transport: 'ssh', secure: true, home: '/home/tester', maxEditBytes: 2 * 1024 * 1024,
        });
    });

    it('lists folders first in natural order, with hidden files', async () => {
        const listing = await ok<ListResult>(socket, 'files-list', { path: '/home/tester/' });
        expect(listing.path).toBe('/home/tester');
        expect(listing.truncated).toBe(false);
        expect(listing.entries.map((entry) => entry.name)).toEqual(['projects', '.hidden', 'big.bin', 'file2.log', 'file10.log', 'notes.txt']);
        expect(listing.entries[0]).toMatchObject({ isDir: true, isLink: false, size: 0 });
        expect(listing.entries.find((entry) => entry.name === 'notes.txt')).toMatchObject({ isDir: false, size: 12 });
        expect(listing.entries.every((entry) => entry.mtime > 1_600_000_000)).toBe(true);
    });

    it('answers failures with typed errors instead of empty listings', async () => {
        expect(await request(socket, 'files-list', { path: '/home/tester/missing' })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        expect(await request(socket, 'files-list', { path: 'relative/path' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
        expect(await request(socket, 'files-list', { path: '/tmp\r\nDELE x' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
        // Not a request the protocol allows: the server must refuse it all the same.
        expect(await request(socket, 'files-list', {} as never)).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    });

    it('ignores requests without an acknowledgement and keeps serving', async () => {
        socket.emit('files-list', { path: '/home/tester' });
        socket.emit('files-delete');
        expect((await ok<ListResult>(socket, 'files-list', { path: '/home/tester' })).entries.length).toBeGreaterThan(0);
    });

    it('lists folders with thousands of entries (many READDIR replies)', async () => {
        fs.mkdirSync(local('/home/tester/many'));
        for (let i = 0; i < 2500; i++) fs.writeFileSync(local(`/home/tester/many/log-${i}.txt`), '');
        const listing = await ok<ListResult>(socket, 'files-list', { path: '/home/tester/many' });
        expect(listing.entries).toHaveLength(2500);
        expect(listing.entries.slice(0, 3).map((entry) => entry.name)).toEqual(['log-0.txt', 'log-1.txt', 'log-2.txt']);
        expect(listing.entries.at(-1)?.name).toBe('log-2499.txt');
    });

    it('stats files and missing paths', async () => {
        expect(await ok<StatResult>(socket, 'files-stat', { path: '/home/tester/notes.txt' })).toMatchObject({ stat: { isDir: false, size: 12 } });
        expect(await ok<StatResult>(socket, 'files-stat', { path: '/home/tester/nope' })).toEqual({ path: '/home/tester/nope', stat: null });
    });
});

describe('editor reads and writes', () => {
    it('reads small files and refuses folders and files above the limit', async () => {
        const read = await ok<ReadResult>(socket, 'files-read', { path: '/home/tester/notes.txt' });
        expect(Buffer.from(read.data as Uint8Array).toString()).toBe('hello world\n');
        expect(read.stat).toMatchObject({ size: 12, isDir: false });

        expect(await request(socket, 'files-read', { path: '/home/tester/big.bin' })).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
        expect(await request(socket, 'files-read', { path: '/home/tester/notes.txt', maxBytes: 4 })).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
        expect(await request(socket, 'files-read', { path: '/home/tester/projects' })).toMatchObject({ ok: false, error: { code: 'NOT_A_FILE' } });
    });

    it('saves atomically and refuses to overwrite a file changed in between', async () => {
        write('/home/tester/app.conf', 'port=80\n');
        const opened = await ok<ReadResult>(socket, 'files-read', { path: '/home/tester/app.conf' });
        const expected = { size: opened.stat.size, mtime: opened.stat.mtime };

        const saved = await ok<WriteResult>(socket, 'files-write', { path: '/home/tester/app.conf', data: Buffer.from('port=8080\n'), expected });
        expect(fs.readFileSync(local('/home/tester/app.conf'), 'utf8')).toBe('port=8080\n');
        expect(saved.stat).toMatchObject({ size: 10 });
        expect(sftpLog.some((entry) => /^open:wx:\/home\/tester\/\.app\.conf\.shellmind-[0-9a-f]+\.part$/.test(entry))).toBe(true);
        expect(partFiles('/home/tester')).toEqual([]);

        // Someone else edits the file: the old version no longer matches.
        write('/home/tester/app.conf', 'port=9090 # edited elsewhere\n');
        const conflict = await request(socket, 'files-write', { path: '/home/tester/app.conf', data: Buffer.from('port=1\n'), expected });
        expect(conflict).toMatchObject({ ok: false, error: { code: 'CONFLICT', current: { size: 29 } } });
        expect(fs.readFileSync(local('/home/tester/app.conf'), 'utf8')).toBe('port=9090 # edited elsewhere\n');

        await ok(socket, 'files-write', { path: '/home/tester/app.conf', data: Buffer.from('port=1\n'), expected, force: true });
        expect(fs.readFileSync(local('/home/tester/app.conf'), 'utf8')).toBe('port=1\n');
    });

    it('creates new files only when the path is free', async () => {
        await ok(socket, 'files-write', { path: '/home/tester/new.txt', data: Buffer.from('fresh'), expected: null });
        expect(fs.readFileSync(local('/home/tester/new.txt'), 'utf8')).toBe('fresh');
        expect(await request(socket, 'files-write', { path: '/home/tester/new.txt', data: Buffer.from('again'), expected: null }))
            .toMatchObject({ ok: false, error: { code: 'EXISTS' } });
    });
});

describe('uploads', () => {
    it('streams chunks through a temporary file and moves it into place', async () => {
        const data = randomBytes(1024 * 1024 + 123);
        const result = await uploadBytes(socket, '/home/tester/upload.bin', data);
        expect(result).toEqual({ ok: true, data: { path: '/home/tester/upload.bin', size: data.length } });
        expect(fs.readFileSync(local('/home/tester/upload.bin')).equals(data)).toBe(true);
        expect(sftpLog.filter((entry) => entry.startsWith('rename:'))).toEqual([
            expect.stringMatching(/^rename:\/home\/tester\/\.upload\.bin\.shellmind-[0-9a-f]+\.part->\/home\/tester\/upload\.bin$/),
        ]);
        expect(partFiles('/home/tester')).toEqual([]);
    });

    it('refuses to replace an existing file unless asked to', async () => {
        write('/home/tester/keep.txt', 'original');
        const refused = await uploadBytes(socket, '/home/tester/keep.txt', Buffer.from('replacement'));
        expect(refused).toMatchObject({ ok: false, error: { code: 'EXISTS' } });
        expect(fs.readFileSync(local('/home/tester/keep.txt'), 'utf8')).toBe('original');

        expect(await uploadBytes(socket, '/home/tester/keep.txt', Buffer.from('replacement'), { overwrite: true })).toMatchObject({ ok: true });
        expect(fs.readFileSync(local('/home/tester/keep.txt'), 'utf8')).toBe('replacement');
        expect(partFiles('/home/tester')).toEqual([]);
    });

    it('reports a failed remote write and leaves the original file untouched', async () => {
        write(`/home/tester/${FULL_DISK}.dat`, 'precious');
        const result = await uploadBytes(socket, `/home/tester/${FULL_DISK}.dat`, randomBytes(512 * 1024), { overwrite: true });
        expect(result).toMatchObject({ ok: false, error: { code: 'FAILED', message: expect.stringMatching(/No space left on device/) } });
        expect(fs.readFileSync(local(`/home/tester/${FULL_DISK}.dat`), 'utf8')).toBe('precious');
        await vi.waitFor(() => expect(partFiles('/home/tester')).toEqual([]));
    });

    it('removes the partial file when an upload is cancelled', async () => {
        write('/home/tester/cancel-me.txt', 'still here');
        const start = await ok<{ transferId: string }>(socket, 'files-upload-start', { path: '/home/tester/cancel-me.txt', size: 1000, overwrite: true });
        await ok(socket, 'files-upload-chunk', { transferId: start.transferId, seq: 0, data: Buffer.alloc(100, 1) });
        expect(partFiles('/home/tester')).toHaveLength(1);
        await ok(socket, 'files-upload-cancel', { transferId: start.transferId });
        expect(partFiles('/home/tester')).toEqual([]);
        expect(fs.readFileSync(local('/home/tester/cancel-me.txt'), 'utf8')).toBe('still here');
        expect(await request(socket, 'files-upload-end', { transferId: start.transferId })).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    });

    it('overwrites in place only when the user accepted it (the folder is not writable)', async () => {
        write(`/home/tester/${LOCKED}/app.conf`, 'v1');
        const refused = await uploadBytes(socket, `/home/tester/${LOCKED}/app.conf`, Buffer.from('v2 from upload'), { overwrite: true });
        expect(refused).toMatchObject({ ok: false, error: { code: 'NOT_ATOMIC', message: expect.stringMatching(/not writable/) } });
        expect(fs.readFileSync(local(`/home/tester/${LOCKED}/app.conf`), 'utf8')).toBe('v1');
        expect(sftpLog.some((entry) => entry === `open:w:/home/tester/${LOCKED}/app.conf`)).toBe(false);

        expect(await uploadBytes(socket, `/home/tester/${LOCKED}/app.conf`, Buffer.from('v2 from upload'), { overwrite: true, inPlace: true })).toMatchObject({ ok: true });
        expect(fs.readFileSync(local(`/home/tester/${LOCKED}/app.conf`), 'utf8')).toBe('v2 from upload');

        // An editor save sends everything at once: it may write in place.
        const opened = await ok<ReadResult>(socket, 'files-read', { path: `/home/tester/${LOCKED}/app.conf` });
        await ok(socket, 'files-write', { path: `/home/tester/${LOCKED}/app.conf`, data: Buffer.from('v3'), expected: { size: opened.stat.size, mtime: opened.stat.mtime } });
        expect(fs.readFileSync(local(`/home/tester/${LOCKED}/app.conf`), 'utf8')).toBe('v3');
        expect(fs.readdirSync(local(`/home/tester/${LOCKED}`))).toEqual(['app.conf']);
    });

    it('rejects chunks out of order or beyond the announced size', async () => {
        const start = await ok<{ transferId: string }>(socket, 'files-upload-start', { path: '/home/tester/order.txt', size: 4, overwrite: false });
        expect(await request(socket, 'files-upload-chunk', { transferId: start.transferId, seq: 1, data: Buffer.from('ab') }))
            .toMatchObject({ ok: false, error: { code: 'INVALID' } });
        expect(fs.existsSync(local('/home/tester/order.txt'))).toBe(false);
        await vi.waitFor(() => expect(partFiles('/home/tester')).toEqual([]));

        const again = await ok<{ transferId: string }>(socket, 'files-upload-start', { path: '/home/tester/order.txt', size: 2, overwrite: false });
        expect(await request(socket, 'files-upload-chunk', { transferId: again.transferId, seq: 0, data: Buffer.from('abc') }))
            .toMatchObject({ ok: false, error: { code: 'INVALID' } });
    });

    // BC-12: the temporary name of a 231-255 byte name used to be too long.
    it('uploads and saves files whose names are as long as names may be', async () => {
        const name = `${'n'.repeat(236)}.txt`;
        const remote = `/home/tester/${name}`;
        expect(await uploadBytes(socket, remote, Buffer.from('long name'))).toMatchObject({ ok: true });
        expect(fs.readFileSync(local(remote), 'utf8')).toBe('long name');

        const opened = await ok<ReadResult>(socket, 'files-read', { path: remote });
        await ok(socket, 'files-write', { path: remote, data: Buffer.from('saved'), expected: { size: opened.stat.size, mtime: opened.stat.mtime } });
        expect(fs.readFileSync(local(remote), 'utf8')).toBe('saved');
        expect(sftpLog.filter((entry) => entry.startsWith('open-refused:'))).toEqual([]);
        expect(partFiles('/home/tester')).toEqual([]);

        // 128 characters but 256 bytes: refused before anything is opened.
        const opens = sftpLog.filter((entry) => entry.startsWith('open')).length;
        const tooLong = await uploadBytes(socket, `/home/tester/${'é'.repeat(128)}`, Buffer.from('x'));
        expect(tooLong).toMatchObject({ ok: false, error: { code: 'INVALID' } });
        expect(sftpLog.filter((entry) => entry.startsWith('open'))).toHaveLength(opens);
    });

    // BC-11: a start refused by the limit used to open (and leak) its temporary file first.
    it('refuses uploads beyond the per-session limit without leaving a temporary file', async () => {
        const started: Array<{ transferId: string }> = [];
        for (let i = 0; i < 8; i++) {
            started.push(await ok<{ transferId: string }>(socket, 'files-upload-start', { path: `/home/tester/limit-${i}.bin`, size: 10, overwrite: false }));
        }
        expect(partFiles('/home/tester')).toHaveLength(8);
        const refused = await request(socket, 'files-upload-start', { path: '/home/tester/limit-8.bin', size: 10, overwrite: false });
        expect(refused).toMatchObject({ ok: false, error: { message: expect.stringMatching(/Too many uploads/) } });
        expect(partFiles('/home/tester')).toHaveLength(8);
        expect(sftpLog.filter((entry) => entry.includes('limit-8'))).toEqual([]);

        for (const { transferId } of started) await ok(socket, 'files-upload-cancel', { transferId });
        expect(partFiles('/home/tester')).toEqual([]);
    });
});

describe('downloads', () => {
    it('streams a file in acknowledged chunks within the window', async () => {
        const data = randomBytes(3 * 1024 * 1024 + 7);
        write('/home/tester/download.bin', data);
        const result = await downloadBytes(socket, '/home/tester/download.bin', { delayAckMs: 5 });
        expect(result.error).toBeUndefined();
        expect(result.data.equals(data)).toBe(true);
        expect(result.chunks).toBe(Math.ceil(data.length / (256 * 1024)));
        expect(result.maxUnacked).toBeLessThanOrEqual(8);
    });

    it('downloads empty files and refuses folders', async () => {
        write('/home/tester/empty.txt', '');
        const empty = await downloadBytes(socket, '/home/tester/empty.txt');
        expect(empty.error).toBeUndefined();
        expect(empty.chunks).toBe(0);
        expect((await downloadBytes(socket, '/home/tester/projects')).error).toMatchObject({ code: 'NOT_A_FILE' });
    });

    it('stops sending once a download is cancelled', async () => {
        write('/home/tester/long.bin', randomBytes(4 * 1024 * 1024));
        const result = await downloadBytes(socket, '/home/tester/long.bin', { cancelAfterChunks: 2 });
        expect(result.cancelled).toBe(true);
        let late = 0;
        socket.on('files-download-chunk', () => { late += 1; });
        await new Promise((resolve) => setTimeout(resolve, 300));
        socket.off('files-download-chunk');
        expect(late).toBe(0);
    });
});

describe('folders, renames and deletes', () => {
    it('creates folders and refuses duplicates and bad names', async () => {
        expect(await ok(socket, 'files-mkdir', { path: '/home/tester/new-folder' })).toEqual({ path: '/home/tester/new-folder' });
        expect(fs.statSync(local('/home/tester/new-folder')).isDirectory()).toBe(true);
        expect(await request(socket, 'files-mkdir', { path: '/home/tester/new-folder' })).toMatchObject({ ok: false, error: { code: 'EXISTS' } });
        expect(await request(socket, 'files-mkdir', { path: '/' })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    });

    it('renames, refusing to replace or to move a folder into itself', async () => {
        write('/home/tester/a.txt', 'a');
        write('/home/tester/b.txt', 'b');
        expect(await ok(socket, 'files-rename', { from: '/home/tester/a.txt', to: '/home/tester/c.txt', isDir: false }))
            .toEqual({ from: '/home/tester/a.txt', to: '/home/tester/c.txt' });
        expect(await request(socket, 'files-rename', { from: '/home/tester/c.txt', to: '/home/tester/b.txt', isDir: false }))
            .toMatchObject({ ok: false, error: { code: 'EXISTS' } });
        expect(await request(socket, 'files-rename', { from: '/home/tester/projects', to: '/home/tester/projects/inner', isDir: true }))
            .toMatchObject({ ok: false, error: { code: 'INVALID' } });
        expect(fs.readFileSync(local('/home/tester/b.txt'), 'utf8')).toBe('b');
    });

    it('counts and deletes whole trees in one request', async () => {
        fs.mkdirSync(local('/home/tester/tree/a/b'), { recursive: true });
        write('/home/tester/tree/one.txt', '1');
        write('/home/tester/tree/a/two.txt', '22');
        write('/home/tester/tree/a/b/three.txt', '333');
        write('/home/tester/single.txt', 'x');
        const items = [{ path: '/home/tester/tree', isDir: true }, { path: '/home/tester/single.txt', isDir: false }];

        expect(await ok<CountResult>(socket, 'files-count', { items })).toEqual({ files: 4, dirs: 3, bytes: 7, truncated: false });
        expect(await ok<DeleteResult>(socket, 'files-delete', { items })).toEqual({ deleted: 7, failures: [], failureCount: 0 });
        expect(fs.existsSync(local('/home/tester/tree'))).toBe(false);
        expect(fs.existsSync(local('/home/tester/single.txt'))).toBe(false);
    });

    it('treats already deleted items as deleted and refuses the root', async () => {
        expect(await ok<DeleteResult>(socket, 'files-delete', { items: [{ path: '/home/tester/gone', isDir: false }] }))
            .toEqual({ deleted: 0, failures: [], failureCount: 0 });
        expect(await request(socket, 'files-delete', { items: [{ path: '/', isDir: true }] })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
        expect(await request(socket, 'files-delete', { items: [] })).toMatchObject({ ok: false, error: { code: 'INVALID' } });
    });
});

describe('without a file session', () => {
    it('answers NOT_CONNECTED', async () => {
        const { io } = await import('socket.io-client');
        const bare = io(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
        await new Promise<void>((resolve) => bare.once('connect', () => resolve()));
        try {
            expect(await request(bare, 'files-list', { path: '/' })).toMatchObject({ ok: false, error: { code: 'NOT_CONNECTED' } });
            expect(await request(bare, 'files-upload-chunk', { transferId: 'x', seq: 0, data: Buffer.from('a') }))
                .toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
        } finally {
            bare.disconnect();
        }
    });
});
