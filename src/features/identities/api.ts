import type {
    AgentStatus, AssignIdentityInput, AssignIdentityResult, IdentityInput, IdentitySummary, InstallEvent, InstallKeyInput, RotateKeyInput
} from '@shared/identities';
import { createSseParser } from '@shared/sse';
import { api, apiStream, ApiError, type RequestOptions } from '@/lib/api';

type Saved = { message: string; data: IdentitySummary };

export const identitiesApi = {
    list: (options?: RequestOptions) => api.data<IdentitySummary[]>('/api/identities', options),
    agent: (options?: RequestOptions) => api.get<AgentStatus>('/api/identities/agent', options),
    create: async (input: IdentityInput) => (await api.post<Saved>('/api/identities', input)).data,
    update: async (id: number, input: IdentityInput) => (await api.put<Saved & { dependents: number }>(`/api/identities/${id}`, input)).data,
    remove: (id: number) => api.del(`/api/identities/${id}`),
    assign: async (input: AssignIdentityInput) => (await api.post<{ data: AssignIdentityResult }>('/api/identities/assign', input)).data
};

// Runs an install or rotate stream, handing each event to `onEvent`. Rejects
// with ApiError when the request is refused before the stream starts, and
// with AbortError when `signal` cancels it.
async function runStream(path: string, body: unknown, onEvent: (event: InstallEvent) => void, signal?: AbortSignal): Promise<void> {
    const res = await apiStream(path, body, { signal });
    if (!res.body) throw new ApiError(res.status, 'Empty response');
    const parser = createSseParser(({ data }) => {
        try {
            const event = JSON.parse(data) as InstallEvent;
            if (event.type !== 'ping') onEvent(event);
        } catch {
            // A malformed event is skipped.
        }
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
}

export const installKeyStream = (identityId: number, input: InstallKeyInput, onEvent: (event: InstallEvent) => void, signal?: AbortSignal) =>
    runStream(`/api/identities/${identityId}/install`, input, onEvent, signal);

export const rotateKeyStream = (identityId: number, input: RotateKeyInput, onEvent: (event: InstallEvent) => void, signal?: AbortSignal) =>
    runStream(`/api/identities/${identityId}/rotate`, input, onEvent, signal);
