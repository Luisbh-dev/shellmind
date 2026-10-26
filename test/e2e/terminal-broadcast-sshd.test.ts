import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type Page } from '@playwright/test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Split panes and broadcast input end to end (opt-in: SHELLMIND_E2E=1): the
// production web build in Chromium against two real sshd containers. Keys
// typed once reach every terminal of the group (each shell writes its own
// tty to a file), several servers need a confirmation, a password typed at
// a sudo prompt (or ahead of it) stays in its terminal and out of the audit
// log, and Enter on a destructive command asks first. Needs `npm run build` and
// `npx playwright install chromium`.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-split-sshd';
const CONTEXT = fileURLToPath(new URL('../fixtures/terminal/e2e', import.meta.url));
const NAMES = { a: `shellmind-test-split-${process.pid}-a`, b: `shellmind-test-split-${process.pid}-b` };
const WEB_DIR = path.join(fileURLToPath(new URL('../..', import.meta.url)), 'dist');
const PASSWORD = 'demopw';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 240_000 });

let server: TestServer;
let browser: Browser;
let page: Page;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// The lines of `file` in the container (none while it does not exist).
function linesOf(container: string, file: string): string[] {
    const result = spawnSync('docker', ['exec', container, 'cat', file], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.split('\n').filter(Boolean) : [];
}

function sshBanner(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('data', (data) => {
            socket.destroy();
            resolve(data.toString().startsWith('SSH-'));
        });
        socket.once('error', () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 150));
    }
}

async function saveServer(name: string, port: number): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name, ip: '127.0.0.1', port, type: 'linux', username: 'demo', password: PASSWORD })
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

async function audit(): Promise<AuditEntry[]> {
    const res = await server.fetch('/api/audit?source=terminal&limit=200');
    return ((await res.json()) as { data: AuditEntry[] }).data;
}

const visiblePanels = () => page.locator('[id^="terminal-panel-"]:visible');

// Types into the terminal that has the focus, the way a user does.
async function type(text: string) {
    await page.keyboard.type(text, { delay: 10 });
    await page.keyboard.press('Enter');
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// `count` panes on screen, their shells at a prompt (shortly after the
// sessions are up).
async function waitForPanes(count: number) {
    await waitFor(async () => (await visiblePanels().count()) === count, 30_000);
    await sleep(3000);
}

// Each pane of the server on screen leaves the password prompt it waits at.
async function interruptEveryPane() {
    for (const panel of await visiblePanels().all()) {
        await panel.locator('.xterm-screen').click();
        await page.keyboard.press('Control+C');
    }
}

describe.skipIf(!ENABLED)('split panes and broadcast input against real sshd (docker)', () => {
    beforeAll(async () => {
        if (!fs.existsSync(path.join(WEB_DIR, 'index.html'))) throw new Error('No web build in dist/: run `npm run build` first.');
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        const ports = { a: 0, b: 0 };
        for (const key of ['a', 'b'] as const) {
            docker('run', '-d', '--name', NAMES[key], '--hostname', `split-${key}`, '-p', '127.0.0.1::22', IMAGE);
            ports[key] = Number(docker('port', NAMES[key], '22').split('\n')[0].split(':').pop());
        }
        await waitFor(() => sshBanner(ports.a), 30_000);
        await waitFor(() => sshBanner(ports.b), 30_000);
        server = await bootTestServer({ env: { SERVE_WEB: '1', WEB_DIR } });
        await saveServer('split-a', ports.a);
        await saveServer('split-b', ports.b);

        browser = await chromium.launch();
        const context = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 } });
        page = await context.newPage();
        await page.goto(`${server.baseUrl}/`);
        await page.getByLabel('Access token', { exact: true }).fill(server.token);
        await page.getByRole('button', { name: 'Unlock' }).click();
        await page.getByRole('heading', { name: 'Welcome to ShellMind' }).waitFor();
    });

    afterAll(async () => {
        await browser?.close();
        await server?.close();
        for (const name of Object.values(NAMES)) spawnSync('docker', ['rm', '-f', name]);
        vi.restoreAllMocks();
    });

    it('types once into both panes of a split terminal', async () => {
        await page.getByText('split-a', { exact: true }).first().click();
        await waitForPanes(1);
        await visiblePanels().first().locator('.xterm-screen').click();
        await page.keyboard.press('Control+Shift+D');
        await waitForPanes(2);

        await page.keyboard.press('Control+Shift+B');
        await page.getByRole('status').filter({ hasText: 'Broadcasting to 2 terminals' }).waitFor();
        await type('echo "pane $(tty)" >> /tmp/broadcast.log');
        await waitFor(() => linesOf(NAMES.a, '/tmp/broadcast.log').length === 2);
        const ttys = linesOf(NAMES.a, '/tmp/broadcast.log');
        expect(new Set(ttys).size).toBe(2);

        // Each terminal recorded the line, with how many terminals got it
        // (marked as reported by the app, SEC-7).
        await waitFor(async () => (await audit()).filter((entry) => entry.command.includes('/tmp/broadcast.log')).length === 2);
        expect((await audit()).filter((entry) => entry.command.includes('/tmp/broadcast.log')).map((entry) => entry.meta))
            .toEqual([{ broadcast: 2, reportedBy: 'client' }, { broadcast: 2, reportedBy: 'client' }]);

        // Off again; the group is kept for the next start.
        await page.keyboard.press('Control+Shift+B');
        await expect.poll(() => page.getByRole('status').filter({ hasText: 'Broadcasting' }).count()).toBe(0);
    });

    it('asks before broadcasting to several servers, then types into all of them', async () => {
        await page.getByText('split-b', { exact: true }).first().click();
        await waitForPanes(1);
        await page.getByRole('button', { name: /^Broadcast input/ }).click();
        const picker = page.getByRole('dialog', { name: 'Broadcast input' });
        for (const box of await picker.getByRole('checkbox').all()) if (!(await box.isChecked())) await box.check();
        await picker.getByRole('button', { name: 'Start broadcasting' }).click();
        const confirm = page.getByRole('alertdialog');
        await expect.poll(() => confirm.textContent()).toContain('Broadcast to 2 servers?');
        await confirm.getByRole('button', { name: 'Broadcast' }).click();
        await page.getByRole('status').filter({ hasText: 'Broadcasting to 3 terminals on 2 servers' }).waitFor();
        // Starting puts the keys in the terminal on screen.
        await waitFor(async () => (await page.locator('[id^="terminal-panel-"] .xterm-helper-textarea:focus').count()) === 1);

        await type('echo "server $(hostname)" >> /tmp/servers.log');
        await waitFor(() => linesOf(NAMES.a, '/tmp/servers.log').length === 2 && linesOf(NAMES.b, '/tmp/servers.log').length === 1)
            .catch((error: Error) => {
                throw new Error(`${error.message}: split-a ${JSON.stringify(linesOf(NAMES.a, '/tmp/servers.log'))}, split-b ${JSON.stringify(linesOf(NAMES.b, '/tmp/servers.log'))}`);
            });
        expect(linesOf(NAMES.b, '/tmp/servers.log')).toEqual(['server split-b']);
    });

    it('never sends what is typed at a password prompt to the other terminals, nor records it', async () => {
        await type('sudo -k; sudo touch /tmp/sudo-$(tty | tr / _)');
        // Three password prompts; the answer goes to this terminal only.
        await sleep(1500);
        await type(PASSWORD);
        await waitFor(() => docker('exec', NAMES.b, 'ls', '/tmp').includes('sudo-_dev_pts'));
        await sleep(1000);
        expect(docker('exec', NAMES.a, 'ls', '/tmp')).not.toContain('sudo-_dev_pts');
        expect(JSON.stringify(await audit())).not.toContain(PASSWORD);
        // The terminals of split-a still wait for their password: Ctrl+C
        // there stays there too.
        await page.getByText('split-a', { exact: true }).first().click();
        await waitForPanes(2);
        await interruptEveryPane();
        await sleep(500);
        expect(docker('exec', NAMES.a, 'ls', '/tmp')).not.toContain('sudo-_dev_pts');
    });

    it('asks before Enter runs a destructive command on several terminals', async () => {
        await page.getByText('split-b', { exact: true }).first().click();
        await waitForPanes(1);
        await visiblePanels().first().locator('.xterm-screen').click();
        await page.keyboard.type('sudo reboot', { delay: 10 });
        await page.keyboard.press('Enter');
        const confirm = page.getByRole('alertdialog');
        await expect.poll(() => confirm.textContent()).toContain('Run this on 3 terminals?');
        await confirm.getByRole('button', { name: 'Cancel' }).click();
        await page.keyboard.press('Control+U');
        await page.keyboard.press('Control+Shift+B');
        await expect.poll(() => page.getByRole('status').filter({ hasText: 'Broadcasting' }).count()).toBe(0);
        expect((await audit()).some((entry) => entry.command === 'sudo reboot')).toBe(false);
    });

    it('never sends a password typed ahead of its prompt elsewhere, not even to a server that asks none', async () => {
        // On split-b sudo asks no password: one typed there would run as a command.
        docker('exec', NAMES.b, 'sh', '-c', "echo 'demo ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/demo");
        await page.getByText('split-a', { exact: true }).first().click();
        await waitForPanes(2);
        await visiblePanels().first().locator('.xterm-screen').click();
        // The group kept from before: both panes of split-a and split-b's terminal.
        await page.keyboard.press('Control+Shift+B');
        const confirm = page.getByRole('alertdialog');
        await expect.poll(() => confirm.textContent()).toContain('Broadcast to 2 servers?');
        await confirm.getByRole('button', { name: 'Broadcast' }).click();
        await page.getByRole('status').filter({ hasText: 'Broadcasting to 3 terminals on 2 servers' }).waitFor();
        await waitFor(async () => (await page.locator('[id^="terminal-panel-"] .xterm-helper-textarea:focus').count()) === 1);

        // In one go: the password typed before sudo had a chance to ask for it.
        await page.keyboard.type('sudo -k; sudo touch /tmp/ahead-$(tty | tr / _)', { delay: 5 });
        await page.keyboard.press('Enter');
        await page.keyboard.type(PASSWORD, { delay: 5 });
        await page.keyboard.press('Enter');
        await waitFor(() => linesOf(NAMES.b, '/home/demo/.bash_history').some((line) => line.includes('/tmp/ahead-')));
        await sleep(2500);
        // split-b ran the command line and nothing after it; no audit entry has the password.
        const history = linesOf(NAMES.b, '/home/demo/.bash_history');
        expect(history.at(-1)).toContain('/tmp/ahead-');
        expect(history.join('\n')).not.toContain(PASSWORD.slice(1));
        expect(JSON.stringify(await audit())).not.toContain(PASSWORD.slice(1));
        // The other pane of split-a still waits at its own password prompt.
        expect(docker('exec', NAMES.a, 'sh', '-c', 'ls /tmp | grep -c ahead- || true')).not.toBe('2');
    });
});
