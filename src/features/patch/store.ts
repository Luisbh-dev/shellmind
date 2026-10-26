// The patch center's state in this window: the fleet table's rows (GET
// /api/patch/fleet), the servers whose lists are open, the scans this window
// started and the latest run of each server. Runs are multi-exec jobs: their
// progress lives in the multi-exec store (followed from here).
import { create } from 'zustand';
import type { PatchApplyRequest, PatchApplyResponse, PatchFleetRow, PatchScan, PatchScanEvent, PatchServerState } from '@shared/patch';
import { summarizeScan } from '@shared/patch';
import { getAuthToken, onUnauthorized } from '@/lib/api';
import { useMultiExecStore } from '@/features/multiexec/public';
import { patchApi, type RefreshOutcome } from './api';

export type ServerDetail = {
    state: PatchServerState | null;
    loading: boolean;
    // Loading the server's state failed.
    loadError: unknown;
    // A scan or refresh asked for from its view.
    action: 'scan' | 'refresh' | null;
    actionError: unknown;
    // What the latest refresh printed.
    refreshOutput: string | null;
};

const emptyDetail = (): ServerDetail => ({ state: null, loading: false, loadError: null, action: null, actionError: null, refreshOutput: null });

interface PatchState {
    rows: Record<number, PatchFleetRow>;
    fleetStatus: 'idle' | 'loading' | 'ready' | 'error';
    fleetError: unknown;
    // Servers a scan stream of this window is reading (until their result).
    streaming: Record<number, true>;
    // The latest scan request failed as a whole (the stream never started).
    scanFailure: unknown;
    details: Record<number, ServerDetail>;
    // The latest run seen on each server (kept once it ends).
    lastJobs: Record<number, string>;

    loadFleet: () => Promise<void>;
    scanMany: (ids: number[]) => Promise<void>;
    loadServer: (id: number) => Promise<void>;
    scanServer: (id: number) => Promise<void>;
    refreshServer: (id: number) => Promise<RefreshOutcome | null>;
    startRun: (request: PatchApplyRequest) => Promise<PatchApplyResponse>;
}

function withScan(row: PatchFleetRow | undefined, serverId: number, scan: PatchScan): PatchFleetRow {
    return { serverId, fleet: null, jumpHostFor: [], jobId: null, ...row, scan: summarizeScan(scan), scanError: null, scanning: false };
}

export const usePatchStore = create<PatchState>()((set, get) => {
    const detail = (id: number, change: (current: ServerDetail) => Partial<ServerDetail>) => set((state) => {
        const current = state.details[id] ?? emptyDetail();
        return { details: { ...state.details, [id]: { ...current, ...change(current) } } };
    });

    // A fresh scan: the table's row and, when its lists are open, the server's view.
    const scanned = (id: number, scan: PatchScan) => set((state) => {
        const current = state.details[id];
        return {
            rows: { ...state.rows, [id]: withScan(state.rows[id], id, scan) },
            details: current ? { ...state.details, [id]: { ...current, state: { ...(current.state ?? { jobId: null, scanning: false }), scan, error: null } } } : state.details
        };
    });

    const remember = (rows: PatchFleetRow[]) => {
        const lastJobs = { ...get().lastJobs };
        for (const row of rows) {
            if (row.jobId) {
                lastJobs[row.serverId] = row.jobId;
                useMultiExecStore.getState().follow(row.jobId);
            }
        }
        set({ lastJobs });
    };

    return {
        rows: {},
        fleetStatus: 'idle',
        fleetError: null,
        streaming: {},
        scanFailure: null,
        details: {},
        lastJobs: {},

        loadFleet: async () => {
            if (get().fleetStatus !== 'ready') set({ fleetStatus: 'loading' });
            try {
                const { rows } = await patchApi.fleet();
                set({ rows: Object.fromEntries(rows.map((row) => [row.serverId, row])), fleetStatus: 'ready', fleetError: null });
                remember(rows);
            } catch (error) {
                set({ fleetStatus: get().fleetStatus === 'ready' ? 'ready' : 'error', fleetError: error });
            }
        },

        scanMany: async (ids) => {
            const fresh = ids.filter((id) => !get().streaming[id]);
            if (!fresh.length) return;
            set((state) => ({ scanFailure: null, streaming: { ...state.streaming, ...Object.fromEntries(fresh.map((id) => [id, true as const])) } }));
            const done = (id: number) => set((state) => {
                const streaming = { ...state.streaming };
                delete streaming[id];
                return { streaming };
            });
            const onEvent = (event: PatchScanEvent) => {
                if (event.type === 'scan') {
                    scanned(event.serverId, event.scan);
                    done(event.serverId);
                } else if (event.type === 'error') {
                    set((state) => ({
                        rows: state.rows[event.serverId] ? { ...state.rows, [event.serverId]: { ...state.rows[event.serverId], scanError: event.error, scanning: false } } : state.rows
                    }));
                    done(event.serverId);
                }
            };
            try {
                await patchApi.scanMany(fresh, onEvent);
            } catch (error) {
                if (!(error instanceof Error && error.name === 'AbortError')) set({ scanFailure: error });
            } finally {
                for (const id of fresh) done(id);
                void get().loadFleet();
            }
        },

        loadServer: async (id) => {
            detail(id, () => ({ loading: true, loadError: null }));
            try {
                const state = await patchApi.server(id);
                detail(id, () => ({ state, loading: false }));
                if (state.jobId) {
                    set((current) => ({ lastJobs: { ...current.lastJobs, [id]: state.jobId! } }));
                    useMultiExecStore.getState().follow(state.jobId);
                }
            } catch (error) {
                detail(id, () => ({ loading: false, loadError: error }));
            }
        },

        scanServer: async (id) => {
            detail(id, () => ({ action: 'scan', actionError: null }));
            try {
                scanned(id, await patchApi.scan(id));
                detail(id, () => ({ action: null }));
            } catch (error) {
                detail(id, () => ({ action: null, actionError: error }));
            }
        },

        refreshServer: async (id) => {
            detail(id, () => ({ action: 'refresh', actionError: null, refreshOutput: null }));
            try {
                const outcome = await patchApi.refresh(id);
                scanned(id, outcome.scan);
                detail(id, () => ({ action: null, refreshOutput: outcome.output || null }));
                return outcome;
            } catch (error) {
                detail(id, () => ({ action: null, actionError: error }));
                return null;
            }
        },

        startRun: async (request) => {
            const response = await patchApi.apply(request);
            const store = useMultiExecStore.getState();
            store.follow(response.job.id);
            set((state) => {
                const rows = { ...state.rows };
                const lastJobs = { ...state.lastJobs };
                for (const target of response.targets) {
                    if (rows[target.serverId]) rows[target.serverId] = { ...rows[target.serverId], jobId: response.job.id };
                    lastJobs[target.serverId] = response.job.id;
                }
                return { rows, lastJobs };
            });
            return response;
        }
    };
});

// Forgets what this window knew (sign-out).
export function resetPatchStore(): void {
    usePatchStore.setState(usePatchStore.getInitialState(), true);
}

onUnauthorized((rejected) => {
    if (rejected === undefined || rejected === getAuthToken()) resetPatchStore();
});
