import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConfigImportPreview, ConfigImportResult, ImportReviewCredential } from '@shared/organization';
import { setLanguage } from '@/i18n';
import { ToastProvider } from '@/components/ui';
import { DataTransfer } from '@/features/organization/DataTransfer';

// W7-S2: a configuration file that names an identity saved here (or asks to
// forward the SSH agent) gets those credentials only with the user's consent.

type Call = { url: string; method: string; body: unknown };

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

const ASKED: ImportReviewCredential = { name: 'shared-build-box', host: '203.0.113.7:2222', identity: 'prod', saved: true, uses: ['password', 'agent'], agent_forward: true };

const PREVIEW: ConfigImportPreview = {
    servers: { created: [{ name: 'shared-build-box' }], skipped: [] },
    snippets: { created: [], skipped: [] },
    tunnels: { created: [], skipped: [] },
    identities: { created: [{ name: 'ci' }], skipped: [{ name: 'prod', reason: 'duplicate' }] },
    review: { consoles: [], tunnels: [], credentials: [ASKED] },
};

const result = (linked: boolean): ConfigImportResult => ({
    servers: { created: [{ name: 'shared-build-box', id: 7 }], skipped: [] },
    snippets: { created: [], skipped: [] },
    tunnels: { created: [], skipped: [] },
    identities: { created: [{ name: 'ci', id: 3 }], skipped: [{ name: 'prod', id: 1, reason: 'duplicate' }] },
    credentials: { linked, servers: [ASKED] },
});

let calls: Call[];

beforeEach(() => {
    setLanguage('en');
    calls = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
        if (url.endsWith('/api/import/preview')) return json(PREVIEW);
        return json(result(url.includes('link_credentials=1')));
    }));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

async function review(user: ReturnType<typeof userEvent.setup>) {
    render(<ToastProvider><DataTransfer onImported={() => undefined} onOpenSshImport={() => undefined} /></ToastProvider>);
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    // The file itself claims consent: it must not count.
    await user.upload(input, new File([JSON.stringify({ format: 'shellmind-config', version: 1, servers: [], link_credentials: true })], 'shared.json', { type: 'application/json' }));
    return screen.findByRole('region', { name: 'Review “shared.json”' });
}

describe('import: credentials saved here', () => {
    it('lists the hosts that would get saved credentials and imports without them unless the user consents', async () => {
        const user = userEvent.setup();
        const region = await review(user);
        expect(region).toHaveTextContent('These connections would sign in with credentials saved on this computer');
        expect(region).toHaveTextContent('shared-build-box');
        expect(region).toHaveTextContent('203.0.113.7:2222');
        expect(region).toHaveTextContent('Saved identity "prod"');
        expect(region).toHaveTextContent('Forwards your SSH agent');
        expect(region).toHaveTextContent('1 will be added: ci');
        const consent = within(region).getByRole('checkbox', { name: 'I trust these hosts: let them use these credentials' });
        expect(consent).not.toBeChecked();

        // Importing does not wait for the consent: the hosts just do not get the credentials.
        await user.click(within(region).getByRole('button', { name: 'Import' }));
        const report = await screen.findByRole('status');
        expect(calls[1].url).toMatch(/\/api\/import$/);
        expect(report).toHaveTextContent('1 connection was imported without the saved credentials it asked for');
        expect(report).toHaveTextContent('1 created: ci');
    });

    it('gives them with consent, through the request and never the file', async () => {
        const user = userEvent.setup();
        const region = await review(user);
        await user.click(within(region).getByRole('checkbox', { name: 'I trust these hosts: let them use these credentials' }));
        await user.click(within(region).getByRole('button', { name: 'Import' }));
        expect(await screen.findByRole('status')).toHaveTextContent('1 connection signs in with credentials saved here: shared-build-box');
        expect(calls[1].url).toMatch(/\/api\/import\?link_credentials=1$/);
    });

    it('is translated', async () => {
        setLanguage('es');
        const user = userEvent.setup();
        render(<ToastProvider><DataTransfer onImported={() => undefined} onOpenSshImport={() => undefined} /></ToastProvider>);
        const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
        await user.upload(input, new File(['{"format":"shellmind-config","version":1}'], 'f.json', { type: 'application/json' }));
        expect(await screen.findByText('Estas conexiones entrarían con credenciales guardadas en este equipo')).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Confío en estos hosts: que usen estas credenciales' })).toBeInTheDocument();
    });
});
