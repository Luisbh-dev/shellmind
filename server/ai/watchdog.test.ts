import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createUpstreamWatchdog, defaultTimeouts, UpstreamTimeoutError } from './watchdog';

const limits = { connectMs: 100, idleMs: 50, totalMs: 1000 };

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('createUpstreamWatchdog', () => {
    it('aborts when the response does not start in time', () => {
        const watchdog = createUpstreamWatchdog(undefined, limits);
        vi.advanceTimersByTime(99);
        expect(watchdog.signal.aborted).toBe(false);
        vi.advanceTimersByTime(1);
        expect(watchdog.signal.aborted).toBe(true);
        expect(watchdog.timeoutError()).toBeInstanceOf(UpstreamTimeoutError);
        expect(watchdog.timeoutError()?.phase).toBe('connect');
    });

    it('restarts the idle limit on every chunk and enforces the total limit', () => {
        const watchdog = createUpstreamWatchdog(undefined, limits);
        watchdog.connected();
        for (let i = 0; i < 18; i++) {
            vi.advanceTimersByTime(40);
            watchdog.activity();
        }
        expect(watchdog.signal.aborted).toBe(false);
        vi.advanceTimersByTime(50);
        expect(watchdog.timeoutError()?.phase).toBe('idle');

        const busy = createUpstreamWatchdog(undefined, limits);
        busy.connected();
        for (let i = 0; i < 30; i++) {
            vi.advanceTimersByTime(40);
            busy.activity();
        }
        expect(busy.timeoutError()?.phase).toBe('total');
    });

    it('follows the caller abort without reporting a timeout, and stops after dispose', () => {
        const parent = new AbortController();
        const watchdog = createUpstreamWatchdog(parent.signal, limits);
        parent.abort();
        expect(watchdog.signal.aborted).toBe(true);
        expect(watchdog.timeoutError()).toBeNull();

        const disposed = createUpstreamWatchdog(undefined, limits);
        disposed.dispose();
        vi.advanceTimersByTime(5000);
        expect(disposed.signal.aborted).toBe(false);
    });

    it('gives non-streamed answers longer to start', () => {
        expect(defaultTimeouts(false).connectMs).toBeGreaterThan(defaultTimeouts(true).connectMs);
    });
});
