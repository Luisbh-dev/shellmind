import type { Page } from '@playwright/test';
import { expect, openApp, reloadApp, test, uid } from './support/test';
import { choose, expectTerminalText, openServer } from './support/ui';

// Settings: the interface language (English / Spanish), the light and dark
// themes, and screen reader support in the terminal.

async function openSettings(page: Page, section: string, title = 'Settings') {
    await page.keyboard.press('Control+,');
    const settings = page.getByRole('dialog', { name: title });
    await expect(settings).toBeVisible();
    await settings.getByRole('tab', { name: section, exact: true }).click();
    return settings;
}

test('switches the interface between English and Spanish, and remembers it', async ({ app: page }) => {
    let settings = await openSettings(page, 'General');
    await expect(settings.getByRole('combobox', { name: /^Language/ })).toHaveText(/System default \(English\)/);
    await choose(page, settings.getByRole('combobox', { name: /^Language/ }), /^Español$/);

    // The whole interface follows at once.
    settings = page.getByRole('dialog', { name: 'Ajustes' });
    await expect(settings.getByRole('heading', { name: 'Ajustes' })).toBeVisible();
    await expect(settings.getByRole('tab', { name: 'Llavero' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'es');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Bienvenido a ShellMind' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: /conexiones/i })).toBeVisible();

    // Kept for the next visit (this browser).
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Bienvenido a ShellMind' })).toBeVisible({ timeout: 60_000 });

    settings = await openSettings(page, 'General', 'Ajustes');
    await choose(page, settings.getByRole('combobox', { name: /^Idioma/ }), /^English$/);
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Welcome to ShellMind' })).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
});

test('switches between the light and dark themes', async ({ app: page }) => {
    const root = page.locator('html');
    const background = () => page.evaluate('getComputedStyle(document.body).backgroundColor') as Promise<string>;
    await expect(root).toHaveAttribute('data-theme', 'dark');
    const dark = await background();

    const settings = await openSettings(page, 'Appearance');
    const theme = settings.getByRole('radiogroup', { name: 'Theme' });
    await theme.getByRole('radio', { name: 'Light' }).check();
    await expect(root).toHaveAttribute('data-theme', 'light');
    await expect.poll(background).not.toBe(dark);
    await page.keyboard.press('Escape');

    // Kept for the next visit.
    await reloadApp(page);
    await expect(root).toHaveAttribute('data-theme', 'light');

    // The sidebar's quick switch goes back to dark.
    await page.getByRole('button', { name: 'Switch to the dark theme' }).click();
    await expect(root).toHaveAttribute('data-theme', 'dark');
    await expect.poll(background).toBe(dark);
});

test('screen reader support exposes the terminal output line by line', async ({ page, state, addServer }) => {
    const server = await addServer('alpha', { name: `Screen reader ${uid()}` });
    await openApp(page, state);
    const settings = await openSettings(page, 'Appearance');
    const toggle = settings.getByRole('checkbox', { name: 'Screen reader support in the terminal' });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await page.keyboard.press('Escape');

    await openServer(page, server.name);
    const terminal = page.getByRole('tabpanel', { name: 'Terminal 1', exact: true });
    await expect(terminal.getByRole('list').getByRole('listitem').first()).toBeVisible({ timeout: 30_000 });
    await expectTerminalText(terminal, /demo@[\w-]+:~\$ $/m, 30_000);
    await expect(terminal.getByRole('listitem').filter({ hasText: 'Welcome to Alpine!' })).toBeVisible();

    // Off again: the accessible copy of the rows goes away, live.
    const again = await openSettings(page, 'Appearance');
    await again.getByRole('checkbox', { name: 'Screen reader support in the terminal' }).uncheck();
    await page.keyboard.press('Escape');
    await expect(terminal.locator('.xterm-accessibility-tree')).toHaveCount(0);
});
