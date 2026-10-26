import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { AuditEntry, AuditSettings, ServerSummary } from '@shared/types';
import { setLanguage } from '@/i18n';
import AuditModal, { dayBoundary } from './AuditModal';
import { resetServersStore } from '@/store/servers';

// Pages of 100 rendered rows are slow in jsdom when the whole suite runs in parallel.
vi.setConfig({ testTimeout: 20_000 });

const SERVERS: ServerSummary[] = [{ id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux' }];

const entry = (id: number, overrides: Partial<AuditEntry> = {}): AuditEntry => ({
    id,
    ts: Date.UTC(2026, 9, 20, 10, 0, 0) + id * 1000,
    server_id: 1,
    server_name: 'web-1',
    source: 'multi-exec',
    command: `echo ${id}`,
    exit_code: 0,
    meta: null,
    ...overrides,
});

let entries: AuditEntry[];
let requests: URL[];
let retention: AuditSettings;
let retentionSaves: unknown[];

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

// GET /api/audit with the filters and paging the backend implements, and its retention setting.
function backend(input: RequestInfo | URL, init?: RequestInit): Response {
    const url = new URL(String(input));
    if (url.pathname === '/api/servers') return json({ data: SERVERS });
    if (url.pathname === '/api/audit/settings') {
        if (init?.method !== 'PUT') return json({ message: 'success', data: retention });
        const { retentionDays } = JSON.parse(String(init.body)) as { retentionDays: AuditSettings['retentionDays'] };
        retentionSaves.push(retentionDays);
        retention = { ...retention, retentionDays };
        const kept = entries.filter((item) => item.id > 1);
        const pruned = entries.length - kept.length;
        entries = kept;
        return json({ message: 'success', data: retention, pruned });
    }
    if (url.pathname !== '/api/audit') return json({ error: 'unexpected' }, 500);
    requests.push(url);
    const params = url.searchParams;
    const before = params.get('before');
    const q = params.get('q')?.toLowerCase();
    const matching = entries
        .filter((item) => !params.get('source') || item.source === params.get('source'))
        .filter((item) => !before || item.id < Number(before))
        .filter((item) => !q || item.command.toLowerCase().includes(q))
        .filter((item) => !params.get('from') || item.ts >= Number(params.get('from')))
        .sort((a, b) => b.id - a.id);
    return json({ data: matching.slice(0, Number(params.get('limit'))) });
}

const lastAuditRequest = () => requests.at(-1)!.searchParams;

beforeEach(() => {
    setLanguage('en');
    resetServersStore();
    entries = [];
    requests = [];
    retention = { retentionDays: 90, maxEntries: 100_000 };
    retentionSaves = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => backend(input, init)));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

// perf-db-global-queue-audit-growth: the log kept every entry forever.
describe('audit log retention', () => {
    const control = () => screen.getByRole('combobox', { name: /^Keep entries/ });
    const choose = async (option: string | RegExp) => {
        fireEvent.click(control());
        fireEvent.click(await screen.findByRole('option', { name: option }));
    };

    it('shows how long entries are kept and asks before a shorter period deletes the older ones', async () => {
        entries = [entry(1), entry(2)];
        const ask = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
        render(<AuditModal onClose={vi.fn()} server={null} />);
        await waitFor(() => expect(control()).toHaveAccessibleName('Keep entries 90 days'));
        expect(control()).toBeEnabled();

        // Declined: nothing is saved.
        await choose('30 days');
        expect(ask).toHaveBeenCalledTimes(1);
        expect(retentionSaves).toEqual([]);

        await choose('30 days');
        await waitFor(() => expect(retentionSaves).toEqual([30]));
        await waitFor(() => expect(control()).toHaveAccessibleName('Keep entries 30 days'));
        // The deleted entry leaves the list.
        await waitFor(() => expect(screen.getByText('Entries: 1')).toBeInTheDocument());

        // A longer period deletes nothing and does not ask.
        await choose(/^No time limit.*Up to the newest 100,000 entries$/);
        await waitFor(() => expect(retentionSaves).toEqual([30, 0]));
        expect(ask).toHaveBeenCalledTimes(2);
    });

    it('stays out of the way when the backend has no retention setting', async () => {
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
            new URL(String(input)).pathname === '/api/audit/settings' ? json({ error: 'Not found', code: 'NOT_FOUND' }, 404) : backend(input, init)));
        render(<AuditModal onClose={vi.fn()} server={null} />);
        await screen.findByText('Nothing recorded yet. Commands run from the AI chat, snippets, multi-exec and ops panels appear here.');
        await waitFor(() => expect(screen.queryByRole('combobox', { name: /^Keep entries/ })).toBeNull());
    });
});

describe('audit log viewer', () => {
    it('lists entries newest first and loads older pages with the before cursor', async () => {
        entries = Array.from({ length: 130 }, (_, index) => entry(index + 1));
        render(<AuditModal onClose={vi.fn()} server={null} />);

        const table = await screen.findByRole('table', { name: 'Audit log' });
        // Plain selectors: role queries over a few hundred rows are slow in jsdom.
        const rows = () => table.querySelectorAll('tbody tr');
        expect(rows()).toHaveLength(100);
        expect(rows()[0]).toHaveTextContent('echo 130');
        expect(screen.getByText('Showing the latest 100 entries')).toBeInTheDocument();

        fireEvent.click(screen.getByText('Load older entries'));
        await waitFor(() => expect(rows()).toHaveLength(130));
        expect(lastAuditRequest().get('before')).toBe('31');
        expect(screen.queryByRole('button', { name: 'Load older entries' })).toBeNull();
        expect(screen.getByText('Entries: 130')).toBeInTheDocument();
    });

    it('drops an older page that arrives after the filters changed', async () => {
        entries = [
            ...Array.from({ length: 130 }, (_, index) => entry(index + 1, { command: `echo noise-${index + 1}` })),
            entry(131, { command: 'echo special' }),
        ];
        // Older pages wait until released (and ignore the abort, like a slow
        // response that is already on its way).
        const held: Array<() => void> = [];
        vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
            if (new URL(String(input)).searchParams.has('before')) await new Promise<void>((resolve) => held.push(resolve));
            return backend(input);
        }));
        render(<AuditModal onClose={vi.fn()} server={null} />);
        const rows = () => screen.getByRole('table', { name: 'Audit log' }).querySelectorAll('tbody tr');
        await waitFor(() => expect(rows()).toHaveLength(100));

        fireEvent.click(screen.getByText('Load older entries'));
        await waitFor(() => expect(held).toHaveLength(1));
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'special' } });
        await waitFor(() => expect(lastAuditRequest().get('q')).toBe('special'));
        await waitFor(() => expect(rows()).toHaveLength(1));

        await act(async () => {
            held.forEach((release) => release());
            await new Promise((resolve) => setTimeout(resolve, 20));
        });
        expect(rows()).toHaveLength(1);
        expect(rows()[0]).toHaveTextContent('echo special');
        expect(screen.getByText('Entries: 1')).toBeInTheDocument();
        expect(screen.queryByText('Load older entries')).toBeNull();
    });

    it('filters by source, text and date range on the backend', async () => {
        entries = [
            entry(1, { source: 'snippet', command: 'df -h' }),
            entry(2, { source: 'ai-run', command: 'systemctl restart nginx', exit_code: 1 }),
            entry(3, { source: 'snippet', command: 'docker ps' }),
        ];
        render(<AuditModal onClose={vi.fn()} server={null} />);
        await screen.findByRole('table', { name: 'Audit log' });

        fireEvent.click(within(screen.getByRole('group', { name: 'Source' })).getByRole('combobox', { name: 'All sources' }));
        fireEvent.click(screen.getByRole('option', { name: 'Snippet' }));
        await waitFor(() => expect(lastAuditRequest().get('source')).toBe('snippet'));
        await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search' }), { target: { value: 'docker' } });
        await waitFor(() => expect(lastAuditRequest().get('q')).toBe('docker'));
        await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(2));

        fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-10-21' } });
        await waitFor(() => expect(lastAuditRequest().get('from')).toBe(String(dayBoundary('2026-10-21', false))));
        expect(await screen.findByText('No entries match these filters.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
        await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(4));
        expect(lastAuditRequest().get('source')).toBeNull();
    });

    it('shows the full command and its details, and copies it', async () => {
        const writeText = vi.fn(async () => undefined);
        vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
        entries = [entry(1, { command: 'for i in 1 2; do\n  echo $i\ndone', meta: { runId: 'r-1', status: 'ok' }, server_name: null, server_id: null })];
        render(<AuditModal onClose={vi.fn()} server={null} />);
        const table = await screen.findByRole('table', { name: 'Audit log' });
        expect(within(table).getByText('No server')).toBeInTheDocument();

        fireEvent.click(within(table).getByRole('button', { name: 'Show details' }));
        expect(within(table).getByText('runId')).toBeInTheDocument();
        expect(within(table).getByText('r-1')).toBeInTheDocument();

        fireEvent.click(within(table).getByRole('button', { name: 'Copy command' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('for i in 1 2; do\n  echo $i\ndone'));
    });

    // SEC-7: what the interface reported is told apart from the backend's own records.
    it('marks the entries the interface reported', async () => {
        entries = [
            entry(1, { source: 'ops', command: 'systemctl restart nginx' }),
            entry(2, { source: 'ops', command: 'docker restart web', meta: { via: 'terminal', reportedBy: 'client' } }),
        ];
        render(<AuditModal onClose={vi.fn()} server={null} />);
        const table = await screen.findByRole('table', { name: 'Audit log' });
        const rows = within(table).getAllByRole('row');
        const reported = rows.find((row) => row.textContent?.includes('docker restart web'))!;
        const own = rows.find((row) => row.textContent?.includes('systemctl restart nginx'))!;
        expect(within(reported).getByText('reported')).toHaveAttribute('title', 'Reported by the interface after it typed the command into a terminal, not recorded by the backend on its own.');
        expect(within(own).queryByText('reported')).toBeNull();
    });

    it('exports every matching entry as CSV', async () => {
        entries = Array.from({ length: 620 }, (_, index) => entry(index + 1, { command: index === 0 ? '=cmd|calc' : `echo ${index + 1}` }));
        const blobs: Blob[] = [];
        const original = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
        URL.createObjectURL = vi.fn((blob: Blob) => {
            blobs.push(blob);
            return 'blob:audit';
        });
        URL.revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);

        try {
            render(<AuditModal onClose={vi.fn()} server={null} />);
            await screen.findByText('echo 620');
            fireEvent.click(screen.getByText('Export CSV'));
            await waitFor(() => expect(click).toHaveBeenCalled());
        } finally {
            URL.createObjectURL = original.create;
            URL.revokeObjectURL = original.revoke;
        }
        // Blob.text() drops the BOM, so look at the raw bytes.
        expect([...new Uint8Array(await blobs[0].arrayBuffer()).slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
        const lines = (await blobs[0].text()).split('\r\n');
        expect(lines[0]).toBe('id,time,server_id,server,source,exit_code,command,meta');
        expect(lines).toHaveLength(622);
        expect(lines[620]).toContain(",'=cmd|calc,");
        const exportRequests = requests.filter((url) => url.searchParams.get('limit') === '500');
        expect(exportRequests.map((url) => url.searchParams.get('before'))).toEqual([null, '121']);
    });

    it('speaks Spanish', async () => {
        setLanguage('es');
        render(<AuditModal onClose={vi.fn()} server={null} />);
        expect(await screen.findByText(/Todavía no hay nada registrado/)).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Exportar CSV' })).toBeDisabled();
    });
});
