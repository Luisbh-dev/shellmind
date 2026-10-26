import { inside } from './support/docker';
import { expect, openApp, test, uid } from './support/test';
import { openServer, runFromPalette } from './support/ui';

// The patch center's scan of a server (Alpine 3.20.0 with a newer package
// index: updates are pending) and the disk usage view.

test('the patch center scans a server and lists its pending updates', async ({ page, state, addServer }) => {
    const server = await addServer('beta', { name: `Patch ${uid()}` });
    await openApp(page, state);
    await page.getByRole('banner').getByRole('button', { name: 'Patch center' }).click();
    const center = page.getByRole('dialog', { name: 'Patch center' });
    await center.getByRole('searchbox', { name: 'Filter servers' }).fill(server.name);
    const table = center.getByRole('table', { name: 'Patch center' });
    const row = table.getByRole('row', { name: new RegExp(`^Select ${server.name} `) });
    await expect(row).toContainText('Not scanned');

    // Opening the server's updates scans it.
    await row.getByRole('button', { name: `${server.name}: updates` }).click();
    const updates = center.getByRole('complementary', { name: `Updates of ${server.name}` });
    await expect(updates).toContainText('apk', { timeout: 60_000 });
    await expect(updates).toContainText('Scanned now');
    await expect(updates.getByRole('definition').first()).toHaveText(/^[1-9]\d*$/);
    const pending = updates.getByRole('table', { name: 'Pending updates' });
    await expect(pending.getByRole('row', { name: /^musl x86_64 1\.2\.5-r0 1\.2\.5-r\d+/ })).toBeVisible();
    await expect(row.getByRole('cell').nth(2)).toHaveText(/^[1-9]\d*$/);

    // A filter over the pending packages.
    await updates.getByRole('searchbox', { name: 'Filter updates' }).fill('musl');
    await expect(pending.getByRole('row')).toHaveCount(3);

    await updates.getByRole('button', { name: 'Scan again' }).click();
    await expect(updates).toContainText('Scanned now', { timeout: 60_000 });
    await updates.getByRole('button', { name: `Close the updates of ${server.name}` }).click();
    await expect(updates).toBeHidden();
});

test('the disk view explores the usage of a filesystem and finds its largest files', async ({ page, state, addServer }) => {
    const id = uid();
    const dir = `/srv/disk-${id}`;
    inside(state.hosts.alpha.container, `mkdir -p ${dir} && head -c 62914560 /dev/zero > ${dir}/big-${id}.bin`);
    try {
        const server = await addServer('alpha', { name: `Disk ${id}` });
        await openApp(page, state);
        await openServer(page, server.name);
        await runFromPalette(page, 'disk usage', /^Disk usage and cleanup/);

        const view = page.getByRole('dialog', { name: 'Disk usage' });
        await expect(view).toContainText(server.name);
        await expect(view.getByRole('region', { name: 'Usage of /' }).getByRole('meter', { name: 'Space used on /' })).toBeVisible({ timeout: 30_000 });

        // Largest first: /srv holds the 60 MB file. A folder's name starts
        // with what it shows, then says it opens.
        const usage = view.getByRole('tabpanel', { name: 'Usage' });
        const root = usage.getByRole('list', { name: 'Contents of /, largest first' });
        await expect(root.getByRole('button').first()).toHaveAccessibleName(/^srv, \d+(\.\d+)? MB, .* \(open\)$/, { timeout: 60_000 });
        await root.getByRole('button', { name: /^srv, .* \(open\)$/ }).click();
        const srv = usage.getByRole('list', { name: 'Contents of /srv, largest first' });
        await expect(srv.getByRole('button').first()).toHaveAccessibleName(new RegExp(`^disk-${id}, 60 MB, .* \\(open\\)$`), { timeout: 60_000 });

        await view.getByRole('tablist', { name: 'Disk views' }).getByRole('tab', { name: 'Largest files' }).click();
        const largest = view.getByRole('tabpanel', { name: 'Largest files' });
        await largest.getByRole('radio', { name: '50 MB' }).check();
        await expect(largest).toContainText(`${dir}/big-${id}.bin`, { timeout: 60_000 });
    } finally {
        inside(state.hosts.alpha.container, `rm -rf ${dir}`);
    }
});
