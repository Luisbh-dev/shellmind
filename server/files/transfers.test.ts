import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadChunk } from '../../shared/files';
import { FsError, type UploadSink } from './remoteFs';
import { DownloadTransfer, TransferRegistry, UploadTransfer } from './transfers';

const sink = (overrides: Partial<UploadSink> = {}): UploadSink & { written: Buffer[] } => {
    const written: Buffer[] = [];
    return {
        written,
        write: vi.fn(async (chunk: Buffer) => { written.push(chunk); }),
        commit: vi.fn(async () => undefined),
        abort: vi.fn(async () => undefined),
        ...overrides,
    };
};

afterEach(() => {
    vi.useRealTimers();
});

describe('UploadTransfer', () => {
    it('writes chunks in order and commits a complete upload', async () => {
        const target = sink();
        const upload = new UploadTransfer('/a', 5, target, () => undefined);
        expect(await upload.chunk(0, Buffer.from('ab'))).toEqual({ seq: 0, received: 2 });
        expect(await upload.chunk(1, Buffer.from('cde'))).toEqual({ seq: 1, received: 5 });
        expect(await upload.end()).toEqual({ path: '/a', size: 5 });
        expect(target.commit).toHaveBeenCalledTimes(1);
        expect(Buffer.concat(target.written).toString()).toBe('abcde');
    });

    it('refuses gaps, overflows and incomplete uploads', async () => {
        const target = sink();
        const upload = new UploadTransfer('/a', 4, target, () => undefined);
        await expect(upload.chunk(1, Buffer.from('a'))).rejects.toMatchObject({ code: 'INVALID' });
        await expect(upload.chunk(0, Buffer.from('abcde'))).rejects.toMatchObject({ code: 'INVALID' });
        await upload.chunk(0, Buffer.from('ab'));
        await expect(upload.end()).rejects.toMatchObject({ code: 'INVALID', message: expect.stringContaining('incomplete') });
        expect(target.commit).not.toHaveBeenCalled();
        expect(target.abort).toHaveBeenCalled();
    });

    it('surfaces write errors on the chunk that hit them', async () => {
        const upload = new UploadTransfer('/a', 4, sink({ write: async () => { throw new FsError('FAILED', 'disk full'); } }), () => undefined);
        await expect(upload.chunk(0, Buffer.from('ab'))).rejects.toMatchObject({ message: 'disk full' });
    });

    it('gives up on an upload that stopped receiving data', async () => {
        vi.useFakeTimers();
        const onIdle = vi.fn();
        new UploadTransfer('/a', 4, sink(), onIdle);
        vi.advanceTimersByTime(119_000);
        expect(onIdle).not.toHaveBeenCalled();
        vi.advanceTimersByTime(2_000);
        expect(onIdle).toHaveBeenCalledTimes(1);
    });
});

describe('DownloadTransfer', () => {
    const start = (window = 2) => {
        const stream = new PassThrough();
        const chunks: DownloadChunk[] = [];
        const emit = { chunk: (chunk: DownloadChunk) => chunks.push(chunk), end: vi.fn(), error: vi.fn() };
        const done = vi.fn();
        const transfer = new DownloadTransfer({ stream, size: null }, emit, done, window);
        return { stream, chunks, emit, done, transfer };
    };

    it('frames data into chunks and pauses the source when the window is full', async () => {
        const { stream, chunks, emit, done, transfer } = start(2);
        transfer.start();
        stream.write(Buffer.alloc(256 * 1024 * 3 + 10, 1));
        await new Promise((resolve) => setImmediate(resolve));
        expect(chunks.map((chunk) => chunk.seq)).toEqual([0, 1, 2]);
        expect(stream.isPaused()).toBe(true);

        transfer.ack(0);
        transfer.ack(1);
        expect(stream.isPaused()).toBe(false);
        stream.end();
        await vi.waitFor(() => expect(emit.end).toHaveBeenCalledWith({ transferId: transfer.id, bytes: 256 * 1024 * 3 + 10 }));
        expect(chunks.at(-1)?.data).toHaveLength(10);
        expect(done).toHaveBeenCalledWith(transfer);
    });

    it('reports source errors, also those raised before it started', async () => {
        const { stream, emit, transfer } = start();
        stream.destroy(new FsError('PERMISSION_DENIED', 'denied'));
        await new Promise((resolve) => setImmediate(resolve));
        transfer.start();
        expect(emit.error).toHaveBeenCalledWith({ transferId: transfer.id, error: { code: 'PERMISSION_DENIED', message: 'denied' } });
    });

    it('ignores stale or unknown acknowledgements', () => {
        const { stream, transfer } = start(1);
        transfer.start();
        stream.write(Buffer.alloc(256 * 1024));
        transfer.ack(5);
        transfer.ack(-1);
        expect(stream.isPaused()).toBe(true);
    });
});

describe('TransferRegistry', () => {
    it('aborts every transfer of a closing session', async () => {
        const registry = new TransferRegistry();
        const target = sink();
        const upload = registry.addUpload('/a', 10, target);
        const download = registry.addDownload({ stream: new PassThrough(), size: 3 }, { chunk: vi.fn(), end: vi.fn(), error: vi.fn() });
        expect(registry.active).toBe(true);
        await registry.abortAll();
        expect(target.abort).toHaveBeenCalled();
        expect(registry.active).toBe(false);
        expect(() => registry.upload(upload.id)).toThrow(/No such upload/);
        expect(registry.download(download.id)).toBeUndefined();
    });
});
