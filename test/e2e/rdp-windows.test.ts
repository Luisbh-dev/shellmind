import fs from 'node:fs';
import path from 'node:path';
import { X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { io as connect, type Socket } from 'socket.io-client';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { RdpOpenResult } from '../../shared/rdp';
import { decodePdu, encodeRequest } from '../../server/rdp/rdcleanpath';
import { parseConnectionConfirm } from '../../server/rdp/x224';
import { connectionRequest } from '../helpers/rdpServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The embedded Remote Desktop against a real RDP server (opt-in):
//   SHELLMIND_E2E_RDP=user@host:port  SHELLMIND_E2E_RDP_PASSWORD=<password>
// (an account allowed to sign in remotely; NLA may be on). The gateway is
// checked from Node (negotiation, TLS, the certificate it pins), then the
// production web build (`npm run build`) signs in from Chromium: the CSP
// lets the WebAssembly client run and reach the gateway, and the remote
// desktop is drawn. The session is disconnected, not signed out.

const TARGET = /^([^@]+)@(.+):(\d+)$/.exec(process.env.SHELLMIND_E2E_RDP ?? '');
const PASSWORD = process.env.SHELLMIND_E2E_RDP_PASSWORD ?? '';
const ENABLED = Boolean(TARGET && PASSWORD);
const webDir = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'dist');

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: TestServer;
let serverId: number;
let browser: Browser | null = null;
const sockets: Socket[] = [];

beforeAll(async () => {
    if (!ENABLED) return;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const built = fs.existsSync(path.join(webDir, 'index.html'));
    server = await bootTestServer({ env: built ? { SERVE_WEB: '1', WEB_DIR: webDir } : {} });
    const [, user, host, port] = TARGET!;
    const [domain, username] = user.includes('\\') ? user.split('\\') : ['', user];
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'RDP e2e', ip: host, type: 'windows', port: Number(port), username, domain, password: PASSWORD }),
    });
    serverId = ((await res.json()) as { data: { id: number } }).data.id;
    if (built) browser = await chromium.launch();
});

afterAll(async () => {
    for (const socket of sockets) socket.disconnect();
    await browser?.close();
    await server?.close();
    vi.restoreAllMocks();
});

describe.skipIf(!ENABLED)('embedded Remote Desktop against a real server', () => {
    it('negotiates TLS through the gateway and pins the server certificate', async () => {
        const socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
        sockets.push(socket);
        const opened = await new Promise<RdpOpenResult>((resolve) => socket.emit('rdp-open', { serverId, credentials: 'prompt' }, resolve));
        if (!opened.ok) throw new Error(opened.error);
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}${opened.gatewayPath}?ticket=${encodeURIComponent(opened.ticket)}`);
        ws.binaryType = 'arraybuffer';
        const answer = new Promise<Buffer>((resolve, reject) => {
            ws.onmessage = (event) => resolve(Buffer.from(event.data as ArrayBuffer));
            ws.onclose = () => reject(new Error('the gateway closed the connection'));
        });
        await new Promise((resolve) => { ws.onopen = resolve; });
        ws.send(encodeRequest({ destination: opened.destination, proxyAuth: opened.ticket, x224: connectionRequest({ user: 'e2e', protocols: 0x0b }) }));
        const pdu = decodePdu(await answer, 1024 * 1024);
        ws.close();
        expect(pdu.error).toBeUndefined();
        expect(parseConnectionConfirm(pdu.x224!)).toMatchObject({ kind: 'response', selectedProtocol: expect.any(Number) });
        const leaf = new X509Certificate(pdu.serverCertChain![0]);
        const state = (await (await server.fetch(`/api/rdp/certificate?serverId=${serverId}`)).json()) as { data: { pinned: { fingerprint: string } } };
        expect(state.data.pinned.fingerprint).toBe(leaf.fingerprint256);
    });

    it.skipIf(!fs.existsSync(path.join(webDir, 'index.html')))('signs in and draws the remote desktop from the built web UI', async () => {
        const context = await browser!.newContext({ viewport: { width: 1400, height: 900 } });
        const page = await context.newPage();
        const problems: string[] = [];
        page.on('pageerror', (error) => problems.push(error.message));
        page.on('console', (message) => { if (/Content.Security.Policy|CompileError/i.test(message.text())) problems.push(message.text()); });
        await page.goto(`${server.baseUrl}/`);
        await page.getByLabel('Access token', { exact: true }).fill(server.token);
        await page.getByRole('button', { name: 'Unlock' }).click();
        await page.getByText('RDP e2e', { exact: true }).first().click();
        await page.getByRole('tab', { name: /RDP/ }).click();
        await page.getByRole('button', { name: 'Connect', exact: true }).click();
        await page.getByText('Connected', { exact: true }).waitFor({ timeout: 90_000 });
        // A drawn desktop compresses to far more than an empty canvas.
        const drawn = "(() => { const canvas = document.querySelector('iron-remote-desktop')?.shadowRoot?.querySelector('canvas'); return canvas ? canvas.toDataURL().length : 0; })()";
        await expect.poll(() => page.evaluate<number>(drawn), { timeout: 30_000 }).toBeGreaterThan(20_000);
        await page.getByRole('button', { name: 'Disconnect' }).click();
        await page.getByText('Session ended').waitFor();
        expect(problems).toEqual([]);
        await context.close();
    });
});
