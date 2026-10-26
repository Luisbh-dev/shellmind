// The saved servers (GET /api/servers), loaded once and shared: the sidebar,
// the palette, the welcome screen and any dialog that lists servers read
// them from here instead of fetching the list again.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { ServerSummary } from '@shared/types';
import { ApiError, api } from '@/lib/api';

export type ServersStatus = 'loading' | 'ready' | 'error';

type ServersState = {
    servers: ServerSummary[];
    status: ServersStatus;
    error: string | null;
};

export const useServersStore = create<ServersState>()(() => ({ servers: [], status: 'loading', error: null }));

let inFlight: Promise<ServerSummary[] | null> | null = null;
let loadedOnce = false;

// Loads the list (a load already running is shared). Resolves with it, or
// with null when it could not be loaded (the store then says why). `fresh`
// after a change (a server saved, deleted, imported): a load that started
// before it may answer the list as it was, so one more follows it.
export function loadServers(options: { fresh?: boolean } = {}): Promise<ServerSummary[] | null> {
    if (options.fresh && inFlight) return inFlight.then(() => loadServers());
    inFlight ??= api.data<ServerSummary[]>('/api/servers')
        .then((data) => {
            const servers = Array.isArray(data) ? data : [];
            loadedOnce = true;
            useServersStore.setState({ servers, status: 'ready', error: null });
            return servers;
        }, (error: unknown) => {
            useServersStore.setState({ status: 'error', error: error instanceof ApiError ? error.message : String(error) });
            return null;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

// The list as it is now, loaded first if nothing has loaded it yet.
export async function getServers(): Promise<ServerSummary[]> {
    if (loadedOnce && useServersStore.getState().status === 'ready') return useServersStore.getState().servers;
    const servers = await loadServers();
    if (!servers) throw new ApiError(0, useServersStore.getState().error ?? '');
    return servers;
}

// A local change shown at once (a new order, a favourite), before or
// without a reload.
export function updateServers(update: (servers: ServerSummary[]) => ServerSummary[]): void {
    useServersStore.setState((state) => ({ servers: update(state.servers) }));
}

// The list for a component; loads it on first use.
export function useServers(): ServersState & { reload: () => Promise<ServerSummary[] | null> } {
    const state = useServersStore();
    useEffect(() => {
        if (!loadedOnce && !inFlight) void loadServers();
    }, []);
    return { ...state, reload: loadServers };
}

// Tests start from an empty list.
export function resetServersStore(): void {
    inFlight = null;
    loadedOnce = false;
    useServersStore.setState({ servers: [], status: 'loading', error: null });
}
