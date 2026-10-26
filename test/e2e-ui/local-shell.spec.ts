import { expect, openApp, test } from './support/test';
import { enableReadableTerminals, expectTerminalText, typeCommand } from './support/ui';

// A local console: the welcome screen creates a "Local shell" connection (the
// default shell of the machine running the backend) and opens its terminal.

test('opens a local shell on this machine from the welcome screen', async ({ page, state }) => {
    await enableReadableTerminals(page);
    await openApp(page, state);

    await page.getByRole('button', { name: /^Open a local shell/ }).click();
    // Created the first time (a run's database starts empty), then reused.
    const confirm = page.getByRole('alertdialog', { name: 'Create a local shell?' });
    if (await confirm.waitFor({ timeout: 5000 }).then(() => true, () => false)) {
        await expect(confirm).toContainText('Create “Local shell” and open it?');
        await confirm.getByRole('button', { name: 'Create and open' }).click();
    }
    await expect(page.getByRole('banner')).toContainText('Local shell');

    const terminal = page.getByRole('tabpanel', { name: 'Terminal 1', exact: true });
    await expectTerminalText(terminal, /[>$#] *$/m, 30_000);
    await terminal.locator('.xterm-screen').click();
    await typeCommand(page, 'echo local-shell-ok');
    // A line of its own: the output, not the echo of the command line.
    await expectTerminalText(terminal, /^local-shell-ok\s*$/m);
});
