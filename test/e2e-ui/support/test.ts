import { test as base, expect, type Page } from '@playwright/test';
import type { ServerSummary } from '../../../shared/types';
import { readState, type E2EState, type HostName } from './state';

// The fixtures every spec uses: the run's state, an authenticated API client
// for setting up data, and `app`, a page with the app unlocked.

export type Api = {
    get: <T = unknown>(path: string) => Promise<T>;
    post: <T = unknown>(path: string, body?: unknown) => Promise<T>;
    del: (path: string) => Promise<void>;
};

function createApi(state: E2EState): Api {
    const call = async <T,>(method: string, path: string, body?: unknown): Promise<T> => {
        const res = await fetch(`${state.apiUrl}${path}`, {
            method,
            headers: { authorization: `Bearer ${state.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        const text = await res.text();
        if (res.status >= 400) throw new Error(`${method} ${path} -> ${res.status} ${text}`);
        return (text ? JSON.parse(text) : null) as T;
    };
    return {
        get: (path) => call('GET', path),
        post: (path, body) => call('POST', path, body),
        del: async (path) => {
            await call('DELETE', path);
        },
    };
}

export type ServerInput = Partial<Omit<ServerSummary, 'tags'>> & { tags?: string[]; password?: string };

export type Fixtures = {
    api: Api;
    app: Page;
    // Saves a server for one of the sshd containers: Linux, signing in as
    // demo / demopw unless `input` says otherwise.
    addServer: (host: HostName, input?: ServerInput) => Promise<ServerSummary>;
};

// Opens the app with the run's token in the address (the way the desktop app
// launches it); the page keeps it for its session and strips the URL.
export async function openApp(page: Page, state: E2EState): Promise<void> {
    await page.goto(`${state.webUrl}/?token=${encodeURIComponent(state.token)}`);
    await expect(page.getByRole('navigation', { name: 'Saved connections' })).toBeVisible({ timeout: 60_000 });
}

// The data a spec creates stays in the run's database; names carry a short
// random suffix so a spec run again against the same backend (see the README)
// never meets its own leftovers.
export const uid = () => Math.random().toString(36).slice(2, 7);

export async function reloadApp(page: Page): Promise<void> {
    await page.reload();
    await expect(page.getByRole('navigation', { name: 'Saved connections' })).toBeVisible({ timeout: 60_000 });
}

let serial = 0;

export const test = base.extend<Fixtures, { state: E2EState }>({
    // eslint-disable-next-line no-empty-pattern -- Playwright reads a fixture's dependencies from this pattern
    state: [async ({}, use) => {
        await use(readState());
    }, { scope: 'worker' }],
    api: async ({ state }, use) => {
        await use(createApi(state));
    },
    app: async ({ page, state }, use) => {
        await openApp(page, state);
        await use(page);
    },
    addServer: async ({ api, state }, use) => {
        await use(async (host, input = {}) => {
            serial += 1;
            const body = {
                name: `${host}-${Date.now().toString(36)}-${serial}`,
                ip: '127.0.0.1',
                port: state.hosts[host].port,
                type: 'linux',
                username: 'demo',
                password: 'demopw',
                ...input,
            };
            const res = await api.post<{ data: ServerSummary }>('/api/servers', body);
            return res.data;
        });
    },
});

export { expect };
