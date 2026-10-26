import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ContainerList, OpsCapabilities, ServiceInfo } from '@shared/ops';
import { setLanguage } from '@/i18n';
import { ConfirmProvider } from '@/components/ui';
import type { WorkspaceServer } from '@/workspace/types';
import OperationsPanel from './OperationsPanel';

// The log view needs a socket; its own test covers it.
vi.mock('./LogsView', () => ({
    LogsView: ({ request }: { request: { source: unknown } | null }) => <div data-testid="logs-view">{JSON.stringify(request?.source ?? null)}</div>,
}));

const CAPS: OpsCapabilities = {
    platform: 'linux', root: false, sudo: true, systemd: true, journal: true,
    containers: { engine: 'docker', version: '26.1.4', sudo: false, compose: true, problem: null },
    detectedAt: 0,
};

const SERVICES: ServiceInfo[] = [
    { name: 'cron.service', description: 'Regular background program processing daemon', load: 'loaded', active: 'active', sub: 'running', startup: 'enabled' },
    { name: 'nginx.service', description: 'A high performance web server', load: 'loaded', active: 'failed', sub: 'failed', startup: 'enabled' },
    { name: 'postgresql.service', description: '', load: null, active: 'inactive', sub: 'dead', startup: 'disabled' },
];

const CONTAINERS: ContainerList = {
    engine: 'docker',
    projects: [{ name: 'web', status: 'running(1)', configFiles: '/srv/web/compose.yaml' }],
    containers: [
        { id: 'aaaaaaaaaaaa1', name: 'web-proxy-1', image: 'nginx:1.25', state: 'running', status: 'Up 3 days', ports: '0.0.0.0:80->80/tcp', createdAt: null, composeProject: 'web', composeService: 'proxy' },
        { id: 'bbbbbbbbbbbb2', name: 'old-job', image: 'alpine:3', state: 'exited', status: 'Exited (1) 2 weeks ago', ports: '', createdAt: null, composeProject: null, composeService: null },
    ],
};

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const WINDOWS_CAPS: OpsCapabilities = {
    platform: 'windows', root: true, sudo: false, systemd: false, journal: false,
    containers: { engine: null, version: null, sudo: false, compose: false, problem: 'Docker is not installed.' },
    detectedAt: 0,
};

let fetchMock: ReturnType<typeof vi.fn>;
let caps: OpsCapabilities;
let services: ServiceInfo[];
// Answers a capabilities request instead of `caps` (e.g. a pending or failed re-detection).
let capsOverride: ((url: string) => Promise<Response>) | null;

function route(url: string, init?: RequestInit): Response {
    const path = new URL(url).pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/ops/capabilities')) return json(caps);
    if (path.endsWith('/ops/services')) return json({ services });
    if (method === 'POST' && path.endsWith('/ops/services/LanmanWorkstation/stop')) {
        return json({ ok: true, command: "Stop-Service -Force -Name 'LanmanWorkstation'", output: '' });
    }
    if (path.endsWith('/ops/services/LanmanWorkstation')) {
        return json({ name: 'LanmanWorkstation', properties: { State: 'Running', StartMode: 'Auto' }, statusText: null, dependents: ['SessionEnv', 'Netlogon'] });
    }
    if (method === 'POST' && path.endsWith('/ops/services/nginx.service/restart')) {
        return json({ ok: true, command: "sudo -n systemctl --no-ask-password restart -- 'nginx.service'", output: '' });
    }
    if (path.endsWith('/ops/services/nginx.service')) return json({ name: 'nginx.service', properties: { ActiveState: 'failed', MainPID: '0' }, statusText: '× nginx.service - web' });
    if (path.endsWith('/ops/containers')) return json(CONTAINERS);
    if (method === 'POST' && path.endsWith('/ops/containers/old-job/remove')) return json({ ok: true, command: "docker 'rm' '-f' 'old-job'", output: '' });
    return json({ error: `unexpected ${method} ${path}` }, 404);
}

const server: WorkspaceServer = { id: 7, name: 'web-01', ip: '10.0.0.7', type: 'linux' };

function renderPanel(isActive = true) {
    return render(<ConfirmProvider><OperationsPanel server={server} isActive={isActive} /></ConfirmProvider>);
}

beforeEach(() => {
    setLanguage('en');
    caps = CAPS;
    services = SERVICES;
    capsOverride = null;
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => (capsOverride && url.includes('/ops/capabilities') ? capsOverride(url) : route(url, init)));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

// Without ResizeObserver (jsdom) the views measure their element once.
function narrowPanel(width = 600) {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width, height: 600, top: 0, left: 0, right: width, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect);
}

const calls = (method: string, pattern: RegExp) => fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && pattern.test(String(url)));

describe('OperationsPanel', () => {
    it('loads nothing until the tab is first opened', async () => {
        const { rerender } = renderPanel(false);
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock).not.toHaveBeenCalled();
        rerender(<ConfirmProvider><OperationsPanel server={server} isActive /></ConfirmProvider>);
        expect(await screen.findByText('cron.service')).toBeInTheDocument();
        expect(screen.getByText('sudo')).toBeInTheDocument();
    });

    // UX-06: in Spanish at 1366 px "Logs" was cut at the edge with nothing
    // to say more tabs were there.
    it('scrolls its view tabs when they do not fit, fading the edge, with the selected one in sight', async () => {
        renderPanel();
        await screen.findByText('nginx.service');
        const tablist = screen.getByRole('tablist');
        expect(tablist.className).toContain('overflow-x-auto');
        expect(tablist.className).toContain('min-w-0');
        Object.defineProperty(tablist, 'clientWidth', { configurable: true, value: 300 });
        Object.defineProperty(tablist, 'scrollWidth', { configurable: true, value: 500 });
        fireEvent.scroll(tablist);
        expect(tablist.style.maskImage).toBe('linear-gradient(to right, black, black calc(100% - 1.5rem), transparent)');
        Object.defineProperty(tablist, 'scrollLeft', { configurable: true, value: 200 });
        fireEvent.scroll(tablist);
        expect(tablist.style.maskImage).toBe('linear-gradient(to right, transparent, black 1.5rem, black)');
    });

    it('filters services by state and text', async () => {
        renderPanel();
        await screen.findByText('nginx.service');
        const filter = screen.getByRole('radiogroup', { name: 'Show services' });
        fireEvent.click(within(filter).getByRole('radio', { name: /Failed/ }));
        expect(screen.queryByText('cron.service')).toBeNull();
        expect(screen.getByText('nginx.service')).toBeInTheDocument();

        fireEvent.click(within(filter).getByRole('radio', { name: /All/ }));
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search services' }), { target: { value: 'postgres' } });
        expect(screen.getByText('postgresql.service')).toBeInTheDocument();
        expect(screen.queryByText('nginx.service')).toBeNull();
    });

    it('confirms an action before running it, then refreshes', async () => {
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /nginx\.service/ }));
        const detail = await screen.findByRole('region', { name: 'Service nginx.service' });
        expect(await within(detail).findByText('× nginx.service - web')).toBeInTheDocument();

        fireEvent.click(within(detail).getByRole('button', { name: 'Restart' }));
        expect(await screen.findByText('Restart nginx.service?')).toBeInTheDocument();
        expect(calls('POST', /restart$/)).toHaveLength(0);

        const buttons = screen.getAllByRole('button', { name: 'Restart' });
        fireEvent.click(buttons[buttons.length - 1]);
        await waitFor(() => expect(calls('POST', /\/ops\/services\/nginx\.service\/restart$/)).toHaveLength(1));
        await waitFor(() => expect(calls('GET', /\/ops\/services$/).length).toBeGreaterThan(1));
    });

    it('opens the live journal of a unit in the Logs view', async () => {
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /nginx\.service/ }));
        const detail = await screen.findByRole('region', { name: 'Service nginx.service' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Follow live' }));
        expect(screen.getByRole('tab', { name: 'Logs' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByTestId('logs-view')).toHaveTextContent('{"kind":"journal","unit":"nginx.service"}');
    });

    it('moves between views with the arrow keys', async () => {
        renderPanel();
        await screen.findByText('cron.service');
        const services = screen.getByRole('tab', { name: 'Services' });
        services.focus();
        fireEvent.keyDown(services, { key: 'ArrowRight' });
        const containers = screen.getByRole('tab', { name: 'Containers' });
        expect(containers).toHaveAttribute('aria-selected', 'true');
        expect(containers).toHaveFocus();
        expect(await screen.findByText('web-proxy-1')).toBeInTheDocument();
        // The services view stays mounted (hidden) with its state.
        const servicesPanel = document.getElementById(services.getAttribute('aria-controls') ?? '');
        expect(servicesPanel).not.toBeVisible();
        expect(servicesPanel).toHaveTextContent('cron.service');
    });

    it('lists containers, filters by compose project and removes after confirmation', async () => {
        renderPanel();
        await screen.findByText('cron.service');
        fireEvent.click(screen.getByRole('tab', { name: 'Containers' }));
        await screen.findByText('web-proxy-1');
        expect(screen.getByText('Exited (1) 2 weeks ago')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: /^web/, pressed: false }));
        expect(screen.queryByText('old-job')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /^web/, pressed: true }));

        fireEvent.click(screen.getByRole('button', { name: /old-job/ }));
        const detail = await screen.findByRole('region', { name: 'Container old-job' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Remove' }));
        expect(await screen.findByText(/Named volumes are kept/)).toBeInTheDocument();
        const buttons = screen.getAllByRole('button', { name: 'Remove' });
        fireEvent.click(buttons[buttons.length - 1]);
        await waitFor(() => expect(calls('POST', /\/ops\/containers\/old-job\/remove$/)).toHaveLength(1));
    });

    it('checks the server again without unmounting the views (a running log stream survives)', async () => {
        renderPanel();
        await screen.findByText('cron.service');
        fireEvent.click(screen.getByRole('tab', { name: 'Logs' }));
        const logs = screen.getByTestId('logs-view');

        let answer: (response: Response) => void = () => undefined;
        capsOverride = () => new Promise<Response>((resolve) => { answer = resolve; });
        fireEvent.click(screen.getByRole('button', { name: 'Check the server again' }));
        await waitFor(() => expect(calls('GET', /\/ops\/capabilities\?refresh=1$/)).toHaveLength(1));
        // While it checks, the views keep the previous capabilities.
        expect(screen.getByTestId('logs-view')).toBe(logs);
        expect(screen.queryByText('Checking what this server offers…')).toBeNull();

        await act(async () => { answer(json({ error: 'The command did not finish within 20s', code: 'EXEC_TIMEOUT' }, 504)); });
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not check the server again; the views use the previous results.');
        expect(alert).toHaveTextContent('The server took too long to answer.');
        expect(screen.getByTestId('logs-view')).toBe(logs);

        // Retry asks for a fresh detection again, and a success clears the banner.
        capsOverride = null;
        fireEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
        await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        expect(calls('GET', /\/ops\/capabilities\?refresh=1$/)).toHaveLength(2);
        expect(screen.getByTestId('logs-view')).toBe(logs);
    });

    it('calls a Windows administrator "Administrator", not root', async () => {
        caps = WINDOWS_CAPS;
        services = [];
        renderPanel();
        expect(await screen.findByText('Administrator')).toBeInTheDocument();
        expect(screen.getByText('This user is a Windows administrator: services can be started and stopped.')).toBeInTheDocument();
        expect(screen.queryByText('root')).toBeNull();
    });

    it('keeps a radio group without a choice reachable from the keyboard', async () => {
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /nginx\.service/ }));
        const lines = await screen.findByRole('radiogroup', { name: 'Journal lines to show' });
        const radios = within(lines).getAllByRole('radio');
        expect(radios.map((radio) => radio.tabIndex)).toEqual([0, -1, -1]);
        expect(radios.every((radio) => radio.getAttribute('aria-checked') === 'false')).toBe(true);
        fireEvent.keyDown(radios[0], { key: 'ArrowRight' });
        expect(radios[1]).toHaveAttribute('aria-checked', 'true');
        expect(radios[1]).toHaveFocus();
        expect(radios.map((radio) => radio.tabIndex)).toEqual([-1, 0, -1]);
    });

    it('moves the focus into the detail and back to its row in a narrow panel', async () => {
        narrowPanel();
        renderPanel();
        const row = await screen.findByRole('button', { name: /nginx\.service/ });
        row.focus();
        fireEvent.click(row);
        expect(await screen.findByRole('heading', { name: 'nginx.service' })).toHaveFocus();
        // The list made room for the detail.
        expect(screen.queryByRole('table')).toBeNull();

        fireEvent.click(screen.getByRole('button', { name: 'Back to the list' }));
        const again = await screen.findByRole('button', { name: /nginx\.service/ });
        expect(again).toHaveFocus();
    });

    it('keeps the focus on a button while it is busy and ignores repeated presses', async () => {
        renderPanel();
        await screen.findByText('cron.service');
        let answer: (response: Response) => void = () => undefined;
        fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
        const refresh = screen.getByRole('button', { name: 'Refresh' });
        refresh.focus();
        fireEvent.click(refresh);
        await waitFor(() => expect(refresh).toHaveAttribute('aria-disabled', 'true'));
        expect(refresh).not.toBeDisabled();
        expect(refresh).toHaveFocus();
        const before = calls('GET', /\/ops\/services$/).length;
        fireEvent.click(refresh);
        expect(calls('GET', /\/ops\/services$/)).toHaveLength(before);
        await act(async () => { answer(json({ services: SERVICES })); });
        await waitFor(() => expect(refresh).not.toHaveAttribute('aria-disabled'));
        expect(refresh).toHaveFocus();
    });

    it('names the running dependents before stopping a Windows service', async () => {
        caps = WINDOWS_CAPS;
        services = [{ name: 'LanmanWorkstation', description: 'Workstation', load: null, active: 'active', sub: 'Running', startup: 'Automatic' }];
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /LanmanWorkstation/ }));
        const detail = await screen.findByRole('region', { name: 'Service LanmanWorkstation' });
        await within(detail).findByText('Auto');
        fireEvent.click(within(detail).getByRole('button', { name: 'Stop' }));
        expect(await screen.findByText('Running services that depend on it are stopped too: SessionEnv, Netlogon.')).toBeInTheDocument();
        const buttons = screen.getAllByRole('button', { name: 'Stop' });
        fireEvent.click(buttons[buttons.length - 1]);
        await waitFor(() => expect(calls('POST', /\/ops\/services\/LanmanWorkstation\/stop$/)).toHaveLength(1));
    });

    it('explains why services or containers are unavailable', async () => {
        caps = { ...CAPS, systemd: false, containers: { ...CAPS.containers, engine: null, problem: 'permission denied while trying to connect to the Docker daemon socket' } };
        renderPanel();
        expect(await screen.findByText('This server does not use systemd')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('tab', { name: 'Containers' }));
        expect(await screen.findByText(/permission denied while trying to connect/)).toBeInTheDocument();
        expect(calls('GET', /\/ops\/(services|containers)$/)).toHaveLength(0);
    });
});
