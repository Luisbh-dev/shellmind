import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { CleanupPreview, DeletedOpenResult, DirectoryListing, DiskActionResult, DiskOverview, LargeFilesResult } from '@shared/disk';
import { ConfirmProvider } from '@/components/ui';
import { ToastProvider } from '@/components/ui/Toast';
import { languageReady, setLanguage, t } from '@/i18n';
import { describeOpsError } from '@/features/ops/errors';
import { ApiError } from '@/lib/api';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import DiskToolkit from './DiskToolkit';
import { DISK_ACTION_ID, openDiskView, useDiskTarget } from '@/store/diskView';

// W8-T4 disk view: opened on a filesystem (or the fullest one), the
// explorer, the largest files, deleted files still open and the cleanups.
// Requests name paths, mounts, cleanups and processes only.

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const ROOT = { mount: '/', device: '/dev/sda1', fsType: 'ext4', totalBytes: 40 * GiB, usedBytes: 20 * GiB, freeBytes: 18 * GiB, usagePercent: 52.6, inodes: { total: 2_000_000, used: 400_000, free: 1_600_000, usagePercent: 20 }, readOnly: false };
const DATA = { mount: '/data', device: '/dev/sdb1', fsType: 'ext4', totalBytes: 400 * MiB, usedBytes: 350 * MiB, freeBytes: 0, usagePercent: 100, inodes: { total: 102_400, used: 22, free: 102_378, usagePercent: 0 }, readOnly: false };

let overview: DiskOverview;

const listing = (path: string, entries: DirectoryListing['entries'], extra: Partial<DirectoryListing> = {}): DirectoryListing => ({
    path, mount: path.startsWith('/data') ? '/data' : '/', totalBytes: entries.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), entries, omitted: null,
    denied: 0, timedOut: false, budgetSeconds: 60, elevated: true, collectedAt: Date.now(), cached: false, durationMs: 120, ...extra,
});

const LISTINGS: Record<string, DirectoryListing> = {
    '/data': listing('/data', [
        { name: 'postgres', path: '/data/postgres', bytes: 150 * MiB, kind: 'dir' },
        { name: 'backups', path: '/data/backups', bytes: 100 * MiB, kind: 'dir' },
        { name: 'notes.txt', path: '/data/notes.txt', bytes: 2 * MiB, kind: 'file' },
    ]),
    '/data/postgres': listing('/data/postgres', [{ name: 'base', path: '/data/postgres/base', bytes: 150 * MiB, kind: 'dir' }]),
    '/': listing('/', [
        { name: 'var', path: '/var', bytes: 12 * GiB, kind: 'dir' },
        { name: 'data', path: '/data', bytes: 4096, kind: 'dir', otherFs: true },
    ], { timedOut: true, totalBytes: null }),
};

const LARGE: LargeFilesResult = {
    mount: '/data', minMB: 100, files: [{ path: '/data/backups/db.sql.gz', bytes: 100 * MiB, modifiedAt: Date.UTC(2026, 9, 1), owner: 'postgres' }],
    timedOut: false, denied: 0, elevated: true, collectedAt: Date.now(), cached: false, durationMs: 900,
};

const DELETED: DeletedOpenResult = {
    mount: '/data', totalBytes: 20 * MiB, source: 'lsof', partial: false, elevated: true, collectedAt: Date.now(),
    files: [{ pid: 812, fd: 5, process: 'nginx', user: 'www-data', path: '/data/logs/access.log', bytes: 20 * MiB, inode: '1311', started: '4242', unit: 'nginx.service', container: null }],
};
// What the server answers now (a test may change it).
let deletedNow: DeletedOpenResult = DELETED;

const preview = (id: CleanupPreview['id'], extra: Partial<CleanupPreview> = {}): CleanupPreview => ({
    id, status: 'ready', bytes: 16 * MiB, estimate: 'about', count: 3, items: [], mounts: ['/'], command: `sudo -n ${id}`, params: {}, ...extra,
});

const CLEANUPS: CleanupPreview[] = [
    preview('journal', { status: 'nothing', bytes: 0, count: 0, params: { keepMB: 200, keepDays: 0 }, command: 'sudo -n journalctl --vacuum-size=200M' }),
    preview('rotated-logs', { mounts: ['/data'], params: { days: 7 }, items: [{ label: '/data/logs/app.log.1', bytes: 10 * MiB, modifiedAt: Date.UTC(2026, 9, 5) }] }),
    preview('package-cache', { bytes: 24 * MiB, count: null, estimate: 'up-to' }),
    preview('tmp', { status: 'unavailable', reason: { code: 'NOT_ELEVATED', message: 'needs root' }, params: { days: 10 } }),
    preview('core-dumps', { status: 'nothing', bytes: 0, count: 0, mounts: [], params: { days: 0 } }),
];

const RESULT: DiskActionResult = { ok: true, command: 'sudo -n find /var/log ...', output: '3 files removed', freedBytes: 16 * MiB, reportedBytes: null, mounts: [{ mount: '/data', freeBefore: 0, freeAfter: 16 * MiB }] };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

function route(url: string, init?: RequestInit): Response {
    const { pathname: path, searchParams } = new URL(url);
    const method = init?.method ?? 'GET';
    if (path === '/api/servers/7/disk') return json(overview);
    if (path === '/api/servers/7/disk/usage') return json(LISTINGS[searchParams.get('path') ?? ''] ?? listing(searchParams.get('path') ?? '/', []));
    if (path === '/api/servers/7/disk/large-files') return json({ ...LARGE, minMB: Number(searchParams.get('minMB')) });
    if (path === '/api/servers/7/disk/deleted') return json(deletedNow);
    if (path === '/api/servers/7/disk/deleted/release' && method === 'POST') return json({ ...RESULT, command: ': > /proc/812/fd/5', mounts: [{ mount: '/data', freeBefore: 0, freeAfter: 20 * MiB }], freedBytes: 20 * MiB });
    if (path === '/api/servers/7/disk/cleanups') return json({ cleanups: CLEANUPS });
    if (path === '/api/servers/7/disk/cleanups/rotated-logs' && method === 'GET') {
        const days = Number(searchParams.get('days'));
        // (The second preview comes from a server whose find has no -delete.)
        return json(preview('rotated-logs', { mounts: ['/data'], params: { days }, count: days === 30 ? 1 : 3, items: [{ label: '/data/logs/app.log.1', bytes: 10 * MiB, modifiedAt: Date.UTC(2026, 9, 5) }], facts: { removal: days === 30 ? 'rm' : 'delete' } }));
    }
    if (path === '/api/servers/7/disk/cleanups/rotated-logs' && method === 'POST') return json(RESULT);
    return json({ error: `unexpected ${method} ${path}` }, 404);
}

const calls = (method: string, pattern: RegExp) => fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && pattern.test(decodeURIComponent(String(url))));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body ?? '{}')) as unknown;

const server: WorkspaceServer = { id: 7, name: 'web-prod', ip: '10.0.0.7', type: 'linux' };

function renderView(target = server, onClose = vi.fn()) {
    render(<ToastProvider><ConfirmProvider><DiskToolkit server={target} onClose={onClose} /></ConfirmProvider></ToastProvider>);
    return onClose;
}

beforeEach(() => {
    setLanguage('en');
    overview = { access: { platform: 'linux', user: 'ops', root: false, sudo: true, elevated: true }, mounts: [ROOT, DATA], collectedAt: Date.now() };
    deletedNow = DELETED;
    useAppStore.setState(useAppStore.getInitialState(), true);
    useDiskTarget.setState({ target: null });
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(url, init));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('opening the disk view', () => {
    it('opens on the filesystem and the part the Status page asked for, once', async () => {
        openDiskView(7, '/', 'cleanup');
        expect(useAppStore.getState().activeActionId).toBe(DISK_ACTION_ID);
        renderView();
        expect(await screen.findByRole('combobox', { name: 'Filesystem' })).toHaveTextContent('/ · 52.6% used');
        expect(screen.getByRole('tab', { name: 'Clean up' })).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(useDiskTarget.getState().target).toBeNull());
    });

    it('opens on the fullest filesystem from the palette, with its usage and the access', async () => {
        renderView();
        const summary = await screen.findByRole('region', { name: 'Usage of /data' });
        expect(within(summary).getByRole('meter', { name: 'Space used on /data' })).toHaveAttribute('aria-valuenow', '100');
        expect(within(summary).getByText('Critical')).toBeInTheDocument();
        expect(within(summary).getByText('sudo -n')).toBeInTheDocument();
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Usage', 'Largest files', 'Deleted but open', 'Clean up']);
    });

    it('says who it runs as when it cannot read everything, and offers no deleted files on Windows', async () => {
        overview = { access: { platform: 'windows', user: 'ops', root: false, sudo: false, elevated: false }, mounts: [{ ...ROOT, mount: 'C:\\', device: 'C:', fsType: 'NTFS', inodes: null }], collectedAt: Date.now() };
        renderView({ ...server, type: 'windows' });
        expect(await screen.findByText('Limited: ops')).toBeInTheDocument();
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Usage', 'Largest files', 'Clean up']);
        // NTFS has no inode table to speak of: no inode reading at all.
        expect(screen.queryByText('Inodes')).toBeNull();
        expect(screen.queryByText('No fixed inode table on this filesystem.')).toBeNull();
    });

    it('opens the Windows drive a Status row names ("D:"), not the fullest one', async () => {
        const drive = (letter: string, usagePercent: number) => ({ ...ROOT, mount: `${letter}:\\`, device: `${letter}:`, fsType: 'NTFS', usagePercent, inodes: null });
        overview = { access: { platform: 'windows', user: 'ops', root: true, sudo: false, elevated: true }, mounts: [drive('C', 93), drive('D', 41)], collectedAt: Date.now() };
        openDiskView(7, 'D:');
        renderView({ ...server, type: 'windows' });
        expect(await screen.findByRole('combobox', { name: 'Filesystem' })).toHaveTextContent('D:\\ · 41% used');
        await screen.findByRole('region', { name: 'Usage of D:\\' });
        await waitFor(() => expect(calls('GET', /\/disk\/usage\?path=D:\\&budget=60$/)).toHaveLength(1));
        fireEvent.click(screen.getByRole('button', { name: 'Why is this disk full?' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ attachment: { kind: 'disk', mount: 'D:\\' } });
    });

    it('asks the AI why the filesystem is full, then gives the screen to the chat', async () => {
        const onClose = renderView();
        fireEvent.click(await screen.findByRole('button', { name: 'Why is this disk full?' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ serverId: 7, kind: 'context', attachment: { kind: 'disk', mount: '/data' } });
        expect(useAppStore.getState().chatRequest).toMatchObject({ prompt: expect.stringContaining('/data') });
        expect(onClose).toHaveBeenCalled();
    });
});

describe('the explorer', () => {
    it('lists a folder largest first and drills down and back up', async () => {
        renderView();
        const list = await screen.findByRole('list', { name: 'Contents of /data, largest first' });
        expect(within(list).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
            expect.stringMatching(/^postgres150 MB59\.5%/), expect.stringMatching(/^backups100 MB39\.7%/), expect.stringMatching(/^notes\.txt2 MB/),
        ]);
        // UX-15: the name starts with what the row shows (voice control).
        fireEvent.click(within(list).getByRole('button', { name: 'postgres, 150 MB, 59.5% (open)' }));
        await screen.findByRole('list', { name: 'Contents of /data/postgres, largest first' });
        await waitFor(() => expect(screen.getByRole('heading', { name: 'postgres' })).toHaveFocus());
        fireEvent.click(within(screen.getByRole('navigation', { name: 'Folder' })).getByRole('button', { name: '/data' }));
        await screen.findByRole('list', { name: 'Contents of /data, largest first' });
        expect(calls('GET', /\/disk\/usage\?path=\/data\/postgres&budget=60$/)).toHaveLength(1);
    });

    it('points to deleted files when the files add up to less than the filesystem uses', async () => {
        renderView();
        // 252 MB in files, 350 MB used.
        expect(await screen.findByText(/add up to 252 MB, but the filesystem reports 350 MB used: 98 MB/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Check deleted files' }));
        expect(screen.getByRole('tab', { name: 'Deleted but open' })).toHaveAttribute('aria-selected', 'true');
        expect(await screen.findByText('/data/logs/access.log')).toBeInTheDocument();
    });

    it('scans longer when the time budget ran out, and moves to another filesystem', async () => {
        openDiskView(7, '/');
        renderView();
        expect(await screen.findByText(/The scan stopped after 60 s/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Scan for up to 3 min' }));
        await waitFor(() => expect(calls('GET', /\/disk\/usage\?path=\/&budget=180&rescan=1$/)).toHaveLength(1));
        fireEvent.click(await screen.findByRole('button', { name: 'Explore the filesystem mounted at /data' }));
        expect(await screen.findByRole('combobox', { name: 'Filesystem' })).toHaveTextContent('/data · 100% used');
    });
});

describe('largest files', () => {
    it('searches above a threshold and shows a file\'s folder in the explorer', async () => {
        renderView();
        fireEvent.click(await screen.findByRole('tab', { name: 'Largest files' }));
        expect(await screen.findByText('/data/backups/db.sql.gz')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('radio', { name: '500 MB' }));
        await waitFor(() => expect(calls('GET', /\/large-files\?mount=\/data&minMB=500$/)).toHaveLength(1));
        fireEvent.click(await screen.findByRole('button', { name: 'Show the folder of /data/backups/db.sql.gz in Usage' }));
        expect(screen.getByRole('tab', { name: 'Usage' })).toHaveAttribute('aria-selected', 'true');
        await waitFor(() => expect(calls('GET', /\/disk\/usage\?path=\/data\/backups&budget=60$/)).toHaveLength(1));
    });
});

describe('deleted files still open', () => {
    it('restarts the unit or empties the file after a confirmation', async () => {
        renderView();
        fireEvent.click(await screen.findByRole('tab', { name: 'Deleted but open' }));
        expect(await screen.findByText('nginx.service')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Free the space of /data/logs/access.log' }));
        expect(screen.getByRole('menuitem', { name: 'Restart nginx.service' })).toBeInTheDocument();
        fireEvent.click(screen.getByRole('menuitem', { name: 'Empty the file now (truncate)' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Empty /data/logs/access.log?' });
        expect(dialog).toHaveTextContent('nginx (pid 812) keeps running');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Empty the file' }));
        await waitFor(() => expect(calls('POST', /\/disk\/deleted\/release$/)).toHaveLength(1));
        // With what names the process and the file of the row (SEC-3).
        expect(bodyOf(calls('POST', /\/disk\/deleted\/release$/)[0])).toEqual({ action: 'truncate', mount: '/data', pid: 812, process: 'nginx', fd: 5, inode: '1311', started: '4242' });
        // The summary is read again (its free space changed).
        await waitFor(() => expect(calls('GET', /\/api\/servers\/7\/disk$/).length).toBeGreaterThanOrEqual(2));
    });

    it('needs elevation to touch other users\' processes', async () => {
        overview = { ...overview, access: { ...overview.access, sudo: false, elevated: false } };
        renderView();
        fireEvent.click(await screen.findByRole('tab', { name: 'Deleted but open' }));
        expect(await screen.findByText(/Only the processes of the login user could be checked/)).toBeInTheDocument();
        fireEvent.click(await screen.findByRole('button', { name: 'Free the space of /data/logs/access.log' }));
        expect(screen.getByRole('menuitem', { name: /^Empty the file now \(truncate\)/ })).toBeDisabled();
        expect(screen.getByRole('menuitem', { name: /^Restart nginx\.service/ })).toHaveTextContent('needs root');
    });

    it('does not call it clean when only the login user\'s processes were checked', async () => {
        overview = { ...overview, access: { ...overview.access, sudo: false, elevated: false } };
        deletedNow = { ...DELETED, files: [], totalBytes: 0, partial: true, elevated: false };
        renderView();
        fireEvent.click(await screen.findByRole('tab', { name: 'Deleted but open' }));
        expect(await screen.findByText('No deleted file is held open by the processes of ops on /data.')).toBeInTheDocument();
        expect(screen.getByText(/The processes of other users could not be checked\./)).toBeInTheDocument();
        expect(screen.queryByText(/No deleted file is holding space/)).toBeNull();
    });

    it('runs one release at a time', async () => {
        let finish: (response: Response) => void = () => {};
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => (
            String(url).endsWith('/deleted/release') ? new Promise<Response>((resolve) => { finish = resolve; }) : route(url, init)
        ));
        renderView();
        fireEvent.click(await screen.findByRole('tab', { name: 'Deleted but open' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Free the space of /data/logs/access.log' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Restart nginx.service' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Restart nginx.service?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Restart nginx.service' }));
        await waitFor(() => expect(calls('POST', /\/disk\/deleted\/release$/)).toHaveLength(1));

        fireEvent.click(screen.getByRole('button', { name: 'Free the space of /data/logs/access.log' }));
        const restart = screen.getByRole('menuitem', { name: /^Restart nginx\.service/ });
        expect(restart).toBeDisabled();
        expect(restart).toHaveTextContent('another action is running');
        expect(screen.getByRole('menuitem', { name: /^Stop nginx \(SIGTERM\)/ })).toBeDisabled();
        finish(json(RESULT));
        await waitFor(() => expect(calls('GET', /\/disk\/deleted\?mount=\/data$/).length).toBeGreaterThanOrEqual(2));
    });
});

describe('cleanups', () => {
    it('lists what would free space here first, and why one cannot run', async () => {
        openDiskView(7, '/data', 'cleanup');
        renderView();
        const list = await screen.findByRole('list', { name: 'Cleanups' });
        const titles = within(list).getAllByRole('heading').map((heading) => heading.textContent);
        expect(titles[0]).toBe('Old rotated logs');
        expect(screen.getByText('About 16 MB could be freed on /data.')).toBeInTheDocument();
        const tmp = within(list).getAllByRole('listitem').find((item) => item.textContent?.includes('Old temporary files'))!;
        expect(tmp).toHaveTextContent('Needs root or passwordless sudo');
        expect(within(tmp).getByRole('button', { name: 'Review…' })).toBeDisabled();
        // No filesystem to name: the parameters stand alone.
        const cores = within(list).getAllByRole('listitem').find((item) => item.textContent?.includes('Core dumps'))!;
        expect(cores).toHaveTextContent('of any age');
        expect(cores.textContent).not.toContain('·');
    });

    it('words the toolkit\'s own error codes in the UI language', async () => {
        setLanguage('es');
        await languageReady();
        const nothing = new ApiError(409, 'There is nothing to clean up right now.', { error: 'There is nothing to clean up right now.', code: 'DISK_NOTHING_TO_CLEAN' });
        expect(describeOpsError(nothing, t)).toEqual({ title: 'Ahora mismo no hay nada que limpiar.', detail: null, code: 'DISK_NOTHING_TO_CLEAN' });
        const unknown = new ApiError(404, '/proc is not on /: it is on another filesystem.', { error: '/proc is not on /: it is on another filesystem.', code: 'DISK_UNKNOWN_MOUNT' });
        expect(describeOpsError(unknown, t)).toMatchObject({ title: 'No está en un sistema de archivos local de este servidor.', detail: '/proc is not on /: it is on another filesystem.' });
    });

    it('previews with the chosen parameters, runs after the confirmation and shows the space freed', async () => {
        openDiskView(7, '/data', 'cleanup');
        renderView();
        const list = await screen.findByRole('list', { name: 'Cleanups' });
        const card = within(list).getAllByRole('listitem').find((item) => item.textContent?.includes('Old rotated logs'))!;
        fireEvent.click(within(card).getByRole('button', { name: 'Review…' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Old rotated logs' });
        expect(await within(dialog).findByText('Removes 3 items')).toBeInTheDocument();
        expect(within(dialog).getByText('/data/logs/app.log.1')).toBeInTheDocument();
        const byPath = 'The find of this server has no -delete: each file goes to rm by its full path.';
        expect(within(dialog).queryByText(byPath)).toBeNull();

        fireEvent.click(within(dialog).getByRole('combobox', { name: 'Only files older than' }));
        fireEvent.click(await screen.findByRole('option', { name: '30 days' }));
        expect(await within(dialog).findByText('Removes 1 item')).toBeInTheDocument();
        expect(within(dialog).getByText(byPath)).toBeInTheDocument();
        expect(calls('GET', /\/cleanups\/rotated-logs\?days=30$/)).toHaveLength(1);

        fireEvent.click(within(dialog).getByRole('button', { name: /^Clean up · 16 MB/ }));
        const result = await screen.findByRole('dialog', { name: 'Old rotated logs: done' });
        expect(bodyOf(calls('POST', /\/cleanups\/rotated-logs$/)[0])).toEqual({ days: 30 });
        expect(result).toHaveTextContent('16 MB');
        expect(within(result).getByRole('table', { name: 'Free space before and after' })).toHaveTextContent('/data0 B free16 MB free');
        // The overview and the summary are measured again.
        await waitFor(() => expect(calls('GET', /\/disk\/cleanups$/).length).toBeGreaterThanOrEqual(2));
    });
});
