import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import type { OpsCapabilities } from '@shared/ops';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { LogsView } from './LogsView';
import type { LogRequest } from './viewTypes';

type Handler = (...args: unknown[]) => void;

// A stand-in socket: records what the view emits and lets the test play the backend.
const fake = vi.hoisted(() => {
    const state = {
        handlers: new Map<string, Handler>(),
        emitted: [] as Array<[string, unknown]>,
        disconnected: 0,
    };
    const socket = {
        connected: true,
        on: (event: string, handler: Handler) => { state.handlers.set(event, handler); return socket; },
        emit: (event: string, payload: unknown) => { state.emitted.push([event, payload]); return socket; },
        connect: () => socket,
        disconnect: () => { state.disconnected += 1; return socket; },
    };
    return { state, socket };
});

vi.mock('@/lib/socket', () => ({ createSocket: () => fake.socket }));

const CAPS: OpsCapabilities = {
    platform: 'linux', root: true, sudo: false, systemd: true, journal: true,
    containers: { engine: 'docker', version: '26.1.4', sudo: false, compose: false, problem: null },
    detectedAt: 0,
};

function serverSends(event: string, payload: unknown) {
    act(() => {
        fake.state.handlers.get(event)?.(payload, () => undefined);
    });
}

const started = () => fake.state.emitted.filter(([event]) => event === 'logs-start').map(([, payload]) => payload as { id: string; serverId: number; source: unknown });

beforeEach(() => {
    vi.useFakeTimers();
    setLanguage('en');
    fake.state.handlers.clear();
    fake.state.emitted.length = 0;
    fake.state.disconnected = 0;
});

afterEach(() => {
    vi.useRealTimers();
    setLanguage('system');
});

describe('LogsView', () => {
    it('validates the source before starting anything', () => {
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={null} />);
        fireEvent.click(screen.getByRole('radio', { name: 'File' }));
        const input = screen.getByLabelText('File path');
        fireEvent.change(input, { target: { value: "var/log/x'; reboot" } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        expect(input).toHaveAttribute('aria-invalid', 'true');
        expect(screen.getByText(/Enter an absolute path/)).toBeInTheDocument();
        expect(started()).toEqual([]);
    });

    it('streams a unit journal, filters, pauses and stops', () => {
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={null} />);
        fireEvent.change(screen.getByLabelText('Unit (optional)'), { target: { value: 'nginx' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        const [{ id, serverId, source }] = started();
        expect({ serverId, source }).toEqual({ serverId: 3, source: { kind: 'journal', unit: 'nginx.service' } });

        serverSends('logs-started', { id });
        serverSends('logs-chunk', { id, data: 'GET /a 200\nGET /b 502\nPOST /c 2' });
        serverSends('logs-chunk', { id: 'someone-else', data: 'ignored\n' });
        act(() => { vi.advanceTimersByTime(150); });
        expect(screen.getByText('Streaming')).toBeInTheDocument();
        // Two complete lines plus the one being written.
        expect(screen.getByText('3 lines')).toBeInTheDocument();

        fireEvent.change(screen.getByRole('searchbox', { name: 'Filter lines' }), { target: { value: ' 5\\d\\d' } });
        fireEvent.click(screen.getByRole('button', { name: 'Use a regular expression' }));
        expect(screen.getByText('1 of 3 lines')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
        serverSends('logs-chunk', { id, data: '00\nmore\n' });
        act(() => { vi.advanceTimersByTime(150); });
        expect(screen.getByRole('status')).toHaveTextContent('Paused: 2 new lines waiting');
        fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
        expect(screen.getByText('1 of 4 lines')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
        expect(fake.state.emitted).toContainEqual(['logs-stop', { id }]);
        serverSends('logs-end', { id, code: null });
        expect(screen.getByText('Ended')).toBeInTheDocument();
    });

    it('starts what another view asked for and reports stream errors', () => {
        const request: LogRequest = { source: { kind: 'container', container: 'web-proxy-1' }, nonce: 1 };
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={request} />);
        const [{ id, source }] = started();
        expect(source).toEqual({ kind: 'container', container: 'web-proxy-1' });
        expect(screen.getByRole('radio', { name: 'Container' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByLabelText('Container name or ID')).toHaveValue('web-proxy-1');

        serverSends('logs-error', { id, code: 'EXEC_STREAMS_BUSY', message: 'At most 3 live streams can run on one connection; stop one first.' });
        const alert = screen.getByRole('alert');
        expect(within(alert).getByText(/already runs the maximum number of live streams/)).toBeInTheDocument();
        expect(screen.getByText('Stopped by an error')).toBeInTheDocument();
    });

    it('says why the connection of a stream failed', () => {
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={null} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        const [{ id }] = started();
        serverSends('logs-error', { id, code: 'SSH_FAILED', message: 'connect ECONNREFUSED 10.0.0.5:22', connection: { code: 'ECONNREFUSED' } });
        const alert = screen.getByRole('alert');
        expect(within(alert).getByText('Could not connect to the server.')).toBeInTheDocument();
        expect(within(alert).getByText('The server refused the connection: nothing listens on that port.')).toBeInTheDocument();
    });

    it('closes its socket when it unmounts (the backend stops the remote command)', () => {
        const { unmount } = render(<LogsView serverId={3} serverName="web" caps={CAPS} request={null} />);
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        expect(started()[0].source).toEqual({ kind: 'journal' });
        unmount();
        expect(fake.state.disconnected).toBe(1);
    });

    it('follows a Compose project or one of its services (W7-S3)', () => {
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={null} />);
        fireEvent.click(screen.getByRole('radio', { name: 'Compose' }));
        const input = screen.getByLabelText('Compose project, or project/service');
        for (const value of ['shop/web/x', 'shop;id', '/web']) {
            fireEvent.change(input, { target: { value } });
            fireEvent.click(screen.getByRole('button', { name: 'Start' }));
            expect(screen.getByText('Enter a project name, or project/service (letters, digits, "_", "." and "-").')).toBeInTheDocument();
        }
        expect(started()).toEqual([]);
        fireEvent.change(input, { target: { value: 'shop/web' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        fireEvent.change(input, { target: { value: ' shop ' } });
        fireEvent.click(screen.getByRole('button', { name: 'Restart' }));
        expect(started().map((payload) => payload.source)).toEqual([{ kind: 'compose', project: 'shop', service: 'web' }, { kind: 'compose', project: 'shop' }]);
    });

    it('shows a Compose stream another view asked for (W7-S3)', () => {
        const request: LogRequest = { source: { kind: 'compose', project: 'shop', service: 'db' }, nonce: 1 };
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={request} />);
        expect(screen.getByRole('radio', { name: 'Compose' })).toHaveAttribute('aria-checked', 'true');
        expect(screen.getByLabelText('Compose project, or project/service')).toHaveValue('shop/db');
        expect(started()[0].source).toEqual({ kind: 'compose', project: 'shop', service: 'db' });
    });

    it('offers only the sources a Windows server has', () => {
        render(<LogsView serverId={3} serverName="win" caps={{ ...CAPS, platform: 'windows', journal: false, systemd: false }} request={null} />);
        expect(screen.queryByRole('radio', { name: 'Journal' })).toBeNull();
        // Compose projects are a Linux feature.
        expect(screen.queryByRole('radio', { name: 'Compose' })).toBeNull();
        fireEvent.change(screen.getByLabelText('File path'), { target: { value: 'C:\\logs\\app.log' } });
        fireEvent.click(screen.getByRole('button', { name: 'Start' }));
        expect(started()[0].source).toEqual({ kind: 'file', path: 'C:\\logs\\app.log' });
    });

    // W7-S5: "Ask AI" about the source being followed.
    it('asks the AI about the log it follows', () => {
        useAppStore.setState(useAppStore.getInitialState(), true);
        render(<LogsView serverId={3} serverName="web" caps={CAPS} request={{ source: { kind: 'container', container: 'web-proxy-1' }, nonce: 1 }} />);
        fireEvent.click(screen.getByRole('button', { name: 'Ask AI about web-proxy-1' }));
        expect(useAppStore.getState().chatRequest).toMatchObject({ serverId: 3, kind: 'context', attachment: { kind: 'logs', source: { kind: 'container', container: 'web-proxy-1' } } });
    });
});
