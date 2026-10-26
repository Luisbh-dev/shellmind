import type { Locator, Page } from '@playwright/test';
import { inside } from './support/docker';
import { expect, openApp, test, uid } from './support/test';
import { enableReadableTerminals, expectTerminalText, openServer, openWorkspaceTab, typeCommand } from './support/ui';

// The operations panel: what it offers on a server without systemd or a
// container engine (Alpine), containers on a real Docker engine (Docker in
// Docker), and live logs of a file and of a container.

async function opsView(page: Page, view: string): Promise<Locator> {
    const ops = page.getByRole('tabpanel', { name: 'Operations', exact: true });
    await ops.getByRole('tablist', { name: 'Operations views' }).getByRole('tab', { name: view, exact: true }).click();
    return ops.getByRole('tabpanel', { name: view, exact: true });
}

// The view's count of lines received ("Streaming 204 lines"); the output
// itself is virtualized, only the rows in sight are in the page.
async function streamed(view: Locator): Promise<number> {
    const match = /Streaming\s*([\d,.]+)\s*lines?/.exec((await view.textContent()) ?? '');
    return match ? Number(match[1].replace(/[,.]/g, '')) : 0;
}

// New lines keep arriving (the hosts write two a second).
async function expectStreaming(view: Locator, label: string) {
    await expect(view.getByRole('log', { name: 'Log output' })).toContainText(label, { timeout: 30_000 });
    const before = await streamed(view);
    expect(before).toBeGreaterThan(0);
    await expect.poll(() => streamed(view), { timeout: 20_000 }).toBeGreaterThan(before + 2);
}

test('a server without systemd or containers says so, and its log files stream live', async ({ page, state, addServer }) => {
    const server = await addServer('alpha', { name: `Ops alpine ${uid()}` });
    await openApp(page, state);
    await openServer(page, server.name);
    await openWorkspaceTab(page, 'Operations');

    const services = await opsView(page, 'Services');
    await expect(services).toContainText('This server does not use systemd', { timeout: 30_000 });
    await expect(services).toContainText('Live logs of files and containers are still available.');
    await expect(page.getByRole('tabpanel', { name: 'Operations', exact: true })).toContainText('Privileged actions run with passwordless sudo');
    const containers = await opsView(page, 'Containers');
    await expect(containers).toContainText('No container engine available');

    const logs = await opsView(page, 'Logs');
    const source = logs.getByRole('form', { name: 'Log source' });
    await source.getByRole('textbox', { name: 'File path' }).fill('/var/log/e2e/app.log');
    await source.getByRole('button', { name: 'Start' }).click();
    const output = logs.getByRole('log', { name: 'Log output' });
    await expectStreaming(logs, 'e2e-app tick');

    // A filter narrows what is shown; Stop ends the stream.
    await logs.getByRole('searchbox', { name: 'Filter lines' }).fill('tick 1');
    await expect.poll(async () => ((await output.textContent()) ?? '').split('e2e-app tick').slice(1).every((line) => line.trim().startsWith('1'))).toBe(true);
    await source.getByRole('button', { name: 'Stop' }).click();
    await expect(source.getByRole('button', { name: 'Start' })).toBeVisible();
});

test('containers on a Docker engine: list, stop and start, a shell inside and their logs', async ({ page, state, addServer }) => {
    await enableReadableTerminals(page);
    const server = await addServer('dind', { name: `Ops docker ${uid()}`, username: 'ops', password: 'opspw' });
    const engine = state.hosts.dind.container;
    const running = () => inside(engine, "docker inspect -f '{{.State.Running}}' e2e-web");
    inside(engine, 'docker start e2e-web >/dev/null');
    await openApp(page, state);
    await openServer(page, server.name);
    await openWorkspaceTab(page, 'Operations');

    const containers = await opsView(page, 'Containers');
    const table = containers.getByRole('table', { name: /\d+ containers?/ });
    await expect(table.getByRole('row', { name: /^e2e-web alpine:3 running/ })).toBeVisible({ timeout: 30_000 });
    await expect(table.getByRole('row', { name: /^e2e-idle alpine:3 created/ })).toBeVisible();
    await containers.getByRole('radiogroup', { name: 'Show containers' }).getByRole('radio', { name: /^Running/ }).check();
    await expect(table.getByRole('row', { name: /^e2e-idle / })).toHaveCount(0);

    // Stop (confirmed), then start again.
    await table.getByRole('button', { name: 'e2e-web alpine:3' }).click();
    const detail = containers.getByRole('region', { name: 'Container e2e-web' });
    const actions = detail.getByRole('group', { name: 'Container actions' });
    await actions.getByRole('button', { name: 'Stop', exact: true }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Stop e2e-web?' });
    await confirm.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(actions.getByRole('button', { name: 'Start', exact: true })).toBeEnabled({ timeout: 45_000 });
    expect(running()).toBe('false');
    await actions.getByRole('button', { name: 'Start', exact: true }).click();
    await page.getByRole('alertdialog', { name: 'Start e2e-web?' }).getByRole('button', { name: 'Start', exact: true }).click();
    await expect(actions.getByRole('button', { name: 'Stop', exact: true })).toBeEnabled({ timeout: 45_000 });
    expect(running()).toBe('true');

    // A shell inside the container opens as a terminal tab.
    await actions.getByRole('button', { name: 'Open shell' }).click();
    await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true');
    const sessions = page.getByRole('tablist', { name: 'Terminal sessions' });
    await expect(sessions.getByRole('tab', { name: /e2e-web/ })).toHaveAttribute('aria-selected', 'true');
    const shell = page.getByRole('tabpanel', { name: /e2e-web/ });
    await expectTerminalText(shell, /[#$] $/m, 30_000);
    await shell.locator('.xterm-screen').click();
    await typeCommand(page, 'echo "inside $(cat /etc/alpine-release)"');
    await expectTerminalText(shell, /inside 3\.\d+\.\d+/);

    // Its log, live.
    await openWorkspaceTab(page, 'Operations');
    const logs = await opsView(page, 'Logs');
    const source = logs.getByRole('form', { name: 'Log source' });
    await source.getByRole('radio', { name: 'Container' }).check();
    await source.getByRole('textbox', { name: 'Container name or ID' }).fill('e2e-web');
    await source.getByRole('button', { name: 'Start' }).click();
    await expectStreaming(logs, 'web tick');
    await source.getByRole('button', { name: 'Stop' }).click();
});
