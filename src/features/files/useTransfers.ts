// Uploads and downloads of the explorer, shown in the transfer dock. Each
// direction runs one file at a time (a file itself keeps several chunks in
// flight). Jobs are independent: finishing or clearing one never touches
// another, and a finished one leaves the dock on its own after a while.
import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { FileErrorCode } from '@shared/files';
import type { FileClient } from './client';
import { isFileClientError } from './client';
import { chooseSaveTargets, MEMORY_DOWNLOAD_LIMIT, MemorySink, openSaveTarget, pickSaveTarget, tooLargeForMemory, type SaveTarget } from './saveTarget';
import { saveBlob } from '@/lib/download';

export type TransferKind = 'upload' | 'download';
// waiting: the server had no free connection; it starts again after the
// other transfer (or a short pause).
export type TransferStatus = 'queued' | 'waiting' | 'running' | 'done' | 'error' | 'cancelled';

export type TransferError = { code: FileErrorCode; message: string };

export type TransferJob = {
    id: string;
    kind: TransferKind;
    name: string;
    // Remote path (the upload target or the downloaded file).
    path: string;
    size: number | null;
    loaded: number;
    status: TransferStatus;
    error?: TransferError;
    // Upload source, whether it may replace an existing file and whether it
    // may do so in place (see NOT_ATOMIC).
    file?: File;
    overwrite?: boolean;
    inPlace?: boolean;
    // Download destination (picked when the download was asked for); a
    // queued download whose target is 'ask' waits for chooseTarget().
    target?: SaveTarget;
};

export type NewUpload = { file: File; path: string; overwrite: boolean };
export type NewDownload = { path: string; name: string; size: number | null };

type Action =
    | { type: 'add'; jobs: TransferJob[] }
    | { type: 'update'; id: string; patch: Partial<TransferJob> }
    // Back in the queue after a BUSY pause, unless cancelled meanwhile.
    | { type: 'requeue'; id: string }
    | { type: 'remove'; ids: string[] };

function reducer(jobs: TransferJob[], action: Action): TransferJob[] {
    switch (action.type) {
        case 'add':
            return [...jobs, ...action.jobs];
        case 'update':
            return jobs.map((job) => (job.id === action.id ? { ...job, ...action.patch } : job));
        case 'requeue':
            return jobs.map((job) => (job.id === action.id && job.status === 'waiting' ? { ...job, status: 'queued' } : job));
        case 'remove':
            return jobs.filter((job) => !action.ids.includes(job.id));
    }
}

const PROGRESS_INTERVAL_MS = 120;
const DONE_LINGER_MS = 5000;
const BUSY_RETRY_MS = 1000;

let sequence = 0;
const nextId = () => `transfer-${Date.now().toString(36)}-${(sequence += 1)}`;

export type Transfers = {
    jobs: TransferJob[];
    upload: (uploads: NewUpload[]) => void;
    download: (downloads: NewDownload[]) => void;
    cancel: (id: string) => void;
    // `inPlace`: retry an upload refused with NOT_ATOMIC, overwriting in place.
    retry: (id: string, options?: { inPlace?: boolean }) => void;
    // Asks where to save a download waiting for that; call it from a click.
    chooseTarget: (id: string) => void;
    dismiss: (id: string) => void;
    clearFinished: () => void;
};

export type TransferCallbacks = {
    // An upload finished: the folder it went to may need a refresh.
    onUploaded?: (job: TransferJob) => void;
};

export function useTransfers(client: FileClient | null, callbacks: TransferCallbacks = {}): Transfers {
    const [jobs, dispatch] = useReducer(reducer, []);
    const controllers = useRef(new Map<string, AbortController>());
    const busy = useRef<Record<TransferKind, boolean>>({ upload: false, download: false });
    // Set once the server ran out of connections (FTP servers limit them):
    // from then on transfers run one at a time, whatever their direction.
    const oneAtATime = useRef(false);
    const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
    const callbacksRef = useRef(callbacks);
    callbacksRef.current = callbacks;
    const jobsRef = useRef(jobs);
    jobsRef.current = jobs;

    const later = useCallback((id: string, ms: number, action: Action) => {
        clearTimeout(timers.current.get(id));
        timers.current.set(id, setTimeout(() => {
            timers.current.delete(id);
            dispatch(action);
        }, ms));
    }, []);

    const run = useCallback(async (job: TransferJob, fileClient: FileClient) => {
        busy.current[job.kind] = true;
        const controller = new AbortController();
        controllers.current.set(job.id, controller);
        dispatch({ type: 'update', id: job.id, patch: { status: 'running', loaded: 0, error: undefined } });

        let lastReport = 0;
        const progress = (loaded: number) => {
            const now = Date.now();
            if (now - lastReport < PROGRESS_INTERVAL_MS) return;
            lastReport = now;
            dispatch({ type: 'update', id: job.id, patch: { loaded } });
        };
        let outcome: Partial<TransferJob>;
        try {
            if (job.kind === 'upload' && job.file) {
                await fileClient.upload(job.file, job.path, {
                    overwrite: job.overwrite ?? false,
                    inPlace: job.inPlace,
                    signal: controller.signal,
                    onProgress: progress
                });
                outcome = { status: 'done', loaded: job.file.size };
            } else {
                const target = job.target?.kind === 'file' ? job.target : { kind: 'memory' as const };
                // Known to be too large for memory: say so before transferring anything.
                if (target.kind === 'memory' && job.size !== null && job.size > MEMORY_DOWNLOAD_LIMIT) throw tooLargeForMemory(job.name, job.size);
                const sink = await openSaveTarget(target, job.name);
                const size = await fileClient.download(job.path, {
                    sink,
                    signal: controller.signal,
                    onProgress: (stored, total) => {
                        if (total !== null && job.size === null) dispatch({ type: 'update', id: job.id, patch: { size: total } });
                        progress(stored);
                    }
                });
                if (sink instanceof MemorySink) saveBlob(sink.blob(), job.name);
                outcome = { status: 'done', loaded: size, size };
            }
        } catch (error) {
            if (isFileClientError(error, 'CANCELLED')) outcome = { status: 'cancelled' };
            else if (isFileClientError(error, 'BUSY')) outcome = { status: 'waiting', loaded: 0 };
            else if (isFileClientError(error)) outcome = { status: 'error', error: { code: error.code, message: error.message } };
            else outcome = { status: 'error', error: { code: 'FAILED', message: error instanceof Error ? error.message : String(error) } };
        }
        // Free the direction before the update that lets the next job start.
        controllers.current.delete(job.id);
        busy.current[job.kind] = false;
        if (outcome.status === 'waiting') {
            oneAtATime.current = true;
            later(job.id, BUSY_RETRY_MS, { type: 'requeue', id: job.id });
        }
        dispatch({ type: 'update', id: job.id, patch: outcome });
        if (outcome.status !== 'done') return;
        if (job.kind === 'upload') callbacksRef.current.onUploaded?.(job);
        later(job.id, DONE_LINGER_MS, { type: 'remove', ids: [job.id] });
    }, [later]);

    // Starts the next waiting job of each direction whenever one is free.
    useEffect(() => {
        if (!client) return;
        for (const kind of ['upload', 'download'] as const) {
            if (busy.current[kind]) continue;
            if (oneAtATime.current && (busy.current.upload || busy.current.download)) continue;
            const next = jobs.find((job) => job.kind === kind && job.status === 'queued' && job.target?.kind !== 'ask');
            if (next) void run(next, client);
        }
    }, [jobs, client, run]);

    useEffect(() => {
        const pending = timers.current;
        const running = controllers.current;
        return () => {
            for (const timer of pending.values()) clearTimeout(timer);
            for (const controller of running.values()) controller.abort();
        };
    }, []);

    const upload = useCallback((uploads: NewUpload[]) => {
        if (!uploads.length) return;
        dispatch({
            type: 'add',
            jobs: uploads.map(({ file, path, overwrite }) => ({
                id: nextId(), kind: 'upload', name: file.name, path, size: file.size, loaded: 0, status: 'queued', file, overwrite
            }))
        });
    }, []);

    // Call it right from the user's click: large downloads ask where to save
    // them first (see saveTarget.ts); closing that picker downloads nothing.
    const download = useCallback((downloads: NewDownload[]) => {
        if (!downloads.length) return;
        void chooseSaveTargets(downloads).then((targets) => {
            if (!targets) return;
            dispatch({
                type: 'add',
                jobs: downloads.map(({ path, name, size }, index) => ({
                    id: nextId(), kind: 'download', name, path, size, loaded: 0, status: 'queued', target: targets[index]
                }))
            });
        });
    }, []);

    const cancel = useCallback((id: string) => {
        const controller = controllers.current.get(id);
        if (controller) controller.abort();
        else dispatch({ type: 'update', id, patch: { status: 'cancelled' } });
    }, []);

    const retry = useCallback((id: string, options: { inPlace?: boolean } = {}) => {
        const patch: Partial<TransferJob> = { status: 'queued', loaded: 0, error: undefined };
        if (options.inPlace) patch.inPlace = true;
        dispatch({ type: 'update', id, patch });
    }, []);

    const chooseTarget = useCallback((id: string) => {
        const job = jobsRef.current.find((candidate) => candidate.id === id);
        if (!job) return;
        void pickSaveTarget(job.name).then((target) => {
            if (target) dispatch({ type: 'update', id, patch: { target } });
        });
    }, []);

    const dismiss = useCallback((id: string) => {
        clearTimeout(timers.current.get(id));
        timers.current.delete(id);
        dispatch({ type: 'remove', ids: [id] });
    }, []);

    const clearFinished = useCallback(() => {
        const finished = jobs.filter((job) => job.status === 'done' || job.status === 'cancelled' || job.status === 'error').map((job) => job.id);
        for (const id of finished) {
            clearTimeout(timers.current.get(id));
            timers.current.delete(id);
        }
        dispatch({ type: 'remove', ids: finished });
    }, [jobs]);

    return { jobs, upload, download, cancel, retry, chooseTarget, dismiss, clearFinished };
}
