import { useSyncExternalStore } from 'react';

// W8-T2: a workspace tab whose isAvailable() can change while a server is
// open (the Kubernetes tab once kubectl has been looked for on the server)
// calls notifyTabAvailability() when it does; the workspace, which calls
// useTabAvailability(), then renders again and asks every tab anew.

let version = 0;
const listeners = new Set<() => void>();

export function notifyTabAvailability(): void {
    version += 1;
    listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

const snapshot = () => version;

// Renders the caller again whenever a tab's availability changed.
export function useTabAvailability(): number {
    return useSyncExternalStore(subscribe, snapshot, snapshot);
}
