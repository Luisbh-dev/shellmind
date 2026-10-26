// Per-device organization preferences: collapsed sidebar groups, the sort
// mode and when each server was last opened (for "Recent"). Kept in
// localStorage; a private window or blocked storage just starts empty.
import { create } from 'zustand';
import { SORT_MODES, type RecentMap, type SortMode } from './organize';

const STORAGE_KEY = 'shellmind.organization';
const MAX_RECENT = 200;

type Stored = { collapsed: string[]; sortMode: SortMode; recent: RecentMap };

function load(): Stored {
    const fallback: Stored = { collapsed: [], sortMode: 'manual', recent: {} };
    try {
        const raw = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Partial<Stored> | null;
        if (!raw || typeof raw !== 'object') return fallback;
        const recent: RecentMap = {};
        if (raw.recent && typeof raw.recent === 'object') {
            for (const [id, at] of Object.entries(raw.recent)) {
                if (/^\d+$/.test(id) && typeof at === 'number') recent[Number(id)] = at;
            }
        }
        return {
            collapsed: Array.isArray(raw.collapsed) ? raw.collapsed.filter((key): key is string => typeof key === 'string') : [],
            sortMode: SORT_MODES.includes(raw.sortMode as SortMode) ? raw.sortMode as SortMode : 'manual',
            recent
        };
    } catch {
        return fallback;
    }
}

function save(state: Stored) {
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
        // Not remembered on this device.
    }
}

interface OrganizationPrefs extends Stored {
    toggleGroup: (key: string) => void;
    setSortMode: (mode: SortMode) => void;
    markUsed: (serverId: number) => void;
    forgetServer: (serverId: number) => void;
}

const pick = ({ collapsed, sortMode, recent }: Stored): Stored => ({ collapsed, sortMode, recent });

export const useOrganizationPrefs = create<OrganizationPrefs>()((set, get) => {
    const update = (patch: Partial<Stored>) => {
        set(patch);
        save(pick(get()));
    };
    return {
        ...load(),
        toggleGroup: (key) => {
            const collapsed = get().collapsed;
            update({ collapsed: collapsed.includes(key) ? collapsed.filter((other) => other !== key) : [...collapsed, key] });
        },
        setSortMode: (sortMode) => update({ sortMode }),
        markUsed: (serverId) => {
            const entries = Object.entries({ ...get().recent, [serverId]: Date.now() })
                .sort(([, a], [, b]) => b - a)
                .slice(0, MAX_RECENT);
            update({ recent: Object.fromEntries(entries) as RecentMap });
        },
        forgetServer: (serverId) => {
            if (!(serverId in get().recent)) return;
            const recent = { ...get().recent };
            delete recent[serverId];
            update({ recent });
        }
    };
});
