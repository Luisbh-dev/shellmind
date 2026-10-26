import { createHash, randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileClient, isFileClientError } from '../../src/features/files/client';
import { MemorySink } from '../../src/features/files/saveTarget';
import type { AppSocket } from '../../src/lib/socket';
import { bootTestServer, type TestServer } from '../helpers/testServer';
import { startFakeS3, type FakeS3 } from './fakeS3';

// The file manager on an S3-compatible bucket without Docker: the UI's
// FileClient -> the real backend -> the real AWS SDK -> an in-process
// path-style endpoint. Uploads (single PUT and multipart, cancelled ones
// aborted), folders and deletes, which before only ran against MinIO in the
// opt-in end-to-end suite.

vi.setConfig({ testTimeout: 60_000 });

let server: TestServer;
let s3: FakeS3;
let socket: AppSocket;
let client: FileClient;
// The backend uploads in 8 MiB parts (server/files/s3Fs.ts).
const PART = 8 * 1024 * 1024;
const sha = (data: Buffer | Uint8Array) => createHash('sha256').update(data).digest('hex');

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    s3 = await startFakeS3('backups');
    server = await bootTestServer();
    const created = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            name: 'bucket', ip: 's3', type: 's3', s3_provider: 'other', s3_bucket: s3.bucket, s3_region: 'us-east-1',
            s3_endpoint: s3.endpoint, s3_access_key: 'AKIATEST', s3_secret_key: 'secret-key',
        }),
    }).then((res) => res.json() as Promise<{ data: { id: number } }>);

    socket = io(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } }) as AppSocket;
    socket.io.on('open', () => { socket.io.engine.binaryType = 'arraybuffer'; });
    await new Promise<void>((resolve, reject) => {
        socket.once('connection-ready', () => resolve());
        socket.once('ssh-error', (message) => reject(new Error(message)));
        socket.once('connect_error', reject);
        socket.on('connect', () => socket.emit('start-ssh', { serverId: created.data.id, purpose: 'files' }));
    });
    client = new FileClient(socket);
});

beforeEach(() => {
    s3.calls.length = 0;
});

afterAll(async () => {
    client?.dispose();
    socket?.disconnect();
    await server?.close();
    await s3?.close();
    vi.restoreAllMocks();
});

const actions = () => s3.calls.map((call) => `${call.method} ${call.action}`.trim());

describe('FileClient on an S3-compatible bucket', () => {
    it('opens the bucket as an insecure (http) session', async () => {
        expect(await client.session()).toMatchObject({ protocol: 's3', secure: false });
    });

    it('uploads a small file with a single PUT', async () => {
        const bytes = randomBytes(300 * 1024);
        expect(await client.upload(new Blob([bytes]), '/reports/small.bin', { overwrite: false })).toEqual({ path: '/reports/small.bin', size: bytes.length });
        expect(sha(s3.objects.get('reports/small.bin')!)).toBe(sha(bytes));
        expect(actions()).not.toContain('POST uploads');
    });

    it('uploads a large file in parts and completes the multipart upload', async () => {
        const bytes = randomBytes(PART + 512 * 1024);
        const progress: number[] = [];
        await client.upload(new Blob([bytes]), '/backups/db.dump', { overwrite: false, onProgress: (sent) => progress.push(sent) });

        expect(sha(s3.objects.get('backups/db.dump')!)).toBe(sha(bytes));
        expect(actions()).toEqual(expect.arrayContaining(['POST uploads', 'PUT uploadId+partNumber', 'POST uploadId']));
        expect(s3.uploads.size).toBe(0);
        expect(progress.at(-1)).toBe(bytes.length);
    });

    it('refuses to replace an object unless asked', async () => {
        s3.objects.set('reports/keep.txt', Buffer.from('original'));
        const refused = await client.upload(new Blob(['new']), '/reports/keep.txt', { overwrite: false }).catch((error: unknown) => error);
        expect(isFileClientError(refused, 'EXISTS')).toBe(true);
        expect(s3.objects.get('reports/keep.txt')!.toString()).toBe('original');
        await client.upload(new Blob(['new']), '/reports/keep.txt', { overwrite: true });
        expect(s3.objects.get('reports/keep.txt')!.toString()).toBe('new');
    });

    it('aborts the multipart upload of a cancelled transfer and leaves no object', async () => {
        const controller = new AbortController();
        const bytes = randomBytes(2 * PART + 1024);
        const pending = client.upload(new Blob([bytes]), '/backups/cancelled.dump', {
            overwrite: false,
            signal: controller.signal,
            onProgress: (sent) => { if (sent > PART + 1024 * 1024) controller.abort(); },
        });
        expect(isFileClientError(await pending.catch((error: unknown) => error), 'CANCELLED')).toBe(true);
        await vi.waitFor(() => expect(actions()).toContain('DELETE uploadId'), { timeout: 15_000 });
        expect(s3.objects.has('backups/cancelled.dump')).toBe(false);
        expect(s3.uploads.size).toBe(0);
    });

    it('creates folders, lists them, and deletes several items with the Content-MD5 older services require', async () => {
        await client.mkdir('/archive');
        expect(s3.objects.has('archive/')).toBe(true);
        s3.objects.set('archive/2025.tar', Buffer.from('old'));
        s3.objects.set('archive/2026.tar', Buffer.from('new'));
        expect((await client.list('/')).entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['archive', 'backups', 'reports']));

        const result = await client.remove([{ path: '/archive', isDir: true }, { path: '/reports/small.bin', isDir: false }]);
        expect(result).toMatchObject({ failureCount: 0 });
        expect([...s3.objects.keys()].filter((key) => key.startsWith('archive/') || key === 'reports/small.bin')).toEqual([]);
        const deletes = s3.calls.filter((call) => call.action === 'delete');
        expect(deletes.length).toBeGreaterThan(0);
        for (const call of deletes) expect(call.headers['content-md5']).toEqual(expect.any(String));
    });

    it('downloads an object through the acknowledged chunk loop', async () => {
        const bytes = randomBytes(3 * 1024 * 1024 + 5);
        s3.objects.set('backups/restore.bin', bytes);
        const sink = new MemorySink('restore.bin');
        expect(await client.download('/backups/restore.bin', { sink })).toBe(bytes.length);
        expect(sha(Buffer.from(await sink.blob().arrayBuffer()))).toBe(sha(bytes));
    });
});
