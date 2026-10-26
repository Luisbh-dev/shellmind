// Where downloads are saved. Chromium and Electron can write a download
// straight into a file the user picks (the File System Access API): only the
// chunks in flight are in memory, whatever the size. Elsewhere a download
// collects in a Blob the browser saves at the end, which memory limits, so
// it is refused beyond MEMORY_DOWNLOAD_LIMIT with a message saying why.
//
// A picker opens only from a click, once per click: in a batch, the first
// large file is placed right away and each further one waits for a click of
// its own (the transfer dock offers it). No folder picker: writing into a
// picked folder needs a permission the desktop app does not grant.
import { getLanguage, t } from '@/i18n';
import { FileClientError, type DownloadSink } from './client';
import { formatBytes } from './listing';

// Smaller files download like any browser download (no dialog).
export const DISK_DOWNLOAD_THRESHOLD = 64 * 1024 * 1024;
// The most a download may hold in memory.
export const MEMORY_DOWNLOAD_LIMIT = 1024 * 1024 * 1024;
// A Blob in the making is folded every this many bytes, so the browser moves
// the data into its blob storage instead of keeping it all as JS buffers.
const FOLD_BYTES = 32 * 1024 * 1024;
// The pickers remember the last folder under this id.
const PICKER_ID = 'shellmind-downloads';

export type SaveTarget =
    | { kind: 'memory' }
    // A file the user picked.
    | { kind: 'file'; handle: FileSystemFileHandle }
    // Goes to disk, but the user has yet to pick the file (with a click).
    | { kind: 'ask' };

const MEMORY: SaveTarget = { kind: 'memory' };
const ASK: SaveTarget = { kind: 'ask' };

type SaveFilePicker = (options: { suggestedName?: string; id?: string; startIn?: 'downloads' }) => Promise<FileSystemFileHandle>;

function savePicker(): SaveFilePicker | null {
    const candidate = (window as Window & { showSaveFilePicker?: SaveFilePicker }).showSaveFilePicker;
    return typeof candidate === 'function' ? candidate.bind(window) : null;
}

export type DownloadRequest = { name: string; size: number | null };

const goesToDisk = (download: DownloadRequest) => download.size === null || download.size >= DISK_DOWNLOAD_THRESHOLD;

// Asks where to save one download. Call it right from a click. null: the
// user closed the picker; memory: there is no picker here (or it is not
// allowed), so the browser download it is.
export async function pickSaveTarget(name: string): Promise<SaveTarget | null> {
    const picker = savePicker();
    if (!picker) return MEMORY;
    try {
        return { kind: 'file', handle: await picker({ suggestedName: name, id: PICKER_ID, startIn: 'downloads' }) };
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        return MEMORY;
    }
}

// Where each download of a batch goes: small ones into memory, large ones
// (or of unknown size) to disk when the browser can write files. The first
// large one is placed now; the others are 'ask'. Call it right from the
// user's click. null: the user closed the picker, so nothing is downloaded.
export async function chooseSaveTargets(downloads: DownloadRequest[]): Promise<SaveTarget[] | null> {
    const first = savePicker() ? downloads.findIndex(goesToDisk) : -1;
    if (first < 0) return downloads.map(() => MEMORY);
    const picked = await pickSaveTarget(downloads[first].name);
    if (!picked) return null;
    if (picked.kind === 'memory') return downloads.map(() => MEMORY);
    return downloads.map((download, index) => (index === first ? picked : goesToDisk(download) ? ASK : MEMORY));
}

const writeFailed = (error: unknown) => new FileClientError({
    code: 'FAILED',
    message: t('files.download.writeFailed', { message: error instanceof Error ? error.message : String(error) })
});

// Collects a download in a Blob (see saveBlob), refusing to grow past `limit`.
export class MemorySink implements DownloadSink {
    private folded: Blob | null = null;
    private pending: Uint8Array<ArrayBuffer>[] = [];
    private pendingBytes = 0;
    private bytes = 0;

    constructor(private readonly name: string, private readonly limit = MEMORY_DOWNLOAD_LIMIT) {}

    async write(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        this.bytes += chunk.byteLength;
        if (this.bytes > this.limit) throw tooLargeForMemory(this.name, this.bytes, this.limit);
        // A view into a larger buffer would keep all of it alive.
        this.pending.push(chunk.byteOffset === 0 && chunk.byteLength === chunk.buffer.byteLength ? chunk : chunk.slice());
        this.pendingBytes += chunk.byteLength;
        if (this.pendingBytes >= FOLD_BYTES) this.fold();
    }

    private fold(): void {
        this.folded = new Blob(this.folded ? [this.folded, ...this.pending] : this.pending);
        this.pending = [];
        this.pendingBytes = 0;
    }

    async close(): Promise<void> {
        this.fold();
    }

    async abort(): Promise<void> {
        this.folded = null;
        this.pending = [];
        this.pendingBytes = 0;
    }

    blob(): Blob {
        return this.folded ?? new Blob([]);
    }
}

export function tooLargeForMemory(name: string, size: number, limit = MEMORY_DOWNLOAD_LIMIT): FileClientError {
    const language = getLanguage();
    // The save picker exists only in secure contexts: over plain HTTP (a
    // self-hosted instance on a LAN address) even Chrome keeps downloads in
    // memory, so the browser is not what to change there.
    const key = globalThis.isSecureContext === false ? 'files.download.tooLargeInsecure' : 'files.download.tooLargeForMemory';
    return new FileClientError({
        code: 'TOO_LARGE',
        message: t(key, { name, size: formatBytes(size, language), limit: formatBytes(limit, language) })
    });
}

// Writes a download into a file on disk. The browser writes to a temporary
// file and replaces the target only when the stream is closed.
export class DiskSink implements DownloadSink {
    constructor(private readonly writable: FileSystemWritableFileStream) {}

    async write(chunk: Uint8Array<ArrayBuffer>): Promise<void> {
        try {
            await this.writable.write(chunk);
        } catch (error) {
            throw writeFailed(error);
        }
    }

    async close(): Promise<void> {
        try {
            await this.writable.close();
        } catch (error) {
            throw writeFailed(error);
        }
    }

    async abort(): Promise<void> {
        await this.writable.abort().catch(() => undefined);
    }
}

// Opens where the bytes of a download go ('ask' targets are picked first).
export async function openSaveTarget(target: Exclude<SaveTarget, { kind: 'ask' }>, name: string): Promise<DownloadSink> {
    if (target.kind === 'memory') return new MemorySink(name);
    try {
        return new DiskSink(await target.handle.createWritable());
    } catch (error) {
        throw writeFailed(error);
    }
}
