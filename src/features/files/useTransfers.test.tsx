import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { act, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { setLanguage, t } from '@/i18n';
import type { AppSocket } from '@/lib/socket';
import { FakeFileServer } from '../../../test/helpers/fakeFileServer';
import { FileClient, FileClientError, type DownloadOptions, type UploadOptions } from './client';
import { MEMORY_DOWNLOAD_LIMIT } from './saveTarget';
import { TransferDock } from './TransferDock';
import { useTransfers, type TransferJob } from './useTransfers';

type Deferred = { resolve: () => void; reject: (error: unknown) => void; options: UploadOptions };

function fakeClient() {
    const uploads: Deferred[] = [];
    const client = {
        upload: vi.fn((_file: Blob, _path: string, options: UploadOptions) => new Promise((resolve, reject) => {
            const entry: Deferred = { resolve: () => resolve({ path: _path, size: 1 }), reject, options };
            options.signal?.addEventListener('abort', () => reject(new FileClientError({ code: 'CANCELLED', message: 'Cancelled' })));
            uploads.push(entry);
        })),
        // Writes "data" into the sink, like a 4-byte download.
        download: vi.fn(async (_path: string, options: DownloadOptions) => {
            await options.sink.write(new TextEncoder().encode('data'));
            await options.sink.close();
            return 4;
        })
    };
    return { client: client as unknown as FileClient, uploads, mock: client };
}

const file = (name: string) => new File(['x'], name);

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('useTransfers', () => {
    it('runs uploads one after another and lets finished jobs leave on their own', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { client, uploads, mock } = fakeClient();
        const onUploaded = vi.fn();
        const { result } = renderHook(() => useTransfers(client, { onUploaded }));

        act(() => result.current.upload([{ file: file('a'), path: '/a', overwrite: false }, { file: file('b'), path: '/b', overwrite: true }]));
        await waitFor(() => expect(mock.upload).toHaveBeenCalledTimes(1));
        expect(result.current.jobs.map((job) => job.status)).toEqual(['running', 'queued']);

        await act(async () => uploads[0].resolve());
        await waitFor(() => expect(mock.upload).toHaveBeenCalledTimes(2));
        expect(mock.upload.mock.calls[1][2]).toMatchObject({ overwrite: true });
        expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ path: '/a' }));

        // A new batch while "a" lingers as done: nothing wipes it.
        act(() => result.current.upload([{ file: file('c'), path: '/c', overwrite: false }]));
        expect(result.current.jobs.map((job) => [job.name, job.status])).toEqual([['a', 'done'], ['b', 'running'], ['c', 'queued']]);

        await act(async () => { await vi.advanceTimersByTimeAsync(5100); });
        expect(result.current.jobs.map((job) => job.name)).toEqual(['b', 'c']);
    });

    it('cancels, reports failures and retries', async () => {
        const { client, uploads, mock } = fakeClient();
        const { result } = renderHook(() => useTransfers(client));
        act(() => result.current.upload([{ file: file('a'), path: '/a', overwrite: false }, { file: file('b'), path: '/b', overwrite: false }]));
        await waitFor(() => expect(uploads).toHaveLength(1));

        act(() => result.current.cancel(result.current.jobs[0].id));
        await waitFor(() => expect(result.current.jobs[0].status).toBe('cancelled'));
        await waitFor(() => expect(uploads).toHaveLength(2));
        await act(async () => uploads[1].reject(new FileClientError({ code: 'EXISTS', message: '/b already exists' })));
        await waitFor(() => expect(result.current.jobs[1]).toMatchObject({ status: 'error', error: { code: 'EXISTS', message: '/b already exists' } }));

        act(() => result.current.retry(result.current.jobs[0].id));
        await waitFor(() => expect(mock.upload).toHaveBeenCalledTimes(3));
        act(() => result.current.clearFinished());
        expect(result.current.jobs.map((job) => job.name)).toEqual(['a']);
    });

    it('waits when the server has no free connection, then runs one transfer at a time', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        const { client, uploads, mock } = fakeClient();
        const downloads: Array<() => void> = [];
        mock.download
            .mockRejectedValueOnce(new FileClientError({ code: 'BUSY', message: 'busy' }))
            .mockImplementation(() => new Promise<number>((resolve) => downloads.push(() => resolve(1))));
        const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
        URL.createObjectURL = vi.fn(() => 'blob:fake');
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        onTestFinished(() => {
            click.mockRestore();
            URL.createObjectURL = original.create;
            URL.revokeObjectURL = original.revoke;
        });
        const { result } = renderHook(() => useTransfers(client));

        act(() => result.current.upload([{ file: file('up'), path: '/up', overwrite: false }]));
        act(() => result.current.download([{ path: '/down', name: 'down', size: 1 }]));
        await waitFor(() => expect(result.current.jobs.map((job) => job.status)).toEqual(['running', 'waiting']));

        // Back in the queue after a pause, but not while the upload runs.
        await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
        expect(result.current.jobs.map((job) => job.status)).toEqual(['running', 'queued']);
        expect(mock.download).toHaveBeenCalledTimes(1);

        await act(async () => uploads[0].resolve());
        await waitFor(() => expect(mock.download).toHaveBeenCalledTimes(2));
        await act(async () => downloads[0]());
        await waitFor(() => expect(result.current.jobs.map((job) => job.status)).toEqual(['done', 'done']));
    });

    it('retries an upload refused as not atomic only when asked, overwriting in place', async () => {
        const { client, uploads, mock } = fakeClient();
        const { result } = renderHook(() => useTransfers(client));
        act(() => result.current.upload([{ file: file('app.bin'), path: '/opt/app.bin', overwrite: true }]));
        await waitFor(() => expect(uploads).toHaveLength(1));
        await act(async () => uploads[0].reject(new FileClientError({ code: 'NOT_ATOMIC', message: '/opt is not writable' })));
        await waitFor(() => expect(result.current.jobs[0].error?.code).toBe('NOT_ATOMIC'));
        expect(mock.upload.mock.calls[0][2]).toMatchObject({ inPlace: undefined });

        act(() => result.current.retry(result.current.jobs[0].id, { inPlace: true }));
        await waitFor(() => expect(mock.upload).toHaveBeenCalledTimes(2));
        expect(mock.upload.mock.calls[1][2]).toMatchObject({ overwrite: true, inPlace: true });
    });

    it('saves downloads through an object URL, never a data: URL', async () => {
        // jsdom has no object URLs.
        const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
        const createObjectURL = vi.fn(() => 'blob:fake');
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        try {
            const { client } = fakeClient();
            const { result } = renderHook(() => useTransfers(client));
            act(() => result.current.download([{ path: '/srv/a.log', name: 'a.log', size: 4 }]));
            await waitFor(() => expect(result.current.jobs[0]?.status).toBe('done'));
            expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
            expect(click).toHaveBeenCalled();
        } finally {
            click.mockRestore();
            URL.createObjectURL = original.create;
            URL.revokeObjectURL = original.revoke;
        }
    });
});

// FE-13 / perf-download-buffered-in-renderer: downloads used to collect in
// renderer memory whatever their size.
describe('where downloads are saved', () => {
    type Writable = { chunks: number[][]; closed: boolean; aborted: boolean };

    function fakeFile(writable: Writable) {
        return {
            createWritable: vi.fn(async () => ({
                write: async (chunk: Uint8Array) => { writable.chunks.push([...chunk]); },
                close: async () => { writable.closed = true; },
                abort: async () => { writable.aborted = true; }
            }))
        };
    }

    function stubPickers(options: { save?: (options?: unknown) => Promise<unknown> }) {
        const showSaveFilePicker = vi.fn(options.save ?? (async () => { throw new DOMException('no', 'AbortError'); }));
        vi.stubGlobal('showSaveFilePicker', showSaveFilePicker);
        return { showSaveFilePicker };
    }

    function stubObjectUrls() {
        const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
        const createObjectURL = vi.fn(() => 'blob:fake');
        URL.createObjectURL = createObjectURL;
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        onTestFinished(() => {
            click.mockRestore();
            URL.createObjectURL = original.create;
            URL.revokeObjectURL = original.revoke;
        });
        return createObjectURL;
    }

    it('streams a large download into the file the user picked, not into memory', async () => {
        const writable: Writable = { chunks: [], closed: false, aborted: false };
        const pickers = stubPickers({ save: async () => fakeFile(writable) });
        const createObjectURL = stubObjectUrls();
        const { client, mock } = fakeClient();
        const { result } = renderHook(() => useTransfers(client));

        act(() => result.current.download([{ path: '/backup/db.dump', name: 'db.dump', size: 5 * 1024 ** 3 }]));
        await waitFor(() => expect(result.current.jobs[0]?.status).toBe('done'));
        expect(pickers.showSaveFilePicker).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: 'db.dump' }));
        expect(writable).toEqual({ chunks: [[...new TextEncoder().encode('data')]], closed: true, aborted: false });
        expect(mock.download).toHaveBeenCalledTimes(1);
        expect(createObjectURL).not.toHaveBeenCalled();
    });

    // createWritable() already made the browser's swap file next to the
    // picked one: a download refused (or cancelled) before it starts must
    // drop it rather than leave it in the user's folder.
    it('drops the picked file when the download cannot start', async () => {
        const writable: Writable = { chunks: [], closed: false, aborted: false };
        stubPickers({ save: async () => fakeFile(writable) });
        const server = new FakeFileServer();
        server.handle('files-download-start', () => ({ ok: false, error: { code: 'NOT_FOUND', message: 'no such file or folder' } }));
        const client = new FileClient(server.connect() as unknown as AppSocket);
        const { result } = renderHook(() => useTransfers(client));

        act(() => result.current.download([{ path: '/srv/vanishing.iso', name: 'vanishing.iso', size: 70 * 1024 ** 2 }]));
        await waitFor(() => expect(result.current.jobs[0]?.status).toBe('error'));
        expect(result.current.jobs[0].error).toMatchObject({ code: 'NOT_FOUND' });
        expect(writable).toEqual({ chunks: [], closed: false, aborted: true });
    });

    it('downloads small files as before, and nothing when the picker is closed', async () => {
        const pickers = stubPickers({});
        const createObjectURL = stubObjectUrls();
        const { client, mock } = fakeClient();
        const { result } = renderHook(() => useTransfers(client));

        act(() => result.current.download([{ path: '/srv/a.log', name: 'a.log', size: 4 }]));
        await waitFor(() => expect(result.current.jobs[0]?.status).toBe('done'));
        expect(pickers.showSaveFilePicker).not.toHaveBeenCalled();
        expect(createObjectURL).toHaveBeenCalledTimes(1);

        act(() => result.current.download([{ path: '/srv/big.iso', name: 'big.iso', size: 4 * 1024 ** 3 }]));
        await waitFor(() => expect(pickers.showSaveFilePicker).toHaveBeenCalledTimes(1));
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(result.current.jobs).toHaveLength(1);
        expect(mock.download).toHaveBeenCalledTimes(1);
    });

    it('picks the first large file of a batch right away, and each further one with a click of its own', async () => {
        const files = new Map<string, Writable>();
        const pickers = stubPickers({
            save: async (options?: unknown) => {
                const name = (options as { suggestedName: string }).suggestedName;
                files.set(name, { chunks: [], closed: false, aborted: false });
                return fakeFile(files.get(name)!);
            }
        });
        const createObjectURL = stubObjectUrls();
        const { client, mock } = fakeClient();
        const { result } = renderHook(() => useTransfers(client));

        act(() => result.current.download([
            { path: '/logs/a.log', name: 'a.log', size: 100 * 1024 ** 2 },
            { path: '/logs/b.log', name: 'b.log', size: 200 * 1024 ** 2 },
            { path: '/logs/c.txt', name: 'c.txt', size: 10 }
        ]));
        await waitFor(() => expect(result.current.jobs.map((job) => job.status)).toEqual(['done', 'queued', 'done']));
        expect(pickers.showSaveFilePicker).toHaveBeenCalledTimes(1);
        expect(files.get('a.log')).toMatchObject({ closed: true, chunks: [[...new TextEncoder().encode('data')]] });
        expect(result.current.jobs[1].target).toEqual({ kind: 'ask' });
        expect(createObjectURL).toHaveBeenCalledTimes(1);
        expect(mock.download.mock.calls.map((call) => call[0])).toEqual(['/logs/a.log', '/logs/c.txt']);

        act(() => result.current.chooseTarget(result.current.jobs[1].id));
        await waitFor(() => expect(result.current.jobs[1].status).toBe('done'));
        expect(pickers.showSaveFilePicker).toHaveBeenLastCalledWith(expect.objectContaining({ suggestedName: 'b.log' }));
        expect(files.get('b.log')?.closed).toBe(true);
        expect(createObjectURL).toHaveBeenCalledTimes(1);
    });

    it('refuses what does not fit in memory when the browser cannot write files, and says why', async () => {
        const createObjectURL = stubObjectUrls();
        const { client, mock } = fakeClient();
        const { result } = renderHook(() => useTransfers(client));
        act(() => result.current.download([{ path: '/vm/disk.img', name: 'disk.img', size: MEMORY_DOWNLOAD_LIMIT + 1 }]));
        await waitFor(() => expect(result.current.jobs[0]?.status).toBe('error'));
        expect(result.current.jobs[0].error).toMatchObject({ code: 'TOO_LARGE', message: expect.stringMatching(/^disk\.img is 1 GB: too large to download here/) });
        expect(result.current.jobs[0].error?.message).toContain('save large files straight to disk');
        expect(mock.download).not.toHaveBeenCalled();
        expect(createObjectURL).not.toHaveBeenCalled();
    });
});

describe('TransferDock', () => {
    const job = (overrides: Partial<TransferJob>): TransferJob => ({
        id: overrides.name ?? 'x', kind: 'upload', name: 'x', path: '/x', size: 200, loaded: 50, status: 'running', ...overrides,
    });

    it('shows progress and per-job actions', () => {
        setLanguage('en');
        const handlers = { onCancel: vi.fn(), onRetry: vi.fn(), onChooseTarget: vi.fn(), onDismiss: vi.fn(), onClearFinished: vi.fn() };
        render(<TransferDock jobs={[
            job({ name: 'big.iso' }),
            job({ name: 'bad.txt', status: 'error', error: { code: 'PERMISSION_DENIED', message: '/srv/bad.txt: permission denied' } }),
            job({ name: 'ok.txt', kind: 'download', status: 'done' })
        ]} {...handlers} />);

        expect(screen.getByRole('region', { name: 'Transfers' })).toBeInTheDocument();
        expect(screen.getByRole('progressbar', { name: 'big.iso: 25%' })).toHaveAttribute('aria-valuenow', '25');
        expect(screen.getByText('Permission denied: /srv/bad.txt: permission denied')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Cancel big.iso' }));
        fireEvent.click(screen.getByRole('button', { name: 'Retry bad.txt' }));
        fireEvent.click(screen.getByRole('button', { name: 'Remove ok.txt from the list' }));
        fireEvent.click(screen.getByRole('button', { name: 'Clear finished' }));
        expect(handlers.onCancel).toHaveBeenCalledWith('big.iso');
        expect(handlers.onRetry).toHaveBeenCalledWith('bad.txt');
        expect(handlers.onDismiss).toHaveBeenCalledWith('ok.txt');
        expect(handlers.onClearFinished).toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Collapse transfers' }));
        expect(screen.queryByRole('progressbar')).toBeNull();
        setLanguage('system');
    });

    it('offers to choose where a waiting download goes', () => {
        setLanguage('en');
        const handlers = { onCancel: vi.fn(), onRetry: vi.fn(), onChooseTarget: vi.fn(), onDismiss: vi.fn(), onClearFinished: vi.fn() };
        render(<TransferDock jobs={[job({ name: 'b.log', kind: 'download', status: 'queued', loaded: 0, target: { kind: 'ask' } })]} {...handlers} />);
        expect(screen.getByText('Where to save?')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Choose where to save b.log' }));
        expect(handlers.onChooseTarget).toHaveBeenCalledWith('b.log');
        setLanguage('system');
    });

    it('speaks the UI language, including failures the client noticed itself', () => {
        setLanguage('es');
        const handlers = { onCancel: vi.fn(), onRetry: vi.fn(), onChooseTarget: vi.fn(), onDismiss: vi.fn(), onClearFinished: vi.fn() };
        const stalled = new FileClientError({ code: 'TIMEOUT', message: t('files.client.stalled') });
        render(<TransferDock jobs={[
            job({ name: 'log.gz', kind: 'download', status: 'error', error: { code: stalled.code, message: stalled.message } }),
            job({ name: 'x.bin', status: 'error', error: { code: 'PERMISSION_DENIED', message: '/x.bin: permission denied' } }),
            job({ name: 'next.bin', status: 'waiting' }),
            job({ name: 'app.bin', status: 'error', error: { code: 'NOT_ATOMIC', message: '/opt is not writable' } })
        ]} {...handlers} />);

        expect(screen.getByText('Tiempo de espera agotado: No llegó nada durante un minuto, así que se detuvo la descarga.')).toBeInTheDocument();
        expect(screen.getByText('Permiso denegado: /x.bin: permission denied')).toBeInTheDocument();
        expect(screen.getByText('Esperando una conexión libre')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Sobrescribir app.bin directamente' }));
        expect(handlers.onRetry).toHaveBeenCalledWith('app.bin', { inPlace: true });
        setLanguage('system');
    });
});
