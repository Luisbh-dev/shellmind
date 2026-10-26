import fs from 'node:fs';
import { inside } from './support/docker';
import { expect, openApp, test, uid } from './support/test';
import { openServer, openWorkspaceTab } from './support/ui';

// The file manager over SFTP: listing and navigation, upload, download, the
// remote editor and deleting several files at once.

test('lists, uploads, downloads, edits and bulk-deletes files over SFTP', async ({ page, state, addServer }, testInfo) => {
    const id = uid();
    const dir = `/home/demo/files-${id}`;
    inside(state.hosts.alpha.container, [
        `mkdir -p ${dir}/nested`,
        `printf 'first line\\n' > ${dir}/notes.txt`,
        `printf 'ünïcödé payload\\n' > ${dir}/report.csv`,
        `for n in 1 2 3; do echo "old $n" > ${dir}/old-$n.log; done`,
        `chown -R demo:demo ${dir}`,
    ].join('\n'));
    const server = await addServer('alpha', { name: `Files ${id}` });
    await openApp(page, state);
    await openServer(page, server.name);
    const files = await openWorkspaceTab(page, 'Files');

    // Opens in the home folder; then navigate by path.
    await expect(files.getByRole('grid', { name: 'Files in /home/demo' })).toBeVisible({ timeout: 30_000 });
    await files.getByRole('button', { name: /^Edit path/ }).click();
    const path = files.getByRole('textbox', { name: 'Folder path' });
    await path.fill(dir);
    await path.press('Enter');
    const grid = files.getByRole('grid', { name: `Files in ${dir}` });
    await expect(grid).toBeVisible();
    for (const name of ['nested', 'notes.txt', 'report.csv', 'old-1.log', 'old-2.log', 'old-3.log']) {
        await expect(grid.getByRole('row', { name: new RegExp(`^Select ${name.replace('.', '\\.')} `) })).toBeVisible();
    }
    await expect(files.getByRole('status').filter({ hasText: '6 items' })).toBeVisible();

    // Upload through the file picker.
    const chooser = page.waitForEvent('filechooser');
    await files.getByRole('button', { name: 'Upload files' }).click();
    await (await chooser).setFiles({ name: `upload-${id}.txt`, mimeType: 'text/plain', buffer: Buffer.from(`uploaded from the browser ${id}\n`) });
    await expect(grid.getByRole('row', { name: new RegExp(`^Select upload-${id}\\.txt `) })).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => inside(state.hosts.alpha.container, `cat ${dir}/upload-${id}.txt`)).toBe(`uploaded from the browser ${id}`);

    // Download keeps the bytes (UTF-8 included).
    const download = page.waitForEvent('download');
    await grid.getByRole('button', { name: 'Download report.csv' }).click();
    const saved = testInfo.outputPath('report.csv');
    await (await download).saveAs(saved);
    expect(fs.readFileSync(saved, 'utf8')).toBe('ünïcödé payload\n');

    // Edit in place and save with Ctrl+S.
    await grid.getByRole('button', { name: 'Edit notes.txt' }).click();
    const editor = page.getByRole('dialog', { name: 'Editing notes.txt' });
    await expect(editor).toContainText(`${dir}/notes.txt`);
    const contents = editor.getByRole('textbox', { name: 'Contents of notes.txt' });
    await expect(contents).toContainText('first line');
    await contents.click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(`second line ${id}`);
    await expect(editor.getByRole('button', { name: /^Save/ })).toBeEnabled();
    await page.keyboard.press('Control+S');
    await expect(editor.getByRole('button', { name: /^Save/ })).toBeDisabled();
    await expect.poll(() => inside(state.hosts.alpha.container, `cat ${dir}/notes.txt`)).toBe(`first line\nsecond line ${id}`);
    await editor.getByRole('button', { name: 'Close the editor' }).click();
    await expect(editor).toBeHidden();

    // Select the three logs and delete them together.
    for (const n of [1, 2, 3]) await grid.getByRole('checkbox', { name: `Select old-${n}.log` }).check();
    await expect(files.getByRole('status').filter({ hasText: '3 selected' })).toBeVisible();
    await files.getByRole('button', { name: 'Delete (3)' }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete 3 items?' });
    await expect(confirm.getByRole('listitem')).toHaveText(['old-1.log', 'old-2.log', 'old-3.log']);
    await confirm.getByRole('button', { name: /^Delete/ }).click();
    for (const n of [1, 2, 3]) await expect(grid.getByRole('row', { name: new RegExp(`^Select old-${n}\\.log `) })).toHaveCount(0);
    await expect.poll(() => inside(state.hosts.alpha.container, `ls ${dir}`).split('\n').sort()).toEqual(['nested', 'notes.txt', 'report.csv', `upload-${id}.txt`]);
});
