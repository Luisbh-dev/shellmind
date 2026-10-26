// While a blocking layer is up (a dialog, the access-token screen) the app
// behind it is inert: no focus, no clicks, hidden from assistive technology.
// Those layers render into <body>, outside #root. Each layer holds the root
// inert until it releases it, so one closing never frees the app while
// another is still up. Others can follow whether one is up (the toasts move
// out of a dialog's way).

let holds = 0;
const listeners = new Set<() => void>();

function apply() {
    const root = typeof document === 'undefined' ? null : document.getElementById('root');
    if (root) {
        if (holds > 0) root.setAttribute('inert', '');
        else root.removeAttribute('inert');
    }
    for (const listener of listeners) listener();
}

export function holdAppInert(): () => void {
    holds += 1;
    apply();
    let released = false;
    return () => {
        if (released) return;
        released = true;
        holds = Math.max(0, holds - 1);
        apply();
    };
}

export function isAppInert(): boolean {
    return holds > 0;
}

// For useSyncExternalStore.
export function subscribeAppInert(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}
