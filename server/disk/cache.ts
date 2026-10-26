import type { CleanupPreview, DirectoryListing, LargeFilesResult } from "../../shared/disk";

// The results of the slow scans (directory sizes, largest files, DISM) per server,
// so going back up the explorer or reopening the view does not walk the disk
// again. Entries expire, are bounded in number, and a server's go when a
// cleanup or a release changes what is on its disks. Two requests for the
// same scan share one run.

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 300;

type Entry<T> = { value: T; storedAt: number };

export class ScanCache<T> {
    private readonly entries = new Map<string, Entry<T>>();
    private readonly running = new Map<string, Promise<T>>();

    constructor(private readonly ttlMs = TTL_MS, private readonly maxEntries = MAX_ENTRIES, private readonly now = () => Date.now()) {}

    get(key: string): T | null {
        const entry = this.entries.get(key);
        if (!entry) return null;
        if (this.now() - entry.storedAt > this.ttlMs) {
            this.entries.delete(key);
            return null;
        }
        // Most recently used last (the first one is the next to go).
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(key: string, value: T): void {
        this.entries.delete(key);
        this.entries.set(key, { value, storedAt: this.now() });
        while (this.entries.size > this.maxEntries) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    // Runs `scan` and stores its result under `key`, unless the same scan
    // (`runKey`: the key and whatever else makes it the same, such as its
    // time budget) is running already: then its result is shared.
    async run(key: string, scan: () => Promise<T>, runKey = key): Promise<T> {
        const pending = this.running.get(runKey);
        if (pending) return pending;
        const promise = scan().then((value) => {
            this.set(key, value);
            return value;
        }).finally(() => this.running.delete(runKey));
        this.running.set(runKey, promise);
        return promise;
    }

    // Drops everything under a key prefix (one server's scans).
    clear(prefix: string): void {
        for (const key of [...this.entries.keys()]) {
            if (key.startsWith(prefix)) this.entries.delete(key);
        }
    }
}

// The explorer's listings and the largest-file searches, per server.
export const usageScans = new ScanCache<DirectoryListing>();
export const largeFileScans = new ScanCache<LargeFilesResult>();
// DISM's analysis of a Windows server's component store (minutes long).
export const componentStoreAnalyses = new ScanCache<CleanupPreview>(15 * 60_000, 50);

// After a cleanup or a release: the server's disks changed.
export function clearDiskScans(serverId: number): void {
    usageScans.clear(`${serverId}|`);
    largeFileScans.clear(`${serverId}|`);
    componentStoreAnalyses.clear(`${serverId}|`);
}
