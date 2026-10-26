import { expect, test } from './support/test';

// The access gate: the backend accepts nothing without its session token, and
// the UI asks for it until it has one that works.

test('asks for the access token, refuses a wrong one and opens with the right one', async ({ page, state }) => {
    await page.goto(`${state.webUrl}/`);
    const gate = page.getByRole('form', { name: 'Access token required' });
    await expect(gate).toBeVisible();
    await expect(gate.getByRole('button', { name: 'Unlock' })).toBeDisabled();

    await gate.getByLabel('Access token', { exact: true }).fill('not-the-token');
    await gate.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByText('That token was not accepted.')).toBeVisible();

    await gate.getByLabel('Access token', { exact: true }).fill(state.token);
    await gate.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to ShellMind' })).toBeVisible();
    await expect(gate).toBeHidden();
});

test('remembers the token on this device only when asked to', async ({ context, page, state }) => {
    await page.goto(`${state.webUrl}/`);
    const gate = page.getByRole('form', { name: 'Access token required' });
    await gate.getByLabel('Access token', { exact: true }).fill(state.token);
    await gate.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to ShellMind' })).toBeVisible();

    // Another tab has its own session: not remembered, it asks again.
    const second = await context.newPage();
    await second.goto(`${state.webUrl}/`);
    await expect(second.getByRole('form', { name: 'Access token required' })).toBeVisible();
    const secondGate = second.getByRole('form', { name: 'Access token required' });
    await secondGate.getByLabel('Access token', { exact: true }).fill(state.token);
    await secondGate.getByRole('checkbox', { name: /Remember on this device/ }).check();
    await secondGate.getByRole('button', { name: 'Unlock' }).click();
    await expect(second.getByRole('heading', { name: 'Welcome to ShellMind' })).toBeVisible();

    // Remembered: a third tab opens straight away.
    const third = await context.newPage();
    await third.goto(`${state.webUrl}/`);
    await expect(third.getByRole('heading', { name: 'Welcome to ShellMind' })).toBeVisible();
    await expect(third.getByRole('form', { name: 'Access token required' })).toHaveCount(0);
});

test('takes the token from the launch address and removes it from there', async ({ page, state }) => {
    await page.goto(`${state.webUrl}/?token=${encodeURIComponent(state.token)}`);
    await expect(page.getByRole('heading', { name: 'Welcome to ShellMind' })).toBeVisible();
    expect(page.url()).not.toContain(state.token);
    expect(new URL(page.url()).search).toBe('');
});
