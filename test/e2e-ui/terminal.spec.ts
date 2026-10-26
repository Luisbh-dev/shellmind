import type { Locator, Page } from '@playwright/test';
import { inside } from './support/docker';
import { expect, openApp, test, uid } from './support/test';
import { enableReadableTerminals, expectTerminalText, openServer, setClipboard, terminalText, typeCommand } from './support/ui';

// The SSH terminal: tabs with their own shells, split panes, broadcast input
// across servers (confirmed first), UTF-8 in both directions, and a snippet's
// command that waits for the session to come back.

const terminals = (page: Page) => page.locator('[id^="terminal-panel-"]:visible');
const prompt = /demo@[\w-]+:~\$ $/m;

// The terminal panel of the tab named `name`, focused and at a prompt.
async function readyTerminal(page: Page, name = 'Terminal 1') {
    const panel = page.getByRole('tabpanel', { name, exact: true });
    await expectTerminalText(panel, prompt, 30_000);
    await panel.locator('.xterm-screen').click();
    return panel;
}

async function ttyOf(page: Page, panel: Locator): Promise<string> {
    await typeCommand(page, 'echo "tty=$(tty)"');
    await expectTerminalText(panel, /tty=\/dev\/pts\/\d+/);
    return /tty=(\/dev\/pts\/\d+)/.exec(await terminalText(panel))![1];
}

test.beforeEach(async ({ page }) => {
    await enableReadableTerminals(page);
});

test('terminal tabs run their own shells, and UTF-8 goes both ways', async ({ page, context, state, addServer }) => {
    const server = await addServer('alpha', { name: `Terminal tabs ${uid()}` });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: state.webUrl });
    await openApp(page, state);
    await openServer(page, server.name);

    const first = await readyTerminal(page);
    const firstTty = await ttyOf(page, first);

    // A second tab is a second shell on the same (pooled) connection.
    await page.getByRole('button', { name: 'New terminal' }).click();
    const sessions = page.getByRole('tablist', { name: 'Terminal sessions' });
    await expect(sessions.getByRole('tab', { name: 'Terminal 2' })).toHaveAttribute('aria-selected', 'true');
    const second = await readyTerminal(page, 'Terminal 2');
    const secondTty = await ttyOf(page, second);
    expect(secondTty).not.toBe(firstTty);

    // Output: UTF-8 split across packets still renders whole.
    await typeCommand(page, String.raw`printf '\303\261and\303\272 \342\200\224 \346\227\245\346\234\254\350\252\236 \342\234\223\n'`);
    await expectTerminalText(second, 'ñandú — 日本語 ✓');

    // Input: pasted UTF-8 reaches the server as UTF-8.
    const file = `/tmp/utf8-${uid()}.txt`;
    await setClipboard(page, `echo 'ñandú — 日本語 ✓' > ${file}`);
    await page.getByRole('toolbar', { name: 'Terminal tools' }).getByRole('button', { name: /^Paste/ }).click();
    await page.keyboard.press('Enter');
    await expect.poll(() => inside(state.hosts.alpha.container, `cat ${file} 2>/dev/null || true`)).toBe('ñandú — 日本語 ✓');

    // Back to the first tab: its shell and output are still there.
    await sessions.getByRole('tab', { name: 'Terminal 1' }).click();
    await expectTerminalText(first, `tty=${firstTty}`);

    // Closing a live tab from the keyboard asks first.
    await sessions.getByRole('tab', { name: 'Terminal 2' }).click();
    await sessions.getByRole('tab', { name: 'Terminal 2' }).focus();
    await page.keyboard.press('Delete');
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Terminal 2');
    await confirm.getByRole('button', { name: 'Close' }).last().click();
    await expect(sessions.getByRole('tab')).toHaveCount(1);
    await expect(sessions.getByRole('tab', { name: 'Terminal 1' })).toHaveAttribute('aria-selected', 'true');
});

test('split panes and broadcast input to several servers after a confirmation', async ({ page, state, addServer }) => {
    const id = uid();
    const alpha = await addServer('alpha', { name: `Split alpha ${id}` });
    const beta = await addServer('beta', { name: `Split beta ${id}` });
    await openApp(page, state);
    const log = `/tmp/broadcast-${id}.log`;

    // Two panes on alpha.
    await openServer(page, alpha.name);
    await readyTerminal(page);
    await page.getByRole('button', { name: 'Layout' }).click();
    await page.getByRole('menuitem', { name: /^Split right/ }).click();
    await expect(terminals(page)).toHaveCount(2);
    for (const panel of await terminals(page).all()) await expectTerminalText(panel, prompt, 30_000);

    // One terminal on beta, then a broadcast group over all three.
    await openServer(page, beta.name);
    await readyTerminal(page);
    await page.getByRole('button', { name: /^Broadcast input/ }).click();
    const picker = page.getByRole('dialog', { name: 'Broadcast input' });
    const boxes = picker.getByRole('checkbox');
    await expect(boxes).toHaveCount(3);
    for (const box of await boxes.all()) await box.check();
    await picker.getByRole('button', { name: 'Start broadcasting' }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText('Broadcast to 2 servers?');
    await confirm.getByRole('button', { name: 'Broadcast' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Broadcasting to 3 terminals on 2 servers' })).toBeVisible();

    await expect(page.locator('[id^="terminal-panel-"] .xterm-helper-textarea:focus')).toHaveCount(1);
    await typeCommand(page, `echo "from $(hostname) $(tty)" >> ${log}`);
    const lines = (container: string) => inside(container, `cat ${log} 2>/dev/null || true`).split('\n').filter(Boolean);
    await expect.poll(() => lines(state.hosts.alpha.container).length).toBe(2);
    await expect.poll(() => lines(state.hosts.beta.container).length).toBe(1);
    expect(new Set(lines(state.hosts.alpha.container)).size).toBe(2);

    // Off again.
    await page.keyboard.press('Control+Shift+B');
    await expect(page.getByRole('status').filter({ hasText: 'Broadcasting' })).toHaveCount(0);
    await typeCommand(page, `echo "alone" >> ${log}`);
    await expect.poll(() => lines(state.hosts.beta.container).length).toBe(2);
    expect(lines(state.hosts.alpha.container)).toHaveLength(2);
});

test("a snippet's command waits for the terminal to reconnect, then runs", async ({ page, state, api, addServer }) => {
    const id = uid();
    const server = await addServer('alpha', { name: `Queued ${id}` });
    const file = `/tmp/greet-${id}.txt`;
    await api.post('/api/snippets', { name: `Greet ${id}`, command: `echo "hello {{who:world}}" > ${file}`, description: 'Writes a greeting', tags: ['e2e'] });
    await openApp(page, state);
    await openServer(page, server.name);

    // The session ends: the server is disconnected.
    const panel = await readyTerminal(page);
    await typeCommand(page, 'exit');
    const ended = panel.getByRole('status').filter({ hasText: 'Session ended' });
    await expect(ended).toBeVisible();
    await expect(page.getByRole('banner')).toContainText('Disconnected');

    await page.getByRole('banner').getByRole('button', { name: 'Snippets', exact: true }).click();
    const library = page.getByRole('dialog', { name: 'Snippets' });
    await library.getByRole('button', { name: new RegExp(`^Greet ${id} `) }).click();
    const detail = library.getByRole('article', { name: `Greet ${id}` });
    await detail.getByRole('textbox', { name: 'who' }).fill('e2e');
    await expect(detail).toContainText(`echo "hello e2e" > ${file}`);
    await detail.getByRole('button', { name: `Run in ${server.name}` }).click();
    await expect(library).toBeHidden();
    await expect(page.getByRole('region', { name: 'Notifications' })).toContainText(`Waiting for the terminal of ${server.name}`);
    expect(inside(state.hosts.alpha.container, `cat ${file} 2>/dev/null || true`)).toBe('');

    await ended.getByRole('button', { name: 'Reconnect' }).click();
    await expect.poll(() => inside(state.hosts.alpha.container, `cat ${file} 2>/dev/null || true`), { timeout: 30_000 }).toBe('hello e2e');
    await expectTerminalText(panel, `echo "hello e2e" > ${file}`);
});
