// The saved identities (GET /api/identities), loaded once and shared by
// Settings > Keychain and the connection form.
import { useEffect } from 'react';
import { create } from 'zustand';
import type { IdentitySummary } from '@shared/identities';
import { ApiError } from '@/lib/api';
import { identitiesApi } from './api';

type IdentitiesState = {
    identities: IdentitySummary[];
    status: 'loading' | 'ready' | 'error';
    error: string | null;
};

export const useIdentitiesStore = create<IdentitiesState>()(() => ({ identities: [], status: 'loading', error: null }));

let inFlight: Promise<IdentitySummary[] | null> | null = null;
let loadedOnce = false;

// Loads the list (a load already running is shared); null when it failed.
export function loadIdentities(): Promise<IdentitySummary[] | null> {
    inFlight ??= identitiesApi.list()
        .then((data) => {
            const identities = Array.isArray(data) ? data : [];
            loadedOnce = true;
            useIdentitiesStore.setState({ identities, status: 'ready', error: null });
            return identities;
        }, (error: unknown) => {
            useIdentitiesStore.setState({ status: 'error', error: error instanceof ApiError ? error.message : String(error) });
            return null;
        })
        .finally(() => {
            inFlight = null;
        });
    return inFlight;
}

// One saved or changed identity shown at once, before the next reload.
export function upsertIdentity(identity: IdentitySummary): void {
    useIdentitiesStore.setState((state) => {
        const others = state.identities.filter((item) => item.id !== identity.id);
        return { identities: [...others, identity].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id - b.id) };
    });
}

export function useIdentities(): IdentitiesState & { reload: () => Promise<IdentitySummary[] | null> } {
    const state = useIdentitiesStore();
    useEffect(() => {
        if (!loadedOnce && !inFlight) void loadIdentities();
    }, []);
    return { ...state, reload: loadIdentities };
}

// Tests start from an empty list.
export function resetIdentitiesStore(): void {
    inFlight = null;
    loadedOnce = false;
    useIdentitiesStore.setState({ identities: [], status: 'loading', error: null });
}
