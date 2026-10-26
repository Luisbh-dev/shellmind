import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export type RemoteState<T> = {
    data: T | null;
    error: unknown;
    loading: boolean;
    // Loads again (aborting a request still running).
    reload: () => void;
};

// One request whose answer belongs to `key` (e.g. a server and a unit): a
// new key or reload() aborts the previous request, and an answer that arrives
// after its key changed is dropped. Nothing loads while `enabled` is false.
export function useRemote<T>(load: (signal: AbortSignal) => Promise<T>, key: string, enabled = true): RemoteState<T> {
    const [state, setState] = useState<{ key: string; data: T | null; error: unknown; loading: boolean }>({ key, data: null, error: null, loading: false });
    const [nonce, setNonce] = useState(0);
    const loadRef = useRef(load);
    useLayoutEffect(() => {
        loadRef.current = load;
    });

    useEffect(() => {
        if (!enabled) return;
        const controller = new AbortController();
        setState((previous) => ({ key, data: previous.key === key ? previous.data : null, error: null, loading: true }));
        loadRef.current(controller.signal).then(
            (data) => {
                if (!controller.signal.aborted) setState({ key, data, error: null, loading: false });
            },
            (error: unknown) => {
                if (!controller.signal.aborted) setState((previous) => ({ key, data: previous.key === key ? previous.data : null, error, loading: false }));
            }
        );
        return () => controller.abort();
    }, [key, enabled, nonce]);

    const reload = useCallback(() => setNonce((value) => value + 1), []);
    const current = state.key === key;
    return {
        data: current ? state.data : null,
        error: current ? state.error : null,
        loading: current ? state.loading : enabled,
        reload
    };
}
