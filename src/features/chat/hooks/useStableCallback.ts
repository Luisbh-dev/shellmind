import { useCallback, useLayoutEffect, useRef } from 'react';

// A callback with a stable identity that always runs the latest `fn`: memoized
// children (message items, code blocks) keep their props while the chat
// re-renders, and timers never call a stale closure.
export function useStableCallback<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    const ref = useRef(fn);
    useLayoutEffect(() => {
        ref.current = fn;
    });
    return useCallback((...args: A) => ref.current(...args), []);
}
