import type { Page } from '@playwright/test';
import type { AuditEntry } from '../../shared/types';
import { AUTORUN_COMMAND, AUTORUN_MARKER, AUTORUN_OUTPUT, DANGEROUS_COMMAND, DANGEROUS_MARKER, type RecordedRequest } from './support/aiMock';
import { expect, openApp, test, uid, type Api } from './support/test';
import { enableReadableTerminals, expectTerminalText, openServer, openWorkspaceTab, terminalText } from './support/ui';

// The AI chat against a local Anthropic-compatible provider (support/aiMock.ts,
// reached through MINIMAX_PROXY_URL): streamed answers, the legal notice,
// evidence attached for a diagnosis, and Auto-Run with its confirmation and
// its gate before destructive commands.

const chat = (page: Page) => page.getByRole('complementary', { name: 'AI chat' });

// Sends once the chat takes a message (not while an answer still arrives).
async function send(page: Page, text: string) {
    const composer = chat(page).getByRole('textbox', { name: 'Message for the AI assistant' });
    await expect(chat(page).getByRole('button', { name: 'Stop', exact: true })).toBeHidden();
    await composer.fill(text);
    const sendButton = chat(page).getByRole('button', { name: 'Send (Enter)' });
    await expect(sendButton).toBeEnabled();
    await sendButton.click();
    await expect(composer).toHaveValue('');
}

async function providerRequests(mockUrl: string): Promise<RecordedRequest[]> {
    return (await fetch(`${mockUrl}/__mock/requests`)).json() as Promise<RecordedRequest[]>;
}

async function auditOf(api: Api, serverId: number): Promise<AuditEntry[]> {
    return (await api.get<{ data: AuditEntry[] }>(`/api/audit?serverId=${serverId}&limit=200`)).data;
}

test('answers through the provider as it streams, and links its legal notice', async ({ page, context, state, addServer }) => {
    const id = uid();
    const server = await addServer('alpha', { name: `Chat ${id}` });
    await context.route('https://shellmind.app/**', (route) => route.fulfill({ contentType: 'text/html', body: '<title>Legal</title>legal notice' }));
    await openApp(page, state);
    await openServer(page, server.name);
    await expect(chat(page).getByRole('log', { name: 'Conversation' })).toContainText(`Connected to ${server.name}. Ready to help.`, { timeout: 30_000 });

    // The notice links the legal page (outside the app), until dismissed.
    const notice = chat(page).getByRole('note');
    const legal = notice.getByRole('link', { name: 'legal notice' });
    await expect(legal).toHaveAttribute('href', 'https://shellmind.app/legal.html#ai-data');
    await expect(legal).toHaveAttribute('target', '_blank');
    const popup = context.waitForEvent('page');
    await legal.click();
    await expect.poll(async () => (await popup).url()).toBe('https://shellmind.app/legal.html#ai-data');
    await (await popup).close();
    await notice.getByRole('button', { name: 'Got it' }).click();
    await expect(notice).toBeHidden();

    await send(page, `Hello from the e2e suite ${id}`);
    const log = chat(page).getByRole('log', { name: 'Conversation' });
    // Streaming: the answer grows while Stop is offered, then completes.
    await expect(chat(page).getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
    await expect(log).toContainText('Mock answer:');
    await expect(log).toContainText('Mock answer: streaming works from the local provider.');
    await expect(chat(page).getByRole('button', { name: 'Stop', exact: true })).toBeHidden();

    const sent = (await providerRequests(state.aiMockUrl)).filter((request) => request.lastUser.includes(`Hello from the e2e suite ${id}`));
    expect(sent).toHaveLength(1);
    expect(sent[0].path).toBe('/anthropic/v1/messages');
    expect(sent[0].model).toMatch(/MiniMax/i);
    expect(sent[0].system).toContain(server.name);
});

test('a diagnosis sends the evidence it shows', async ({ page, state, addServer }) => {
    const id = uid();
    const server = await addServer('alpha', { name: `Diagnose ${id}` });
    const hostname = state.hosts.alpha.container.replace('shellmind-test-e2eui-', '');
    await openApp(page, state);
    await openServer(page, server.name);
    const status = await openWorkspaceTab(page, 'Status');
    await expect(status.getByText(/^Health: /)).toBeVisible({ timeout: 30_000 });

    await status.getByRole('button', { name: 'Ask AI about this status' }).click();
    const attachment = chat(page).getByRole('region', { name: 'Attachment: Server status' });
    await expect(attachment).toContainText('sent exactly as shown', { timeout: 30_000 });
    const composer = chat(page).getByRole('textbox', { name: 'Message for the AI assistant' });
    await expect(composer).toHaveValue('Is anything wrong with this server, and what should I do about it?');
    await attachment.getByRole('button', { name: 'Review' }).click();
    await expect(attachment).toContainText(hostname);

    await composer.fill(`Is anything wrong with this server? ${id}`);
    await composer.press('Enter');
    await expect(chat(page).getByRole('log', { name: 'Conversation' })).toContainText('Mock answer: streaming works from the local provider.');

    // The provider got the status snapshot with the question.
    const sent = (await providerRequests(state.aiMockUrl)).find((request) => request.lastUser.includes(id));
    expect(sent).toBeDefined();
    expect(`${sent!.system}\n${sent!.lastUser}`).toContain(hostname);
});

test('Auto-Run asks before it turns on, runs safe commands and stops before destructive ones', async ({ page, state, api, addServer }) => {
    const id = uid();
    await enableReadableTerminals(page);
    const server = await addServer('alpha', { name: `Auto-Run ${id}` });
    await openApp(page, state);
    await openServer(page, server.name);
    const terminal = page.getByRole('tabpanel', { name: 'Terminal 1', exact: true });
    await expectTerminalText(terminal, /demo@[\w-]+:~\$ $/m, 30_000);

    // Turning it on needs a confirmation naming the server.
    await chat(page).getByRole('button', { name: /Auto-Run/ }).click();
    const confirm = page.getByRole('dialog', { name: 'Enable Auto-Run?' });
    await expect(confirm).toContainText('Commands will run on');
    await expect(confirm).toContainText(server.name);
    await confirm.getByRole('button', { name: 'Enable Auto-Run' }).click();
    await expect(chat(page).getByRole('button', { name: /AUTO ON/ })).toBeVisible();

    // A safe command runs by itself; its output goes back to the provider.
    await send(page, `Check the shell please (${AUTORUN_MARKER} ${id})`);
    await expectTerminalText(terminal, AUTORUN_OUTPUT, 30_000);
    const log = chat(page).getByRole('log', { name: 'Conversation' });
    await expect(log).toContainText(`The command printed ${AUTORUN_OUTPUT}. Nothing else to run.`, { timeout: 30_000 });
    expect((await providerRequests(state.aiMockUrl)).some((request) => request.lastUser.includes(AUTORUN_OUTPUT))).toBe(true);
    await expect.poll(async () => (await auditOf(api, server.id)).filter((entry) => entry.source === 'ai-autorun').map((entry) => entry.command))
        .toContain(AUTORUN_COMMAND);

    // A destructive one waits for the user, who skips it.
    await send(page, `Clean the disk (${DANGEROUS_MARKER} ${id})`);
    const gate = chat(page).getByRole('alertdialog').filter({ hasText: 'Auto-Run paused before a destructive command' });
    await expect(gate).toBeVisible({ timeout: 30_000 });
    await expect(gate).toContainText('writes to or formats a disk');
    await expect(gate).toContainText(server.name);
    await gate.getByRole('button', { name: 'Skip' }).click();
    await expect(gate).toBeHidden();
    await expect(chat(page)).toContainText('Destructive command skipped. Auto-Run stopped.');
    expect(await terminalText(terminal)).not.toContain(DANGEROUS_COMMAND);
    expect((await auditOf(api, server.id)).some((entry) => entry.command.includes('mkfs'))).toBe(false);
});
