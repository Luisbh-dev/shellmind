// Command history and favorite commands of each server's terminals, shared
// by all its tabs and kept in this browser's localStorage.
import { create } from 'zustand';
import type { CommandSource } from '@/store/appStore';

export type HistoryEntry = { id: string; command: string; timestamp: number; source: CommandSource };
export type FavoriteEntry = { id: string; command: string; addedAt: number };

export const HISTORY_LIMIT = 30;

const historyKey = (serverId: number) => `shellmind-terminal-history:${serverId}`;
const favoritesKey = (serverId: number) => `shellmind-favorite-commands:${serverId}`;
// Before 1.0 every keystroke line was saved, passwords typed at prompts
// included; that list is migrated without its typed entries.
const legacyHistoryKey = (serverId: number) => `shellmind-command-history:${serverId}`;

const SOURCES: readonly CommandSource[] = ['typed', 'hint', 'ai', 'ai-autorun', 'snippet', 'multi-exec', 'ops'];

function storage(): Storage | undefined {
    try {
        return window.localStorage;
    } catch {
        return undefined;
    }
}

function readJson(key: string): unknown {
    try {
        const raw = storage()?.getItem(key);
        return raw ? JSON.parse(raw) : undefined;
    } catch {
        return undefined;
    }
}

function writeJson(key: string, value: unknown): void {
    try {
        storage()?.setItem(key, JSON.stringify(value));
    } catch {
        // Full or unavailable storage: the list still lives for this session.
    }
}

function removeKey(key: string): void {
    try {
        storage()?.removeItem(key);
    } catch {
        // Nothing to remove.
    }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

function isHistoryEntry(value: unknown): value is HistoryEntry {
    return isRecord(value) && typeof value.id === 'string' && typeof value.command === 'string' && value.command.trim() !== ''
        && typeof value.timestamp === 'number' && SOURCES.includes(value.source as CommandSource);
}

function isFavoriteEntry(value: unknown): value is FavoriteEntry {
    return isRecord(value) && typeof value.id === 'string' && typeof value.command === 'string' && value.command.trim() !== ''
        && typeof value.addedAt === 'number';
}

// History and favorites load independently: either may be missing or broken.
export function loadHistory(serverId: number): HistoryEntry[] {
    const stored = readJson(historyKey(serverId));
    if (Array.isArray(stored)) return stored.filter(isHistoryEntry).slice(0, HISTORY_LIMIT);

    const legacy = readJson(legacyHistoryKey(serverId));
    if (legacy === undefined) return [];
    const migrated = (Array.isArray(legacy) ? legacy : []).filter(isHistoryEntry).filter((entry) => entry.source !== 'typed').slice(0, HISTORY_LIMIT);
    writeJson(historyKey(serverId), migrated);
    removeKey(legacyHistoryKey(serverId));
    return migrated;
}

export function loadFavorites(serverId: number): FavoriteEntry[] {
    const stored = readJson(favoritesKey(serverId));
    return Array.isArray(stored) ? stored.filter(isFavoriteEntry) : [];
}

let sequence = 0;
const nextId = () => `${Date.now().toString(36)}-${(sequence += 1)}`;

interface CommandHistoryState {
    history: Record<number, HistoryEntry[]>;
    favorites: Record<number, FavoriteEntry[]>;
    // Reads the stored lists of a server once.
    load: (serverId: number) => void;
    record: (serverId: number, command: string, source: CommandSource) => void;
    remove: (serverId: number, entryId: string) => void;
    clear: (serverId: number) => void;
    toggleFavorite: (serverId: number, command: string) => void;
}

const EMPTY_HISTORY: HistoryEntry[] = [];
const EMPTY_FAVORITES: FavoriteEntry[] = [];

export const useCommandHistory = create<CommandHistoryState>()((set, get) => ({
    history: {},
    favorites: {},

    load: (serverId) => {
        if (serverId in get().history) return;
        set((state) => ({
            history: { ...state.history, [serverId]: loadHistory(serverId) },
            favorites: { ...state.favorites, [serverId]: loadFavorites(serverId) }
        }));
    },

    record: (serverId, command, source) => {
        const normalized = command.replace(/\r\n?/g, '\n').trim();
        if (!normalized) return;
        get().load(serverId);
        const current = get().history[serverId] ?? EMPTY_HISTORY;
        const next = [
            { id: nextId(), command: normalized, timestamp: Date.now(), source },
            ...current.filter((entry) => entry.command !== normalized)
        ].slice(0, HISTORY_LIMIT);
        writeJson(historyKey(serverId), next);
        set((state) => ({ history: { ...state.history, [serverId]: next } }));
    },

    remove: (serverId, entryId) => {
        const next = (get().history[serverId] ?? EMPTY_HISTORY).filter((entry) => entry.id !== entryId);
        writeJson(historyKey(serverId), next);
        set((state) => ({ history: { ...state.history, [serverId]: next } }));
    },

    clear: (serverId) => {
        writeJson(historyKey(serverId), []);
        set((state) => ({ history: { ...state.history, [serverId]: EMPTY_HISTORY } }));
    },

    toggleFavorite: (serverId, command) => {
        get().load(serverId);
        const current = get().favorites[serverId] ?? EMPTY_FAVORITES;
        const exists = current.some((entry) => entry.command === command);
        const next = exists
            ? current.filter((entry) => entry.command !== command)
            : [{ id: nextId(), command, addedAt: Date.now() }, ...current];
        writeJson(favoritesKey(serverId), next);
        set((state) => ({ favorites: { ...state.favorites, [serverId]: next } }));
    }
}));

export const selectHistory = (serverId: number) => (state: CommandHistoryState) => state.history[serverId] ?? EMPTY_HISTORY;
export const selectFavorites = (serverId: number) => (state: CommandHistoryState) => state.favorites[serverId] ?? EMPTY_FAVORITES;
