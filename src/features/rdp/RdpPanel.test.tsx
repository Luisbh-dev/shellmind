import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { PinnedRdpCertificate, RdpCertificate } from '@shared/rdp';
import { ToastProvider } from '@/components/ui/Toast';
import { setLanguage } from '@/i18n';
import { collectUnsavedWork } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import type { RdpConnectOptions, RdpStatus } from './connection';
import RdpPanel from './RdpPanel';
import { useRdpStore } from './store';

// The Remote Desktop tab with a stand-in connection: what it starts, what it
// shows for each state, and the actions of the toolbar and the error screens.

type FakeConnection = {
    options: RdpConnectOptions | null;
    calls: string[];
    emit: (status: RdpStatus) => void;
    focusTarget: HTMLElement;
};

const connections: FakeConnection[] = [];

vi.mock('./connection', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./connection')>();
    class RdpConnection {
        readonly fake: FakeConnection;
        constructor(mount: HTMLElement, onStatus: (status: RdpStatus) => void) {
            const target = document.createElement('iron-remote-desktop');
            target.tabIndex = 0;
            mount.appendChild(target);
            this.fake = { options: null, calls: [], emit: onStatus, focusTarget: target };
            connections.push(this.fake);
        }
        get focusTarget() { return this.fake.focusTarget; }
        get isConnected() { return true; }
        async start(options: RdpConnectOptions) { this.fake.options = options; }
        disconnect() { this.fake.calls.push('disconnect'); }
        dispose() { this.fake.calls.push('dispose'); }
        ctrlAltDel() { this.fake.calls.push('ctrlAltDel'); }
        sendKeys(codes: readonly string[]) { this.fake.calls.push(`keys:${codes.join('+')}`); }
        releaseInputs() { this.fake.calls.push('release'); }
        focus() { this.fake.focusTarget.focus(); }
        resize() { this.fake.calls.push('resize'); }
        syncClipboard() { this.fake.calls.push('syncClipboard'); }
    }
    return { ...actual, RdpConnection };
});

const trustRequests: unknown[] = [];
let trustAnswer: unknown = { ok: true };
vi.mock('@/lib/socket', () => ({
    createSocket: () => ({
        timeout: () => ({
            emit: (event: string, payload: unknown, ack: (error: Error | null, result: unknown) => void) => {
                trustRequests.push([event, payload]);
                queueMicrotask(() => ack(null, trustAnswer));
            },
        }),
        disconnect: () => undefined,
    }),
}));

const SERVER: WorkspaceServer = { id: 7, name: 'Win Box', ip: '10.0.0.9', type: 'windows', username: 'admin', domain: 'CORP', port: null, has_password: 1 };

// The backend: the options it keeps per server, the pinned certificate.
let askPassword = false;
let certificateRefusal: { code: string; error: string } | null = null;
const optionWrites: unknown[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes('/api/rdp/certificate')) {
        if (certificateRefusal) return Response.json(certificateRefusal, { status: 400 });
        return Response.json({ message: 'success', data: { host: '10.0.0.9', port: 3389, via: '', pinned: null } });
    }
    if (url.includes('/api/rdp/options')) {
        if (init?.method === 'PUT') {
            const body = JSON.parse(String(init.body)) as { askPassword: boolean };
            optionWrites.push(body);
            askPassword = body.askPassword;
        }
        return Response.json({ message: 'success', data: { askPassword } });
    }
    if (url.endsWith('/api/rdp/native')) return Response.json({ message: 'success', data: { supported: true, client: 'mstsc', platform: 'win32' } });
    return Response.json({ error: 'unexpected' }, { status: 404 });
});

beforeEach(() => {
    setLanguage('en');
    connections.length = 0;
    trustRequests.length = 0;
    trustAnswer = { ok: true };
    askPassword = false;
    certificateRefusal = null;
    optionWrites.length = 0;
    localStorage.clear();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    setLanguage('system');
});

const renderPanel = (server: WorkspaceServer = SERVER) => render(<ToastProvider><RdpPanel server={server} isActive /></ToastProvider>);
const current = () => connections[connections.length - 1];
const emit = (status: RdpStatus) => act(() => current().emit(status));
const connected = (extra: Partial<Extract<RdpStatus, { kind: 'connected' }>> = {}): RdpStatus => ({
    kind: 'connected', since: 1, desktop: { width: 1280, height: 720 }, via: null, account: 'CORP\\admin', certificate: null, pinnedNow: false, clipboard: 'on', ...extra,
});

const certificate = (fingerprint: string, subject: string): RdpCertificate => ({
    host: '10.0.0.9', port: 3389, via: '', fingerprint, thumbprint: 'ABCDEF', subject, issuer: subject, validFrom: Date.UTC(2026, 0, 1), validTo: Date.UTC(2026, 6, 1),
});

describe('RdpPanel', () => {
    it('connects with the saved credentials and the options of this device', async () => {
        renderPanel();
        expect(screen.getByText('10.0.0.9:3389 as CORP\\admin')).toBeInTheDocument();
        expect(screen.getByText('Signs in with the saved password.')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(current().options).toEqual({ serverId: 7, credentials: { kind: 'saved' }, desktop: { width: 1280, height: 720 }, clipboard: true, keyboard: 'unicode' });
        // The connect screen still shows the external client.
        expect(await screen.findByRole('button', { name: 'Open in external client' })).toBeInTheDocument();
    });

    it('asks for the password each time when told to (the backend keeps that), also as another user', async () => {
        renderPanel();
        const option = screen.getByLabelText('Ask for the password each time');
        // Read from the backend first.
        await waitFor(() => expect(option).toBeEnabled());
        fireEvent.click(option);
        // UX-07: two columns only when the card itself is wide enough (the
        // tab can be narrow on a wide window, next to the chat).
        const keyboard = screen.getByRole('radio', { name: 'Key positions' });
        expect(keyboard.closest('section')?.className).toContain('[container-type:inline-size]');
        expect(keyboard.closest('.grid')?.className).toContain('[@container(min-width:34rem)]:grid-cols-2');
        fireEvent.click(keyboard);
        await waitFor(() => expect(optionWrites).toEqual([{ serverId: 7, askPassword: true }]));
        // This device only keeps how the desktop is shown.
        expect(JSON.parse(localStorage.getItem('shellmind.rdp.prefs.7') ?? '{}')).toEqual({ resolution: 'auto', fit: true, clipboard: true, keyboard: 'scancode' });
        expect(screen.getByText('Asks for the password when you connect.')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        const dialog = await screen.findByRole('dialog', { name: 'Sign in to Win Box' });
        expect(within(dialog).getByLabelText('User name')).toHaveValue('CORP\\admin');
        fireEvent.change(within(dialog).getByLabelText('User name'), { target: { value: 'OTHER\\bob' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
        expect(within(dialog).getByText('Enter the password.')).toBeInTheDocument();
        fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'Typed!1' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        expect(current().options).toMatchObject({ credentials: { kind: 'typed', username: 'bob', domain: 'OTHER', password: 'Typed!1' }, keyboard: 'scancode' });
    });

    it('follows the option the backend keeps, set from another device', async () => {
        askPassword = true;
        renderPanel();
        await waitFor(() => expect(screen.getByLabelText('Ask for the password each time')).toBeChecked());
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByRole('dialog', { name: 'Sign in to Win Box' })).toBeInTheDocument();
        expect(connections).toHaveLength(0);
    });

    it('asks for the password when the backend refuses to hand out the saved one', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        emit({ kind: 'failed', failure: { code: 'RDP_PASSWORD_REQUIRED', message: 'asks each time' } });
        expect(await screen.findByRole('dialog', { name: 'Sign in to Win Box' })).toBeInTheDocument();
        expect(screen.queryByText('Could not connect')).toBeNull();
    });

    it('says why the pinned certificate cannot be read instead of loading for ever', async () => {
        certificateRefusal = { code: 'RDP_INVALID_TARGET', error: 'The user name or domain contains characters Remote Desktop cannot use.' };
        renderPanel();
        expect(screen.getByText('Checking the pinned certificate…')).toBeInTheDocument();
        expect(await screen.findByText('The pinned certificate could not be read: The address, port, user name or domain of this connection cannot be used for Remote Desktop.')).toBeInTheDocument();
        expect(screen.queryByText('Checking the pinned certificate…')).toBeNull();
    });

    it('says a connection the user stopped was cancelled, not that a session ended', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        emit({ kind: 'connecting', step: 'server', via: null, account: 'CORP\\admin' });
        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(current().calls).toContain('disconnect');
        emit({ kind: 'cancelled' });
        expect(screen.getByText('Connection cancelled')).toBeInTheDocument();
        expect(screen.queryByText('Session ended')).toBeNull();
        expect(screen.getByRole('button', { name: 'Connect' })).toBeInTheDocument();
        expect(useRdpStore.getState().sessions[7]).toBeUndefined();
    });

    it('explains in the user’s words why the server ended the session', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        emit(connected());
        const reason = 'The disconnection was initiated by the user logging off his or her session on the server';
        emit({ kind: 'ended', byUser: false, reason });
        expect(screen.getByText('You signed out of Windows.')).toBeInTheDocument();
        expect(screen.getByText(`Server message: ${reason}`)).toBeInTheDocument();
    });

    it('always asks when no password is saved', async () => {
        renderPanel({ ...SERVER, has_password: 0 });
        expect(screen.getByText(/No password is saved for this connection/)).toBeInTheDocument();
        expect(screen.getByLabelText('Ask for the password each time')).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        expect(await screen.findByRole('dialog')).toBeInTheDocument();
        expect(connections).toHaveLength(0);
    });

    it('shows the progress, then the live session with its toolbar', async () => {
        const { container } = renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        emit({ kind: 'connecting', step: 'server', via: 'bastion', account: 'CORP\\admin' });
        expect(screen.getByText('Connecting to 10.0.0.9:3389…')).toBeInTheDocument();
        expect(screen.getByText('Through bastion')).toBeInTheDocument();
        emit({ kind: 'connecting', step: 'signing-in', via: null, account: 'CORP\\admin' });
        expect(screen.getByText('Signing in as CORP\\admin…')).toBeInTheDocument();
        expect(useRdpStore.getState().sessions[7]).toEqual({ state: 'connecting' });

        emit(connected());
        expect(screen.getByText('Connected')).toBeInTheDocument();
        // jsdom lays nothing out: a panel this narrow shows the size as a tooltip.
        expect(screen.getByTitle('1280 × 720')).toHaveTextContent('Connected');
        expect(screen.getByRole('application', { name: 'Remote desktop of Win Box' })).toBeInTheDocument();
        expect(container.querySelector('[data-keyboard-capture]')).not.toBeNull();
        expect(useRdpStore.getState().sessions[7]).toMatchObject({ state: 'connected', desktop: { width: 1280, height: 720 } });
        expect(collectUnsavedWork(7)).toEqual(['A Remote Desktop session is open']);

        fireEvent.click(screen.getByRole('button', { name: 'Send Ctrl+Alt+Del' }));
        fireEvent.click(screen.getByRole('button', { name: 'Send the clipboard to the remote desktop' }));
        fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
        // The remote desktop took the focus when it connected (and got the clipboard).
        expect(current().calls[0]).toBe('syncClipboard');
        expect(current().calls.filter((call) => call !== 'syncClipboard')).toEqual(['ctrlAltDel', 'disconnect']);

        emit({ kind: 'ended', byUser: true, reason: null });
        expect(screen.getByText('Session ended')).toBeInTheDocument();
        expect(screen.getByText(/You disconnected/)).toBeInTheDocument();
        expect(useRdpStore.getState().sessions[7]).toBeUndefined();
        expect(collectUnsavedWork(7)).toEqual([]);
    });

    it('sends special keys from the menu and gives the keyboard back on Ctrl+Alt+Home', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        emit(connected());
        fireEvent.click(screen.getByRole('button', { name: 'Send a key combination' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: /Run/ }));
        expect(current().calls).toContain('keys:MetaLeft+KeyR');

        const target = current().focusTarget;
        act(() => target.focus());
        expect(screen.getByTitle('Keyboard in the remote desktop · Ctrl+Alt+Home to release')).toBeInTheDocument();
        expect(current().calls).toContain('syncClipboard');
        fireEvent.keyDown(target, { key: 'Home', ctrlKey: true, altKey: true });
        expect(current().calls).toContain('release');
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Send Ctrl+Alt+Del' }));
        expect(screen.getByTitle('Click the remote desktop to type in it')).toBeInTheDocument();
    });

    it('explains a failure and reconnects the same way', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        emit({ kind: 'failed', failure: { code: 'RDP_UNREACHABLE', message: 'refused', details: { address: '10.0.0.9:3389', errno: 'ECONNREFUSED' } } });
        const alert = screen.getByRole('alert');
        expect(alert).toHaveTextContent('Could not connect');
        expect(alert).toHaveTextContent('10.0.0.9:3389 could not be reached (connection refused).');
        expect(alert).toHaveTextContent('Port 3389 of the server must be reachable');
        expect(useRdpStore.getState().sessions[7]).toEqual({ state: 'error' });
        fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
        expect(connections).toHaveLength(2);
        expect(current().options?.credentials).toEqual({ kind: 'saved' });
    });

    it('asks again, saying why, when a typed password is refused', async () => {
        renderPanel({ ...SERVER, has_password: 0 });
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        const dialog = await screen.findByRole('dialog');
        fireEvent.change(within(dialog).getByLabelText('Password'), { target: { value: 'nope' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Connect' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        emit({ kind: 'failed', failure: { code: 'RDP_LOGON_FAILURE' } });
        const again = await screen.findByRole('dialog');
        expect(within(again).getByRole('alert')).toHaveTextContent(/user name or password is wrong/);
        expect(within(again).getByLabelText('Password')).toHaveValue('');
    });

    it('compares a changed certificate and trusts the new one on request', async () => {
        renderPanel();
        fireEvent.click(screen.getByRole('button', { name: 'Connect' }));
        const expected: PinnedRdpCertificate = { ...certificate('AA:BB', 'CN=old'), id: 4, createdAt: 1 };
        const actual = certificate('CC:DD', 'CN=new');
        emit({ kind: 'failed', failure: { code: 'RDP_CERT_MISMATCH', mismatch: { expected, actual } } });
        expect(screen.getByText('The server presented a different certificate')).toBeInTheDocument();
        expect(screen.getAllByText('CN=old')).toHaveLength(2);
        expect(screen.getAllByText('CN=new')).toHaveLength(2);

        trustAnswer = { ok: false, code: 'RDP_CERT_CHANGED', error: 'Connect again to compare.' };
        fireEvent.click(screen.getByRole('button', { name: 'Trust the new certificate and connect' }));
        expect(await screen.findByText('Could not trust the certificate')).toBeInTheDocument();
        // In the user's language, not the backend's.
        expect(screen.getByText('The server presents another certificate by now. Connect again to compare the current one.')).toBeInTheDocument();
        expect(connections).toHaveLength(1);

        trustAnswer = { ok: true };
        fireEvent.click(screen.getByRole('button', { name: 'Trust the new certificate and connect' }));
        await waitFor(() => expect(connections).toHaveLength(2));
        expect(trustRequests.at(-1)).toEqual(['rdp-trust-certificate', { serverId: 7, expected: 'AA:BB', actual: 'CC:DD' }]);
    });

    it('speaks Spanish, keyboard labels included', async () => {
        setLanguage('es');
        renderPanel();
        expect(screen.getByRole('button', { name: 'Conectar' })).toBeInTheDocument();
        expect(screen.getByText('Pedir la contraseña cada vez')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Conectar' }));
        emit(connected());
        act(() => current().focusTarget.focus());
        expect(screen.getByTitle('Teclado en el escritorio remoto · Ctrl+Alt+Inicio para liberarlo')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Enviar una combinación de teclas' }));
        expect(await screen.findByRole('menuitem', { name: /Impr Pant/ })).toBeInTheDocument();
    });
});
