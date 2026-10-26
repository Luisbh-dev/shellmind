import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setLanguage } from '@/i18n';
import { MAX_OPEN_SERVERS, useAppStore } from './appStore';
import { describeOpenWork, liveSessionCount, pickEviction } from './openServers';
import { getServers, loadServers, resetServersStore, updateServers, useServersStore } from './servers';

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('open server work', () => {
    it('counts the live terminal sessions and the registered work', () => {
        const store = useAppStore.getState();
        const first = store.openTerminalSession(1);
        store.openTerminalSession(1);
        store.setTerminalSessionState(1, first, { state: 'connected' });
        expect(liveSessionCount(1)).toBe(1);
        expect(describeOpenWork(1)).toEqual(['1 live terminal session']);

        const sessions = useAppStore.getState().terminalSessions[1].sessions;
        store.setTerminalSessionState(1, sessions[1].id, { state: 'connected' });
        const unregister = store.registerUnsavedGuard(1, () => '1 upload in progress');
        expect(describeOpenWork(1)).toEqual(['1 upload in progress', '2 live terminal sessions']);
        unregister();
        expect(describeOpenWork(2)).toEqual([]);
    });

    it('makes room with the least recently used server without work, else the least recently used one', () => {
        const work: Record<number, string[]> = { 6: ['1 live terminal session'], 5: [] };
        const describe = (id: number) => work[id] ?? ['busy'];
        const open = [1, 2, 3, 4, 5, 6];

        expect(pickEviction(open.slice(0, MAX_OPEN_SERVERS - 1), 9, describe)).toBeNull();
        expect(pickEviction(open, 3, describe)).toBeNull();
        expect(pickEviction(open, 9, describe)).toEqual({ serverId: 5, work: [] });
        work[5] = ['busy'];
        expect(pickEviction(open, 9, describe)).toEqual({ serverId: 6, work: ['1 live terminal session'] });
    });
});

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('servers store', () => {
    beforeEach(() => resetServersStore());

    it('loads the list once for everyone and shares a load in flight', async () => {
        const fetchMock = vi.fn(async () => json({ message: 'success', data: [{ id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux' }] }));
        vi.stubGlobal('fetch', fetchMock);

        const [a, b] = await Promise.all([loadServers(), loadServers()]);
        expect(a).toBe(b);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(useServersStore.getState()).toMatchObject({ status: 'ready', error: null });
        // Already loaded: the dialogs that list servers do not fetch again.
        await expect(getServers()).resolves.toEqual([expect.objectContaining({ name: 'web-1' })]);
        expect(fetchMock).toHaveBeenCalledTimes(1);

        updateServers((servers) => servers.map((server) => ({ ...server, favorite: 1 })));
        expect(useServersStore.getState().servers[0].favorite).toBe(1);
    });

    it('says why the list could not be loaded', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'database is locked' }, 500)));
        await expect(loadServers()).resolves.toBeNull();
        expect(useServersStore.getState()).toMatchObject({ status: 'error', error: 'database is locked' });
        await expect(getServers()).rejects.toThrow('database is locked');
    });
});
