import type { MultiExecJob, MultiExecJobInfo, MultiExecRequest, MultiExecStartResponse } from '@shared/multiexec';
import { api, apiEventStream, type Envelope } from '@/lib/api';

const job = (id: string) => `/api/multiexec/jobs/${encodeURIComponent(id)}`;

export const multiexecApi = {
    start: async (request: MultiExecRequest) => (await api.post<Envelope<MultiExecStartResponse>>('/api/multiexec', request)).data.job,
    // Newest first; `before`: the createdAt of the last job of the previous page.
    list: (query: { active?: boolean; limit?: number; before?: number } = {}, signal?: AbortSignal) => {
        const params = new URLSearchParams();
        if (query.active) params.set('active', '1');
        if (query.limit) params.set('limit', String(query.limit));
        if (query.before !== undefined) params.set('before', String(query.before));
        const search = params.toString();
        return api.data<MultiExecJobInfo[]>(`/api/multiexec/jobs${search ? `?${search}` : ''}`, { signal });
    },
    get: (id: string, signal?: AbortSignal) => api.data<MultiExecJob>(job(id), { signal }),
    events: (id: string, signal: AbortSignal) => apiEventStream(`${job(id)}/events`, { signal }),
    pause: async (id: string) => (await api.post<Envelope<MultiExecJobInfo>>(`${job(id)}/pause`)).data,
    resume: async (id: string) => (await api.post<Envelope<MultiExecJobInfo>>(`${job(id)}/resume`)).data,
    cancel: async (id: string) => (await api.post<Envelope<MultiExecJobInfo>>(`${job(id)}/cancel`)).data,
    remove: async (id: string) => {
        await api.del(job(id));
    },
    clearFinished: async () => (await api.del<Envelope<{ deleted: number }>>('/api/multiexec/jobs')).data.deleted
};
