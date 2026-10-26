import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { DEFAULT_STRATEGY, emptyCounts, type MultiExecJob, type MultiExecJobInfo } from '@shared/multiexec';
import type { PatchFleetRow, PatchPreview, PatchScan, PatchScanError, PatchScanEvent } from '@shared/patch';
import type { ServerSummary } from '@shared/types';
import { ToastProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { resetServersStore } from '@/store/servers';
import { useMultiExecStore } from '@/features/multiexec/public';
import PatchCenter from './PatchCenter';
import patchServerAction from '@/workspace/actions/patchServer';
import { clearPatchHandoff, openPatchCenter, openPatchRun, pendingFocusServer } from './public';
import ServerUpdates from './ServerUpdates';
import { resetPatchStore } from './store';

// The patch center against a fake backend: the fleet table, scans streamed
// in, a server's updates beside the table, and a run planned, confirmed by
// typing the number of servers, started and followed as a multi-exec job.

const SERVERS: ServerSummary[] = [
    { id: 1, name: 'web-1', ip: '10.0.0.1', type: 'linux', username: 'ops' },
    { id: 2, name: 'db-1', ip: '10.0.0.2', type: 'linux', username: 'ops' },
    { id: 3, name: 'win-1', ip: '10.0.0.3', type: 'windows' },
    { id: 4, name: 'bucket', ip: '', type: 's3' }
];

function scan(serverId: number, overrides: Partial<PatchScan> = {}): PatchScan {
    return {
        serverId, platform: 'linux', manager: 'apt', privilege: 'sudo', total: 2, security: 1, held: [], patches: [], rebootRequired: false,
        rebootPackages: [], restartServices: [], lastUpdateAt: null, metadataAt: Date.now() - 3600_000, notices: [], scannedAt: Date.now(), durationMs: 40,
        updates: [
            { name: 'openssl', arch: 'amd64', current: '3.0.11-1', available: '3.0.15-1', repository: 'bookworm-security', security: true, severity: null },
            { name: 'tzdata', arch: 'all', current: '2024a', available: '2024b', repository: 'bookworm-updates', security: false, severity: null }
        ],
        ...overrides
    };
}

const summary = (full: PatchScan) => {
    const { updates: _updates, held, patches, ...rest } = full;
    return { ...rest, held: held.length, patches: patches.length };
};

let calls: Array<{ method: string; path: string; body?: Record<string, unknown> }>;
let fleetRows: PatchFleetRow[];
let scans: Record<number, PatchScan>;
// Servers whose latest scan failed (GET /api/servers/:id/patch).
let scanErrors: Record<number, PatchScanError>;
let preview: PatchPreview;

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });
const sse = (events: unknown[]) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });

function jobInfo(overrides: Partial<MultiExecJobInfo> = {}): MultiExecJobInfo {
    return {
        id: 'job-9', command: '# ShellMind patch center: install security updates\nLC_ALL=C', masked: false, template: null, templateMasked: false, variables: null,
        secretVariables: [], snippet: null, timeoutSec: 3600, strategy: DEFAULT_STRATEGY, status: 'running', pause: null, stopReason: null, batch: 0, batches: 1,
        nextBatchAt: null, danger: null, rerunOf: null, createdAt: Date.now(), finishedAt: null, total: 2, counts: emptyCounts(), ...overrides
    };
}

function backend(input: RequestInfo | URL, init: RequestInit = {}): Response {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ method, path: url.pathname, body });
    let match: RegExpExecArray | null;
    if (url.pathname === '/api/servers') return json({ data: SERVERS });
    if (url.pathname === '/api/patch/fleet') return json({ data: { rows: fleetRows } });
    if (url.pathname === '/api/patch/scan' && method === 'POST') {
        const ids = (body?.serverIds as number[]) ?? [];
        const events: PatchScanEvent[] = ids.flatMap((id): PatchScanEvent[] => {
            if (id === 3) {
                const error = { code: 'AUTH_FAILED', message: 'Auth failed', at: 1 };
                fleetRows = fleetRows.map((entry) => (entry.serverId === id ? { ...entry, scanError: error } : entry));
                return [{ type: 'start', serverId: id }, { type: 'error', serverId: id, error }];
            }
            const result = scans[id] ?? scan(id);
            fleetRows = fleetRows.map((entry) => (entry.serverId === id ? { ...entry, scan: summary(result) } : entry));
            return [{ type: 'start', serverId: id }, { type: 'scan', serverId: id, scan: result }];
        });
        return sse([...events, { type: 'end' }]);
    }
    if ((match = /^\/api\/servers\/(\d+)\/patch$/.exec(url.pathname))) {
        const id = Number(match[1]);
        return json({ data: { scan: scans[id] ?? null, error: scanErrors[id] ?? null, jobId: null, scanning: false } });
    }
    if ((match = /^\/api\/servers\/(\d+)\/patch\/scan$/.exec(url.pathname))) return json({ data: scans[Number(match[1])] ?? scan(Number(match[1])) });
    if ((match = /^\/api\/servers\/(\d+)\/patch\/refresh$/.exec(url.pathname))) {
        return json({ error: 'Refreshing the package lists needs root or sudo without a password (sudo -n).', code: 'PATCH_PRIVILEGE', details: { output: 'sudo: a password is required' } }, 403);
    }
    if (url.pathname === '/api/patch/preview') return json({ data: { ...preview, options: { mode: body?.mode, refresh: body?.refresh, reboot: body?.reboot } } });
    if (url.pathname === '/api/patch/apply') {
        return json({ data: { job: jobInfo(), targets: preview.servers.filter((entry) => !entry.skip).map(({ serverId, name, host, type }) => ({ serverId, name, host, type })), skipped: [] } }, 201);
    }
    if ((match = /^\/api\/multiexec\/jobs\/([^/]+)\/events$/.exec(url.pathname))) {
        const job: MultiExecJob = { ...jobInfo({ id: match[1] }), servers: [] };
        return sse([{ type: 'snapshot', job }]);
    }
    return json({ error: 'unexpected' }, 500);
}

function renderCenter() {
    return render(<ToastProvider><PatchCenter onClose={vi.fn()} server={null} /></ToastProvider>);
}

beforeEach(() => {
    setLanguage('en');
    resetServersStore();
    resetPatchStore();
    useAppStore.setState(useAppStore.getInitialState(), true);
    useMultiExecStore.setState(useMultiExecStore.getInitialState(), true);
    calls = [];
    scans = { 1: scan(1), 2: scan(2, { total: 5, security: 0, privilege: 'sudo-password', updates: [] }) };
    scanErrors = {};
    fleetRows = [1, 2, 3].map((serverId) => ({ serverId, scan: null, scanError: null, fleet: null, jumpHostFor: serverId === 1 ? [2] : [], jobId: null, scanning: false }));
    preview = {
        options: { mode: 'security', refresh: false, reboot: false },
        servers: [
            { serverId: 1, name: 'web-1', host: '10.0.0.1', type: 'linux', manager: 'apt', privilege: 'sudo', skip: null, pending: 1, security: 1, rebootRequired: true, reboot: 'jump-host', jumpHostFor: [2], scannedAt: Date.now(), metadataAt: null },
            { serverId: 2, name: 'db-1', host: '10.0.0.2', type: 'linux', manager: 'apt', privilege: 'sudo', skip: null, pending: 3, security: 3, rebootRequired: true, reboot: 'if-required', jumpHostFor: [], scannedAt: Date.now(), metadataAt: null },
            { serverId: 3, name: 'win-1', host: '10.0.0.3', type: 'windows', manager: 'windows-update', privilege: 'admin', skip: 'windows', pending: 1, security: 1, rebootRequired: true, reboot: 'off', jumpHostFor: [], scannedAt: Date.now(), metadataAt: null }
        ],
        eligible: 2,
        totals: { pending: 4, security: 4 },
        rebootable: 1,
        commands: [{ manager: 'apt', commands: ['apt-get -y install --only-upgrade <the pending security updates>'] }],
        script: '# ShellMind patch center: install security updates\nLC_ALL=C\n'
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => backend(input, init)));
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

const rowOf = (name: string) => screen.getByRole('button', { name: `${name}: updates` }).closest('tr')!;

describe('patch center', () => {
    it('lists the SSH servers, scans them as a stream and shows what each one has', async () => {
        renderCenter();
        await screen.findByRole('button', { name: 'web-1: updates' });
        expect(screen.queryByRole('button', { name: 'bucket: updates' })).not.toBeInTheDocument();
        expect(within(rowOf('web-1')).getByText('Not scanned')).toBeInTheDocument();
        // UX-12: no manager is known yet, so nothing is claimed about it.
        expect(within(rowOf('web-1')).queryByText('This package manager does not say which updates fix security problems.')).toBeNull();
        expect(within(rowOf('web-1')).getAllByText('Unknown').length).toBeGreaterThan(0);

        fireEvent.click(screen.getByRole('button', { name: 'Scan all' }));
        await waitFor(() => expect(within(rowOf('web-1')).getByText('apt')).toBeInTheDocument());
        // In the table's order (most security updates first, then by name).
        expect(calls.find((call) => call.path === '/api/patch/scan')?.body).toEqual({ serverIds: [2, 1, 3] });
        expect(within(rowOf('db-1')).getByText('sudo asks for a password')).toBeInTheDocument();
        expect(within(rowOf('win-1')).getByText(/Auth failed|credentials/i)).toBeInTheDocument();
        // Scanning everything again leaves out the server whose login was refused.
        fireEvent.click(screen.getByRole('button', { name: 'Scan all' }));
        await waitFor(() => expect(calls.filter((call) => call.path === '/api/patch/scan')).toHaveLength(2));
        expect(calls.filter((call) => call.path === '/api/patch/scan')[1].body).toEqual({ serverIds: [1, 2] });
        // Filters by what the scans found.
        fireEvent.click(screen.getByRole('button', { name: /Security updates/ }));
        expect(screen.getByRole('button', { name: 'web-1: updates' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'db-1: updates' })).not.toBeInTheDocument();
    });

    it('opens a server’s updates beside the table, with what keeps it from being patched', async () => {
        fleetRows = fleetRows.map((entry) => ({ ...entry, scan: entry.serverId === 3 ? null : summary(scans[entry.serverId]) }));
        renderCenter();
        fireEvent.click(await screen.findByRole('button', { name: 'web-1: updates' }));
        const pane = await screen.findByRole('complementary', { name: 'Updates of web-1' });
        await within(pane).findByRole('table', { name: 'Pending updates' });
        expect(within(pane).getByText('openssl')).toBeInTheDocument();
        expect(within(pane).getByText(/Other servers are reached through this one \(db-1\)/)).toBeInTheDocument();
        expect(within(pane).getByRole('button', { name: /Install security updates/ })).toBeEnabled();

        fireEvent.click(screen.getByRole('button', { name: 'db-1: updates' }));
        const db = await screen.findByRole('complementary', { name: 'Updates of db-1' });
        expect(await within(db).findByText(/sudo asks this user for a password/)).toBeInTheDocument();
        expect(within(db).getByRole('button', { name: /Install all updates/ })).toBeDisabled();
        expect(within(db).getByRole('button', { name: 'Refresh package lists' })).toBeDisabled();
        fireEvent.click(within(db).getByRole('button', { name: 'Close the updates of db-1' }));
        expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
    });

    it('plans a run, asks for the number of servers typed, starts it and follows the job', async () => {
        fleetRows = fleetRows.map((entry) => ({ ...entry, scan: entry.serverId === 3 ? null : summary(scans[entry.serverId]) }));
        renderCenter();
        await screen.findByRole('button', { name: 'web-1: updates' });
        expect(screen.getByRole('button', { name: 'Patch selected (0)' })).toBeDisabled();
        fireEvent.click(screen.getByRole('checkbox', { name: 'Select every server shown' }));
        fireEvent.click(screen.getByRole('button', { name: 'Patch selected (3)' }));

        const dialog = await screen.findByRole('dialog', { name: 'Patch 3 servers' });
        // A fleet run starts with a canary that waits for approval.
        expect(within(dialog).getByRole('checkbox', { name: /Start with a canary/ })).toBeChecked();
        fireEvent.click(within(dialog).getByRole('checkbox', { name: /Reboot servers that need it/ }));
        fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));

        expect(await within(dialog).findByText('Install security updates on 2 of 3 servers.')).toBeInTheDocument();
        expect(calls.find((call) => call.path === '/api/patch/preview')?.body).toEqual({ serverIds: [1, 2, 3], mode: 'security', refresh: false, reboot: true });
        expect(within(dialog).getByText('Windows: listed only')).toBeInTheDocument();
        expect(within(dialog).getByText('Jump host: no reboot')).toBeInTheDocument();
        // A jump host is never rebooted, so only db-1 is named.
        expect(within(dialog).getByText('Already waiting for a reboot: db-1.')).toBeInTheDocument();

        const start = within(dialog).getByRole('button', { name: 'Start patching 2 servers' });
        expect(start).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Type 2 to confirm patching 2 servers'), { target: { value: '3' } });
        expect(start).toBeDisabled();
        fireEvent.change(within(dialog).getByLabelText('Type 2 to confirm patching 2 servers'), { target: { value: '2' } });
        expect(start).toBeEnabled();
        fireEvent.click(start);

        await waitFor(() => expect(calls.some((call) => call.path === '/api/patch/apply')).toBe(true));
        expect(calls.find((call) => call.path === '/api/patch/apply')?.body).toEqual({
            serverIds: [1, 2, 3], mode: 'security', refresh: false, reboot: true, confirm: 2, timeoutSec: 3600, rebootWaitSec: 600,
            strategy: { concurrency: 5, batch: null, pauseSec: 0, canary: { count: 1, onSuccess: 'pause' }, failureLimit: null }
        });
        // The run shows as the multi-exec job it is.
        expect(await screen.findByRole('button', { name: 'Back to the servers' })).toBeInTheDocument();
        await waitFor(() => expect(calls.some((call) => call.path === '/api/multiexec/jobs/job-9/events')).toBe(true));
        expect(await screen.findByRole('region', { name: 'Job' })).toBeInTheDocument();
    });

    // In StrictMode, as the app runs in development: state initializers run
    // twice, and the hand-off must survive the second run.
    const renderStrict = () => render(<StrictMode><ToastProvider><PatchCenter onClose={vi.fn()} server={null} /></ToastProvider></StrictMode>);

    it('opens on the server it was asked for', async () => {
        act(() => openPatchCenter(2));
        expect(useAppStore.getState().activeActionId).toBe('patch-center');
        renderStrict();
        expect(await screen.findByRole('complementary', { name: 'Updates of db-1' })).toBeInTheDocument();
        // Once: the next time it opens on the table.
        expect(pendingFocusServer()).toBeNull();
    });

    it('opens on a run to plan again (a patch job’s failed servers, from the multi-exec history)', async () => {
        act(() => openPatchRun({ serverIds: [1, 2], mode: 'all' }));
        renderStrict();
        const dialog = await screen.findByRole('dialog', { name: 'Patch 2 servers' });
        expect(within(dialog).getByRole('radio', { name: /All updates/ })).toBeChecked();
        // Above the patch center (after it in the page), with the focus, and first to close on Escape.
        expect(screen.getAllByRole('dialog').at(-1)).toBe(dialog);
        await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
        fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
        expect(screen.queryByRole('dialog', { name: 'Patch 2 servers' })).not.toBeInTheDocument();
        expect(screen.getByRole('dialog', { name: 'Patch center' })).toBeInTheDocument();
    });

    describe('in a narrow window, where a server’s updates cover the table', () => {
        let width: PropertyDescriptor | undefined;
        beforeEach(() => {
            width = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth');
            Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 900 });
        });
        afterEach(() => {
            if (width) Object.defineProperty(HTMLElement.prototype, 'clientWidth', width);
        });

        it('moves the focus into the pane, closes it first on Escape and gives the focus back to its row', async () => {
            fleetRows = fleetRows.map((entry) => ({ ...entry, scan: entry.serverId === 3 ? null : summary(scans[entry.serverId]) }));
            const onClose = vi.fn();
            render(<ToastProvider><PatchCenter onClose={onClose} server={null} /></ToastProvider>);
            const open = await screen.findByRole('button', { name: 'web-1: updates' });
            open.focus();
            fireEvent.click(open);
            const pane = await screen.findByRole('complementary', { name: 'Updates of web-1' });
            await waitFor(() => expect(document.activeElement).toBe(within(pane).getByRole('heading', { name: 'web-1' })));
            // The table behind is hidden from the keyboard and screen readers.
            expect(open.closest('[aria-hidden="true"]')).not.toBeNull();

            fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
            expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
            expect(onClose).not.toHaveBeenCalled();
            await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'web-1: updates' })));
            // With nothing covering the table, Escape closes the patch center.
            fireEvent.keyDown(document.activeElement!, { key: 'Escape' });
            expect(onClose).toHaveBeenCalledTimes(1);
        });

        it('gives the focus back to the row when the pane is closed with its button', async () => {
            fleetRows = fleetRows.map((entry) => ({ ...entry, scan: entry.serverId === 3 ? null : summary(scans[entry.serverId]) }));
            renderCenter();
            fireEvent.click(await screen.findByRole('button', { name: 'db-1: updates' }));
            const pane = await screen.findByRole('complementary', { name: 'Updates of db-1' });
            fireEvent.click(within(pane).getByRole('button', { name: 'Close the updates of db-1' }));
            await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'db-1: updates' })));
        });
    });

    it('keeps the time per server long enough for the reboot’s wait for SSH', async () => {
        preview = { ...preview, servers: [preview.servers[0]], eligible: 1 };
        render(<ToastProvider><ServerUpdates server={SERVERS[0]} layout="tab" /></ToastProvider>);
        fireEvent.click(await screen.findByRole('button', { name: /Install all updates/ }));
        const dialog = await screen.findByRole('dialog', { name: 'Patch web-1' });
        const timeout = within(dialog).getByRole('combobox', { name: /Time per server/ });
        fireEvent.click(timeout);
        fireEvent.click(screen.getByRole('option', { name: '15 min' }));
        expect(timeout).toHaveTextContent('15 min');

        fireEvent.click(within(dialog).getByRole('checkbox', { name: /Reboot servers that need it/ }));
        const wait = within(dialog).getByRole('combobox', { name: /Wait for SSH up to/ });
        fireEvent.click(wait);
        fireEvent.click(screen.getByRole('option', { name: '30 min' }));
        // 30 min of waiting + 5 min: only 60 min fits.
        expect(timeout).toHaveTextContent('60 min');
        expect(within(dialog).getByText('Updates, reboot and wait included: at least 35 min with this wait for SSH.')).toBeInTheDocument();
        fireEvent.click(timeout);
        expect(screen.getByRole('option', { name: '15 min' })).toHaveAttribute('aria-disabled', 'true');
        expect(screen.getByRole('option', { name: '30 min' })).toHaveAttribute('aria-disabled', 'true');
        fireEvent.keyDown(timeout, { key: 'Escape' });

        fireEvent.click(within(dialog).getByRole('button', { name: 'Review' }));
        fireEvent.click(await within(dialog).findByRole('button', { name: 'Start patching web-1' }));
        await waitFor(() => expect(calls.some((call) => call.path === '/api/patch/apply')).toBe(true));
        expect(calls.find((call) => call.path === '/api/patch/apply')?.body).toMatchObject({ reboot: true, timeoutSec: 3600, rebootWaitSec: 1800 });
    });
});

describe('the palette entry for the active server', () => {
    it('hands over to the patch center, opened on that server', () => {
        const onClose = vi.fn();
        const Component = patchServerAction.Component;
        render(<Component onClose={onClose} server={SERVERS[1]} />);
        expect(onClose).toHaveBeenCalledTimes(1);
        expect(useAppStore.getState().activeActionId).toBe('patch-center');
        expect(pendingFocusServer()).toBe(2);
        clearPatchHandoff();
        expect(pendingFocusServer()).toBeNull();
    });
});

describe('server updates (Operations tab)', () => {
    it('reads a server never scanned at once, and explains a refresh it may not do', async () => {
        scans = {};
        render(<ToastProvider><ServerUpdates server={SERVERS[0]} layout="tab" onOpenCenter={vi.fn()} /></ToastProvider>);
        expect(await screen.findByText('openssl')).toBeInTheDocument();
        expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers/1/patch/scan')).toBe(true);
        fireEvent.click(screen.getByRole('button', { name: 'Refresh package lists' }));
        expect(await screen.findByText('Refreshing the package lists needs root or sudo without a password (sudo -n).')).toBeInTheDocument();
        expect(screen.getByText('sudo: a password is required')).toBeInTheDocument();
    });

    it('says why when the only scan of a server failed, and scans it again', async () => {
        scans = {};
        scanErrors = { 2: { code: 'PATCH_SCAN_FAILED', message: 'Could not read the server\'s updates: The update check was cut off before it finished.', at: 1 } };
        render(<ToastProvider><ServerUpdates server={SERVERS[1]} layout="tab" /></ToastProvider>);
        expect(await screen.findByText('The scan failed')).toBeInTheDocument();
        expect(screen.getByText('The server’s updates could not be read.')).toBeInTheDocument();
        expect(screen.getByText(/The update check was cut off before it finished\./)).toBeInTheDocument();
        expect(screen.queryByText('Not scanned yet')).not.toBeInTheDocument();
        // Not scanned again on its own (the failure stays on screen)...
        expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers/2/patch/scan')).toBe(false);
        // ...but on request.
        fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
        await waitFor(() => expect(calls.some((call) => call.method === 'POST' && call.path === '/api/servers/2/patch/scan')).toBe(true));
        expect(await screen.findByText('openssl')).toBeInTheDocument();
    });

    it('lists Windows updates without install actions', async () => {
        scans = { 3: scan(3, { platform: 'windows', manager: 'windows-update', privilege: 'admin', updates: [{ name: '2026-09 Security Update (KB5122871)', arch: null, current: null, available: 'KB5122871', repository: 'Security Updates', security: true, severity: 'Critical' }], total: 1, security: 1, rebootRequired: true }) };
        render(<ToastProvider><ServerUpdates server={SERVERS[2]} layout="pane" onClose={vi.fn()} /></ToastProvider>);
        expect(await screen.findByText('2026-09 Security Update (KB5122871)')).toBeInTheDocument();
        expect(screen.getByText('Critical')).toBeInTheDocument();
        expect(screen.getByText(/ShellMind does not install them/)).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /Install/ })).not.toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Search Windows Update' })).toBeEnabled();
        expect(screen.queryByRole('columnheader', { name: 'Installed' })).not.toBeInTheDocument();
    });
});
