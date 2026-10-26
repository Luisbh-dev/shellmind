import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConfigImportPreview, ConfigImportResult, SshConfigPreview } from '@shared/organization';
import { setLanguage } from '@/i18n';
import { ToastProvider } from '@/components/ui/Toast';
import { DataTransfer } from './DataTransfer';
import { SshConfigImport } from './SshConfigImport';

type Call = { url: string; method: string; body: Record<string, unknown> };
let calls: Call[];
let respond: (call: Call) => Response;

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const PREVIEW: SshConfigPreview = {
    source: null,
    warnings: [{ code: 'match-ignored' }],
    entries: [
        { alias: 'bastion', host: '203.0.113.5', port: null, user: 'jump', identityFile: null, proxyJump: null, proxyJumpSavedId: null, duplicateOf: null, warnings: [] },
        { alias: 'app', host: '10.3.0.10', port: 2222, user: 'deploy', identityFile: '~/.ssh/app', proxyJump: 'bastion', proxyJumpSavedId: null, duplicateOf: null, warnings: [] },
        { alias: 'known', host: '10.0.0.9', port: null, user: 'root', identityFile: null, proxyJump: null, proxyJumpSavedId: null, duplicateOf: { id: 4, name: 'db' }, warnings: [{ code: 'user-default', detail: 'me' }] },
    ],
};

beforeEach(() => {
    setLanguage('en');
    calls = [];
    respond = (call) => {
        if (call.url.endsWith('/preview')) return json(PREVIEW);
        if (call.url.endsWith('/apply')) return json({ created: [{ name: 'app', id: 10 }], skipped: [{ name: 'other', reason: 'jump-missing', detail: 'gw' }] });
        return json({});
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        const call = { url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} };
        calls.push(call);
        return respond(call);
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('SSH config import wizard', () => {
    it('previews pasted text, lets the user pick hosts and imports them into a group', async () => {
        const user = userEvent.setup();
        const onImported = vi.fn();
        render(<SshConfigImport open onClose={() => undefined} onImported={onImported} />);
        const dialog = screen.getByRole('dialog', { name: 'Import from SSH config' });

        await user.click(within(dialog).getByRole('radio', { name: 'Paste the text' }));
        await user.type(within(dialog).getByLabelText('SSH config'), 'Host app');
        await user.click(within(dialog).getByRole('button', { name: 'Preview' }));

        expect(await within(dialog).findByText('3 hosts found')).toBeInTheDocument();
        expect(within(dialog).getByRole('checkbox', { name: /bastion/ })).toBeChecked();
        expect(calls[0]).toMatchObject({ method: 'POST', body: { text: 'Host app' } });
        expect(within(dialog).getByText('Match blocks are not evaluated.')).toBeInTheDocument();
        // Duplicates cannot be picked; the others start selected.
        expect(within(dialog).getByRole('checkbox', { name: /known/ })).toBeDisabled();
        expect(within(dialog).getByText('Already saved as db')).toBeInTheDocument();
        expect(within(dialog).getByRole('checkbox', { name: /app/ })).toBeChecked();

        await user.click(within(dialog).getByRole('checkbox', { name: /bastion/ }));
        expect(within(dialog).getByText(/Its jump host bastion is not selected/)).toBeInTheDocument();
        await user.click(within(dialog).getByRole('checkbox', { name: /bastion/ }));

        const group = within(dialog).getByLabelText('Group');
        expect(group).toHaveValue('SSH config');
        await user.clear(group);
        await user.type(group, 'Imported');
        await user.click(within(dialog).getByRole('button', { name: 'Import 2' }));

        expect(await within(dialog).findByText('1 created, 1 skipped.')).toBeInTheDocument();
        expect(within(dialog).getByText(/its jump host is missing/)).toBeInTheDocument();
        expect(calls[1].body).toEqual({
            group_name: 'Imported',
            entries: [
                { alias: 'bastion', host: '203.0.113.5', port: null, user: 'jump', identityFile: null, proxyJump: null, proxyJumpSavedId: null },
                { alias: 'app', host: '10.3.0.10', port: 2222, user: 'deploy', identityFile: '~/.ssh/app', proxyJump: 'bastion', proxyJumpSavedId: null },
            ],
        });
        expect(onImported).toHaveBeenCalled();
    });

    it('sends the saved jump host the preview resolved for a jump alias that is already saved', async () => {
        respond = (call) => (call.url.endsWith('/preview')
            ? json({
                source: null,
                warnings: [],
                entries: [
                    { alias: 'bastion', host: '203.0.113.5', port: null, user: 'jump', identityFile: null, proxyJump: null, proxyJumpSavedId: null, duplicateOf: { id: 11, name: 'edge' }, warnings: [] },
                    { alias: 'inner', host: '10.0.0.20', port: null, user: 'root', identityFile: null, proxyJump: 'bastion', proxyJumpSavedId: 11, duplicateOf: null, warnings: [] },
                ],
            } satisfies SshConfigPreview)
            : json({ created: [{ name: 'inner', id: 12 }], skipped: [] }));
        const user = userEvent.setup();
        render(<SshConfigImport open onClose={() => undefined} onImported={() => undefined} />);
        await user.click(screen.getByRole('button', { name: 'Preview' }));
        expect(await screen.findByText('2 hosts found')).toBeInTheDocument();
        // The saved jump host is not offered again, and that is not a problem.
        expect(screen.queryByText(/is not selected/)).toBeNull();
        expect(screen.getByText('via bastion (saved as edge)')).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: 'Import 1' }));
        await screen.findByText('1 created, 0 skipped.');
        expect(calls[1].body.entries).toEqual([
            { alias: 'inner', host: '10.0.0.20', port: null, user: 'root', identityFile: null, proxyJump: 'bastion', proxyJumpSavedId: 11 },
        ]);
    });

    it('reads the backend user\'s file by default and shows why it could not', async () => {
        respond = () => json({ error: 'There is no SSH config file at /home/me/.ssh/config.', code: 'SSH_CONFIG_NOT_FOUND' }, 404);
        const user = userEvent.setup();
        render(<SshConfigImport open onClose={() => undefined} onImported={() => undefined} />);
        await user.click(screen.getByRole('button', { name: 'Preview' }));

        expect(await screen.findByRole('alert')).toHaveTextContent('There is no SSH config file at /home/me/.ssh/config.');
        expect(calls[0].body).toEqual({});
    });
});

describe('configuration export / import', () => {
    const RESULT: ConfigImportResult = {
        servers: { created: [{ name: 'web', id: 1 }, { name: 'dev-shell', id: 2 }], skipped: [{ name: 'db', reason: 'duplicate' }] },
        snippets: { created: [], skipped: [] },
        tunnels: {
            created: [{ name: 'pg', id: 3 }],
            skipped: [{ name: 'redis', reason: 'server-missing' }, { name: 'smb', reason: 'unsupported-server', detail: 'dev-shell' }],
        },
    };
    const PREVIEWED: ConfigImportPreview = {
        servers: { created: [{ name: 'web' }, { name: 'dev-shell' }], skipped: RESULT.servers.skipped },
        snippets: RESULT.snippets,
        tunnels: { created: [{ name: 'pg' }], skipped: RESULT.tunnels.skipped },
        review: {
            consoles: [{ name: 'dev-shell', cli_preset: 'custom', command: 'wsl -d Ubuntu', initial_command: 'curl x | sh', cwd: null }],
            tunnels: [{ name: 'pg', server: 'web', local_host: '127.0.0.1', local_port: 15432, remote_host: '127.0.0.1', remote_port: 5432 }],
        },
    };
    const BUNDLE = { format: 'shellmind-config', version: 1, servers: [] };

    const upload = async (user: ReturnType<typeof userEvent.setup>, content: string) => {
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        await user.upload(input, new File([content], 'export.json', { type: 'application/json' }));
    };

    it('downloads the export', async () => {
        const createObjectURL = vi.fn(() => 'blob:export');
        vi.stubGlobal('URL', Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() }));
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
        respond = () => json({ format: 'shellmind-config', version: 1, servers: [{ name: 'a' }], snippets: [], tunnels: [] });
        const user = userEvent.setup();
        render(<ToastProvider><DataTransfer onImported={() => undefined} onOpenSshImport={() => undefined} /></ToastProvider>);

        await user.click(screen.getByRole('button', { name: 'Export configuration' }));
        await waitFor(() => expect(click).toHaveBeenCalled());
        expect(createObjectURL).toHaveBeenCalled();
        expect(await screen.findByText('Configuration exported (1 connection)')).toBeInTheDocument();
        click.mockRestore();
    });

    it('shows what a file adds, local commands and tunnels included, and imports it only after consent', async () => {
        respond = (call) => (call.url.endsWith('/api/import/preview') ? json(PREVIEWED) : json(RESULT));
        const onImported = vi.fn();
        const user = userEvent.setup();
        render(<ToastProvider><DataTransfer onImported={onImported} onOpenSshImport={() => undefined} /></ToastProvider>);

        await upload(user, JSON.stringify(BUNDLE));
        const review = await screen.findByRole('region', { name: 'Review “export.json”' });
        expect(within(review).getByRole('heading', { name: 'Review “export.json”' })).toHaveFocus();
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({ method: 'POST', url: expect.stringContaining('/api/import/preview'), body: BUNDLE });
        expect(review).toHaveTextContent('2 will be added: web, dev-shell');
        expect(review).toHaveTextContent('already saved');
        expect(review).toHaveTextContent('smb · its server (dev-shell) does not use SSH, so it cannot have tunnels');
        expect(within(review).getByText('wsl -d Ubuntu')).toBeInTheDocument();
        expect(within(review).getByText('curl x | sh')).toBeInTheDocument();
        expect(review).toHaveTextContent('pg via web: 127.0.0.1:15432 → 127.0.0.1:5432');

        const importButton = within(review).getByRole('button', { name: 'Import' });
        expect(importButton).toBeDisabled();
        await user.click(within(review).getByRole('checkbox', { name: 'I have checked these commands and trust them' }));
        await user.click(importButton);

        const report = await screen.findByRole('status');
        expect(report).toHaveTextContent('Import finished.');
        expect(report).toHaveTextContent('2 created: web, dev-shell');
        expect(report).toHaveTextContent('its server was not imported');
        expect(calls[1]).toMatchObject({ method: 'POST', url: expect.stringMatching(/\/api\/import$/), body: BUNDLE });
        expect(onImported).toHaveBeenCalled();
        expect(screen.queryByRole('region', { name: /Review/ })).toBeNull();
    });

    it('saves nothing when the review is cancelled or the file adds nothing', async () => {
        const nothing: ConfigImportPreview = {
            servers: { created: [], skipped: [{ name: 'db', reason: 'duplicate' }] },
            snippets: { created: [], skipped: [] },
            tunnels: { created: [], skipped: [] },
            review: { consoles: [], tunnels: [] },
        };
        respond = (call) => (call.url.endsWith('/api/import/preview') ? json(calls.length === 1 ? PREVIEWED : nothing) : json(RESULT));
        const user = userEvent.setup();
        render(<ToastProvider><DataTransfer onImported={() => undefined} onOpenSshImport={() => undefined} /></ToastProvider>);

        await upload(user, JSON.stringify(BUNDLE));
        await user.click(within(await screen.findByRole('region', { name: /Review/ })).getByRole('button', { name: 'Cancel' }));
        expect(screen.queryByRole('region', { name: /Review/ })).toBeNull();

        await upload(user, JSON.stringify(BUNDLE));
        const review = await screen.findByRole('region', { name: /Review/ });
        expect(review).toHaveTextContent('Nothing new to import');
        expect(within(review).queryByRole('button', { name: 'Import' })).toBeNull();
        expect(calls.map((call) => call.url).every((url) => url.endsWith('/api/import/preview'))).toBe(true);
    });

    it('refuses a file that is not JSON without calling the backend', async () => {
        const user = userEvent.setup();
        render(<ToastProvider><DataTransfer onImported={() => undefined} onOpenSshImport={() => undefined} /></ToastProvider>);
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        await user.upload(input, new File(['not json'], 'x.json', { type: 'application/json' }));
        expect(await screen.findByRole('alert')).toHaveTextContent('That file is not valid JSON.');
        expect(calls).toEqual([]);
    });
});
