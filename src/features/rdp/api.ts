import type { RdpCertificateState, RdpOptions, RdpOptionsInput } from '@shared/rdp';
import { api, type RequestOptions } from '@/lib/api';

export const rdpApi = {
    // The certificate pinned for a saved server's RDP endpoint, if any.
    certificate: (serverId: number, options?: RequestOptions) => api.data<RdpCertificateState>(`/api/rdp/certificate?serverId=${serverId}`, options),
    forgetCertificate: (id: number) => api.del(`/api/rdp/certificates/${id}`),
    // Options the backend enforces for the server ("ask for the password each time").
    options: (serverId: number, options?: RequestOptions) => api.data<RdpOptions>(`/api/rdp/options?serverId=${serverId}`, options),
    setOptions: async (input: RdpOptionsInput) => (await api.put<{ data: RdpOptions }>('/api/rdp/options', input)).data
};
