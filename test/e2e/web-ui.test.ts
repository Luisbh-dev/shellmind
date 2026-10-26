import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The production web build (`npm run build`) served by the backend itself, as
// `npm run serve` does, in a real Chromium: its Content-Security-Policy, the
// access token screen and the app shell in both UI languages. Opt-in
// (SHELLMIND_E2E=1); needs `npx playwright install chromium`.

const enabled = process.env.SHELLMIND_E2E === '1';
const webDir = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'dist');

vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 });

let server: TestServer;
let browser: Browser;

beforeAll(async () => {
    if (!enabled) return;
    if (!fs.existsSync(path.join(webDir, 'index.html'))) throw new Error('No web build in dist/: run `npm run build` first.');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer({ env: { SERVE_WEB: '1', WEB_DIR: webDir } });
    browser = await chromium.launch();
});

afterAll(async () => {
    await browser?.close();
    await server?.close();
    vi.restoreAllMocks();
});

async function openApp(locale: string) {
    const context = await browser.newContext({ locale });
    const page = await context.newPage();
    const problems: string[] = [];
    page.on('console', (message) => { if (message.type() === 'error') problems.push(message.text()); });
    page.on('pageerror', (error) => problems.push(error.message));
    await page.goto(`${server.baseUrl}/`);
    return { context, page, problems };
}

describe.skipIf(!enabled)('built web UI served by the backend', () => {
    it('asks for the access token, then opens the app shell without errors or CSP violations', async () => {
        const { context, page, problems } = await openApp('en-US');
        await page.getByLabel('Access token', { exact: true }).fill('not-the-token');
        await page.getByRole('button', { name: 'Unlock' }).click();
        await expect.poll(() => page.getByText('That token was not accepted.').isVisible()).toBe(true);

        await page.getByLabel('Access token', { exact: true }).fill(server.token);
        await page.getByRole('button', { name: 'Unlock' }).click();
        await page.getByRole('heading', { name: 'Welcome to ShellMind' }).waitFor();
        // The rejected token's 401 is the only expected console error.
        expect(problems.filter((problem) => !/401/.test(problem))).toEqual([]);
        await context.close();
    });

    it('follows the browser language', async () => {
        const { context, page } = await openApp('es-ES');
        await page.getByLabel('Token de acceso', { exact: true }).fill(server.token);
        await page.getByRole('button', { name: 'Desbloquear' }).click();
        await page.getByRole('heading', { name: 'Bienvenido a ShellMind' }).waitFor();
        await context.close();
    });
});
