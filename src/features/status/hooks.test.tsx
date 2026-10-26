import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePolling } from './hooks';

type Deferred = { resolve: (value: string) => void; reject: (error: Error) => void; signal: AbortSignal };

// A fetcher whose calls the test settles by hand.
function controlledFetcher() {
    const calls: Deferred[] = [];
    const fetcher = vi.fn((signal: AbortSignal) => new Promise<string>((resolve, reject) => calls.push({ resolve, reject, signal })));
    return { calls, fetcher };
}

async function settle(fn: () => void) {
    await act(async () => {
        fn();
        await Promise.resolve();
    });
}

describe('usePolling (Known issue frontend/status-overlapping-polls fixed)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('starts the next request only after the previous one settled', async () => {
        const { calls, fetcher } = controlledFetcher();
        const { result } = renderHook(() => usePolling({ fetcher, enabled: true, intervalMs: 1000 }));
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(result.current.loading).toBe(true);

        // A slow answer: no second request piles up behind it.
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(fetcher).toHaveBeenCalledTimes(1);

        await settle(() => calls[0].resolve('first'));
        expect(result.current).toMatchObject({ data: 'first', loading: false, failures: 0 });
        expect(fetcher).toHaveBeenCalledTimes(1);

        await act(async () => { vi.advanceTimersByTime(999); });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('backs off exponentially after failures and keeps the last good data', async () => {
        const { calls, fetcher } = controlledFetcher();
        const { result } = renderHook(() => usePolling({ fetcher, enabled: true, intervalMs: 1000, maxBackoffMs: 3000 }));
        await settle(() => calls[0].resolve('good'));
        await act(async () => { vi.advanceTimersByTime(1000); });
        await settle(() => calls[1].reject(new Error('down')));
        expect(result.current).toMatchObject({ data: 'good', failures: 1 });
        expect((result.current.error as Error).message).toBe('down');

        await act(async () => { vi.advanceTimersByTime(1999); });
        expect(fetcher).toHaveBeenCalledTimes(2);
        await act(async () => { vi.advanceTimersByTime(1); });
        expect(fetcher).toHaveBeenCalledTimes(3);

        await settle(() => calls[2].reject(new Error('down')));
        // 1000 x 2^2 is capped at 3000.
        await act(async () => { vi.advanceTimersByTime(3000); });
        expect(fetcher).toHaveBeenCalledTimes(4);
        await settle(() => calls[3].resolve('back'));
        expect(result.current).toMatchObject({ data: 'back', error: null, failures: 0 });
    });

    it('aborts the request and stops scheduling when disabled', async () => {
        const { calls, fetcher } = controlledFetcher();
        const { rerender, result } = renderHook(({ enabled }) => usePolling({ fetcher, enabled, intervalMs: 1000 }), { initialProps: { enabled: true } });
        rerender({ enabled: false });
        expect(calls[0].signal.aborted).toBe(true);
        await settle(() => calls[0].resolve('late'));
        expect(result.current.data).toBeNull();
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('does nothing while disabled and refreshes on demand when idle', async () => {
        const { calls, fetcher } = controlledFetcher();
        const { rerender, result } = renderHook(({ enabled }) => usePolling({ fetcher, enabled, intervalMs: 5000 }), { initialProps: { enabled: false } });
        expect(fetcher).not.toHaveBeenCalled();
        rerender({ enabled: true });
        await settle(() => calls[0].resolve('a'));
        act(() => result.current.refresh());
        expect(fetcher).toHaveBeenCalledTimes(2);
        // Ignored while a request runs.
        act(() => result.current.refresh());
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    // W7 integration: rejected credentials are not retried by themselves (the
    // fleet board holds on them too).
    it('stops on a failure only someone can fix, until refreshed', async () => {
        const { calls, fetcher } = controlledFetcher();
        const stopOn = (error: unknown) => (error as Error).message === 'AUTH_FAILED';
        const { result } = renderHook(() => usePolling({ fetcher, enabled: true, intervalMs: 1000, stopOn }));
        await settle(() => calls[0].reject(new Error('AUTH_FAILED')));
        expect(result.current).toMatchObject({ failures: 1, nextAt: null });
        await act(async () => { vi.advanceTimersByTime(120_000); });
        expect(fetcher).toHaveBeenCalledTimes(1);

        act(() => result.current.refresh());
        expect(fetcher).toHaveBeenCalledTimes(2);
        // Any other failure keeps backing off as before.
        await settle(() => calls[1].reject(new Error('ECONNREFUSED')));
        await act(async () => { vi.advanceTimersByTime(2000); });
        expect(fetcher).toHaveBeenCalledTimes(3);
    });
});
