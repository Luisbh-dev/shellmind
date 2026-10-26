import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import viteConfig from '../../vite.config';
import { rawRequest } from '../helpers/rawHttp';

// `npm start` hands the Vite dev server the backend's session token. It must
// reach the page only, never /@vite/env: that is a classic script any website
// can include with <script src> and read back from window.

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const TOKEN = 'dev-session-token-for-tests-0123456789';
const API_BASE = 'http://127.0.0.1:3999';

let server: ViteDevServer;
let port: number;
let cacheDir: string;

// A request from a page on another website, with the headers Chromium sends.
const crossSite = (dest: string, mode: string) => ({
    'sec-fetch-dest': dest,
    'sec-fetch-mode': mode,
    'sec-fetch-site': 'cross-site',
    referer: 'https://evil.example/',
});

beforeAll(async () => {
    process.env.SHELLMIND_AUTH_TOKEN = TOKEN;
    process.env.SHELLMIND_DEV_API_BASE = API_BASE;
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-vite-'));
    const config = viteConfig({ command: 'serve', mode: 'development' });
    server = await createServer({
        ...config,
        configFile: false,
        root: repoRoot,
        cacheDir,
        logLevel: 'silent',
        optimizeDeps: { noDiscovery: true, include: [] },
        server: { ...config.server, host: '127.0.0.1', port: 0, strictPort: false, watch: null, hmr: false },
    });
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') throw new Error('Vite did not listen on a port');
    port = address.port;
}, 60_000);

afterAll(async () => {
    await server?.close();
    delete process.env.SHELLMIND_AUTH_TOKEN;
    delete process.env.SHELLMIND_DEV_API_BASE;
    if (cacheDir) fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe('dev session handover', () => {
    it('keeps the token out of /@vite/env', async () => {
        const res = await rawRequest(port, {
            path: '/@vite/env',
            headers: { host: `localhost:${port}`, ...crossSite('script', 'no-cors') },
        });
        expect(res.status).toBe(200);
        expect(res.text).not.toContain(TOKEN);
    });

    it('writes it into the served page for the UI to read', async () => {
        const res = await rawRequest(port, {
            path: '/',
            headers: { host: `localhost:${port}`, 'sec-fetch-dest': 'document', 'sec-fetch-mode': 'navigate' },
        });
        expect(res.status).toBe(200);
        const meta = /<meta name="shellmind-dev-session" content="([^"]*)"/.exec(res.text);
        const content = meta?.[1].replaceAll('&quot;', '"');
        expect(content && JSON.parse(content)).toEqual({ token: TOKEN, apiBase: API_BASE });
    });

    it('does not let other origins read the page through CORS', async () => {
        const res = await rawRequest(port, {
            path: '/',
            headers: { host: `localhost:${port}`, origin: 'http://localhost:8080', ...crossSite('empty', 'cors') },
        });
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });
});
