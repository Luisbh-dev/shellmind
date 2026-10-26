// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, captureLaunchParams, forgetAuthToken, getApiBase, getAuthToken, onUnauthorized, setAuthToken } from './api';

// How the UI learns where its backend is and which session token to send.

beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    window.history.replaceState(null, '', '/');
    document.head.querySelectorAll('meta').forEach((meta) => meta.remove());
});

// A <meta> the server that delivered index.html wrote into it.
function pageSetting(name: string, content: string) {
    const meta = document.createElement('meta');
    meta.name = name;
    meta.content = content;
    document.head.append(meta);
}

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('captureLaunchParams', () => {
    it('keeps ?api and ?token for the session and strips them from the URL', () => {
        window.history.replaceState({ keep: 1 }, '', '/index.html?api=http://127.0.0.1:49152/&token=t0k3n&lang=es#top');

        captureLaunchParams();

        expect(getApiBase()).toBe('http://127.0.0.1:49152');
        expect(getAuthToken()).toBe('t0k3n');
        expect(window.location.pathname + window.location.search + window.location.hash).toBe('/index.html?lang=es#top');
        expect(window.history.state).toEqual({ keep: 1 });
        expect(localStorage.length).toBe(0);
    });

    it('ignores a non-loopback api parameter but still strips it', () => {
        window.history.replaceState(null, '', '/?api=https://evil.example&token=t');

        captureLaunchParams();

        expect(getApiBase()).toBe('http://127.0.0.1:3001');
        expect(getAuthToken()).toBe('t');
        expect(window.location.search).toBe('');
    });

    it('leaves the URL alone when there is nothing to capture', () => {
        window.history.replaceState(null, '', '/?lang=es');
        const replaceState = vi.spyOn(window.history, 'replaceState');

        captureLaunchParams();

        expect(replaceState).not.toHaveBeenCalled();
        expect(getAuthToken()).toBeUndefined();
    });
});

describe('access token storage', () => {
    it('keeps a token for this session only unless asked to remember it', () => {
        setAuthToken('session-only', { remember: false });
        expect(getAuthToken()).toBe('session-only');
        expect(localStorage.getItem('shellmind.token')).toBeNull();

        setAuthToken('remembered', { remember: true });
        sessionStorage.clear();
        expect(getAuthToken()).toBe('remembered');

        forgetAuthToken('remembered');
        expect(getAuthToken()).toBeUndefined();
    });

    it('prefers the launch token over a remembered one', () => {
        setAuthToken('remembered', { remember: true });
        window.history.replaceState(null, '', '/?token=launch');
        captureLaunchParams();
        expect(getAuthToken()).toBe('launch');
    });

    it('forgets only the token that was refused', () => {
        setAuthToken('remembered', { remember: true });
        window.history.replaceState(null, '', '/?token=crafted');
        captureLaunchParams();

        forgetAuthToken('crafted');
        expect(getAuthToken()).toBe('remembered');
        forgetAuthToken('something-else');
        expect(localStorage.getItem('shellmind.token')).toBe('remembered');
    });

    it('sends the token and reports 401 answers to listeners', async () => {
        setAuthToken('abc', { remember: false });
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'Authentication required' }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
        }));
        vi.stubGlobal('fetch', fetchMock);
        const listener = vi.fn();
        const unsubscribe = onUnauthorized(listener);

        await expect(api.get('/api/servers')).rejects.toMatchObject({ status: 401, message: 'Authentication required' });
        expect(fetchMock.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer abc' });
        expect(listener).toHaveBeenCalledExactlyOnceWith('abc');

        await expect(api.get('/api/session', { token: 'candidate' })).rejects.toMatchObject({ status: 401 });
        expect(fetchMock.mock.calls[1][1].headers).toEqual({ Authorization: 'Bearer candidate' });
        expect(listener).toHaveBeenLastCalledWith('candidate');

        unsubscribe();
        await expect(api.get('/api/servers')).rejects.toMatchObject({ status: 401 });
        expect(listener).toHaveBeenCalledTimes(2);
    });
});

describe('settings written into the page', () => {
    it('uses the dev server session (npm start) after a launch token', () => {
        pageSetting('shellmind-dev-session', JSON.stringify({ token: 'dev-token', apiBase: 'http://127.0.0.1:4000/' }));
        expect(getAuthToken()).toBe('dev-token');
        expect(getApiBase()).toBe('http://127.0.0.1:4000');

        setAuthToken('typed', { remember: true });
        expect(getAuthToken()).toBe('typed');
        sessionStorage.clear();
        expect(getAuthToken()).toBe('dev-token');
    });

    it('ignores a malformed dev session', () => {
        pageSetting('shellmind-dev-session', '{not json');
        expect(getAuthToken()).toBeUndefined();
        expect(getApiBase()).toBe('http://127.0.0.1:3001');
    });

    it("calls the page's own origin only when the backend served the page", () => {
        expect(getApiBase()).toBe('http://127.0.0.1:3001');
        pageSetting('shellmind-api', 'same-origin');
        expect(getApiBase()).toBe(window.location.origin);
    });
});
