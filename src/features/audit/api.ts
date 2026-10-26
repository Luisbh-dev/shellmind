import type { AuditEntry, AuditRetentionDays, AuditSettings, AuditSource } from '@shared/types';
import { api } from '@/lib/api';

// How long entries are kept (GET/PUT /api/audit/settings).
export async function fetchAuditSettings(signal?: AbortSignal): Promise<AuditSettings> {
    return (await api.get<{ data: AuditSettings }>('/api/audit/settings', { signal })).data;
}

// Saves the retention; the backend applies it at once (`pruned` entries went).
export async function saveAuditRetention(retentionDays: AuditRetentionDays): Promise<{ settings: AuditSettings; pruned: number }> {
    const res = await api.put<{ data: AuditSettings; pruned: number }>('/api/audit/settings', { retentionDays });
    return { settings: res.data, pruned: res.pruned };
}

export type AuditFilters = {
    serverId?: number;
    source?: AuditSource;
    // Text in the command or the server name.
    q?: string;
    // Epoch ms, inclusive.
    from?: number;
    to?: number;
};

export const AUDIT_PAGE_SIZE = 100;
// GET /api/audit returns at most this many entries per request.
export const AUDIT_EXPORT_PAGE_SIZE = 500;

export function auditQuery(filters: AuditFilters, page: { limit: number; before?: number }): string {
    const params = new URLSearchParams();
    if (filters.serverId !== undefined) params.set('serverId', String(filters.serverId));
    if (filters.source) params.set('source', filters.source);
    if (filters.q?.trim()) params.set('q', filters.q.trim());
    if (filters.from !== undefined) params.set('from', String(filters.from));
    if (filters.to !== undefined) params.set('to', String(filters.to));
    params.set('limit', String(page.limit));
    if (page.before !== undefined) params.set('before', String(page.before));
    return params.toString();
}

// Newest first; `before` is the id of the last entry of the previous page.
export async function fetchAuditPage(filters: AuditFilters, page: { limit: number; before?: number }, signal?: AbortSignal): Promise<AuditEntry[]> {
    const res = await api.get<{ data: AuditEntry[] }>(`/api/audit?${auditQuery(filters, page)}`, { signal });
    return res.data ?? [];
}

// Every entry matching the filters, newest first, up to `max`. `truncated`
// says whether more were left out.
export async function fetchAllAudit(filters: AuditFilters, max: number, signal?: AbortSignal): Promise<{ entries: AuditEntry[]; truncated: boolean }> {
    const entries: AuditEntry[] = [];
    let before: number | undefined;
    while (entries.length < max) {
        const page = await fetchAuditPage(filters, { limit: AUDIT_EXPORT_PAGE_SIZE, before }, signal);
        entries.push(...page);
        if (page.length < AUDIT_EXPORT_PAGE_SIZE) return { entries, truncated: false };
        before = page[page.length - 1].id;
    }
    const more = await fetchAuditPage(filters, { limit: 1, before }, signal);
    return { entries: entries.slice(0, max), truncated: more.length > 0 || entries.length > max };
}
