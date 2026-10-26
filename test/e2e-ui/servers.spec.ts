import type { ServerSummary } from '../../shared/types';
import { expect, openApp, reloadApp, test, uid, type Api } from './support/test';
import { openPalette, rowButton, serverRow, sidebar } from './support/ui';

// Saved connections: the add/edit dialog with its organization fields, the
// sidebar's groups, tag filters, favorites and search, deleting, and the
// command palette.

async function savedServer(api: Api, name: string): Promise<ServerSummary | undefined> {
    const { data } = await api.get<{ data: ServerSummary[] }>('/api/servers');
    return data.find((server) => server.name === name);
}

test('adds a connection with its group, tags and color, edits it and deletes it', async ({ app: page, api, state }) => {
    const id = uid();
    const name = `Orders API ${id}`;
    await sidebar(page).getByRole('button', { name: 'Add connections' }).click();
    await page.getByRole('menuitem', { name: 'New connection' }).click();
    const dialog = page.getByRole('dialog', { name: 'New connection' });
    await expect(dialog.getByRole('radio', { name: 'SSH / Linux' })).toBeChecked();
    await dialog.getByLabel('Display name').fill(name);
    await dialog.getByLabel('Host / IP').fill('127.0.0.1');
    await dialog.getByLabel('SSH port').fill(String(state.hosts.alpha.port));
    await dialog.getByLabel('Username').fill('demo');
    await dialog.getByLabel('Password', { exact: true }).fill('demopw');
    await dialog.getByLabel('Group').fill(`Payments ${id}`);
    for (const tag of [`orders-${id}`, 'api']) {
        await dialog.getByLabel('Tags').fill(tag);
        await dialog.getByLabel('Tags').press('Enter');
    }
    await dialog.getByRole('radio', { name: 'Violet' }).click();
    await dialog.getByLabel('Notes').fill('Reached through the e2e suite');
    await dialog.getByRole('button', { name: 'Add connection' }).click();
    await expect(dialog).toBeHidden();

    // Grouped, tagged and filterable in the sidebar; stored without echoing the password.
    const group = sidebar(page).getByRole('region', { name: `Payments ${id}` });
    await expect(group.getByRole('button', { name: new RegExp(`^${name}, demo@127\\.0\\.0\\.1`) })).toBeVisible();
    await expect(serverRow(page, name)).toHaveAccessibleName(new RegExp(`tags: orders-${id}, api, has notes`));
    await expect(sidebar(page).getByRole('group', { name: 'Filter by tag' }).getByRole('button', { name: `orders-${id}` })).toBeVisible();
    const saved = await savedServer(api, name);
    expect(saved).toMatchObject({ group_name: `Payments ${id}`, tags: [`orders-${id}`, 'api'], color: 'violet', notes: 'Reached through the e2e suite' });
    expect(saved?.has_password).toBeTruthy();
    expect(JSON.stringify(saved)).not.toContain('demopw');

    // Edit: a new name and one tag less; the saved password stays.
    await (await rowButton(page, name, `Edit ${name}`)).click();
    const edit = page.getByRole('dialog', { name: 'Edit connection' });
    await expect(edit.getByLabel('Display name')).toHaveValue(name);
    await expect(edit.getByText('Saved', { exact: true })).toBeVisible();
    await edit.getByLabel('Display name').fill(`${name} v2`);
    await edit.getByRole('button', { name: 'Remove tag api' }).click();
    await edit.getByRole('button', { name: 'Save changes' }).click();
    await expect(edit).toBeHidden();
    await expect(serverRow(page, `${name} v2`)).toHaveAccessibleName(new RegExp(`tags: orders-${id}, has notes$`));
    const edited = await savedServer(api, `${name} v2`);
    expect(edited?.tags).toEqual([`orders-${id}`]);
    expect(edited?.has_password).toBeTruthy();

    // Delete, after a confirmation.
    await (await rowButton(page, `${name} v2`, `More actions for ${name} v2`)).click();
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    const confirm = page.getByRole('alertdialog', { name: 'Delete connection' });
    await expect(confirm).toContainText(`Remove ${name} v2 from your connections?`);
    await confirm.getByRole('button', { name: 'Delete' }).click();
    await expect(serverRow(page, `${name} v2`)).toHaveCount(0);
    expect(await savedServer(api, `${name} v2`)).toBeUndefined();
});

test('keeps favorites on top, filters by tag and searches', async ({ page, addServer, state }) => {
    const id = uid();
    await addServer('alpha', { name: `Billing web ${id}`, tags: [`billing-${id}`], group_name: `Finance ${id}` });
    await addServer('beta', { name: `Billing db ${id}`, tags: [`billing-${id}`, `db-${id}`], group_name: `Finance ${id}` });
    await addServer('beta', { name: `Search index ${id}`, tags: [`search-${id}`] });
    await openApp(page, state);

    // A favorite is listed in its own section, above the groups.
    await (await rowButton(page, `Billing db ${id}`, `Add Billing db ${id} to favorites`)).click();
    const favorites = sidebar(page).getByRole('region', { name: 'Favorites' });
    await expect(favorites.getByRole('button', { name: new RegExp(`^Billing db ${id}, `) })).toBeVisible();
    await expect(sidebar(page).getByRole('button', { name: `Remove Billing db ${id} from favorites` })).toHaveAttribute('aria-pressed', 'true');

    // Tag filter: only the servers with that tag.
    const tags = sidebar(page).getByRole('group', { name: 'Filter by tag' });
    await tags.getByRole('button', { name: `db-${id}`, exact: true }).click();
    await expect(serverRow(page, `Billing db ${id}`)).toBeVisible();
    await expect(serverRow(page, `Billing web ${id}`)).toHaveCount(0);
    await expect(serverRow(page, `Search index ${id}`)).toHaveCount(0);
    await tags.getByRole('button', { name: `db-${id}`, exact: true }).click();
    await expect(serverRow(page, `Billing web ${id}`)).toBeVisible();

    // Search by name, group or tag.
    const search = sidebar(page).getByRole('searchbox', { name: /Search connections/ });
    await search.fill(`search index ${id}`);
    await expect(serverRow(page, `Search index ${id}`)).toBeVisible();
    await expect(serverRow(page, `Billing web ${id}`)).toHaveCount(0);
    await search.fill(`finance ${id}`);
    await expect(serverRow(page, `Billing web ${id}`)).toBeVisible();
    await expect(serverRow(page, `Search index ${id}`)).toHaveCount(0);
    await search.fill('');

    // Favorites are kept with the server.
    await reloadApp(page);
    await expect(sidebar(page).getByRole('region', { name: 'Favorites' }).getByRole('button', { name: new RegExp(`^Billing db ${id}, `) })).toBeVisible();
});

test('the command palette finds servers, tabs and commands', async ({ app: page, addServer }) => {
    const id = uid();
    await addServer('alpha', { name: `Palette target ${id}` });
    await reloadApp(page);

    let palette = await openPalette(page);
    await palette.getByRole('combobox', { name: 'Search servers, tabs and commands' }).fill(`palette target ${id}`);
    await expect(palette.getByRole('option').first()).toContainText(`Palette target ${id}`);
    await page.keyboard.press('Enter');
    await expect(palette).toBeHidden();
    await expect(page.getByRole('banner')).toContainText(`Palette target ${id}`);
    await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true');

    // The open server's tabs are listed too.
    palette = await openPalette(page);
    await palette.getByRole('combobox').fill('status');
    await palette.getByRole('option', { name: /Status/ }).first().click();
    await expect(page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name: 'Status' })).toHaveAttribute('aria-selected', 'true');

    // Commands: settings.
    palette = await openPalette(page);
    await palette.getByRole('combobox').fill('open settings');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeHidden();
});
