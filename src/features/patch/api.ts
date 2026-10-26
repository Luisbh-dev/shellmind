import type {
    PatchApplyRequest,
    PatchApplyResponse,
    PatchFleet,
    PatchPreview,
    PatchPreviewRequest,
    PatchScan,
    PatchScanEvent,
    PatchServerState
} from '@shared/patch';
import { createSseParser } from '@shared/sse';
import { api, apiStream, type Envelope } from '@/lib/api';

const server = (id: number) => `/api/servers/${id}/patch`;

export type RefreshOutcome = { exitCode: number | null; output: string; scan: PatchScan };

// Reads the scan stream (Server-Sent Events of PatchScanEvent) until it ends.
async function readScanEvents(body: ReadableStream<Uint8Array>, onEvent: (event: PatchScanEvent) => void): Promise<void> {
    const parser = createSseParser(({ data }) => {
        try {
            onEvent(JSON.parse(data) as PatchScanEvent);
        } catch {
            // A malformed event is skipped.
        }
    });
    const reader = body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();
}

export const patchApi = {
    fleet: (signal?: AbortSignal) => api.data<PatchFleet>('/api/patch/fleet', { signal }),
    server: (id: number, signal?: AbortSignal) => api.data<PatchServerState>(server(id), { signal }),
    scan: async (id: number, signal?: AbortSignal) => (await api.post<Envelope<PatchScan>>(`${server(id)}/scan`, undefined, { signal })).data,
    refresh: async (id: number, signal?: AbortSignal) => (await api.post<Envelope<RefreshOutcome>>(`${server(id)}/refresh`, undefined, { signal })).data,
    // Scans several servers; `onEvent` gets each start, result and failure.
    scanMany: async (serverIds: number[], onEvent: (event: PatchScanEvent) => void, signal?: AbortSignal) => {
        const res = await apiStream('/api/patch/scan', { serverIds }, { signal });
        if (res.body) await readScanEvents(res.body, onEvent);
    },
    preview: async (request: PatchPreviewRequest, signal?: AbortSignal) => (await api.post<Envelope<PatchPreview>>('/api/patch/preview', request, { signal })).data,
    apply: async (request: PatchApplyRequest) => (await api.post<Envelope<PatchApplyResponse>>('/api/patch/apply', request)).data
};
