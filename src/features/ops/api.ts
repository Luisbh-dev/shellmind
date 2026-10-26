import type {
    ComposeAction,
    ComposeOverview,
    ContainerAction,
    ContainerInspectSummary,
    ContainerList,
    ContainerStats,
    DiskUsage,
    ImageList,
    OpsActionResult,
    OpsCapabilities,
    PruneMode,
    PrunePreview,
    PruneResult,
    ServiceAction,
    ServiceDetail,
    ServicesList
} from '@shared/ops';
import { api } from '@/lib/api';

// Typed calls of the operations endpoints (server/http/routes/ops.ts). Only
// names travel: the backend builds every command.

const base = (serverId: number) => `/api/servers/${serverId}/ops`;
const part = encodeURIComponent;

export type ContainerDetail = { inspect: unknown; summary: ContainerInspectSummary | null };

export const opsApi = {
    capabilities: (serverId: number, refresh = false, signal?: AbortSignal) =>
        api.get<OpsCapabilities>(`${base(serverId)}/capabilities${refresh ? '?refresh=1' : ''}`, { signal }),

    services: (serverId: number, signal?: AbortSignal) =>
        api.get<ServicesList>(`${base(serverId)}/services`, { signal }),

    service: (serverId: number, name: string, signal?: AbortSignal) =>
        api.get<ServiceDetail>(`${base(serverId)}/services/${part(name)}`, { signal }),

    journal: (serverId: number, name: string, lines: number, signal?: AbortSignal) =>
        api.get<{ text: string }>(`${base(serverId)}/services/${part(name)}/journal?lines=${lines}`, { signal }).then((body) => body.text),

    serviceAction: (serverId: number, name: string, action: ServiceAction) =>
        api.post<OpsActionResult>(`${base(serverId)}/services/${part(name)}/${action}`),

    containers: (serverId: number, signal?: AbortSignal) =>
        api.get<ContainerList>(`${base(serverId)}/containers`, { signal }),

    containerStats: (serverId: number, signal?: AbortSignal) =>
        api.get<{ stats: ContainerStats[] }>(`${base(serverId)}/container-stats`, { signal }).then((body) => body.stats),

    // The inspect output and the summary the container panel shows.
    container: (serverId: number, ref: string, signal?: AbortSignal) =>
        api.get<ContainerDetail>(`${base(serverId)}/containers/${part(ref)}`, { signal }),

    containerUsage: (serverId: number, ref: string, signal?: AbortSignal) =>
        api.get<{ stats: ContainerStats | null }>(`${base(serverId)}/containers/${part(ref)}/stats`, { signal }).then((body) => body.stats),

    containerLogs: (serverId: number, ref: string, lines: number, signal?: AbortSignal) =>
        api.get<{ text: string }>(`${base(serverId)}/containers/${part(ref)}/logs?lines=${lines}`, { signal }).then((body) => body.text),

    containerAction: (serverId: number, ref: string, action: ContainerAction) =>
        api.post<OpsActionResult>(`${base(serverId)}/containers/${part(ref)}/${action}`),

    compose: (serverId: number, signal?: AbortSignal) =>
        api.get<ComposeOverview>(`${base(serverId)}/compose`, { signal }),

    composeAction: (serverId: number, project: string, action: ComposeAction, service?: string) =>
        api.post<OpsActionResult>(`${base(serverId)}/compose/${part(project)}/${action}`, service ? { service } : {}),

    images: (serverId: number, signal?: AbortSignal) =>
        api.get<ImageList>(`${base(serverId)}/images`, { signal }),

    diskUsage: (serverId: number, signal?: AbortSignal) =>
        api.get<DiskUsage>(`${base(serverId)}/disk-usage`, { signal }),

    prunePreview: (serverId: number, mode: PruneMode, signal?: AbortSignal) =>
        api.get<PrunePreview>(`${base(serverId)}/images/prune-preview?mode=${mode}`, { signal }),

    prune: (serverId: number, mode: PruneMode) =>
        api.post<PruneResult>(`${base(serverId)}/images/prune`, { mode }),

    removeImage: (serverId: number, ref: string) =>
        api.post<OpsActionResult>(`${base(serverId)}/images/remove`, { ref })
};
