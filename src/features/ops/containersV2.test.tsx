import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ComposeOverview, ContainerInspectSummary, ContainerList, ImageList, OpsCapabilities, PrunePreview } from '@shared/ops';
import { ConfirmProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import OperationsPanel from './OperationsPanel';

// W7-S3 in the Operations tab: the view registry, the container detail
// (masked environment, shells, Ask AI), Compose projects and images.

vi.mock('./LogsView', () => ({
    LogsView: ({ request }: { request: { source: unknown } | null }) => <div data-testid="logs-view">{JSON.stringify(request?.source ?? null)}</div>,
}));

const CAPS: OpsCapabilities = {
    platform: 'linux', root: false, sudo: true, systemd: true, journal: true,
    containers: { engine: 'docker', version: '26.1.4', sudo: true, compose: true, problem: null },
    detectedAt: 0,
};

const web = { id: 'aaaaaaaaaaaa1', name: 'shop-web-1', image: 'nginx:1.25', state: 'running', status: 'Up 3 days (healthy)', ports: '0.0.0.0:8080->80/tcp', createdAt: null, composeProject: 'shop', composeService: 'web' };
const db = { id: 'bbbbbbbbbbbb2', name: 'shop-db-1', image: 'postgres:16', state: 'exited', status: 'Exited (1) 1 hour ago', ports: '', createdAt: null, composeProject: 'shop', composeService: 'db' };
const CONTAINERS: ContainerList = { engine: 'docker', projects: [{ name: 'shop', status: 'running(1), exited(1)', configFiles: '/srv/shop/compose.yaml' }], containers: [web, db] };

const SUMMARY: ContainerInspectSummary = {
    id: 'aaaaaaaaaaaa1', name: 'shop-web-1', image: 'nginx:1.25', imageId: null, created: '2026-10-24T15:18:17Z',
    state: { status: 'running', running: true, exitCode: 0, oomKilled: false, error: null, startedAt: '2026-10-24T15:18:19Z', finishedAt: null, pid: 42 },
    restartPolicy: 'unless-stopped', restartCount: 0, command: 'nginx -g daemon off;', workingDir: null, user: null,
    env: [{ name: 'DB_PASSWORD', value: 'hunter2' }, { name: 'MODE', value: 'prod' }],
    mounts: [{ type: 'volume', name: 'uploads', source: '/var/lib/docker/volumes/uploads/_data', destination: '/srv/uploads', readOnly: false }],
    ports: [{ port: '80/tcp', hostIp: '0.0.0.0', hostPort: '8080' }],
    networkMode: 'shop_default',
    networks: [{ name: 'shop_default', ipAddress: '172.19.0.3', gateway: '172.19.0.1', macAddress: null, aliases: ['web'] }],
    health: { status: 'healthy', failingStreak: 0, log: [] },
    compose: { project: 'shop', service: 'web', workingDir: '/srv/shop', configFiles: ['/srv/shop/compose.yaml'] },
};

const OVERVIEW: ComposeOverview = {
    engine: 'docker', tool: 'docker compose', problem: null,
    projects: [
        { name: 'shop', workingDir: '/srv/shop', configFiles: ['/srv/shop/compose.yaml'], missingFiles: [], containers: [db, web], running: 1, actionable: true },
        { name: 'legacy', workingDir: '/srv/legacy', configFiles: ['/srv/legacy/docker-compose.yml'], missingFiles: ['/srv/legacy/docker-compose.yml'], containers: [], running: 0, actionable: true },
        // A label no Compose wrote: listed, nothing runs for it.
        { name: 'bad;id', workingDir: null, configFiles: [], missingFiles: [], containers: [{ ...web, id: 'cccccccccccc3', name: 'odd-1', composeProject: 'bad;id' }], running: 1, actionable: false },
    ],
};

const ID = (n: number) => `sha256:${String(n).repeat(64)}`;
const IMAGES: ImageList = {
    engine: 'docker',
    images: [
        { id: ID(2), repository: null, tag: null, reference: null, size: 12_000_000, createdAt: '2026-08-01 10:00:00 +0000 UTC', createdSince: '3 months ago', containers: 0, dangling: true },
        { id: ID(1), repository: 'nginx', tag: '1.25', reference: 'nginx:1.25', size: 187_000_000, createdAt: '2026-09-01 10:00:00 +0000 UTC', createdSince: '7 weeks ago', containers: 1, dangling: false },
    ],
};
const PREVIEW: PrunePreview = { mode: 'dangling', images: [IMAGES.images[0]], bytes: 12_000_000, estimate: 'at-least' };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let caps: OpsCapabilities;
let fetchMock: ReturnType<typeof vi.fn>;

function route(url: string, init?: RequestInit): Response {
    const { pathname: path, search } = new URL(url);
    const method = init?.method ?? 'GET';
    if (path.endsWith('/ops/capabilities')) return json(caps);
    if (path.endsWith('/ops/services')) return json({ services: [] });
    if (path.endsWith('/ops/containers')) return json(CONTAINERS);
    if (path.endsWith('/ops/containers/shop-web-1')) {
        // Podman repeats the environment in CreateCommand.
        const config = { Env: ['DB_PASSWORD=hunter2', 'MODE=prod'], CreateCommand: ['podman', 'run', '-e', 'DB_PASSWORD=hunter2', '--env=API_KEY=k3y-v4lue', 'nginx:1.25'] };
        return json({ inspect: { Id: 'aaaaaaaaaaaa1', Config: config }, summary: SUMMARY });
    }
    if (path.endsWith('/ops/containers/shop-web-1/stats')) return json({ stats: { id: 'aaaaaaaaaaaa1', name: 'shop-web-1', cpuPercent: 1.5, memoryPercent: 2, memoryUsage: '40MiB / 2GiB', netIO: '1kB / 2kB', blockIO: '0B / 0B', pids: 3 } });
    if (path.endsWith('/ops/compose') && method === 'GET') return json(OVERVIEW);
    if (method === 'POST' && /\/ops\/compose\/shop\/(down|restart)$/.test(path)) return json({ ok: true, command: "sudo -n docker 'compose' '-p' 'shop' 'down'", output: ' Container shop-web-1  Removed' });
    if (path.endsWith('/ops/images') && method === 'GET') return json(IMAGES);
    if (path.endsWith('/ops/disk-usage')) return json({ rows: [{ kind: 'images', count: 2, active: 1, size: 199_000_000, reclaimable: 12_000_000 }], uniqueSizes: {} });
    if (path.endsWith('/ops/images/prune-preview') && search === '?mode=dangling') return json(PREVIEW);
    if (method === 'POST' && path.endsWith('/ops/images/prune')) return json({ ok: true, command: "sudo -n docker 'image' 'prune' '-f'", output: '', reclaimedBytes: 12_000_000 });
    return json({ error: `unexpected ${method} ${path}` }, 404);
}

const server: WorkspaceServer = { id: 7, name: 'docker-host', ip: '10.0.0.7', type: 'linux' };

function renderPanel() {
    return render(<ConfirmProvider><OperationsPanel server={server} isActive /></ConfirmProvider>);
}

const calls = (method: string, pattern: RegExp) => fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && pattern.test(String(url)));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body ?? '{}')) as unknown;

async function openView(name: string) {
    fireEvent.click(await screen.findByRole('tab', { name }));
}

beforeEach(() => {
    setLanguage('en');
    caps = CAPS;
    useAppStore.setState(useAppStore.getInitialState(), true);
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(url, init));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('operations views', () => {
    it('lists Compose and Images where a container engine runs on Linux', async () => {
        renderPanel();
        await screen.findByText('This server does not use systemd').catch(() => undefined);
        await waitFor(() => expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Services', 'Containers', 'Compose', 'Images', 'Updates', 'Logs']));
    });

    it('leaves them out without an engine or on Windows', async () => {
        caps = { ...CAPS, containers: { ...CAPS.containers, engine: null, problem: 'Docker is not installed.' } };
        renderPanel();
        await waitFor(() => expect(calls('GET', /\/ops\/services$/)).toHaveLength(1));
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Services', 'Containers', 'Updates', 'Logs']);
    });
});

describe('container detail', () => {
    it('masks environment values until revealed, also in the inspect output', async () => {
        renderPanel();
        await openView('Containers');
        fireEvent.click(await screen.findByRole('button', { name: /^shop-web-1/ }));
        const detail = await screen.findByRole('region', { name: 'Container shop-web-1' });
        expect(await within(detail).findByText('unless-stopped')).toBeInTheDocument();
        expect(within(detail).getByText('*:8080')).toBeInTheDocument();
        await waitFor(() => expect(within(detail).getByText('40 MiB / 2 GiB')).toBeInTheDocument());

        fireEvent.click(within(detail).getByText('Environment'));
        expect(within(detail).getByText('DB_PASSWORD')).toBeInTheDocument();
        expect(detail).not.toHaveTextContent('hunter2');
        fireEvent.click(within(detail).getByRole('button', { name: 'Show the value of DB_PASSWORD' }));
        expect(within(detail).getByText('hunter2')).toBeInTheDocument();
        expect(within(detail).getByRole('button', { name: 'Hide the value of DB_PASSWORD' })).toHaveAttribute('aria-pressed', 'true');
        expect(detail).not.toHaveTextContent('prod');

        fireEvent.click(within(detail).getByText('Inspect output'));
        const raw = within(detail).getByText(/"Config"/);
        expect(raw).toHaveTextContent('DB_PASSWORD=••••••••');
        expect(raw).toHaveTextContent('--env=API_KEY=••••••••');
        expect(raw).not.toHaveTextContent('MODE=prod');
        expect(raw).not.toHaveTextContent('hunter2');
        expect(raw).not.toHaveTextContent('k3y-v4lue');
        fireEvent.click(within(detail).getByRole('button', { name: 'Show values' }));
        expect(within(detail).getByText(/"Config"/)).toHaveTextContent('MODE=prod');
        expect(within(detail).getByText(/"Config"/)).toHaveTextContent('--env=API_KEY=k3y-v4lue');
    });

    it('names the engine states in the user\'s language', async () => {
        setLanguage('es');
        renderPanel();
        fireEvent.click(await screen.findByRole('tab', { name: 'Contenedores' }));
        const table = await screen.findByRole('table');
        expect(within(table).getByText('en marcha')).toBeInTheDocument();
        expect(within(table).getByText('finalizado')).toBeInTheDocument();
        expect(within(table).queryByText('running')).toBeNull();
        expect(screen.getByRole('group', { name: 'Proyectos de Compose' })).toHaveTextContent('shopen marcha (1), finalizado (1)');
    });

    it('opens a shell in the container as a terminal tab of the server', async () => {
        renderPanel();
        await openView('Containers');
        fireEvent.click(await screen.findByRole('button', { name: /^shop-web-1/ }));
        const detail = await screen.findByRole('region', { name: 'Container shop-web-1' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Open shell' }));
        const state = useAppStore.getState();
        expect(state.terminalSessions[7].sessions.map((session) => session.attach)).toEqual([{ kind: 'container', engine: 'docker', container: 'shop-web-1' }]);
        expect(state.serverTabRequest).toMatchObject({ serverId: 7, tabId: 'terminal' });

        fireEvent.click(within(detail).getByRole('button', { name: 'Choose the shell' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Open bash' }));
        expect(useAppStore.getState().terminalSessions[7].sessions[1].attach).toEqual({ kind: 'container', engine: 'docker', container: 'shop-web-1', shell: 'bash' });
    });

    it('explains why a stopped container has no shell, and asks the AI about a container', async () => {
        renderPanel();
        await openView('Containers');
        // Only running containers have the quick shell button in the list.
        expect(await screen.findByRole('button', { name: 'Open a shell in shop-web-1' })).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Open a shell in shop-db-1' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^shop-db-1/ }));
        const detail = await screen.findByRole('region', { name: 'Container shop-db-1' });
        const shell = within(detail).getByRole('button', { name: 'Open shell' });
        expect(shell).toHaveAttribute('aria-disabled', 'true');
        expect(shell).toHaveAccessibleDescription('Start the container to open a shell in it.');
        fireEvent.click(shell);
        expect(useAppStore.getState().terminalSessions[7]).toBeUndefined();

        fireEvent.click(within(detail).getByRole('button', { name: 'Diagnose shop-db-1 with AI' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ serverId: 7, kind: 'context', attachment: { kind: 'container', container: 'shop-db-1', engine: 'docker' } });
    });
});

describe('compose projects', () => {
    it('takes a project down after a confirmation that names what goes, and shows the output', async () => {
        renderPanel();
        await openView('Compose');
        fireEvent.click(await screen.findByRole('button', { name: /^shop/ }));
        const detail = await screen.findByRole('region', { name: 'Compose project shop' });
        expect(within(detail).getByText('1/2 running')).toBeInTheDocument();

        fireEvent.click(within(detail).getByRole('button', { name: 'Down' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Take down shop?' });
        expect(within(dialog).getByText('shop-db-1')).toBeInTheDocument();
        expect(dialog).toHaveTextContent('Named volumes and images are kept');
        expect(calls('POST', /\/compose\//)).toHaveLength(0);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Down' }));
        await waitFor(() => expect(calls('POST', /\/ops\/compose\/shop\/down$/)).toHaveLength(1));
        expect(bodyOf(calls('POST', /\/ops\/compose\/shop\/down$/)[0])).toEqual({});
        fireEvent.click(await within(detail).findByText('Last action: Down'));
        expect(within(detail).getByText(/Container shop-web-1 +Removed/)).toBeInTheDocument();
        expect(within(detail).getByText("sudo -n docker 'compose' '-p' 'shop' 'down'")).toBeInTheDocument();
    });

    it('restarts one service from its menu', async () => {
        renderPanel();
        await openView('Compose');
        fireEvent.click(await screen.findByRole('button', { name: /^shop/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Actions for web' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Restart' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Restart web of shop?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Restart' }));
        await waitFor(() => expect(calls('POST', /\/ops\/compose\/shop\/restart$/)).toHaveLength(1));
        expect(bodyOf(calls('POST', /\/ops\/compose\/shop\/restart$/)[0])).toEqual({ service: 'web' });
    });

    it('keeps up and update unavailable while the project files are missing, and says why', async () => {
        renderPanel();
        await openView('Compose');
        fireEvent.click(await screen.findByRole('button', { name: /^legacy/ }));
        const detail = await screen.findByRole('region', { name: 'Compose project legacy' });
        expect(within(detail).getByText('Compose files missing on the server')).toBeInTheDocument();
        const up = within(detail).getByRole('button', { name: 'Up' });
        expect(up).toHaveAttribute('aria-disabled', 'true');
        expect(up).toHaveAccessibleDescription('This needs the project’s Compose files, which the server no longer has.');
        expect(within(detail).getByRole('button', { name: 'Restart' })).not.toHaveAttribute('aria-disabled');
        fireEvent.click(within(detail).getByRole('button', { name: 'Follow logs' }));
        expect(screen.getByTestId('logs-view')).toHaveTextContent('{"kind":"compose","project":"legacy"}');
    });

    it('offers no action for a project whose name Compose would not have given', async () => {
        renderPanel();
        await openView('Compose');
        fireEvent.click(await screen.findByRole('button', { name: /^bad;id/ }));
        const detail = await screen.findByRole('region', { name: 'Compose project bad;id' });
        expect(detail).toHaveTextContent('ShellMind does not run Compose commands for it');
        for (const name of ['Up', 'Pull & recreate', 'Restart', 'Stop', 'Down', 'Follow logs']) {
            const button = within(detail).getByRole('button', { name });
            expect(button).toHaveAttribute('aria-disabled', 'true');
            expect(button).toHaveAccessibleDescription('ShellMind does not run Compose for a project with this name.');
            fireEvent.click(button);
        }
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(calls('POST', /\/compose\//)).toHaveLength(0);
    });

    it('says how to bring a project back with the server\'s own Compose', async () => {
        renderPanel();
        await openView('Compose');
        fireEvent.click(await screen.findByRole('button', { name: /^shop/ }));
        const detail = await screen.findByRole('region', { name: 'Compose project shop' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Down' }));
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('bring it back with docker compose up -d in its directory');
    });
});

describe('images', () => {
    it('previews a prune with what it removes and the space it frees, then prunes', async () => {
        renderPanel();
        await openView('Images');
        expect(await screen.findByText('nginx:1.25')).toBeInTheDocument();
        expect(screen.getByText('dangling')).toBeInTheDocument();
        const remove = screen.getByRole('button', { name: 'Remove nginx:1.25' });
        expect(remove).toHaveAttribute('aria-disabled', 'true');
        expect(remove).toHaveAccessibleDescription('Used by a container: remove it first.');
        // UX-04: the columns follow the panel's width, not the window's (next
        // to the chat at 1024 px the name column was squeezed to nothing).
        const table = screen.getByRole('table');
        expect(table.parentElement?.className).toContain('[container-type:inline-size]');
        const created = within(table).getByRole('columnheader', { name: 'Created' });
        expect(created.className).toContain('[@container(min-width:40rem)]:table-cell');
        expect(created.className).not.toMatch(/\bmd:/);
        expect(within(table).getByRole('columnheader', { name: 'Used by' }).className).toContain('w-28');

        fireEvent.click(screen.getByRole('button', { name: 'Clean up' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Remove dangling images…' }));
        const dialog = await screen.findByRole('dialog', { name: 'Remove dangling images?' });
        expect(await within(dialog).findByText('1 image')).toBeInTheDocument();
        expect(dialog).toHaveTextContent('frees at least 11.4 MB');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Remove 1 image' }));
        await waitFor(() => expect(calls('POST', /\/ops\/images\/prune$/)).toHaveLength(1));
        expect(bodyOf(calls('POST', /\/ops\/images\/prune$/)[0])).toEqual({ mode: 'dangling' });
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(calls('GET', /\/ops\/images$/).length).toBeGreaterThan(1);
    });
});
