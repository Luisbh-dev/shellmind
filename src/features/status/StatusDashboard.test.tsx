import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { StatusSnapshot } from '@shared/status';
import { setLanguage } from '@/i18n';
import type { WorkspaceServer } from '@/workspace/types';
import StatusDashboard from './StatusDashboard';

const snapshot = (overrides: Partial<StatusSnapshot> = {}): StatusSnapshot => ({
    platform: 'linux',
    collectedAt: Date.now(),
    hostname: 'web-01',
    os: 'Ubuntu 22.04.4 LTS',
    kernel: '5.15.0',
    uptimeSeconds: 90061,
    cpu: { usagePercent: 42.5, cores: 4, iowaitPercent: 1.5 },
    memory: { totalMB: 8192, usedMB: 7782.4, availableMB: 409.6, usagePercent: 95 },
    swap: { totalMB: 2048, usedMB: 0, usagePercent: 0 },
    load: { one: 0.52, five: 0.48, fifteen: 0.4 },
    storage: { totalGB: 100, usedGB: 40, freeGB: 60, usagePercent: 40 },
    disks: [{ name: '/dev/sda1', mount: '/', fsType: 'ext4', totalGB: 100, usedGB: 40, freeGB: 60, usagePercent: 40 }],
    processes: [
        { pid: 1234, name: 'java', cpuPercent: 180, memoryMB: 2048, memoryPercent: 25 },
        { pid: 99, name: 'postgres', cpuPercent: 12, memoryMB: 4096, memoryPercent: 50 },
        { pid: 7, name: 'bash', cpuPercent: 0, memoryMB: 4, memoryPercent: 0.05 },
    ],
    network: { rxBytesPerSec: 1536, txBytesPerSec: 512, interfaces: [{ name: 'eth0', rxBytesPerSec: 1536, txBytesPerSec: 512 }] },
    failedUnits: 2,
    loggedInUsers: 1,
    sampleSeconds: 1,
    unavailable: [],
    ...overrides,
});

const server = (id: number, name = `srv-${id}`): WorkspaceServer => ({ id, name, ip: '10.0.0.1', type: 'linux' });

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
    setLanguage('en');
    fetchMock = vi.fn(async () => json(snapshot()));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

async function refreshNow() {
    const refresh = screen.getByRole('button', { name: 'Refresh now' });
    await waitFor(() => expect(refresh).not.toHaveAttribute('aria-disabled'));
    fireEvent.click(refresh);
}

describe('StatusDashboard', () => {
    it('shows the metrics of the active server', async () => {
        render(<StatusDashboard server={server(1, 'web')} isActive />);
        const cpu = await screen.findByRole('region', { name: 'CPU' });
        expect(fetchMock.mock.calls[0][0]).toMatch(/\/api\/servers\/1\/status$/);
        expect(within(cpu).getByText('42.5')).toBeInTheDocument();
        expect(within(cpu).getByRole('meter', { name: 'CPU' })).toHaveAttribute('aria-valuenow', '42.5');
        expect(within(cpu).getByText('4 cores')).toBeInTheDocument();

        const facts = screen.getByRole('list', { name: 'System' });
        for (const fact of ['web-01', 'Ubuntu 22.04.4 LTS', 'Kernel 5.15.0', 'Up 1 d 1 h', '1 user logged in']) {
            expect(within(facts).getByText(fact)).toBeInTheDocument();
        }
        // Failed units past their limit are a health issue, said once (not again among the facts).
        expect(screen.getAllByText('2 failed units')).toHaveLength(1);
        expect(within(screen.getByRole('list', { name: 'What needs attention' })).getByText('2 failed units')).toBeInTheDocument();

        // 95% memory is flagged with an icon and a word, not colour alone.
        const memory = screen.getByRole('region', { name: 'Memory' });
        expect(within(memory).getByText('Critical')).toBeInTheDocument();
        expect(within(memory).getByRole('meter', { name: 'Memory' })).toHaveAttribute('aria-valuetext', '95% (Warning from 80%, critical from 90%) · Critical');

        // Process CPU reads as a share of the whole machine, bar and number alike; the per-core figure is the tooltip.
        const table = screen.getByRole('table', { name: /used the most CPU/ });
        const javaCpu = within(table).getByText('45%').closest('td') as HTMLElement;
        expect(javaCpu).toHaveAttribute('title', '180% of one core');
        expect(within(javaCpu).getByRole('meter')).toHaveAttribute('aria-valuetext', '45% of the whole machine');
        expect(screen.getByText('CPU over 1 s · 100% = all 4 cores')).toBeInTheDocument();
        expect(within(screen.getByRole('region', { name: 'Load average' })).getByText('0.52')).toBeInTheDocument();
        expect(screen.getByText('Live')).toBeInTheDocument();
    });

    it('sums up the health as the worst metric, with what pulls it down', async () => {
        render(<StatusDashboard server={server(1)} isActive />);
        expect(await screen.findByText('Health: Critical')).toBeInTheDocument();
        const issues = screen.getByRole('list', { name: 'What needs attention' });
        expect(within(issues).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Critical:Memory 95%', 'High:2 failed units']);
    });

    it('names a high load per core among the issues, as a warning', async () => {
        fetchMock.mockImplementation(async () => json(snapshot({ load: { one: 9.2, five: 6, fifteen: 4 } })));
        render(<StatusDashboard server={server(1)} isActive />);
        const issues = await screen.findByRole('list', { name: 'What needs attention' });
        expect(within(issues).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['Critical:Memory 95%', 'High:Load 2.30 per core', 'High:2 failed units']);
    });

    it('folds a long list of issues, still naming the rest to screen readers', async () => {
        const full = (index: number) => ({ name: `/dev/sd${index}`, mount: `/data${index}`, fsType: 'xfs', totalGB: 10, usedGB: 9.5, freeGB: 0.5, usagePercent: 95 });
        fetchMock.mockImplementation(async () => json(snapshot({ disks: [1, 2, 3, 4, 5, 6].map(full) })));
        render(<StatusDashboard server={server(1)} isActive />);
        const issues = await screen.findByRole('list', { name: 'What needs attention' });
        const items = within(issues).getAllByRole('listitem');
        // Memory and six disks are critical, the failed units high: six shown, two folded.
        expect(items).toHaveLength(7);
        const more = items[6];
        expect(within(more).getByText('+2 more')).toHaveAttribute('aria-hidden', 'true');
        expect(more).toHaveTextContent('Critical: /data6 95% full, High: 2 failed units');
    });

    it('is healthy when every metric is within its limits', async () => {
        fetchMock.mockImplementation(async () => json(snapshot({
            memory: { totalMB: 8192, usedMB: 2048, availableMB: 6144, usagePercent: 25 },
            failedUnits: 0,
        })));
        render(<StatusDashboard server={server(1)} isActive />);
        expect(await screen.findByText('Health: Healthy')).toBeInTheDocument();
        expect(screen.queryByRole('list', { name: 'What needs attention' })).toBeNull();
        expect(screen.getByText('No failed units')).toBeInTheDocument();
    });

    it('names each filesystem by its mount, type and device, without repeating them', async () => {
        fetchMock.mockImplementation(async () => json(snapshot({
            disks: [
                { name: '/dev/sda1', mount: '/', fsType: 'ext4', totalGB: 100, usedGB: 40, freeGB: 60, usagePercent: 40 },
                // The root of a container.
                { name: 'overlay', mount: '/data', fsType: 'overlay', totalGB: 100, usedGB: 93, freeGB: 7, usagePercent: 93 },
            ],
        })));
        render(<StatusDashboard server={server(1)} isActive />);
        const filesystems = await screen.findByRole('region', { name: 'Filesystems' });
        const [root, data] = within(filesystems).getAllByRole('listitem');
        expect(within(root).getByText('ext4')).toBeInTheDocument();
        expect(within(root).getByText('/dev/sda1')).toBeInTheDocument();
        expect(within(data).getAllByText('overlay')).toHaveLength(1);
        // The full one is flagged in words too, and its bar says why.
        expect(within(data).getByText('Critical')).toBeInTheDocument();
        expect(within(data).getByRole('meter', { name: '/data' })).toHaveAttribute('aria-valuetext', expect.stringContaining('Critical'));
        // The storage tile leads with the fullest filesystem: figure, meter and badge agree; the total is the small print.
        const storage = screen.getByRole('region', { name: 'Storage' });
        expect(within(storage).getByText('93')).toBeInTheDocument();
        expect(within(storage).getByText('/data')).toBeInTheDocument();
        expect(within(storage).getByText('Critical')).toBeInTheDocument();
        expect(within(storage).getByRole('meter', { name: 'Fullest filesystem, /data' })).toHaveAttribute('aria-valuetext', expect.stringContaining('Critical'));
        expect(within(storage).getByText('2 filesystems · 40.0 GB / 100 GB in all')).toBeInTheDocument();
    });

    it('sorts the processes by any column', async () => {
        render(<StatusDashboard server={server(1)} isActive />);
        const table = await screen.findByRole('table', { name: /used the most CPU/ });
        const names = () => within(table).getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('cell')[0].textContent);
        expect(names()).toEqual(['java', 'postgres', 'bash']);
        expect(within(table).getByRole('columnheader', { name: /CPU/ })).toHaveAttribute('aria-sort', 'descending');

        fireEvent.click(within(table).getByRole('button', { name: 'Memory' }));
        expect(names()).toEqual(['postgres', 'java', 'bash']);
        expect(within(table).getByRole('columnheader', { name: /Memory/ })).toHaveAttribute('aria-sort', 'descending');
        expect(within(table).getByRole('columnheader', { name: /CPU/ })).toHaveAttribute('aria-sort', 'none');

        fireEvent.click(within(table).getByRole('button', { name: 'Process' }));
        expect(names()).toEqual(['bash', 'java', 'postgres']);
        fireEvent.click(within(table).getByRole('button', { name: 'Process' }));
        expect(names()).toEqual(['postgres', 'java', 'bash']);
    });

    it('shows a chart as a table on demand', async () => {
        render(<StatusDashboard server={server(1)} isActive />);
        const chart = await screen.findByRole('region', { name: 'CPU usage' });
        // Each toggle is named after its chart.
        expect(screen.getByRole('button', { name: 'Memory usage: show as a table' })).toBeInTheDocument();
        fireEvent.click(within(chart).getByRole('button', { name: 'CPU usage: show as a table' }));
        const table = within(chart).getByRole('table', { name: 'CPU usage, newest first' });
        expect(within(table).getByRole('columnheader', { name: 'CPU' })).toBeInTheDocument();
        expect(within(table).getByText('42.5%')).toBeInTheDocument();
        fireEvent.click(within(chart).getByRole('button', { name: 'CPU usage: show as a chart' }));
        expect(within(chart).getByRole('slider', { name: 'CPU usage' })).toBeInTheDocument();
    });

    it('leaves out what a Windows host does not report', async () => {
        fetchMock.mockImplementation(async () => json(snapshot({
            platform: 'windows',
            os: 'Microsoft Windows Server 2022 Datacenter',
            cpu: { usagePercent: 12, cores: 8, iowaitPercent: null },
            load: null,
            failedUnits: null,
            unavailable: ['load', 'failedUnits'],
        })));
        render(<StatusDashboard server={server(1)} isActive />);
        const cpu = await screen.findByRole('region', { name: 'CPU' });
        expect(screen.queryByRole('region', { name: 'Load average' })).toBeNull();
        expect(screen.queryByText(/failed unit/)).toBeNull();
        expect(within(cpu).queryByText(/I\/O wait/)).toBeNull();
        expect(screen.getByText('1 user logged in')).toBeInTheDocument();
        // A Windows build is a version, not a kernel.
        expect(screen.getByText('Version 5.15.0')).toBeInTheDocument();
        // Three tiles get three columns; two to a row, the third takes the whole row.
        expect(cpu.parentElement?.className).toContain('grid-cols-3');
        expect(screen.getByRole('region', { name: 'Storage' }).className).toContain('col-span-2');
    });

    it('requests nothing while its tab is hidden', async () => {
        render(<StatusDashboard server={server(1)} isActive={false} />);
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock).not.toHaveBeenCalled();
        expect(screen.getByText('Paused')).toBeInTheDocument();
    });

    it('pauses while the window is hidden and resumes when it is visible again', async () => {
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        render(<StatusDashboard server={server(1)} isActive />);
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock).not.toHaveBeenCalled();

        visibility.mockReturnValue('visible');
        act(() => { document.dispatchEvent(new Event('visibilitychange')); });
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        visibility.mockRestore();
    });

    it('shows a skeleton until the first sample arrives', async () => {
        fetchMock.mockImplementation(() => new Promise<Response>(() => undefined));
        render(<StatusDashboard server={server(1)} isActive />);
        expect(screen.getByRole('status', { name: 'Collecting the first sample…' })).toBeInTheDocument();
    });

    it('explains a failed first load and retries on demand', async () => {
        fetchMock.mockImplementation(async () => json({ error: 'The command did not finish within 15s: sh -s', code: 'EXEC_TIMEOUT' }, 504));
        render(<StatusDashboard server={server(1)} isActive />);
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not load the status');
        expect(alert).toHaveTextContent('The server took too long to answer.');
        expect(alert).toHaveTextContent('The command did not finish within 15s');
        // The countdown ticks outside the alert, so the failure is announced once, not every second.
        expect(alert).not.toHaveTextContent(/Next attempt/);
        expect(screen.getByText(/^Next attempt in \d+ s$/)).toBeInTheDocument();
        fetchMock.mockImplementation(async () => json(snapshot()));
        fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
        expect(await screen.findByRole('region', { name: 'CPU' })).toBeInTheDocument();
        expect(screen.queryByRole('alert')).toBeNull();
    });

    // W7 integration (S1): a rejected login is not tried again by itself.
    it('does not retry rejected credentials by itself, only when asked', async () => {
        fetchMock.mockImplementation(async () => json({ error: 'Authentication failed', code: 'SSH_FAILED', details: { connection: { code: 'AUTH_FAILED' } } }, 502));
        render(<StatusDashboard server={server(1)} isActive />);
        expect(await screen.findByRole('alert')).toBeInTheDocument();
        // No attempt is scheduled (any other failure shows its countdown here).
        expect(screen.queryByText(/^Next attempt in \d+ s$/)).toBeNull();
        expect(fetchMock).toHaveBeenCalledTimes(1);
        fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    });

    it('keeps the last values, marked stale, when a refresh fails', async () => {
        render(<StatusDashboard server={server(1)} isActive />);
        await screen.findByRole('region', { name: 'CPU' });
        fetchMock.mockImplementation(async () => json({ error: 'The command did not finish within 15s: sh -s', code: 'EXEC_TIMEOUT' }, 504));
        await refreshNow();
        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not refresh the status: The server took too long to answer.');
        expect(alert).not.toHaveTextContent(/Next attempt/);
        // After one failure the next attempt is two intervals away, and the countdown never reads more.
        expect(screen.getByText(/^Next attempt in (9|10) s$/)).toBeInTheDocument();
        expect(screen.getByText('Stale')).toBeInTheDocument();
        expect(screen.getByRole('region', { name: 'CPU' }).closest('[data-stale]')).not.toBeNull();
        // The verdict is no longer current: it says so, in words and to screen readers, and its reasons dim too.
        expect(screen.getByText('Last known: Critical')).toBeInTheDocument();
        expect(screen.getByText(/^Health at .+, no longer current: Critical$/)).toBeInTheDocument();
        expect(screen.queryByText('Health: Critical')).toBeNull();
        expect(screen.getByRole('list', { name: 'What needs attention' }).closest('[data-stale]')).not.toBeNull();
    });

    it('spins the refresh button only for a refresh the user asked for', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
        try {
            fetchMock
                .mockImplementationOnce(async () => json(snapshot()))
                .mockImplementation(() => new Promise<Response>(() => undefined));
            render(<StatusDashboard server={server(1)} isActive />);
            await screen.findByRole('region', { name: 'CPU' });
            const refresh = screen.getByRole('button', { name: 'Refresh now' });

            // A background poll is running: the button stays as it is.
            await act(async () => { vi.advanceTimersByTime(5000); });
            expect(fetchMock).toHaveBeenCalledTimes(2);
            expect(refresh).not.toHaveAttribute('aria-disabled');

            // Clicked now, it waits for that same request instead of starting another.
            fireEvent.click(refresh);
            expect(refresh).toHaveAttribute('aria-disabled', 'true');
            expect(fetchMock).toHaveBeenCalledTimes(2);
        } finally {
            vi.useRealTimers();
        }
    });

    it('never shows the previous server\'s data under the next one (Known issue ux/status-stale-cross-server fixed)', async () => {
        let resolveSecond: (response: Response) => void = () => undefined;
        fetchMock
            .mockImplementationOnce(async () => json(snapshot({ hostname: 'first-host' })))
            .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveSecond = resolve; }));
        const { rerender } = render(<StatusDashboard server={server(1)} isActive />);
        expect(await screen.findByText('first-host')).toBeInTheDocument();

        rerender(<StatusDashboard server={server(2)} isActive />);
        expect(screen.queryByText('first-host')).toBeNull();
        expect(screen.getByText('Collecting the first sample…')).toBeInTheDocument();
        expect(fetchMock.mock.calls[1][0]).toMatch(/\/api\/servers\/2\/status$/);

        await act(async () => { resolveSecond(json(snapshot({ hostname: 'second-host' }))); });
        expect(await screen.findByText('second-host')).toBeInTheDocument();
    });

    it('lays the grids out by the panel width, not the window (Known issue ux/status-viewport-breakpoints fixed)', async () => {
        const { container } = render(<StatusDashboard server={server(1)} isActive />);
        const cpu = await screen.findByRole('region', { name: 'CPU' });
        // The scroll area is the query container; the grids answer to it.
        expect(container.querySelector('[data-status-scroll]')?.className).toContain('[container-type:inline-size]');
        expect(cpu.parentElement?.className).toContain('[@container(min-width:56rem)]:grid-cols-4');
        const viewportBreakpoint = /(^|\s)(sm|md|lg|xl|2xl):/;
        for (const element of container.querySelectorAll('[class]')) {
            expect(element.getAttribute('class')).not.toMatch(viewportBreakpoint);
        }
    });

    it('refreshes on demand and is translated', async () => {
        setLanguage('es');
        fetchMock.mockImplementation(async () => json(snapshot({ sampleSeconds: 1.03 })));
        render(<StatusDashboard server={server(1)} isActive />);
        const memory = await screen.findByRole('region', { name: 'Memoria' });
        expect(screen.getByText('Procesos principales')).toBeInTheDocument();
        expect(screen.getByText('Salud: Crítico')).toBeInTheDocument();
        // A badge that agrees with any tile ("Memoria", "Carga media"...), and the sample time rounded.
        expect(within(memory).getByText('Nivel crítico')).toBeInTheDocument();
        expect(screen.getByText('CPU en 1 s · 100 % = los 4 núcleos')).toBeInTheDocument();
        const refresh = screen.getByRole('button', { name: 'Actualizar ahora' });
        await waitFor(() => expect(refresh).not.toHaveAttribute('aria-disabled'));
        refresh.focus();
        fireEvent.click(refresh);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        // While it refreshes the button only reports itself unavailable: the focus stays on it.
        expect(refresh).toHaveFocus();
    });

    it('describes both network series to screen readers', async () => {
        let call = 0;
        fetchMock.mockImplementation(async () => {
            call += 1;
            return json(snapshot({ collectedAt: Date.now() + call, network: { rxBytesPerSec: 1024 * call, txBytesPerSec: 2048 * call, interfaces: [] } }));
        });
        render(<StatusDashboard server={server(1)} isActive />);
        await screen.findByRole('region', { name: 'Network traffic' });
        await refreshNow();
        const network = screen.getByRole('region', { name: 'Network traffic' });
        await waitFor(() => expect(within(network).getByRole('slider', { name: 'Network traffic' })).toHaveAccessibleDescription(
            'Received, last 2 samples: lowest 1.0 KB/s, highest 2.0 KB/s, now 2.0 KB/s. Sent, last 2 samples: lowest 2.0 KB/s, highest 4.0 KB/s, now 4.0 KB/s'
        ));
        // The legend carries the current values.
        expect(within(network).getByText('2.0 KB/s')).toBeInTheDocument();
        expect(within(network).getByText('4.0 KB/s')).toBeInTheDocument();
    });
});
