import { expect, type Locator, type Page } from '@playwright/test';

// Shared steps of the specs: the sidebar, workspace tabs, the palette and
// reading a terminal.

export const sidebar = (page: Page) => page.getByRole('navigation', { name: 'Saved connections' });

// A server's row in the sidebar (its accessible name starts with its name).
export function serverRow(page: Page, name: string): Locator {
    return sidebar(page).getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}, `) });
}

// The buttons of a row (favorite, edit, more actions) show on hover.
export async function rowButton(page: Page, server: string, label: string): Promise<Locator> {
    await serverRow(page, server).hover();
    const button = sidebar(page).getByRole('button', { name: label, exact: true });
    await expect(button).toBeVisible();
    return button;
}

export async function openServer(page: Page, name: string): Promise<void> {
    await serverRow(page, name).click();
    await expect(page.getByRole('banner')).toContainText(name);
}

export function workspaceTab(page: Page, name: string): Locator {
    return page.getByRole('tablist', { name: 'Workspace' }).getByRole('tab', { name, exact: true });
}

export async function openWorkspaceTab(page: Page, name: string): Promise<Locator> {
    await workspaceTab(page, name).click();
    const panel = page.getByRole('tabpanel', { name, exact: true });
    await expect(panel).toBeVisible();
    return panel;
}

// Ctrl+Shift+P: unlike Ctrl+K it also opens the palette from a terminal,
// where Ctrl+K belongs to the shell.
export async function openPalette(page: Page): Promise<Locator> {
    await page.keyboard.press('Control+Shift+P');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    return palette;
}

// Runs a palette entry by its name.
export async function runFromPalette(page: Page, query: string, option: string | RegExp): Promise<void> {
    const palette = await openPalette(page);
    await palette.getByRole('combobox').fill(query);
    await palette.getByRole('option', { name: option }).first().click();
    await expect(palette).toBeHidden();
}

// The app's own select (a combobox whose listbox renders in <body>).
export async function choose(page: Page, combobox: Locator, option: string | RegExp): Promise<void> {
    await combobox.click();
    await page.getByRole('listbox').getByRole('option', { name: option }).click();
}

// Terminals render on a canvas; with the screen reader setting on, xterm
// keeps an accessible copy of their rows, which is what these read.
export async function enableReadableTerminals(page: Page): Promise<void> {
    await page.addInitScript({ content: "localStorage.setItem('shellmind.terminal.screenReaderMode', 'on');" });
}

// Puts `text` on the page's clipboard (needs the clipboard permissions).
export async function setClipboard(page: Page, text: string): Promise<void> {
    await page.evaluate(`navigator.clipboard.writeText(${JSON.stringify(text)})`);
}

export function terminalText(terminal: Locator): Promise<string> {
    return terminal.locator('.xterm-accessibility-tree').innerText();
}

export async function expectTerminalText(terminal: Locator, expected: string | RegExp, timeout = 20_000): Promise<void> {
    await expect.poll(() => terminalText(terminal), { timeout }).toEqual(
        typeof expected === 'string' ? expect.stringContaining(expected) : expect.stringMatching(expected)
    );
}

// Types a command line into the terminal that has the keyboard focus.
export async function typeCommand(page: Page, command: string): Promise<void> {
    await page.keyboard.type(command, { delay: 5 });
    await page.keyboard.press('Enter');
}

export function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
