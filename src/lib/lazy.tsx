// Code-split components that recover from a failed download. React.lazy keeps
// a rejected import for good: every later render throws the same error, so a
// panel whose chunk failed once (a flaky link, a redeploy that changed the
// chunk hashes) stayed broken until the window was reloaded, and reloading
// drops every session. Here a failed load is retried a few times, and
// `resetFailedLoads()` (the panel's "Reload panel", closing a dialog that
// failed to load) swaps in a fresh lazy component that imports again.
import { createElement, lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { createLogger } from './logger';

const log = createLogger('lazy');

export type RetryOptions = {
    // Further attempts after the first one fails.
    retries?: number;
    // Wait before attempt n (1-based) of the retries.
    delay?: (attempt: number) => number;
};

export const defaultRetryDelay = (attempt: number) => Math.min(250 * 2 ** attempt, 2000);

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Runs `factory` until it resolves or `retries` further attempts failed too.
export async function importWithRetry<T>(factory: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
    const { retries = 2, delay = defaultRetryDelay } = options;
    for (let attempt = 0; ; attempt++) {
        try {
            return await factory();
        } catch (error) {
            if (attempt >= retries) throw error;
            log.debug(`import failed, retrying (${attempt + 1}/${retries})`, error);
            await wait(delay(attempt + 1));
        }
    }
}

// Loads that failed for good; each entry replaces its lazy component.
const failedLoads = new Set<() => void>();

// Lets every component whose code could not be loaded try again on its next
// render. Returns how many there were.
export function resetFailedLoads(): number {
    const resets = [...failedLoads];
    resets.forEach((reset) => reset());
    return resets.length;
}

// The browsers' messages for a module script that could not be fetched.
const CHUNK_ERROR = /dynamically imported module|Importing a module script failed|error loading dynamically imported module|Unable to preload CSS|ChunkLoadError/i;

export function isChunkLoadError(error: unknown): boolean {
    return error instanceof Error && CHUNK_ERROR.test(`${error.name}: ${error.message}`);
}

export type RetryableComponent<P> = ComponentType<P> & {
    // Starts the download ahead of the first render.
    preload: () => Promise<void>;
};

// React.lazy(factory), recovering as described above.
export function lazyWithRetry<P extends object>(
    factory: () => Promise<{ default: ComponentType<P> }>,
    options?: RetryOptions
): RetryableComponent<P> {
    let pending: Promise<{ default: ComponentType<P> }> | null = null;
    const load = () => {
        pending ??= importWithRetry(factory, options).catch((error: unknown) => {
            pending = null;
            failedLoads.add(reset);
            throw error;
        });
        return pending;
    };
    const create = (): LazyExoticComponent<ComponentType<P>> => lazy(load);
    let current = create();
    function reset() {
        failedLoads.delete(reset);
        current = create();
    }

    function Retryable(props: P) {
        return createElement(current as unknown as ComponentType<P>, props);
    }
    Retryable.preload = () => load().then(() => undefined, () => undefined);
    return Retryable;
}
