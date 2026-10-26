import type { ServerHostKey } from '@shared/tunnels';
import type { KnownHost } from '@shared/types';
import { api, type RequestOptions } from '@/lib/api';

export const knownHostsApi = {
    list: (options?: RequestOptions) => api.data<KnownHost[]>('/api/known-hosts', options),
    forget: (id: number) => api.del(`/api/known-hosts/${id}`),
    // The SSH endpoint of a saved server and the key pinned for it.
    forServer: (serverId: number, options?: RequestOptions) => api.data<ServerHostKey>(`/api/servers/${serverId}/host-key`, options)
};
