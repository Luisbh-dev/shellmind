import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppSocket } from '@/lib/socket';
import { FakeFileServer, type FakeSocket } from '../../../test/helpers/fakeFileServer';
import { FileClient, FileClientError, type DownloadSink } from './client';
import { MemorySink } from './saveTarget';

const setup = () => {
    const server = new FakeFileServer();
    const socket = server.connect();
    return { server, socket, client: new FileClient(socket as unknown as AppSocket) };
};

afterEach(() => {
    vi.useRealTimers();
});

describe('FileClient requests', () => {
    it('returns data and throws typed errors', async () => {
        const { server, client } = setup();
        server.tree.set('/srv', []);
        expect(await client.list('/srv')).toEqual({ path: '/srv', entries: [], truncated: false });
        await expect(client.list('/nope')).rejects.toMatchObject({ name: 'FileClientError', code: 'NOT_FOUND' });
        server.handle('files-write', () => ({ ok: false, error: { code: 'CONFLICT', message: 'changed', current: { isDir: false, isLink: false, size: 3, mtime: 9, permissions: 0 } } }));
        const conflict = await client.write('/a', new Uint8Array([1]), { size: 1, mtime: 1 }).catch((error: unknown) => error);
        expect(conflict).toBeInstanceOf(FileClientError);
        expect(conflict).toMatchObject({ code: 'CONFLICT', current: { size: 3 } });
    });

    it('turns an unanswered request into a TIMEOUT error', async () => {
        vi.useFakeTimers();
        const { server, client } = setup();
        server.handle('files-stat', () => new Promise(() => undefined));
        const pending = client.stat('/slow').catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(61_000);
        expect(await pending).toMatchObject({ code: 'TIMEOUT' });
    });
});

describe('FileClient uploads', () => {
    it('keeps a window of chunks in flight and reports progress', async () => {
        const { server, client } = setup();
        let inflight = 0;
        let maxInflight = 0;
        let received = 0;
        server.handle('files-upload-chunk', async (payload) => {
            inflight += 1;
            maxInflight = Math.max(maxInflight, inflight);
            await new Promise((resolve) => setTimeout(resolve, 5));
            inflight -= 1;
            received += (payload.data as ArrayBuffer).byteLength;
            return { ok: true, data: { seq: payload.seq, received } };
        });
        const progress: number[] = [];
        const result = await client.upload(new Blob(['abcdefghijklmnopq']), '/up.txt', { overwrite: false, onProgress: (sent) => progress.push(sent) });
        expect(result).toEqual({ path: '', size: 0 });
        expect(server.requestsOf('files-upload-chunk').map((chunk) => chunk.seq)).toEqual([0, 1, 2, 3, 4]);
        expect(maxInflight).toBe(2);
        expect(progress.at(-1)).toBe(17);
        // Binary payloads, never base64.
        expect(server.requestsOf('files-upload-chunk')[0].data).toBeInstanceOf(ArrayBuffer);
    });

    it('stops at the first failed chunk and cancels the transfer', async () => {
        const { server, client } = setup();
        server.handle('files-upload-chunk', (payload) => payload.seq === 1
            ? { ok: false, error: { code: 'FAILED', message: 'No space left on device' } }
            : { ok: true, data: { seq: payload.seq, received: 4 } });
        await expect(client.upload(new Blob(['x'.repeat(40)]), '/full.bin', { overwrite: true }))
            .rejects.toMatchObject({ code: 'FAILED', message: 'No space left on device' });
        expect(server.requestsOf('files-upload-end')).toEqual([]);
        expect(server.requestsOf('files-upload-cancel')).toHaveLength(1);
    });

    it('cancels on abort', async () => {
        const { server, client } = setup();
        const controller = new AbortController();
        server.handle('files-upload-chunk', async (payload) => {
            controller.abort();
            return { ok: true, data: { seq: payload.seq, received: 4 } };
        });
        await expect(client.upload(new Blob(['y'.repeat(40)]), '/a', { overwrite: false, signal: controller.signal }))
            .rejects.toMatchObject({ code: 'CANCELLED' });
        expect(server.requestsOf('files-upload-cancel')).toHaveLength(1);
    });

    // FE-09: an abort while the start was pending used to be missed, and the
    // whole file was uploaded (an overwrite replaced the remote file).
    it('cancels when aborted while the server opens the upload', async () => {
        for (const content of ['z'.repeat(40), '']) {
            const { server, client } = setup();
            const controller = new AbortController();
            server.handle('files-upload-start', async () => {
                controller.abort();
                return { ok: true, data: { transferId: 'up-1', chunkSize: 4, window: 2 } };
            });
            await expect(client.upload(new Blob([content]), '/a', { overwrite: true, signal: controller.signal }))
                .rejects.toMatchObject({ code: 'CANCELLED' });
            expect(server.requestsOf('files-upload-chunk')).toEqual([]);
            expect(server.requestsOf('files-upload-end')).toEqual([]);
            expect(server.requestsOf('files-upload-cancel')).toEqual([{ transferId: 'up-1' }]);
        }
    });
});

describe('FileClient downloads', () => {
    const start = (server: FakeFileServer, socket: FakeSocket, chunks: Uint8Array[], options: { early?: boolean; fail?: boolean; onStart?: () => void } = {}) => {
        server.handle('files-download-start', () => {
            options.onStart?.();
            const reply = { ok: true as const, data: { transferId: 't1', size: chunks.reduce((n, c) => n + c.length, 0), window: 8 } };
            const push = () => {
                chunks.forEach((data, seq) => socket.fire('files-download-chunk', { transferId: 't1', seq, data: data.slice().buffer }));
                if (options.fail) socket.fire('files-download-error', { transferId: 't1', error: { code: 'PERMISSION_DENIED', message: 'denied' } });
                else socket.fire('files-download-end', { transferId: 't1', bytes: 0 });
            };
            // Early: the chunks arrive before the client saw the reply.
            if (options.early) push();
            else setTimeout(push, 0);
            return reply;
        });
    };

    // A sink whose writes wait until the test lets them through.
    const slowSink = () => {
        const writes: Array<{ bytes: number[]; done: () => void; fail: (error: Error) => void }> = [];
        const sink: DownloadSink & { closed: boolean; aborted: boolean } = {
            closed: false,
            aborted: false,
            write: (chunk) => new Promise<void>((resolve, reject) => { writes.push({ bytes: [...chunk], done: resolve, fail: reject }); }),
            close: async () => { sink.closed = true; },
            abort: async () => { sink.aborted = true; }
        };
        return { sink, writes };
    };
    const acks = (socket: FakeSocket) => socket.emitted.filter((e) => e.event === 'files-download-ack').map((e) => e.payload);

    it('writes acknowledged chunks into the sink', async () => {
        const { server, socket, client } = setup();
        start(server, socket, [new Uint8Array([1, 2]), new Uint8Array([3])]);
        const progress: Array<[number, number | null]> = [];
        const sink = new MemorySink('f');
        expect(await client.download('/f', { sink, onProgress: (n, size) => progress.push([n, size]) })).toBe(3);
        expect([...new Uint8Array(await sink.blob().arrayBuffer())]).toEqual([1, 2, 3]);
        expect(progress).toEqual([[2, 3], [3, 3]]);
        expect(socket.emitted.filter((e) => e.event === 'files-download-ack').map((e) => e.payload)).toEqual([
            { transferId: 't1', seq: 0 }, { transferId: 't1', seq: 1 },
        ]);
    });

    it('keeps chunks that arrive before the start reply', async () => {
        const { server, socket, client } = setup();
        start(server, socket, [new Uint8Array([9, 8, 7])], { early: true });
        const sink = new MemorySink('f');
        await client.download('/f', { sink });
        expect([...new Uint8Array(await sink.blob().arrayBuffer())]).toEqual([9, 8, 7]);
    });

    // FE-13: the download used to collect in memory whatever the size; now a
    // chunk is acknowledged (so the server sends more) only once it is stored.
    it('acknowledges a chunk only once the sink stored it', async () => {
        const { server, socket, client } = setup();
        start(server, socket, [new Uint8Array([1]), new Uint8Array([2])]);
        const { sink, writes } = slowSink();
        const done = client.download('/f', { sink });
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        expect(acks(socket)).toEqual([]);
        writes[0].done();
        await vi.waitFor(() => expect(writes).toHaveLength(2));
        expect(acks(socket)).toEqual([{ transferId: 't1', seq: 0 }]);
        expect(sink.closed).toBe(false);
        writes[1].done();
        expect(await done).toBe(2);
        expect(acks(socket)).toHaveLength(2);
        expect(sink.closed).toBe(true);
        expect(writes.map((write) => write.bytes)).toEqual([[1], [2]]);
    });

    it('cancels the transfer when the sink cannot write', async () => {
        const { server, socket, client } = setup();
        server.handle('files-download-start', () => ({ ok: true, data: { transferId: 't3', size: 10, window: 8 } }));
        const { sink, writes } = slowSink();
        const done = client.download('/f', { sink }).catch((error: unknown) => error);
        await vi.waitFor(() => expect(server.requestsOf('files-download-start')).toHaveLength(1));
        await new Promise((resolve) => setTimeout(resolve, 0));
        socket.fire('files-download-chunk', { transferId: 't3', seq: 0, data: new Uint8Array([1]).buffer });
        await vi.waitFor(() => expect(writes).toHaveLength(1));
        writes[0].fail(new FileClientError({ code: 'FAILED', message: 'disk full' }));
        expect(await done).toMatchObject({ code: 'FAILED', message: 'disk full' });
        expect(sink.aborted).toBe(true);
        expect(socket.emitted.filter((e) => e.event === 'files-download-cancel').map((e) => e.payload)).toEqual([{ transferId: 't3' }]);
        expect(acks(socket)).toEqual([]);
    });

    it('cancels when aborted while the server opens the file', async () => {
        const { server, socket, client } = setup();
        const controller = new AbortController();
        const chunks = [new Uint8Array([1, 2, 3])];
        start(server, socket, chunks, { onStart: () => controller.abort() });
        const sink = new MemorySink('f');
        await expect(client.download('/f', { sink, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(socket.emitted.filter((e) => e.event === 'files-download-cancel').map((e) => e.payload)).toEqual([{ transferId: 't1' }]);
        expect(socket.emitted.filter((e) => e.event === 'files-download-ack')).toEqual([]);
    });

    // The sink may already be a file the browser created next to the target
    // (its swap file): a download that never started must drop it as well.
    it('aborts the sink when the download is refused or cancelled before it starts', async () => {
        const { server, client } = setup();
        server.handle('files-download-start', () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'no such file' } }));
        const refused = slowSink();
        await expect(client.download('/gone.iso', { sink: refused.sink })).rejects.toMatchObject({ code: 'NOT_FOUND' });
        expect(refused.sink.aborted).toBe(true);

        server.handle('files-download-start', () => ({ ok: false, error: { code: 'BUSY', message: 'no free connection' } }));
        const busy = slowSink();
        await expect(client.download('/f', { sink: busy.sink })).rejects.toMatchObject({ code: 'BUSY' });
        expect(busy.sink.aborted).toBe(true);

        const controller = new AbortController();
        controller.abort();
        const cancelled = slowSink();
        await expect(client.download('/f', { sink: cancelled.sink, signal: controller.signal })).rejects.toMatchObject({ code: 'CANCELLED' });
        expect(cancelled.sink.aborted).toBe(true);
        expect(server.requestsOf('files-download-start')).toHaveLength(2);
    });

    it('reports server errors and stalls', async () => {
        const { server, socket, client } = setup();
        start(server, socket, [new Uint8Array([1])], { fail: true });
        const failing = slowSink();
        const failed = client.download('/f', { sink: failing.sink }).catch((error: unknown) => error);
        await vi.waitFor(() => expect(failing.writes).toHaveLength(1));
        expect(await failed).toMatchObject({ code: 'PERMISSION_DENIED' });
        expect(failing.sink.aborted).toBe(true);
        // The server gave up itself: nothing to cancel.
        expect(socket.emitted.filter((e) => e.event === 'files-download-cancel')).toEqual([]);

        vi.useFakeTimers();
        server.handle('files-download-start', () => ({ ok: true, data: { transferId: 't2', size: 10, window: 8 } }));
        const stalled = client.download('/g', { sink: new MemorySink('g') }).catch((error: unknown) => error);
        await vi.advanceTimersByTimeAsync(61_000);
        expect(await stalled).toMatchObject({ code: 'TIMEOUT' });
        expect(socket.emitted.some((e) => e.event === 'files-download-cancel' && (e.payload as { transferId: string }).transferId === 't2')).toBe(true);
    });
});
