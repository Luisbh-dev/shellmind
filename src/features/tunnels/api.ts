import type { TunnelInput, TunnelView } from '@shared/tunnels';
import { api, type Envelope, type RequestOptions } from '@/lib/api';

// Tunnels HTTP API (server/http/routes/tunnels.ts).
export const tunnelsApi = {
    list: async (serverId: number, options?: RequestOptions) =>
        (await api.get<Envelope<TunnelView[]>>(`/api/servers/${serverId}/tunnels`, options)).data,
    create: async (serverId: number, input: TunnelInput) =>
        (await api.post<Envelope<TunnelView>>(`/api/servers/${serverId}/tunnels`, input)).data,
    update: async (id: number, input: TunnelInput) =>
        (await api.put<Envelope<TunnelView>>(`/api/tunnels/${id}`, input)).data,
    remove: (id: number) => api.del(`/api/tunnels/${id}`),
    start: async (id: number) => (await api.post<Envelope<TunnelView>>(`/api/tunnels/${id}/start`)).data,
    stop: async (id: number) => (await api.post<Envelope<TunnelView>>(`/api/tunnels/${id}/stop`)).data
};
