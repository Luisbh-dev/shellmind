import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { rawRequest, rawUpgrade } from '../helpers/rawHttp';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// SERVE_WEB=1 (`npm run serve`): the backend also serves the built web UI from
// the same origin. The files are public; the API keeps requiring the token.
// Reached on the LAN under an ALLOWED_HOSTS name, the UI's own requests carry
// its origin and must pass the Origin check.

const MARKER = '<meta name="shellmind-api" content="same-origin">';

let server: TestServer;
let webDir: string;
let lan: { host: string; origin: string };

// A module the size of a real chunk (compressible like one).
const BUNDLE = Array.from({ length: 2000 }, (_, i) => `export function f${i}(value) { return value * ${i} + "${i.toString(36)}"; }`).join('\n');

// The raw bytes and headers (fetch would decompress them).
function get(urlPath: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: '127.0.0.1', port: server.port, path: urlPath, method, headers }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.end();
    });
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    webDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-web-'));
    fs.mkdirSync(path.join(webDir, 'assets'));
    fs.writeFileSync(path.join(webDir, 'index.html'), '<!doctype html><html><head><title>ShellMind</title></head><body></body></html>');
    fs.writeFileSync(path.join(webDir, 'assets', 'index-abc123.js'), 'console.log("app")');
    fs.writeFileSync(path.join(webDir, 'assets', 'vendor-def456.js'), BUNDLE);
    fs.writeFileSync(path.join(webDir, 'assets', 'style-0a1b2c.css'), '.a{color:red}\n'.repeat(400));
    fs.writeFileSync(path.join(webDir, 'assets', 'font-9z8y7x.woff2'), Buffer.alloc(4096, 7));
    server = await bootTestServer({ env: { SERVE_WEB: '1', WEB_DIR: webDir, ALLOWED_HOSTS: 'shellmind.test' } });
    lan = { host: `shellmind.test:${server.port}`, origin: `http://shellmind.test:${server.port}` };
});

afterAll(async () => {
    await server?.close();
    fs.rmSync(webDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('self-hosted web UI', () => {
    it('serves index.html without a token, revalidated on every load', async () => {
        const res = await fetch(`${server.baseUrl}/`);
        expect(res.status).toBe(200);
        expect(res.headers.get('content-type')).toMatch(/text\/html/);
        expect(res.headers.get('cache-control')).toBe('no-cache');
        expect(res.headers.get('x-frame-options')).toBe('DENY');
        expect(await res.text()).toContain('<title>ShellMind</title>');
    });

    it('marks the page as served by its backend, at / and /index.html', async () => {
        for (const page of ['/', '/index.html']) {
            const text = await (await fetch(`${server.baseUrl}${page}`)).text();
            expect(text).toBe(`<!doctype html><html><head><title>ShellMind</title>${MARKER}</head><body></body></html>`);
        }
    });

    it('serves fingerprinted assets as immutable', async () => {
        const res = await fetch(`${server.baseUrl}/assets/index-abc123.js`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable');
    });

    it('still requires the token for the API and for unknown files', async () => {
        expect((await fetch(`${server.baseUrl}/api/servers`)).status).toBe(401);
        expect((await fetch(`${server.baseUrl}/missing.js`)).status).toBe(401);
        expect((await server.fetch('/api/servers')).status).toBe(200);
    });

    it('applies the Host check to the static files as well', async () => {
        const res = await rawRequest(server.port, { path: '/', headers: { host: 'rebind.evil.example' } });
        expect(res.status).toBe(403);
    });
});

// perf-serve-no-compression: the bundles went out uncompressed, about three
// times the bytes, to a UI that may sit behind a WAN with no proxy in front.
describe('compressed assets', () => {
    it('sends Brotli or gzip to browsers that accept it, once compressed per file', async () => {
        const br = await get('/assets/vendor-def456.js', { 'accept-encoding': 'gzip, deflate, br, zstd' });
        expect(br.status).toBe(200);
        expect(br.headers).toMatchObject({
            'content-encoding': 'br',
            vary: 'Accept-Encoding',
            'cache-control': 'public, max-age=31536000, immutable',
            'content-type': expect.stringMatching(/javascript/),
        });
        expect(zlib.brotliDecompressSync(br.body).toString()).toBe(BUNDLE);
        expect(br.body.length).toBeLessThan(BUNDLE.length / 3);

        const gz = await get('/assets/style-0a1b2c.css', { 'accept-encoding': 'gzip' });
        expect(gz.headers).toMatchObject({ 'content-encoding': 'gzip', 'content-type': expect.stringMatching(/^text\/css/) });
        expect(zlib.gunzipSync(gz.body).toString()).toBe('.a{color:red}\n'.repeat(400));

        // A revalidation of the same version is a 304; HEAD has the headers only.
        const again = await get('/assets/vendor-def456.js', { 'accept-encoding': 'br', 'if-none-match': String(br.headers.etag) });
        expect(again.status).toBe(304);
        const head = await get('/assets/vendor-def456.js', { 'accept-encoding': 'br' }, 'HEAD');
        expect(head).toMatchObject({ status: 200, headers: { 'content-length': String(br.body.length) } });
        expect(head.body.length).toBe(0);
    });

    it('sends the file as it is without Accept-Encoding, for tiny or binary files, and outside the build', async () => {
        const plain = await get('/assets/vendor-def456.js');
        expect(plain.headers['content-encoding']).toBeUndefined();
        expect(plain.body.toString()).toBe(BUNDLE);
        // The plain copy is immutable for a year too: without Vary, a shared
        // cache that saw it first would hand it to every browser.
        expect(plain.headers).toMatchObject({ vary: 'Accept-Encoding', 'cache-control': 'public, max-age=31536000, immutable' });
        const refused = await get('/assets/vendor-def456.js', { 'accept-encoding': 'br;q=0, gzip;q=0' });
        expect(refused.headers['content-encoding']).toBeUndefined();
        expect(refused.headers.vary).toBe('Accept-Encoding');
        // Not a text file: one representation only.
        expect((await get('/assets/font-9z8y7x.woff2')).headers.vary).toBeUndefined();
        expect((await get('/assets/index-abc123.js', { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
        expect((await get('/assets/font-9z8y7x.woff2', { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
        expect((await get('/assets/..%2f..%2fpackage.json', { 'accept-encoding': 'br' })).headers['content-encoding']).toBeUndefined();
    });

    it('prefers a precompressed copy written by a build step', async () => {
        const file = path.join(webDir, 'assets', 'chunk-5d6e7f.js');
        fs.writeFileSync(file, BUNDLE);
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync('// precompressed\n' + BUNDLE));
        const res = await get('/assets/chunk-5d6e7f.js', { 'accept-encoding': 'gzip' });
        expect(zlib.gunzipSync(res.body).toString()).toBe('// precompressed\n' + BUNDLE);
    });
});

describe('the UI opened under an ALLOWED_HOSTS name', () => {
    it('can write through the API from its own origin', async () => {
        const res = await rawRequest(server.port, {
            method: 'POST',
            path: '/api/servers',
            headers: { ...lan, ...server.authHeaders, 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'lan', ip: '10.0.0.5', type: 'linux' }),
        });
        expect(res.status).toBe(200);
    });

    it('can open its socket from its own origin', async () => {
        const polling = await rawRequest(server.port, { path: '/socket.io/?EIO=4&transport=polling', headers: lan });
        expect(polling.status).toBe(200);
        const upgrade = await rawUpgrade(server.port, { path: '/socket.io/?EIO=4&transport=websocket', headers: lan });
        expect(upgrade.status).toBe(101);
    });

    it('refuses any other origin sent to that name', async () => {
        const origin = `http://evil.example:${server.port}`;
        const res = await rawRequest(server.port, {
            method: 'POST',
            path: '/api/servers',
            headers: { host: lan.host, origin, ...server.authHeaders, 'content-type': 'application/json' },
            body: '{}',
        });
        expect(res.status).toBe(403);
        expect(res.body).toEqual({ error: 'Origin not allowed', code: 'ORIGIN_NOT_ALLOWED' });
        const polling = await rawRequest(server.port, { path: '/socket.io/?EIO=4&transport=polling', headers: { host: lan.host, origin } });
        expect(polling.status).toBe(403);
    });
});
