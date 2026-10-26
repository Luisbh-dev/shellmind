import type {
    CleanupId,
    CleanupOverview,
    CleanupParams,
    CleanupPreview,
    DeletedOpenResult,
    DeletedReleaseRequest,
    DirectoryListing,
    DiskActionResult,
    DiskOverview,
    LargeFilesResult
} from '@shared/disk';
import { api } from '@/lib/api';

// Typed calls of the disk toolkit (server/http/routes/disk.ts). Only paths,
// mounts, cleanups, parameters and process references travel: the backend
// builds every command.

const base = (serverId: number) => `/api/servers/${serverId}/disk`;

function query(values: Record<string, string | number | boolean | null | undefined>): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined || value === null || value === false) continue;
        params.set(name, value === true ? '1' : String(value));
    }
    const text = params.toString();
    return text ? `?${text}` : '';
}

export const diskApi = {
    overview: (serverId: number, signal?: AbortSignal) =>
        api.get<DiskOverview>(base(serverId), { signal }),

    usage: (serverId: number, path: string, options: { budget: number; rescan?: boolean }, signal?: AbortSignal) =>
        api.get<DirectoryListing>(`${base(serverId)}/usage${query({ path, budget: options.budget, rescan: options.rescan })}`, { signal }),

    largeFiles: (serverId: number, mount: string, minMB: number, rescan: boolean, signal?: AbortSignal) =>
        api.get<LargeFilesResult>(`${base(serverId)}/large-files${query({ mount, minMB, rescan })}`, { signal }),

    deleted: (serverId: number, mount: string, signal?: AbortSignal) =>
        api.get<DeletedOpenResult>(`${base(serverId)}/deleted${query({ mount })}`, { signal }),

    release: (serverId: number, request: DeletedReleaseRequest) =>
        api.post<DiskActionResult>(`${base(serverId)}/deleted/release`, request),

    cleanups: (serverId: number, signal?: AbortSignal) =>
        api.get<CleanupOverview>(`${base(serverId)}/cleanups`, { signal }).then((body) => body.cleanups),

    cleanupPreview: (serverId: number, id: CleanupId, params: CleanupParams, signal?: AbortSignal) =>
        api.get<CleanupPreview>(`${base(serverId)}/cleanups/${id}${query(params)}`, { signal }),

    runCleanup: (serverId: number, id: CleanupId, params: CleanupParams) =>
        api.post<DiskActionResult>(`${base(serverId)}/cleanups/${id}`, params)
};
