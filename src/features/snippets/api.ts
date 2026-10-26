import type { Snippet } from '@shared/types';
import type { SnippetImportResult, SnippetInput } from '@shared/snippets';
import { api, type Envelope } from '@/lib/api';

export const snippetsApi = {
    list: (signal?: AbortSignal) => api.data<Snippet[]>('/api/snippets', { signal }),
    create: async (input: SnippetInput) => (await api.post<Envelope<Snippet>>('/api/snippets', input)).data,
    update: async (id: number, input: SnippetInput) => (await api.put<Envelope<Snippet>>(`/api/snippets/${id}`, input)).data,
    remove: async (id: number) => {
        await api.del(`/api/snippets/${id}`);
    },
    importMany: async (snippets: SnippetInput[]) =>
        (await api.post<Envelope<SnippetImportResult>>('/api/snippets/import', { snippets })).data
};
