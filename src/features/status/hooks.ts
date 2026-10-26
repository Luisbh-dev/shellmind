import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// Small hooks of the status dashboard (useElementWidth is in src/lib).

function pageVisible(): boolean {
    return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

// False while the browser tab is in the background or the window is minimised.
export function usePageVisible(): boolean {
    const [visible, setVisible] = useState(pageVisible);
    useEffect(() => {
        const update = () => setVisible(pageVisible());
        document.addEventListener('visibilitychange', update);
        return () => document.removeEventListener('visibilitychange', update);
    }, []);
    return visible;
}

// Date.now(), refreshed every `intervalMs` while `active`.
export function useNow(intervalMs: number, active = true): number {
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!active) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
        return () => window.clearInterval(timer);
    }, [intervalMs, active]);
    return now;
}

export type PollState<T> = {
    data: T | null;
    error: unknown;
    // A request is running.
    loading: boolean;
    // Epoch ms of the last successful answer.
    lastSuccess: number | null;
    // Consecutive failures (drives the backoff).
    failures: number;
    // When the next request is scheduled (null while one runs or polling is paused).
    nextAt: number | null;
};

export type PollOptions<T> = {
    fetcher: (signal: AbortSignal) => Promise<T>;
    enabled: boolean;
    intervalMs: number;
    maxBackoffMs?: number;
    // A failure only someone can fix: polling stops until refresh() (or until
    // it is enabled again) instead of repeating it.
    stopOn?: (error: unknown) => boolean;
};

// Sequential polling: the next request is scheduled only after the previous
// one settled, failures back off exponentially (interval x 2^n, capped), and
// a disabled poll aborts its request. refresh() polls now unless a request is
// already running.
export function usePolling<T>({ fetcher, enabled, intervalMs, maxBackoffMs = 60_000, stopOn }: PollOptions<T>): PollState<T> & { refresh: () => void } {
    const [state, setState] = useState<PollState<T>>({ data: null, error: null, loading: false, lastSuccess: null, failures: 0, nextAt: null });
    const fetcherRef = useRef(fetcher);
    const stopOnRef = useRef(stopOn);
    useLayoutEffect(() => {
        fetcherRef.current = fetcher;
        stopOnRef.current = stopOn;
    });
    const stoppedRef = useRef(false);
    const controllerRef = useRef<AbortController | null>(null);
    const timerRef = useRef<number | null>(null);
    const failuresRef = useRef(0);
    const runRef = useRef<() => void>(() => undefined);

    useEffect(() => {
        if (!enabled) return;
        let disposed = false;
        stoppedRef.current = false;

        const schedule = () => {
            const delay = failuresRef.current === 0 ? intervalMs : Math.min(maxBackoffMs, intervalMs * 2 ** failuresRef.current);
            timerRef.current = window.setTimeout(run, delay);
            setState((previous) => ({ ...previous, nextAt: Date.now() + delay }));
        };

        const run = () => {
            if (disposed || controllerRef.current) return;
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = null;
            const controller = new AbortController();
            controllerRef.current = controller;
            setState((previous) => ({ ...previous, loading: true, nextAt: null }));
            fetcherRef.current(controller.signal).then(
                (data) => {
                    if (controller.signal.aborted) return;
                    failuresRef.current = 0;
                    setState((previous) => ({ ...previous, data, error: null, loading: false, lastSuccess: Date.now(), failures: 0 }));
                },
                (error: unknown) => {
                    if (controller.signal.aborted) return;
                    failuresRef.current += 1;
                    if (stopOnRef.current?.(error)) stoppedRef.current = true;
                    setState((previous) => ({ ...previous, error, loading: false, failures: failuresRef.current }));
                }
            ).finally(() => {
                if (controllerRef.current === controller) controllerRef.current = null;
                if (!disposed && !controller.signal.aborted && !stoppedRef.current) schedule();
            });
        };

        runRef.current = run;
        run();

        return () => {
            disposed = true;
            runRef.current = () => undefined;
            if (timerRef.current !== null) window.clearTimeout(timerRef.current);
            timerRef.current = null;
            controllerRef.current?.abort();
            controllerRef.current = null;
            setState((previous) => ({ ...previous, loading: false, nextAt: null }));
        };
    }, [enabled, intervalMs, maxBackoffMs]);

    const refresh = useCallback(() => {
        failuresRef.current = 0;
        stoppedRef.current = false;
        runRef.current();
    }, []);

    return { ...state, refresh };
}
