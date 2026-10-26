// The folder shown by the explorer. The path changes only together with a
// listing that succeeded, and only the latest request may change it: a slow
// or failed listing never leaves the path pointing somewhere else than the
// entries on screen.
import { useCallback, useRef, useState } from 'react';
import type { FileEntry } from '@shared/files';
import type { FileClient } from './client';
import { FileClientError } from './client';

export type DirectoryView = {
    path: string;
    entries: FileEntry[];
    truncated: boolean;
};

export type Directory = {
    view: DirectoryView | null;
    // The folder being opened (spinner), if any.
    pending: string | null;
    // Why the last listing failed (cleared by the next success).
    error: FileClientError | null;
    // Resolves to the error, or null once `path` is shown or a newer
    // navigation replaced this one (its outcome is the one that counts).
    navigate: (path: string) => Promise<FileClientError | null>;
    refresh: () => Promise<FileClientError | null>;
};

export function useDirectory(client: FileClient | null): Directory {
    const [view, setView] = useState<DirectoryView | null>(null);
    const [pending, setPending] = useState<string | null>(null);
    const [error, setError] = useState<FileClientError | null>(null);
    const latest = useRef(0);
    const viewRef = useRef<DirectoryView | null>(null);

    const navigate = useCallback(async (path: string): Promise<FileClientError | null> => {
        if (!client) return null;
        const request = ++latest.current;
        setPending(path);
        try {
            const listing = await client.list(path);
            if (request !== latest.current) return null;
            const next = { path: listing.path, entries: listing.entries, truncated: listing.truncated };
            viewRef.current = next;
            setView(next);
            setError(null);
            return null;
        } catch (caught) {
            // A newer navigation took over: this failure is not news to anyone.
            if (request !== latest.current) return null;
            const failure = caught instanceof FileClientError ? caught : new FileClientError({ code: 'FAILED', message: String(caught) });
            setError(failure);
            return failure;
        } finally {
            if (request === latest.current) setPending(null);
        }
    }, [client]);

    const refresh = useCallback(async () => {
        const current = viewRef.current;
        return current ? navigate(current.path) : null;
    }, [navigate]);

    return { view, pending, error, navigate, refresh };
}
