import { expect, openApp, test, uid } from './support/test';
import { openServer, openWorkspaceTab } from './support/ui';

// The status page of one server and the fleet board of all of them.

test('the status page shows the live snapshot of the server', async ({ page, state, addServer }) => {
    const server = await addServer('alpha', { name: `Status ${uid()}` });
    await openApp(page, state);
    await openServer(page, server.name);
    const status = await openWorkspaceTab(page, 'Status');

    await expect(status.getByRole('heading', { name: server.name, level: 2 })).toBeVisible();
    // The verdict reads the load of the Docker VM too: a busy machine needs attention.
    await expect(status.getByText(/^Health: (Healthy|Needs attention|Critical)$/)).toBeVisible({ timeout: 30_000 });
    const system = status.getByRole('list', { name: 'System', exact: true });
    await expect(system).toContainText(new RegExp(`Hostname:\\s*${state.hosts.alpha.container.replace('shellmind-test-e2eui-', '')}`));
    await expect(system).toContainText(/Operating system:\s*Alpine Linux v3\.20/);
    for (const region of ['CPU', 'Memory', 'Storage', 'Load average']) {
        await expect(status.getByRole('region', { name: region, exact: true }).getByRole('meter').first()).toBeVisible();
    }
    const processes = status.getByRole('table', { name: /Processes that used the most CPU/ });
    await expect(processes.getByRole('row', { name: /^sshd 1 / })).toBeVisible();

    // Live: the samples keep coming, and "Refresh now" takes one at once.
    await expect(status.getByRole('region', { name: 'CPU usage' }).getByRole('paragraph')).toContainText(/last [2-9]\d* samples/, { timeout: 30_000 });
    await status.getByRole('button', { name: 'Refresh now' }).click();
    await expect(status.getByText(/Updated (just now|\d+ s ago)/)).toBeVisible();
});

test('the fleet board checks a server on demand', async ({ page, state, addServer }) => {
    const server = await addServer('beta', { name: `Fleet ${uid()}` });
    await openApp(page, state);
    await page.getByRole('banner').getByRole('button', { name: 'Fleet health' }).click();
    const board = page.getByRole('dialog', { name: 'Fleet health' });
    await board.getByRole('searchbox', { name: 'Filter servers' }).fill(server.name);
    const table = board.getByRole('table', { name: 'Fleet health' });
    const row = table.getByRole('row').filter({ has: page.getByRole('rowheader', { name: new RegExp(`^${server.name} `) }) });
    await expect(row).toHaveCount(1);

    await row.getByRole('button', { name: `Check ${server.name} now` }).click();
    // The health check logs in: the OS, load, memory, disk, pending updates and uptime.
    await expect(row.getByRole('rowheader')).toContainText('Alpine Linux v3.20', { timeout: 60_000 });
    await expect(row.getByRole('cell', { name: /^\d+(\.\d+)?\/core$/ })).toBeVisible();
    await expect(row.getByRole('cell', { name: /^\d+(\.\d+)?%$/ }).first()).toBeVisible();
    await expect(row.getByRole('cell', { name: /^\/ \d+(\.\d+)?%$/ })).toBeVisible();
    await expect(row.getByRole('cell', { name: /^(just now|\d+ s ago)$/ })).toBeVisible();
    // Alpine 3.20.0 with a newer package index: updates are pending.
    await expect(row.getByRole('cell').nth(6)).toHaveText(/^[1-9]\d*$/);
    await expect(row.getByRole('cell').first()).toHaveText(/Healthy|Warning|Critical/);

    // From the board to the server's status page.
    await row.getByRole('button', { name: `More actions for ${server.name}` }).click();
    await page.getByRole('menuitem', { name: 'Open status' }).click();
    await expect(board).toBeHidden();
    await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'Status' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('banner')).toContainText(server.name);
});
