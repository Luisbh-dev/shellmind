// The multi-exec jobs this window knows about. Jobs run on the backend; this
// store follows the ones that are running (their event streams, reconnecting
// when a stream drops) and keeps the ones opened here, so a job goes on, and
// its results stay, when the dialog is closed and reopened.
import { create } from 'zustand';
import {
    MULTIEXEC_FINAL_STATUSES,
    MULTIEXEC_LIMITS,
    batchOfPositions,
    countStatuses,
    isJobFinal,
    planBatches,
    type MultiExecJobEvent,
    type MultiExecJobInfo,
    type MultiExecRequest,
    type MultiExecServerRun,
    type MultiExecStatus,
    type MultiExecTarget
} from '@shared/multiexec';
import { t } from '@/i18n';
import { ApiError, getAuthToken, onUnauthorized } from '@/lib/api';
import { multiexecApi } from './api';
import { readSseEvents } from './stream';

export type JobView = {
    info: MultiExecJobInfo;
    servers: MultiExecServerRun[];
    // The backend's snapshot arrived (until then `servers` is what was sent).
    loaded: boolean;
    // Following the job failed (it is retried); null while it works.
    streamError: string | null;
    // The job no longer exists on the backend.
    missing: boolean;
};

export const isFinalStatus = (status: MultiExecStatus) => MULTIEXEC_FINAL_STATUSES.includes(status);

// A server where the command may have run, in full or in part, although it
// has no result: the job was cancelled or interrupted (ShellMind closed or
// its backend stopped) while it ran there.
export const mayHaveRun = (server: MultiExecServerRun): boolean =>
    server.errorCode === 'INTERRUPTED' || ((server.status === 'cancelled' || server.status === 'skipped') && server.startedAt !== null);

// Servers worth running again: anything that did not end with exit code 0,
// except where the command may have run already (running a useradd, a
// migration or a patch-and-reboot twice is worse than not running it).
export const retryServers = (servers: readonly MultiExecServerRun[]): MultiExecServerRun[] =>
    servers.filter((server) => server.status !== 'ok' && isFinalStatus(server.status) && !mayHaveRun(server));

export const isJobActive = (view: JobView | null | undefined): boolean => Boolean(view && !view.missing && !isJobFinal(view.info.status));

// The job-level fields with the counts of what is known now.
export function summaryOf(view: JobView): MultiExecJobInfo {
    return view.servers.length ? { ...view.info, total: view.servers.length, counts: countStatuses(view.servers.map((server) => server.status)) } : view.info;
}

function queuedServer(target: MultiExecTarget, batch: number): MultiExecServerRun {
    return {
        ...target,
        batch,
        status: 'queued',
        exitCode: null,
        signal: null,
        error: null,
        errorCode: null,
        startedAt: null,
        finishedAt: null,
        durationMs: null,
        truncated: false,
        outputHash: null,
        normalizedHash: null,
        stdout: '',
        stderr: '',
        outputTrimmed: false
    };
}

// The view of a job just started, until its snapshot arrives.
export function startedView(info: MultiExecJobInfo, targets: readonly MultiExecTarget[]): JobView {
    const batches = batchOfPositions(planBatches(targets.length, info.strategy));
    return { info, servers: targets.map((target, index) => queuedServer(target, batches[index] ?? 0)), loaded: false, streamError: null, missing: false };
}

function updateServer(view: JobView, serverId: number, change: (server: MultiExecServerRun) => MultiExecServerRun): JobView {
    return { ...view, servers: view.servers.map((server) => (server.serverId === serverId ? change(server) : server)) };
}

// Applies one backend event to a job (pure; exported for tests).
export function applyEvent(view: JobView, event: MultiExecJobEvent): JobView {
    switch (event.type) {
        case 'snapshot': {
            const { servers, ...info } = event.job;
            return { info, servers, loaded: true, streamError: null, missing: false };
        }
        case 'job':
            return { ...view, info: event.job, streamError: null };
        case 'running':
            return updateServer(view, event.serverId, (server) => ({ ...server, status: 'running', startedAt: event.startedAt }));
        case 'output':
            return updateServer(view, event.serverId, (server) => {
                const current = server[event.stream];
                // The backend already caps output; this only guards memory.
                if (current.length >= MULTIEXEC_LIMITS.maxOutputBytes) return server;
                return { ...server, [event.stream]: current + event.data };
            });
        case 'result': {
            const { serverId, ...result } = event.result;
            return updateServer(view, serverId, (server) => ({ ...server, ...result }));
        }
        default:
            return view;
    }
}

const isAbortError = (error: unknown) => error instanceof Error && error.name === 'AbortError';

const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

// Job views kept in memory; the oldest finished ones beyond go (they stay in the history).
const MAX_VIEWS = 12;

// How long the request of a finished job is kept (see `requests`).
export const REQUEST_KEEP_MS = 5 * 60_000;

// Jobs per page of the history.
export const LIST_PAGE = 50;

const RETRY_DELAYS_MS = [1000, 2000, 5000, 10_000, 30_000];

interface MultiExecState {
    jobs: Record<string, JobView>;
    // What this window sent for its jobs, secret values included, so "Run
    // again" needs nothing typed again. In memory only, and only while the
    // job runs and for REQUEST_KEEP_MS after; then, as from the history,
    // secret values are asked again.
    requests: Record<string, MultiExecRequest>;
    // The job history (newest first), as far as it was loaded.
    list: MultiExecJobInfo[] | null;
    listError: string | null;
    // Older jobs than those of `list` are in the history.
    hasMore: boolean;
    loadingMore: boolean;
    moreError: string | null;
    // The job the dialog shows when it opens.
    currentJobId: string | null;
    // The job on screen: it gets no notification.
    visibleJobId: string | null;

    start: (request: MultiExecRequest, targets: MultiExecTarget[]) => Promise<MultiExecJobInfo>;
    // Shows a job (from the list) and follows it.
    open: (id: string) => void;
    follow: (id: string) => void;
    // Loads the newest page of the history (older pages already loaded stay).
    refreshList: () => Promise<void>;
    loadMore: () => Promise<void>;
    pause: (id: string) => Promise<void>;
    resume: (id: string) => Promise<void>;
    cancel: (id: string) => Promise<void>;
    remove: (id: string) => Promise<void>;
    clearFinished: () => Promise<number>;
    setVisibleJob: (id: string | null) => void;
}

const followers = new Map<string, AbortController>();

// Timers that drop the request of a finished job (REQUEST_KEEP_MS).
const requestTimers = new Map<string, ReturnType<typeof setTimeout>>();

function delay(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
        }, { once: true });
    });
}

// Stops following every job (tests, sign-out).
export function stopFollowing(): void {
    for (const controller of followers.values()) controller.abort();
    followers.clear();
}

function withoutKeys<T>(record: Record<string, T>, ids: Iterable<string>): Record<string, T> {
    const next = { ...record };
    for (const id of ids) delete next[id];
    return next;
}

// `requests` without those of `ids` (and their timers).
function dropRequests(requests: Record<string, MultiExecRequest>, ids: readonly string[]): Record<string, MultiExecRequest> {
    for (const id of ids) {
        clearTimeout(requestTimers.get(id));
        requestTimers.delete(id);
    }
    return withoutKeys(requests, ids);
}

export const useMultiExecStore = create<MultiExecState>()((set, get) => {
    const update = (id: string, change: (view: JobView) => JobView) => set((state) => {
        const view = state.jobs[id];
        return view ? { jobs: { ...state.jobs, [id]: change(view) } } : state;
    });

    // A view that goes takes its request with it.
    const keep = (view: JobView) => set((state) => {
        const jobs = { ...state.jobs, [view.info.id]: view };
        const spare = Object.values(jobs)
            .filter((item) => !isJobActive(item) && item.info.id !== state.currentJobId && item.info.id !== state.visibleJobId && item.info.id !== view.info.id)
            .sort((a, b) => a.info.createdAt - b.info.createdAt);
        const dropped: string[] = [];
        while (Object.keys(jobs).length > MAX_VIEWS && spare.length) {
            const id = spare.shift()!.info.id;
            delete jobs[id];
            dropped.push(id);
        }
        return dropped.length ? { jobs, requests: dropRequests(state.requests, dropped) } : { jobs };
    });

    const forgetRequest = (id: string) => set((state) => (id in state.requests ? { requests: dropRequests(state.requests, [id]) } : state));

    // The job ended: its request (and secret values) go after a while.
    const forgetRequestLater = (id: string) => {
        if (!(id in get().requests) || requestTimers.has(id)) return;
        const timer = setTimeout(() => {
            requestTimers.delete(id);
            forgetRequest(id);
        }, REQUEST_KEEP_MS);
        requestTimers.set(id, timer);
    };

    const follow = (id: string) => {
        if (followers.has(id)) return;
        const controller = new AbortController();
        followers.set(id, controller);
        void (async () => {
            let failures = 0;
            try {
                while (!controller.signal.aborted) {
                    try {
                        const res = await multiexecApi.events(id, controller.signal);
                        if (!res.body) throw new Error(t('multiexec.errors.noStream'));
                        await readSseEvents(res.body, (data) => {
                            const event = data as MultiExecJobEvent;
                            failures = 0;
                            if (event.type === 'snapshot' && !get().jobs[id]) {
                                const { servers, ...info } = event.job;
                                keep({ info, servers, loaded: true, streamError: null, missing: false });
                            } else {
                                update(id, (view) => applyEvent(view, event));
                            }
                        });
                    } catch (error) {
                        if (isAbortError(error) || controller.signal.aborted) return;
                        if (error instanceof ApiError && error.status === 404) {
                            update(id, (view) => ({ ...view, missing: true, streamError: null }));
                            forgetRequest(id);
                            return;
                        }
                        failures += 1;
                        update(id, (view) => ({ ...view, streamError: errorText(error) }));
                    }
                    const view = get().jobs[id];
                    if (!view || view.missing || (view.loaded && isJobFinal(view.info.status))) {
                        forgetRequestLater(id);
                        return;
                    }
                    await delay(RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)], controller.signal);
                }
            } finally {
                if (followers.get(id) === controller) followers.delete(id);
            }
        })();
    };

    const control = (action: 'pause' | 'resume' | 'cancel') => async (id: string) => {
        const info = await multiexecApi[action](id);
        update(id, (view) => ({ ...view, info: { ...info, counts: view.info.counts } }));
    };

    return {
        jobs: {},
        requests: {},
        list: null,
        listError: null,
        hasMore: false,
        loadingMore: false,
        moreError: null,
        currentJobId: null,
        visibleJobId: null,

        start: async (request, targets) => {
            const info = await multiexecApi.start(request);
            keep(startedView(info, targets));
            set((state) => ({ requests: { ...state.requests, [info.id]: request }, currentJobId: info.id, list: state.list && [info, ...state.list] }));
            follow(info.id);
            return info;
        },

        open: (id) => {
            set({ currentJobId: id });
            const known = get().jobs[id];
            if (known && known.loaded && !isJobActive(known)) return;
            if (!known) {
                const info = get().list?.find((item) => item.id === id);
                if (info) keep({ info, servers: [], loaded: false, streamError: null, missing: false });
            }
            follow(id);
        },

        follow,

        refreshList: async () => {
            try {
                const page = await multiexecApi.list({ limit: LIST_PAGE });
                set((state) => {
                    // Older pages loaded before stay after the fresh one.
                    const last = page.at(-1);
                    const older = page.length === LIST_PAGE && last ? (state.list ?? []).filter((info) => info.createdAt < last.createdAt) : [];
                    return {
                        list: [...page, ...older],
                        listError: null,
                        hasMore: page.length === LIST_PAGE && (older.length === 0 || state.hasMore)
                    };
                });
                // Running jobs are followed, wherever they were started.
                for (const info of page) {
                    if (isJobFinal(info.status)) {
                        forgetRequestLater(info.id);
                        continue;
                    }
                    if (!get().jobs[info.id]) keep({ info, servers: [], loaded: false, streamError: null, missing: false });
                    follow(info.id);
                }
            } catch (error) {
                set({ listError: errorText(error) });
            }
        },

        loadMore: async () => {
            const { list, loadingMore } = get();
            const last = list?.at(-1);
            if (!last || loadingMore) return;
            set({ loadingMore: true, moreError: null });
            try {
                const page = await multiexecApi.list({ limit: LIST_PAGE, before: last.createdAt });
                set((state) => {
                    const known = new Set((state.list ?? []).map((info) => info.id));
                    return {
                        list: [...(state.list ?? []), ...page.filter((info) => !known.has(info.id))],
                        hasMore: page.length === LIST_PAGE,
                        loadingMore: false
                    };
                });
            } catch (error) {
                set({ loadingMore: false, moreError: errorText(error) });
            }
        },

        pause: control('pause'),
        resume: control('resume'),
        cancel: control('cancel'),

        remove: async (id) => {
            await multiexecApi.remove(id);
            set((state) => ({
                jobs: withoutKeys(state.jobs, [id]),
                requests: dropRequests(state.requests, [id]),
                list: state.list?.filter((info) => info.id !== id) ?? null,
                currentJobId: state.currentJobId === id ? null : state.currentJobId
            }));
        },

        clearFinished: async () => {
            const deleted = await multiexecApi.clearFinished();
            set((state) => {
                const jobs = Object.fromEntries(Object.entries(state.jobs).filter(([, view]) => isJobActive(view)));
                return {
                    jobs,
                    requests: dropRequests(state.requests, Object.keys(state.requests).filter((id) => !jobs[id])),
                    list: state.list?.filter((info) => !isJobFinal(info.status)) ?? null,
                    hasMore: false,
                    currentJobId: state.currentJobId && jobs[state.currentJobId] ? state.currentJobId : null
                };
            });
            return deleted;
        },

        setVisibleJob: (id) => set({ visibleJobId: id })
    };
});

// Forgets everything this window knew, secret values included (sign-out).
export function resetMultiExecStore(): void {
    stopFollowing();
    for (const timer of requestTimers.values()) clearTimeout(timer);
    requestTimers.clear();
    useMultiExecStore.setState(useMultiExecStore.getInitialState(), true);
}

// The backend refused the session token: the app locks (AccessGate). A
// refusal of another token than this window's changes nothing.
onUnauthorized((rejected) => {
    if (rejected === undefined || rejected === getAuthToken()) resetMultiExecStore();
});
