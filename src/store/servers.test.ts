import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerSummary } from '@shared/types';

// A load that started before a change answers the list as it was: after a
// save, the app asks for a fresh one (the App test "replaces the open server
// object after it is edited" failed now and then under load because of it).

const server = (name: string): ServerSummary => ({ id: 1, name, ip: '10.0.0.1', type: 'linux' });

afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
});

describe('loadServers', () => {
    it('shares a load already running, and follows it with another when asked for a fresh list', async () => {
        const answers: Array<(name: string) => void> = [];
        const fetchMock = vi.fn(() => new Promise<Response>((resolve) => {
            answers.push((name) => resolve(new Response(JSON.stringify({ message: 'success', data: [server(name)] }), { status: 200, headers: { 'Content-Type': 'application/json' } })));
        }));
        vi.stubGlobal('fetch', fetchMock);
        const { loadServers, useServersStore } = await import('./servers');

        const stale = loadServers();
        const shared = loadServers();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        // The server is renamed now; the first request was already on its way.
        const fresh = loadServers({ fresh: true });
        answers[0]('web-1');
        expect((await stale)?.[0].name).toBe('web-1');
        expect((await shared)?.[0].name).toBe('web-1');
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        answers[1]('web-1-renamed');
        expect((await fresh)?.[0].name).toBe('web-1-renamed');
        expect(useServersStore.getState().servers[0].name).toBe('web-1-renamed');

        // With nothing running, a fresh load is a load.
        const again = loadServers({ fresh: true });
        expect(fetchMock).toHaveBeenCalledTimes(3);
        answers[2]('web-1-renamed');
        expect((await again)?.[0].name).toBe('web-1-renamed');
    });
});
