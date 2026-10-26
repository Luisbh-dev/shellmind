import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { CountResult, DeleteResult, FileSessionInfo, ListResult, ReadResult } from '../../shared/files';
import { downloadBytes, ok, openFileSession, request, uploadBytes, type FileSocket } from '../helpers/fileClient';
import { startFtpServer, type FtpHarness } from '../helpers/ftpServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The file manager and the FTP virtual shell against an in-process FTP
// server: one queue per connection, transfers on a second connection.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let root: string;
const harnesses: FtpHarness[] = [];
const sockets: Socket[] = [];

const local = (remote: string) => path.join(root, ...remote.split('/').filter(Boolean));
const write = (remote: string, content: string | Buffer) => {
    fs.mkdirSync(path.dirname(local(remote)), { recursive: true });
    fs.writeFileSync(local(remote), content);
};

async function saveFtp(harness: FtpHarness, name: string): Promise<number> {
    const created = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ip: harness.host, port: harness.port, type: 'ftp', username: 'ftpuser', password: 'ftppass' }),
    }).then((res) => res.json() as Promise<{ data: { id: number } }>);
    return created.data.id;
}

async function session(options: Parameters<typeof startFtpServer>[1] = {}): Promise<{ harness: FtpHarness; socket: FileSocket }> {
    const harness = await startFtpServer(root, options);
    harnesses.push(harness);
    const socket = await openFileSession(server, await saveFtp(harness, `ftp-${harness.port}`));
    sockets.push(socket);
    return { harness, socket };
}

async function waitUntil(condition: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const connectionsOf = (harness: FtpHarness, pattern: RegExp) =>
    [...new Set(harness.log.filter((entry) => pattern.test(entry.split(':').slice(1).join(':'))).map((entry) => entry.split(':')[0]))];
const partFiles = (dir: string) => fs.readdirSync(local(dir)).filter((name) => name.endsWith('.part'));

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-ftp-'));
    write('/docs/readme.txt', 'read me\n');
    write('/docs/guide.md', '# guide\n');
    write('/data.bin', randomBytes(600 * 1024));
    server = await bootTestServer();
});

afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await server?.close();
    for (const harness of harnesses) await harness.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('FTP file sessions', () => {
    it('reports plain FTP as an insecure transport', async () => {
        const { socket } = await session();
        expect(await ok<FileSessionInfo>(socket, 'files-session')).toMatchObject({ protocol: 'ftp', transport: 'ftp', secure: false, home: '/' });
    });

    it('lists with real modification times', async () => {
        const { socket } = await session();
        const listing = await ok<ListResult>(socket, 'files-list', { path: '/docs' });
        expect(listing.entries.map((entry) => entry.name)).toEqual(['guide.md', 'readme.txt']);
        const mtime = Math.floor(fs.statSync(local('/docs/readme.txt')).mtimeMs / 1000);
        const listed = listing.entries.find((entry) => entry.name === 'readme.txt')!;
        // LIST has minute precision.
        expect(Math.abs(listed.mtime - mtime)).toBeLessThan(120);
    });

    it('serializes overlapping operations instead of losing the connection', async () => {
        const { harness, socket } = await session();
        const results = await Promise.all([
            request<ListResult>(socket, 'files-list', { path: '/' }),
            request<ReadResult>(socket, 'files-read', { path: '/docs/readme.txt' }),
            request(socket, 'files-stat', { path: '/data.bin' }),
            downloadBytes(socket, '/data.bin'),
            request(socket, 'files-mkdir', { path: '/parallel' }),
            request<ListResult>(socket, 'files-list', { path: '/docs' }),
        ]);
        expect(results.filter((result) => 'ok' in result).every((result) => (result as { ok: boolean }).ok)).toBe(true);
        expect((results[3] as { data: Buffer }).data.equals(fs.readFileSync(local('/data.bin')))).toBe(true);
        expect(fs.statSync(local('/parallel')).isDirectory()).toBe(true);
        // One browsing connection plus one for the transfer.
        expect(harness.connections()).toBe(2);
        expect(connectionsOf(harness, /^RETR /)).not.toEqual(connectionsOf(harness, /^LIST /));
    });

    it('uploads through a temporary name and keeps browsing after a cancel', async () => {
        const { harness, socket } = await session();
        const data = randomBytes(300 * 1024);
        expect(await uploadBytes(socket, '/upload.bin', data)).toMatchObject({ ok: true });
        expect(fs.readFileSync(local('/upload.bin')).equals(data)).toBe(true);
        expect(harness.log.some((entry) => /:STOR \/\.upload\.bin\.shellmind-[0-9a-f]+\.part$/.test(entry))).toBe(true);
        expect(harness.log.some((entry) => /:RNTO \/upload\.bin$/.test(entry))).toBe(true);

        expect(await uploadBytes(socket, '/upload.bin', Buffer.from('other'))).toMatchObject({ ok: false, error: { code: 'EXISTS' } });

        const start = await ok<{ transferId: string }>(socket, 'files-upload-start', { path: '/upload.bin', size: 10_000, overwrite: true });
        await ok(socket, 'files-upload-chunk', { transferId: start.transferId, seq: 0, data: Buffer.alloc(1000, 7) });
        await ok(socket, 'files-upload-cancel', { transferId: start.transferId });
        expect(fs.readFileSync(local('/upload.bin')).equals(data)).toBe(true);
        expect(partFiles('/')).toEqual([]);

        // The browsing connection survived the cancelled transfer.
        const browsing = connectionsOf(harness, /^LIST /);
        expect((await ok<ListResult>(socket, 'files-list', { path: '/' })).entries.length).toBeGreaterThan(0);
        expect(connectionsOf(harness, /^LIST /)).toEqual(browsing);
    });

    it('stops a cancelled download without breaking the session', async () => {
        write('/slow.bin', randomBytes(2 * 1024 * 1024));
        const { socket } = await session({ retrDelayMs: 20 });
        const result = await downloadBytes(socket, '/slow.bin', { cancelAfterChunks: 1 });
        expect(result.cancelled).toBe(true);
        expect((await ok<ReadResult>(socket, 'files-read', { path: '/docs/readme.txt' })).stat.size).toBe(8);
        const again = await downloadBytes(socket, '/docs/guide.md');
        expect(again.data.toString()).toBe('# guide\n');
    });

    it('runs a download, an upload and an editor save side by side', async () => {
        write('/slow-big.bin', randomBytes(2 * 1024 * 1024));
        write('/edit-me.conf', 'a=1\n');
        const { harness, socket } = await session({ retrDelayMs: 40 });
        const finished: string[] = [];
        const download = downloadBytes(socket, '/slow-big.bin').then((result) => { finished.push('download'); return result; });
        await waitUntil(() => harness.log.some((entry) => entry.endsWith(':RETR /slow-big.bin')));

        const opened = await ok<ReadResult>(socket, 'files-read', { path: '/edit-me.conf' });
        await ok(socket, 'files-write', { path: '/edit-me.conf', data: Buffer.from('a=2\n'), expected: { size: opened.stat.size, mtime: opened.stat.mtime } });
        finished.push('save');
        expect(await uploadBytes(socket, '/side.bin', randomBytes(300 * 1024))).toMatchObject({ ok: true });
        finished.push('upload');

        expect((await download).data.equals(fs.readFileSync(local('/slow-big.bin')))).toBe(true);
        expect(finished).toEqual(['save', 'upload', 'download']);
        expect(fs.readFileSync(local('/edit-me.conf'), 'utf8')).toBe('a=2\n');
        // Browsing, the download and the upload: one connection each.
        expect(harness.connections()).toBe(3);
        expect(connectionsOf(harness, /^RETR /)).not.toEqual(connectionsOf(harness, /^STOR \/\.side/));
    });

    it('refuses a transfer as BUSY when the server allows no more connections', async () => {
        write('/slow-two.bin', randomBytes(1024 * 1024));
        const { harness, socket } = await session({ retrDelayMs: 40, maxConnections: 2 });
        const download = downloadBytes(socket, '/slow-two.bin');
        await waitUntil(() => harness.log.some((entry) => entry.endsWith(':RETR /slow-two.bin')));
        expect(await uploadBytes(socket, '/later.bin', Buffer.from('later'))).toMatchObject({ ok: false, error: { code: 'BUSY' } });
        // Editor saves use the browsing connection, which is still free.
        await ok(socket, 'files-write', { path: '/busy-save.txt', data: Buffer.from('saved'), expected: null });
        expect((await download).error).toBeUndefined();
        expect(await uploadBytes(socket, '/later.bin', Buffer.from('later'))).toMatchObject({ ok: true });
        expect(fs.readFileSync(local('/later.bin'), 'utf8')).toBe('later');
    });

    it('answers BUSY at once when a transfer occupies the only connection', async () => {
        // About two seconds of RETR.
        write('/slow-one.bin', randomBytes(3 * 1024 * 1024));
        const { harness, socket } = await session({ retrDelayMs: 40, maxConnections: 1 });
        const download = downloadBytes(socket, '/slow-one.bin');
        await waitUntil(() => harness.log.some((entry) => entry.endsWith(':RETR /slow-one.bin')));
        const started = Date.now();
        expect(await uploadBytes(socket, '/one-more.bin', Buffer.from('x'))).toMatchObject({ ok: false, error: { code: 'BUSY' } });
        expect(await downloadBytes(socket, '/docs/readme.txt')).toMatchObject({ error: { code: 'BUSY' } });
        // Not after the running download: right away.
        expect(Date.now() - started).toBeLessThan(1000);
        expect((await download).data.equals(fs.readFileSync(local('/slow-one.bin')))).toBe(true);
        expect(harness.openConnections()).toBe(1);
    });

    it('uploads directly once a drop box refused to rename an upload into place', async () => {
        const { harness, socket } = await session({ refuseRename: true, refuseDelete: true });
        const first = await uploadBytes(socket, '/dropped.txt', Buffer.from('report'));
        expect(first).toMatchObject({ ok: false, error: { code: 'UNSUPPORTED' } });
        expect(!first.ok && first.error.message).toMatch(/refused to rename .*Uploading it again writes it directly.*could not be removed either/);
        expect(fs.existsSync(local('/dropped.txt'))).toBe(false);

        expect(await uploadBytes(socket, '/dropped.txt', Buffer.from('report'))).toMatchObject({ ok: true });
        expect(fs.readFileSync(local('/dropped.txt'), 'utf8')).toBe('report');
        expect(harness.log.some((entry) => entry.endsWith(':STOR /dropped.txt'))).toBe(true);
        for (const name of partFiles('/')) fs.rmSync(local(`/${name}`));
    });

    it('never removes the old file before the new one is in place', async () => {
        write('/keep.conf', 'old\n');
        const over = await session({ refuseRenameOver: true });
        expect(await uploadBytes(over.socket, '/keep.conf', Buffer.from('new\n'), { overwrite: true })).toMatchObject({ ok: true });
        expect(fs.readFileSync(local('/keep.conf'), 'utf8')).toBe('new\n');
        expect(fs.readdirSync(root).filter((name) => name.startsWith('.keep.conf'))).toEqual([]);

        // No renames at all: the replace fails and the old file stays.
        const none = await session({ refuseRename: true });
        expect(await uploadBytes(none.socket, '/keep.conf', Buffer.from('newer\n'), { overwrite: true })).toMatchObject({ ok: false });
        expect(fs.readFileSync(local('/keep.conf'), 'utf8')).toBe('new\n');
        expect(none.harness.log.some((entry) => entry.endsWith(':DELE /keep.conf'))).toBe(false);
        expect(partFiles('/')).toEqual([]);
    });

    it('sends names with quotes and backslashes unchanged', async () => {
        write('/quotes/ab.txt', 'other file');
        const { harness, socket } = await session();
        const result = await ok<DeleteResult>(socket, 'files-delete', { items: [{ path: '/quotes/a"b.txt', isDir: false }] });
        expect(result.failureCount).toBe(1);
        expect(harness.log.some((entry) => entry.endsWith(':DELE /quotes/a"b.txt'))).toBe(true);
        expect(fs.readFileSync(local('/quotes/ab.txt'), 'utf8')).toBe('other file');
        await request(socket, 'files-stat', { path: '/quotes/back\\slash' });
        expect(harness.log.some((entry) => entry.endsWith(':SIZE /quotes/back\\slash'))).toBe(true);
    });

    it('shares the browsing connection when the server allows only one', async () => {
        const { harness, socket } = await session({ maxConnections: 1 });
        const download = await downloadBytes(socket, '/docs/readme.txt');
        expect(download.data.toString()).toBe('read me\n');
        expect(await uploadBytes(socket, '/docs/one.txt', Buffer.from('single'))).toMatchObject({ ok: true });
        expect(fs.readFileSync(local('/docs/one.txt'), 'utf8')).toBe('single');
        expect((await ok<ListResult>(socket, 'files-list', { path: '/docs' })).entries.map((entry) => entry.name)).toContain('one.txt');
        expect(harness.openConnections()).toBe(1);
    });

    it('counts and deletes folder trees, renames and refuses replacing', async () => {
        write('/tree/a/b/deep.txt', 'deep');
        write('/tree/top.txt', 'top');
        write('/move-me.txt', 'm');
        write('/taken.txt', 't');
        const { socket } = await session();
        const items = [{ path: '/tree', isDir: true }];
        expect(await ok<CountResult>(socket, 'files-count', { items })).toEqual({ files: 2, dirs: 3, bytes: 7, truncated: false });
        expect(await ok<DeleteResult>(socket, 'files-delete', { items })).toEqual({ deleted: 5, failures: [], failureCount: 0 });
        expect(fs.existsSync(local('/tree'))).toBe(false);

        expect(await request(socket, 'files-rename', { from: '/move-me.txt', to: '/taken.txt', isDir: false })).toMatchObject({ ok: false, error: { code: 'EXISTS' } });
        await ok(socket, 'files-rename', { from: '/move-me.txt', to: '/moved.txt', isDir: false });
        expect(fs.readFileSync(local('/moved.txt'), 'utf8')).toBe('m');
        expect(fs.readFileSync(local('/taken.txt'), 'utf8')).toBe('t');
    });

    it('saves editor changes with a conflict check', async () => {
        write('/site.conf', 'listen 80;\n');
        const { socket } = await session();
        const opened = await ok<ReadResult>(socket, 'files-read', { path: '/site.conf' });
        const expected = { size: opened.stat.size, mtime: opened.stat.mtime };
        await ok(socket, 'files-write', { path: '/site.conf', data: Buffer.from('listen 8080;\n'), expected });
        expect(fs.readFileSync(local('/site.conf'), 'utf8')).toBe('listen 8080;\n');
        expect(await request(socket, 'files-write', { path: '/site.conf', data: Buffer.from('x'), expected }))
            .toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    });
});

describe('FTP virtual shell', () => {
    async function terminal(): Promise<{ socket: Socket; output: () => string; waitFor: (needle: string, count?: number) => Promise<void> }> {
        const harness = await startFtpServer(root);
        harnesses.push(harness);
        const id = await saveFtp(harness, `ftp-shell-${harness.port}`);
        const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
        sockets.push(socket);
        let text = '';
        socket.on('ssh-output', (chunk: string) => { text += chunk; });
        await new Promise<void>((resolve) => socket.on('connect', () => {
            socket.once('connection-ready', () => resolve());
            socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        }));
        const waitFor = async (needle: string, count = 1) => {
            const deadline = Date.now() + 10_000;
            while (text.split(needle).length - 1 < count) {
                if (Date.now() > deadline) throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(text)}`);
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        };
        return { socket, output: () => text, waitFor };
    }

    it('runs each line once, in order, even when typing during a command', async () => {
        const shell = await terminal();
        // "cd docs" is still running while "l" and then "s" arrive.
        shell.socket.emit('ssh-input', 'cd docs\r');
        shell.socket.emit('ssh-input', 'l');
        shell.socket.emit('ssh-input', 's\r');
        shell.socket.emit('ssh-input', 'pwd\r');
        await shell.waitFor('ftp> ', 3);
        const text = shell.output();
        expect(text.split('Changed directory to /docs').length - 1).toBe(1);
        expect(text).toMatch(/guide\.md[\s\S]*readme\.txt/);
        expect(text).toContain('/docs\r\n');
        expect(text.indexOf('Changed directory')).toBeLessThan(text.indexOf('guide.md'));
    });

    it('keeps the working directory when cd fails and quotes names with spaces', async () => {
        write('/my folder/file one.txt', 'spaced\n');
        const shell = await terminal();
        shell.socket.emit('ssh-input', 'cd nowhere\r');
        await shell.waitFor('No such directory: /nowhere');
        shell.socket.emit('ssh-input', 'cd "my folder"\r');
        await shell.waitFor('Changed directory to /my folder');
        shell.socket.emit('ssh-input', 'cat "file one.txt"\r');
        await shell.waitFor('spaced');
        shell.socket.emit('ssh-input', 'pwd\r');
        await shell.waitFor('/my folder\r\n');
    });
});
