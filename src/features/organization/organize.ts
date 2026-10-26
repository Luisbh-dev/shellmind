// Searching, sorting and grouping the saved servers for the sidebar (pure
// functions; the sidebar and the command palette share them).
import type { ServerSummary } from '@shared/types';

export type SortMode = 'manual' | 'name' | 'recent';
export const SORT_MODES: readonly SortMode[] = ['manual', 'name', 'recent'];

// Last time each server was opened (epoch ms), by id.
export type RecentMap = Record<number, number>;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

export const compareNames = (a: string, b: string) => collator.compare(a, b);

const normalize = (value: string) => value.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

// Everything a search can match: name, address, user, group, tags, and the
// bucket / CLI preset / OS shown in the row.
export function searchableText(server: ServerSummary): string {
    return normalize([
        server.name,
        server.ip,
        server.username,
        server.group_name,
        ...(server.tags ?? []),
        server.s3_bucket,
        server.cli_preset,
        server.os_detail,
        server.type
    ].filter(Boolean).join('\n'));
}

// Every whitespace-separated word of the query must appear.
export function matchesQuery(server: ServerSummary, query: string): boolean {
    const words = normalize(query).split(/\s+/).filter(Boolean);
    if (words.length === 0) return true;
    const text = searchableText(server);
    return words.every((word) => text.includes(word));
}

// Servers having every selected tag (case-insensitive) and matching the query.
export function filterServers(servers: ServerSummary[], query: string, tags: string[] = []): ServerSummary[] {
    const wanted = tags.map((tag) => tag.toLowerCase());
    return servers.filter((server) => {
        if (!matchesQuery(server, query)) return false;
        const own = (server.tags ?? []).map((tag) => tag.toLowerCase());
        return wanted.every((tag) => own.includes(tag));
    });
}

export function allTags(servers: ServerSummary[]): string[] {
    const seen = new Map<string, string>();
    for (const server of servers) {
        for (const tag of server.tags ?? []) {
            if (!seen.has(tag.toLowerCase())) seen.set(tag.toLowerCase(), tag);
        }
    }
    return [...seen.values()].sort(compareNames);
}

export function allGroups(servers: ServerSummary[]): string[] {
    return [...new Set(servers.map((server) => server.group_name?.trim()).filter((name): name is string => Boolean(name)))].sort(compareNames);
}

// The manual order is sort_order, then creation order.
export function manualOrder(servers: ServerSummary[]): ServerSummary[] {
    return [...servers].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0) || a.id - b.id);
}

export function sortServers(servers: ServerSummary[], mode: SortMode, recent: RecentMap = {}): ServerSummary[] {
    if (mode === 'manual') return manualOrder(servers);
    if (mode === 'name') return [...servers].sort((a, b) => compareNames(a.name, b.name) || a.id - b.id);
    return [...servers].sort((a, b) => (recent[b.id] ?? 0) - (recent[a.id] ?? 0) || compareNames(a.name, b.name));
}

export type ServerGroup = {
    // Stable key for the collapsed state ("" for servers without a group).
    key: string;
    name: string | null;
    servers: ServerSummary[];
    // The favourites, listed above every group.
    favorites?: boolean;
};

// Key of the favourites section (no group name can start with a NUL).
export const FAVORITES_KEY = '\u0000favorites';

export const isFavorite = (server: Pick<ServerSummary, 'favorite'>) => Boolean(server.favorite);

// The section a server is listed in: the favourites, or its group.
function sectionKey(server: ServerSummary): string {
    return isFavorite(server) ? FAVORITES_KEY : server.group_name?.trim() || '';
}

// The favourites first, then named groups alphabetically, then the servers
// without a group. The order inside each section is the order of `sorted`.
export function groupServers(sorted: ServerSummary[]): ServerGroup[] {
    const groups = new Map<string, ServerGroup>();
    for (const server of sorted) {
        const key = sectionKey(server);
        if (!groups.has(key)) {
            groups.set(key, key === FAVORITES_KEY
                ? { key, name: null, servers: [], favorites: true }
                : { key, name: key || null, servers: [] });
        }
        groups.get(key)!.servers.push(server);
    }
    return [...groups.values()].sort((a, b) => {
        if (a.favorites || b.favorites) return a.favorites ? -1 : 1;
        if (a.name === null) return 1;
        if (b.name === null) return -1;
        return compareNames(a.name, b.name);
    });
}

// The manual order (all ids) after moving `id` one place up (-1) or down (+1)
// among the servers of its own section. Null when it cannot move.
export function moveInGroup(servers: ServerSummary[], id: number, delta: -1 | 1): number[] | null {
    const ordered = manualOrder(servers);
    const moving = ordered.find((server) => server.id === id);
    if (!moving) return null;
    const section = sectionKey(moving);
    const siblings = ordered.filter((server) => sectionKey(server) === section);
    const position = siblings.indexOf(moving);
    const neighbour = siblings[position + delta];
    if (!neighbour) return null;

    const ids = ordered.map((server) => server.id);
    const from = ids.indexOf(moving.id);
    const to = ids.indexOf(neighbour.id);
    [ids[from], ids[to]] = [ids[to], ids[from]];
    return ids;
}

// Applies an id order to the servers' sort_order (optimistic update).
export function withOrder(servers: ServerSummary[], ids: number[]): ServerSummary[] {
    const position = new Map(ids.map((id, index) => [id, index]));
    return servers.map((server) => (position.has(server.id) ? { ...server, sort_order: position.get(server.id)! } : server));
}
