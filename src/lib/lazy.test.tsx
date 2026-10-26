import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Suspense, useState } from 'react';
import { setLanguage } from '@/i18n';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { LazyDialog } from '@/components/ui/Skeleton';
import { importWithRetry, isChunkLoadError, lazyWithRetry, resetFailedLoads } from './lazy';

const chunkError = () => new TypeError('Failed to fetch dynamically imported module: http://localhost/assets/Panel-abc.js');

// A module whose download fails `failures` times, then works.
function flakyModule(failures: number) {
    let calls = 0;
    const factory = vi.fn(async () => {
        calls += 1;
        if (calls <= failures) throw chunkError();
        return { default: ({ label }: { label: string }) => <p>{label} loaded</p> };
    });
    return factory;
}

// React re-throws render errors to window in development builds.
const silence = (event: ErrorEvent) => event.preventDefault();

beforeEach(() => {
    setLanguage('en');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    window.addEventListener('error', silence);
});

afterEach(() => {
    window.removeEventListener('error', silence);
    resetFailedLoads();
    vi.mocked(console.error).mockRestore();
    setLanguage('system');
});

describe('importWithRetry', () => {
    it('retries a failed import before giving up', async () => {
        const factory = flakyModule(2);
        await expect(importWithRetry(factory, { retries: 2, delay: () => 0 })).resolves.toHaveProperty('default');
        expect(factory).toHaveBeenCalledTimes(3);

        const hopeless = flakyModule(5);
        await expect(importWithRetry(hopeless, { retries: 1, delay: () => 0 })).rejects.toThrow(/dynamically imported module/);
        expect(hopeless).toHaveBeenCalledTimes(2);
    });

    it('recognises the browsers’ chunk load errors', () => {
        expect(isChunkLoadError(chunkError())).toBe(true);
        expect(isChunkLoadError(new TypeError('Importing a module script failed.'))).toBe(true);
        expect(isChunkLoadError(new Error('xterm exploded'))).toBe(false);
    });
});

describe('lazyWithRetry', () => {
    it('loads a panel again on "Reload panel" after its download failed', async () => {
        const factory = flakyModule(1);
        const Panel = lazyWithRetry(factory, { retries: 0 });

        render(
            <ErrorBoundary scope="panel" label="Operations">
                <Suspense fallback={<p>loading</p>}>
                    <Panel label="Operations" />
                </Suspense>
            </ErrorBoundary>
        );

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Operations stopped working');
        expect(alert).toHaveTextContent('could not be downloaded');

        // React.lazy alone would throw the cached failure again here.
        fireEvent.click(screen.getByRole('button', { name: 'Reload panel' }));
        expect(await screen.findByText('Operations loaded')).toBeInTheDocument();
        expect(factory).toHaveBeenCalledTimes(2);
    });

    it('opens a dialog whose download failed once on "Try again" and when opened again', async () => {
        const factory = flakyModule(2);
        const Dialog = lazyWithRetry(factory, { retries: 0 });
        function Host() {
            const [open, setOpen] = useState(true);
            return (
                <>
                    <button type="button" onClick={() => setOpen(true)}>open</button>
                    {open && (
                        <LazyDialog onClose={() => setOpen(false)}>
                            <Dialog label="Snippets" />
                        </LazyDialog>
                    )}
                </>
            );
        }
        render(<Host />);

        const failure = await screen.findByRole('dialog', { name: 'This window could not be opened' });
        fireEvent.click(screen.getAllByRole('button', { name: 'Close' })[0]);
        expect(failure).not.toBeInTheDocument();

        // Opened again: downloaded anew (and failing a second time).
        fireEvent.click(screen.getByRole('button', { name: 'open' }));
        await screen.findByRole('dialog', { name: 'This window could not be opened' });
        expect(factory).toHaveBeenCalledTimes(2);

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
        });
        expect(await screen.findByText('Snippets loaded')).toBeInTheDocument();
        expect(factory).toHaveBeenCalledTimes(3);
    });
});
