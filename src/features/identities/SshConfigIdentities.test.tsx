import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SshConfigApplyResult, SshConfigPreview } from '@shared/organization';
import { setLanguage } from '@/i18n';
import { SshConfigImport } from '@/features/organization/SshConfigImport';

// W7-S2: the ssh-config wizard says that key files and the agent become
// identities, sends IdentityAgent along, and reports the identities.

const PREVIEW: SshConfigPreview = {
    source: null,
    warnings: [],
    entries: [
        { alias: 'web', host: '10.0.0.1', port: null, user: 'deploy', identityFile: '~/.ssh/web', proxyJump: null, proxyJumpSavedId: null, duplicateOf: null, warnings: [], identityAgent: false },
        { alias: 'vault', host: '10.0.0.2', port: null, user: 'ops', identityFile: null, proxyJump: null, proxyJumpSavedId: null, duplicateOf: null, warnings: [], identityAgent: true },
    ],
};

const RESULT: SshConfigApplyResult = {
    created: [{ name: 'web', id: 1 }, { name: 'vault', id: 2 }],
    skipped: [],
    identities: { created: [{ name: 'web', id: 5 }, { name: 'ssh-agent', id: 6 }], skipped: [] },
};

let bodies: unknown[];

beforeEach(() => {
    setLanguage('en');
    bodies = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        bodies.push(init?.body ? JSON.parse(String(init.body)) : null);
        return new Response(JSON.stringify(url.endsWith('/preview') ? PREVIEW : RESULT), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

describe('SSH config import: identities', () => {
    it('groups key files and the agent into identities', async () => {
        const user = userEvent.setup();
        render(<SshConfigImport open onClose={() => undefined} onImported={() => undefined} />);
        const dialog = screen.getByRole('dialog', { name: 'Import from SSH config' });
        await user.click(within(dialog).getByRole('radio', { name: 'Paste the text' }));
        await user.type(within(dialog).getByLabelText('SSH config'), 'Host web');
        await user.click(within(dialog).getByRole('button', { name: 'Preview' }));

        expect(await within(dialog).findByText(/get one identity in Settings › Keychain/)).toBeInTheDocument();
        expect(within(dialog).getByText('SSH agent')).toBeInTheDocument();
        await user.click(within(dialog).getByRole('button', { name: /Import 2/ }));

        expect(bodies[1]).toMatchObject({ entries: [{ alias: 'web', identityFile: '~/.ssh/web' }, { alias: 'vault', identityAgent: true }] });
        expect((bodies[1] as { entries: Array<Record<string, unknown>> }).entries[0]).not.toHaveProperty('identityAgent');
        const report = await within(dialog).findByRole('status');
        expect(report).toHaveTextContent('Identities');
        expect(report).toHaveTextContent('web, ssh-agent');
    });
});
