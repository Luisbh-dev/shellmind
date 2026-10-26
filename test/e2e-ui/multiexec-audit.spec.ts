import { expect, openApp, test, uid } from './support/test';
import { choose, runFromPalette } from './support/ui';

// Multi-exec as a background job with a canary that waits for approval, and
// the audit log that records every command it ran.

test('runs a job on a canary first, then on the rest once approved, and audits it', async ({ page, state, addServer }) => {
    const id = uid();
    const group = `Jobs ${id}`;
    for (const [host, name] of [['alpha', 'one'], ['beta', 'two'], ['alpha', 'three']] as const) {
        await addServer(host, { name: `Job ${name} ${id}`, group_name: group });
    }
    const command = `echo "job ${id} on $(hostname)"`;
    await openApp(page, state);

    await page.getByRole('banner').getByRole('button', { name: 'Multi-exec' }).click();
    const modal = page.getByRole('dialog', { name: 'Multi-exec' });
    const composer = modal.getByRole('tabpanel', { name: 'New job' });
    await expect(composer).toContainText('Selected: 0');
    await choose(page, composer.getByRole('group', { name: 'Group' }).getByRole('combobox'), group);
    await composer.getByRole('button', { name: 'Select shown (3)' }).click();
    await expect(composer).toContainText('Selected: 3');
    await composer.getByRole('textbox', { name: 'Command' }).fill(command);
    await composer.getByRole('checkbox', { name: 'Start with a canary' }).check();
    await expect(composer.getByRole('spinbutton', { name: 'Canary servers' })).toHaveValue('1');
    await expect(composer.getByRole('list', { name: 'Plan' })).toContainText('Canary: 1 server first, then wait for your approval.');
    await modal.getByRole('button', { name: 'Review' }).click();

    const review = modal.getByRole('region', { name: 'Run this command on 3 servers?' });
    await expect(review).toContainText(command);
    const batches = review.getByRole('list', { name: 'Batches' });
    await expect(batches.getByRole('listitem', { name: 'Canary: 1 server' })).toBeVisible();
    await expect(batches.getByRole('listitem', { name: 'Batch 1: 2 servers' })).toBeVisible();
    await modal.getByRole('button', { name: 'Run on 3 servers' }).click();

    // The canary runs alone, then the job waits.
    const job = modal.getByRole('region', { name: 'Job' });
    const approval = job.getByRole('group', { name: /^Canary finished: 1 of 1 OK\. Continue with the remaining 2 servers\?/ });
    await expect(approval).toBeVisible({ timeout: 60_000 });
    await expect(job.getByRole('status').first()).toHaveText('Paused · 1 of 3 finished');
    await approval.getByRole('button', { name: 'Continue' }).click();

    await expect(job.getByRole('status').first()).toHaveText('Finished on 3 servers', { timeout: 60_000 });
    await expect(job.getByRole('img', { name: 'OK: 3' })).toBeVisible();
    // Grouped by output, host names aside: one group of three.
    await expect(job.getByText('All 3 printed the same')).toBeVisible();
    const groupA = job.getByRole('list', { name: 'Results by output' }).getByRole('listitem').first();
    await expect(groupA.getByRole('list', { name: 'Servers in this group' }).getByRole('listitem')).toHaveCount(3);
    await expect(groupA).toContainText(`job ${id} on`);

    // Every run is in the audit log.
    await modal.getByRole('button', { name: 'Audit log' }).click();
    const audit = page.getByRole('dialog', { name: 'Audit log' });
    await audit.getByRole('searchbox', { name: 'Search' }).fill(`job ${id}`);
    const rows = audit.getByRole('table', { name: 'Audit log' }).getByRole('row').filter({ hasText: command });
    await expect(rows).toHaveCount(3);
    for (const name of ['one', 'two', 'three']) {
        await expect(rows.filter({ hasText: `Job ${name} ${id}` }).getByRole('cell').nth(3)).toHaveText('Multi-exec');
    }
    await expect(rows.first().getByRole('cell').nth(5)).toHaveText('0');
});

test('the audit log filters its entries by server and source', async ({ page, state, api, addServer }) => {
    const id = uid();
    const server = await addServer('alpha', { name: `Audited ${id}` });
    // Entries of two sources for this server: a multi-exec run, and a snippet
    // typed into its terminal (which the terminal reports).
    await api.post('/api/multiexec', { serverIds: [server.id], command: `echo audited-${id}` });
    await api.post('/api/audit', { serverId: server.id, source: 'snippet', command: `uptime # snippet ${id}` });
    await openApp(page, state);
    await runFromPalette(page, 'audit log', /^Audit log/);
    const audit = page.getByRole('dialog', { name: 'Audit log' });
    const table = audit.getByRole('table', { name: 'Audit log' });
    const body = table.getByRole('rowgroup').last();

    await choose(page, audit.getByRole('group', { name: 'Server' }).getByRole('combobox'), server.name);
    await expect(body).toContainText(`echo audited-${id}`, { timeout: 30_000 });
    await expect(body).toContainText(`uptime # snippet ${id}`);
    for (const row of await body.getByRole('row').all()) await expect(row.getByRole('cell').nth(2)).toHaveText(server.name);

    await choose(page, audit.getByRole('group', { name: 'Source' }).getByRole('combobox'), 'Snippet');
    await expect(body.getByRole('row')).toHaveCount(1);
    // Reported by the interface, not recorded by the backend: marked so (SEC-7).
    const source = body.getByRole('row').getByRole('cell').nth(3);
    await expect(source).toContainText('Snippet');
    await expect(source.getByTitle(/^Reported by the interface/)).toHaveText('reported');
    await choose(page, audit.getByRole('group', { name: 'Source' }).getByRole('combobox'), 'Multi-exec');
    await expect(body.getByRole('row').filter({ hasText: `echo audited-${id}` })).toHaveCount(1);
    await expect(body).not.toContainText(`snippet ${id}`);
    await expect(body.getByRole('row').filter({ hasText: `echo audited-${id}` }).getByRole('cell').nth(5)).toHaveText('0');

    await audit.getByRole('button', { name: 'Clear filters' }).click();
    await expect(audit.getByRole('group', { name: 'Source' }).getByRole('combobox')).toHaveText('All sources');
});
