import { describe, expect, it } from 'vitest';
import type { ServerSummary } from '@shared/types';
import {
    FAVORITES_KEY, allGroups, allTags, filterServers, groupServers, isFavorite, matchesQuery, moveInGroup, sortServers, withOrder
} from './organize';

const server = (id: number, name: string, extra: Partial<ServerSummary> = {}): ServerSummary =>
    ({ id, name, ip: `10.0.0.${id}`, type: 'linux', sort_order: 0, ...extra });

const SERVERS: ServerSummary[] = [
    server(1, 'web-2', { group_name: 'Prod', tags: ['web', 'EU'], username: 'deploy', sort_order: 2 }),
    server(2, 'web-10', { group_name: 'Prod', tags: ['web'], sort_order: 1 }),
    server(3, 'Base de datos', { group_name: 'Staging', tags: ['db'], sort_order: 0 }),
    server(4, 'laptop', { type: 'local', ip: 'local', cli_preset: 'azure', sort_order: 3 }),
    server(5, 'bucket', { type: 's3', ip: '', s3_bucket: 'nightly-backups', sort_order: 4 }),
];

describe('search', () => {
    it('matches name, address, user, group, tags, bucket and preset, ignoring case and accents', () => {
        expect(matchesQuery(SERVERS[0], 'DEPLOY')).toBe(true);
        expect(matchesQuery(SERVERS[0], '10.0.0.1')).toBe(true);
        expect(matchesQuery(SERVERS[0], 'prod eu')).toBe(true);
        expect(matchesQuery(SERVERS[0], 'prod db')).toBe(false);
        expect(matchesQuery(SERVERS[2], 'datos')).toBe(true);
        expect(matchesQuery(server(9, 'Producción'), 'produccion')).toBe(true);
        expect(matchesQuery(SERVERS[3], 'azure')).toBe(true);
        expect(matchesQuery(SERVERS[4], 'nightly')).toBe(true);
        expect(matchesQuery(SERVERS[4], '   ')).toBe(true);
    });

    it('filters by query and by every selected tag', () => {
        expect(filterServers(SERVERS, '', ['web']).map((s) => s.id)).toEqual([1, 2]);
        expect(filterServers(SERVERS, '', ['web', 'eu']).map((s) => s.id)).toEqual([1]);
        expect(filterServers(SERVERS, 'web', ['db'])).toEqual([]);
    });

    it('collects tags and groups', () => {
        expect(allTags(SERVERS)).toEqual(['db', 'EU', 'web']);
        expect(allGroups(SERVERS)).toEqual(['Prod', 'Staging']);
    });
});

describe('sorting and grouping', () => {
    it('sorts manually, by name (natural order) or by recent use', () => {
        expect(sortServers(SERVERS, 'manual').map((s) => s.id)).toEqual([3, 2, 1, 4, 5]);
        expect(sortServers(SERVERS, 'name').map((s) => s.name)).toEqual(['Base de datos', 'bucket', 'laptop', 'web-2', 'web-10']);
        expect(sortServers(SERVERS, 'recent', { 5: 300, 1: 200 }).map((s) => s.id)).toEqual([5, 1, 3, 4, 2]);
    });

    it('groups named groups alphabetically and ungrouped servers last', () => {
        const groups = groupServers(sortServers(SERVERS, 'manual'));
        expect(groups.map((g) => [g.key, g.servers.map((s) => s.id)])).toEqual([
            ['Prod', [2, 1]],
            ['Staging', [3]],
            ['', [4, 5]],
        ]);
        expect(groups[2].name).toBeNull();
    });

    it('moves a server within its group and leaves the rest of the order alone', () => {
        // Manual order: 3, 2, 1, 4, 5 — moving 1 up swaps it with 2 (its group neighbour).
        expect(moveInGroup(SERVERS, 1, -1)).toEqual([3, 1, 2, 4, 5]);
        expect(moveInGroup(SERVERS, 2, -1)).toBeNull();
        expect(moveInGroup(SERVERS, 3, 1)).toBeNull();
        expect(moveInGroup(SERVERS, 4, 1)).toEqual([3, 2, 1, 5, 4]);
        expect(moveInGroup(SERVERS, 99, 1)).toBeNull();

        const reordered = withOrder(SERVERS, [3, 1, 2, 4, 5]);
        expect(sortServers(reordered, 'manual').map((s) => s.id)).toEqual([3, 1, 2, 4, 5]);
    });
});

describe('favourites', () => {
    // 1 and 4 are favourites: they leave their groups for the section on top.
    const WITH_FAVORITES = SERVERS.map((s) => (s.id === 1 || s.id === 4 ? { ...s, favorite: 1 } : s));

    it('lists the favourites above every group, in the sort order', () => {
        const groups = groupServers(sortServers(WITH_FAVORITES, 'manual'));
        expect(groups.map((g) => [g.key, g.servers.map((s) => s.id)])).toEqual([
            [FAVORITES_KEY, [1, 4]],
            ['Prod', [2]],
            ['Staging', [3]],
            ['', [5]],
        ]);
        expect(groups[0]).toMatchObject({ favorites: true, name: null });
        expect(groupServers(sortServers(WITH_FAVORITES, 'name'))[0].servers.map((s) => s.id)).toEqual([4, 1]);
        expect(isFavorite({ favorite: true })).toBe(true);
        expect(isFavorite({ favorite: 0 })).toBe(false);
        expect(isFavorite({})).toBe(false);
    });

    it('moves a favourite among the favourites only', () => {
        // Manual order: 3, 2, 1, 4, 5; favourites 1 and 4 are neighbours.
        expect(moveInGroup(WITH_FAVORITES, 4, -1)).toEqual([3, 2, 4, 1, 5]);
        expect(moveInGroup(WITH_FAVORITES, 1, -1)).toBeNull();
        // 2 has no other non-favourite server left in Prod.
        expect(moveInGroup(WITH_FAVORITES, 2, 1)).toBeNull();
    });
});
