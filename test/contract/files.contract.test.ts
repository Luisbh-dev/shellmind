import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { FILE_CHUNK_BYTES, UPLOAD_WINDOW } from '../../shared/files';
import { FileClient, isFileClientError } from '../../src/features/files/client';
import { MemorySink } from '../../src/features/files/saveTarget';
import type { AppSocket } from '../../src/lib/socket';
import { serveSftpDirectory, type SftpDirectoryLog } from '../helpers/sftpDirectory';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The two halves of the file manager protocol together: the UI's FileClient
// (src/features/files/client.ts) against the real backend, over a pooled SSH
// connection to a directory-backed SFTP server. The UI tests use a fake
// server and the backend tests their own client; this keeps them honest.

let server: TestServer;
let harness: SshHarness;
let root: string;
let socket: AppSocket;
let client: FileClient;
const sftpLog: SftpDirectoryLog = [];

const local = (remote: string) => path.join(root, ...remote.split('/').filter(Boolean));
const sha = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-contract-files-'));
    fs.mkdirSync(local('/home/tester'), { recursive: true });
    fs.writeFileSync(local('/home/tester/notes.txt'), 'hello world\n');

    server = await bootTestServer();
    harness = await startSshServer({
        sftp: (sftp) => serveSftpDirectory(sftp, root, { home: '/home/tester' }, sftpLog),
    });
    const created = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'files', ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' }),
    }).then((res) => res.json() as Promise<{ data: { id: number } }>);

    // The UI's socket: typed with the shared protocol maps.
    socket = io(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } }) as AppSocket;
    // Binary attachments arrive as ArrayBuffers, as in the browser (Node's
    // default would be Buffers).
    socket.io.on('open', () => { socket.io.engine.binaryType = 'arraybuffer'; });
    await new Promise<void>((resolve, reject) => {
        socket.once('connection-ready', () => resolve());
        socket.once('ssh-error', (message) => reject(new Error(message)));
        socket.once('connect_error', reject);
        socket.on('connect', () => socket.emit('start-ssh', { serverId: created.data.id, purpose: 'files' }));
    });
    client = new FileClient(socket);
});

afterAll(async () => {
    client?.dispose();
    socket?.disconnect();
    await server?.close();
    await harness?.close();
    fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('FileClient against the real backend', () => {
    it('opens the session and lists the login directory', async () => {
        expect(await client.session()).toMatchObject({ protocol: 'sftp', home: '/home/tester', secure: true });
        const listing = await client.list('/home/tester');
        expect(listing.entries.map((entry) => entry.name)).toEqual(['notes.txt']);
    });

    it('uploads with several chunks in flight, reports progress, and the file arrives intact', async () => {
        // More chunks than the window, and a last partial one.
        const bytes = randomBytes(FILE_CHUNK_BYTES * (UPLOAD_WINDOW + 3) + 1234);
        const progress: number[] = [];
        const result = await client.upload(new Blob([bytes]), '/home/tester/upload.bin', { overwrite: false, onProgress: (sent) => progress.push(sent) });

        expect(result).toEqual({ path: '/home/tester/upload.bin', size: bytes.length });
        expect(sha(fs.readFileSync(local('/home/tester/upload.bin')))).toBe(sha(bytes));
        expect(progress.at(-1)).toBe(bytes.length);
        expect(progress).toEqual([...progress].sort((a, b) => a - b));
        // Nothing temporary is left next to it.
        expect(fs.readdirSync(local('/home/tester')).filter((name) => name.endsWith('.part'))).toEqual([]);
    });

    it('refuses to replace an existing file unless asked, then replaces it', async () => {
        const replace = () => client.upload(new Blob(['v2']), '/home/tester/notes.txt', { overwrite: false });
        const refused = await replace().catch((error: unknown) => error);
        expect(isFileClientError(refused, 'EXISTS')).toBe(true);
        await client.upload(new Blob(['v2']), '/home/tester/notes.txt', { overwrite: true });
        expect(fs.readFileSync(local('/home/tester/notes.txt'), 'utf8')).toBe('v2');
    });

    it('cancels an upload through its signal and leaves nothing behind', async () => {
        const controller = new AbortController();
        const bytes = randomBytes(FILE_CHUNK_BYTES * 12);
        const pending = client.upload(new Blob([bytes]), '/home/tester/cancelled.bin', {
            overwrite: false,
            signal: controller.signal,
            onProgress: () => controller.abort(),
        });
        const error = await pending.catch((failure: unknown) => failure);
        expect(isFileClientError(error, 'CANCELLED')).toBe(true);
        await vi.waitFor(() => expect(fs.readdirSync(local('/home/tester')).filter((name) => name.startsWith('cancelled'))).toEqual([]));
    });

    it('downloads through the acknowledged chunk loop, larger than the window', async () => {
        const bytes = randomBytes(FILE_CHUNK_BYTES * 10 + 77);
        fs.writeFileSync(local('/home/tester/big.bin'), bytes);
        const progress: Array<[number, number | null]> = [];
        const sink = new MemorySink('big.bin');
        const size = await client.download('/home/tester/big.bin', { sink, onProgress: (received, total) => progress.push([received, total]) });

        expect(size).toBe(bytes.length);
        expect(sha(Buffer.from(await sink.blob().arrayBuffer()))).toBe(sha(bytes));
        expect(progress.at(-1)).toEqual([bytes.length, bytes.length]);
    });

    it('reports a download of a missing file as the server\'s error code', async () => {
        const error = await client.download('/home/tester/missing.bin', { sink: new MemorySink('missing.bin') }).catch((failure: unknown) => failure);
        expect(isFileClientError(error, 'NOT_FOUND')).toBe(true);
    });

    it('cancels a download through its signal', async () => {
        fs.writeFileSync(local('/home/tester/many.bin'), randomBytes(FILE_CHUNK_BYTES * 40));
        const controller = new AbortController();
        const pending = client.download('/home/tester/many.bin', {
            sink: new MemorySink('many.bin'),
            signal: controller.signal,
            onProgress: (received) => { if (received > FILE_CHUNK_BYTES) controller.abort(); },
        });
        expect(isFileClientError(await pending.catch((failure: unknown) => failure), 'CANCELLED')).toBe(true);
        // The session is still usable afterwards.
        expect((await client.stat('/home/tester/notes.txt')).stat).toMatchObject({ isDir: false });
    });

    it('saves editor contents only over the version it read', async () => {
        const read = await client.read('/home/tester/notes.txt');
        // Someone else changes the file meanwhile.
        fs.writeFileSync(local('/home/tester/notes.txt'), 'changed elsewhere');
        const version = { size: read.stat.size, mtime: read.stat.mtime };
        const stale = await client.write('/home/tester/notes.txt', new TextEncoder().encode('mine'), version).catch((error: unknown) => error);
        expect(isFileClientError(stale, 'CONFLICT')).toBe(true);
        await client.write('/home/tester/notes.txt', new TextEncoder().encode('mine'), version, true);
        expect(fs.readFileSync(local('/home/tester/notes.txt'), 'utf8')).toBe('mine');
    });

    it('creates, renames, counts and deletes', async () => {
        await client.mkdir('/home/tester/dir');
        await client.upload(new Blob(['a']), '/home/tester/dir/a.txt', { overwrite: false });
        await client.rename('/home/tester/dir', '/home/tester/moved', true);
        expect(await client.count([{ path: '/home/tester/moved', isDir: true }])).toMatchObject({ files: 1, dirs: 1 });
        expect(await client.remove([{ path: '/home/tester/moved', isDir: true }])).toMatchObject({ deleted: 2, failureCount: 0 });
        expect(fs.existsSync(local('/home/tester/moved'))).toBe(false);
    });
});
