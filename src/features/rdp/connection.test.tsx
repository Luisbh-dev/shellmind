import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RdpOpenResult, RdpStatusEvent } from '@shared/rdp';
import type { AppSocket } from '@/lib/socket';
import { gatewayUrl, RDP_TIMEOUTS, RdpConnection, redactSecrets, type RdpConnectOptions, type RdpStatus } from './connection';

// RdpConnection against a stand-in <iron-remote-desktop> (the real one needs
// WebAssembly and a canvas) and a stand-in socket.

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void };
function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

class FakeUi {
    calls: string[] = [];
    config: Record<string, unknown> = {};
    extensions: unknown[] = [];
    connected = deferred<{ initialDesktopSize: { width: number; height: number }; run: () => Promise<{ reason: () => string }> }>();
    ended = deferred<{ reason: () => string }>();
    remoteClipboardChanged: (() => void) | null = null;
    configBuilder() {
        const builder = {
            withUsername: (value: string) => { this.config.username = value; return builder; },
            withPassword: (value: string) => { this.config.password = value; return builder; },
            withServerDomain: (value: string) => { this.config.domain = value; return builder; },
            withDestination: (value: string) => { this.config.destination = value; return builder; },
            withProxyAddress: (value: string) => { this.config.proxy = value; return builder; },
            withAuthToken: (value: string) => { this.config.token = value; return builder; },
            withDesktopSize: (value: unknown) => { this.config.desktop = value; return builder; },
            withExtension: (value: unknown) => { this.extensions.push(value); return builder; },
            build: () => ({ ...this.config }),
        };
        return builder;
    }
    connect() {
        this.calls.push('connect');
        return this.connected.promise;
    }
    setVisibility(visible: boolean) { this.calls.push(`visible:${visible}`); }
    setEnableClipboard(enabled: boolean) { this.calls.push(`clipboard:${enabled}`); }
    setEnableAutoClipboard(enabled: boolean) { this.calls.push(`autoClipboard:${enabled}`); }
    setKeyboardUnicodeMode(enabled: boolean) { this.calls.push(`unicode:${enabled}`); }
    onClipboardRemoteUpdateCallback(callback: () => void) { this.remoteClipboardChanged = callback; }
    onWarningCallback() { /* none */ }
    saveRemoteClipboardData() { this.calls.push('saveRemoteClipboard'); return Promise.resolve(); }
    sendClipboardData() { this.calls.push('sendClipboard'); return Promise.resolve(); }
    shutdown() {
        this.calls.push('shutdown');
        this.ended.resolve({ reason: () => 'user requested' });
    }
    ctrlAltDel() { this.calls.push('ctrlAltDel'); }
    resize(width: number, height: number) { this.calls.push(`resize:${width}x${height}`); }
    setScale(scale: number) { this.calls.push(`scale:${scale}`); }
}

let ui: FakeUi;

beforeAll(() => {
    customElements.define('iron-remote-desktop', class extends HTMLElement {
        connectedCallback() {
            const root = this.attachShadow({ mode: 'open' });
            root.innerHTML = '<div class="screen-wrapper"><div><canvas width="800" height="600"></canvas></div></div>';
            queueMicrotask(() => this.dispatchEvent(new CustomEvent('ready', { detail: { irgUserInteraction: ui }, bubbles: true, composed: true })));
        }
    });
});

class FakeSocket {
    handlers = new Map<string, (payload: unknown) => void>();
    emitted: Array<[string, unknown]> = [];
    openResult: RdpOpenResult = { ok: false, code: 'UNSET', error: 'unset' };
    disconnected = false;
    on(event: string, handler: (payload: unknown) => void) {
        this.handlers.set(event, handler);
        return this;
    }
    timeout() {
        return {
            emit: (event: string, payload: unknown, ack: (error: Error | null, result: unknown) => void) => {
                this.emitted.push([event, payload]);
                if (event === 'rdp-open') queueMicrotask(() => ack(null, this.openResult));
            },
        };
    }
    emit(event: string, payload: unknown) {
        this.emitted.push([event, payload]);
        return this;
    }
    disconnect() { this.disconnected = true; }
    fire(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }
}

const OPENED: RdpOpenResult = {
    ok: true, sessionId: 'session-1', ticket: 'ticket/+1', gatewayPath: '/api/rdp/gateway', destination: '10.0.0.9:3389',
    username: 'admin', domain: 'CORP', password: 'Saved$ecret', via: null,
};
const OPTIONS: RdpConnectOptions = { serverId: 3, credentials: { kind: 'saved' }, desktop: { width: 1001, height: 700 }, clipboard: true, keyboard: 'unicode' };

let socket: FakeSocket;
let mount: HTMLDivElement;
let statuses: RdpStatus[];

const CLIENT = { backend: { name: 'backend' }, displayControl: (enable: boolean) => `display:${enable}`, enableCredssp: (enable: boolean) => `credssp:${enable}` };
let loadClient: () => Promise<typeof CLIENT>;

function create() {
    return new RdpConnection(mount, (status) => statuses.push(status), {
        loadClient: () => loadClient(),
        createSocket: () => socket as unknown as AppSocket,
        apiBase: () => 'http://127.0.0.1:3001',
    });
}

const last = () => statuses[statuses.length - 1];
const waitFor = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(check()).toBe(true);
};

const GATEWAY_REPORT_MS = RDP_TIMEOUTS.gatewayReport;
const LINGER_MS = RDP_TIMEOUTS.linger;

beforeEach(() => {
    // A client error waits this long for the gateway's reason.
    RDP_TIMEOUTS.gatewayReport = 100;
    RDP_TIMEOUTS.linger = LINGER_MS;
    loadClient = async () => CLIENT;
    ui = new FakeUi();
    socket = new FakeSocket();
    socket.openResult = OPENED;
    mount = document.createElement('div');
    document.body.appendChild(mount);
    statuses = [];
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    Object.defineProperty(navigator, 'clipboard', { value: {}, configurable: true });
});

afterEach(() => {
    mount.remove();
    RDP_TIMEOUTS.gatewayReport = GATEWAY_REPORT_MS;
    RDP_TIMEOUTS.linger = LINGER_MS;
});

async function connectWith(options: RdpConnectOptions = OPTIONS) {
    const connection = create();
    void connection.start(options);
    await waitFor(() => ui.calls.includes('connect'));
    return connection;
}

describe('RdpConnection', () => {
    it('connects with the saved credentials the backend hands over, through the gateway', async () => {
        const connection = await connectWith();
        expect(socket.emitted[0]).toEqual(['rdp-open', { serverId: 3, credentials: 'saved' }]);
        expect(ui.config).toEqual({
            username: 'admin', password: 'Saved$ecret', domain: 'CORP', destination: '10.0.0.9:3389',
            proxy: 'ws://127.0.0.1:3001/api/rdp/gateway?ticket=ticket%2F%2B1', token: 'ticket/+1',
            // Even widths only (display control).
            desktop: { width: 1000, height: 700 },
        });
        expect(ui.extensions).toEqual(['display:true', 'credssp:true']);
        expect(ui.calls).toEqual(expect.arrayContaining(['clipboard:true', 'autoClipboard:false', 'unicode:true']));

        socket.fire('rdp-status', { sessionId: 'other', phase: 'securing' } satisfies RdpStatusEvent);
        socket.fire('rdp-status', { sessionId: 'session-1', phase: 'securing' } satisfies RdpStatusEvent);
        const certificate = { host: '10.0.0.9', port: 3389, via: '', fingerprint: 'AA', thumbprint: 'BB', subject: 'CN=win', issuer: 'CN=win', validFrom: null, validTo: null };
        socket.fire('rdp-status', { sessionId: 'session-1', phase: 'established', certificate, pinnedNow: true } satisfies RdpStatusEvent);
        expect(statuses.map((status) => (status.kind === 'connecting' ? status.step : status.kind))).toEqual(['loading', 'server', 'securing', 'signing-in']);

        ui.connected.resolve({ initialDesktopSize: { width: 1000, height: 700 }, run: () => ui.ended.promise });
        await waitFor(() => last().kind === 'connected');
        expect(last()).toMatchObject({ kind: 'connected', desktop: { width: 1000, height: 700 }, account: 'CORP\\admin', certificate, pinnedNow: true, clipboard: 'on' });
        expect(ui.calls).toContain('visible:true');
        expect(connection.isConnected).toBe(true);
        expect(mount.querySelector('iron-remote-desktop')).not.toBeNull();
    });

    it('signs in with what the user typed and never asks the backend for the saved password', async () => {
        await connectWith({ ...OPTIONS, credentials: { kind: 'typed', username: 'bob', domain: '', password: 'Typed!1' }, clipboard: false, keyboard: 'scancode' });
        expect(socket.emitted[0]).toEqual(['rdp-open', { serverId: 3, credentials: 'prompt', username: 'bob', domain: '' }]);
        expect(ui.config).toMatchObject({ username: 'bob', password: 'Typed!1', domain: '' });
        expect(ui.calls).toEqual(expect.arrayContaining(['clipboard:false', 'unicode:false']));
    });

    it('reports a refusal of the backend', async () => {
        socket.openResult = { ok: false, code: 'SECRET_UNREADABLE', error: 'Cannot decrypt the password.' };
        const connection = create();
        await connection.start(OPTIONS);
        expect(last()).toEqual({ kind: 'failed', failure: { code: 'SECRET_UNREADABLE', message: 'Cannot decrypt the password.' } });
        expect(socket.disconnected).toBe(true);
        expect(mount.childElementCount).toBe(0);
    });

    it('names the sign-in failures of the client', async () => {
        await connectWith();
        ui.connected.reject({ kind: () => 1, backtrace: () => 'wrong password' });
        await waitFor(() => last().kind === 'failed');
        expect(last()).toEqual({ kind: 'failed', failure: { code: 'RDP_WRONG_PASSWORD' } });
        expect(mount.childElementCount).toBe(0);
    });

    it('prefers the gateway’s reason (a changed certificate) to the client’s RDCleanPath error', async () => {
        await connectWith();
        const mismatch = { expected: { id: 1, createdAt: 1 } as never, actual: {} as never };
        ui.connected.reject({ kind: () => 4, backtrace: () => 'received an RDCleanPath error\nmore' });
        setTimeout(() => socket.fire('rdp-status', { sessionId: 'session-1', phase: 'failed', error: { code: 'RDP_CERT_MISMATCH', message: 'changed', mismatch } }), 20);
        await waitFor(() => last().kind === 'failed');
        expect(last()).toMatchObject({ kind: 'failed', failure: { code: 'RDP_CERT_MISMATCH', mismatch } });
    });

    it('falls back to the client’s error when the gateway says nothing', async () => {
        await connectWith();
        ui.connected.reject({ kind: () => 5, backtrace: () => 'failed to connect to proxy\nstack' });
        await waitFor(() => last().kind === 'failed');
        expect(last()).toEqual({ kind: 'failed', failure: { code: 'RDP_GATEWAY', message: 'failed to connect to proxy' } });
    });

    it('ends when the user disconnects or the server ends the session', async () => {
        const connection = await connectWith();
        ui.connected.resolve({ initialDesktopSize: { width: 1000, height: 700 }, run: () => ui.ended.promise });
        await waitFor(() => last().kind === 'connected');
        connection.disconnect();
        await waitFor(() => last().kind === 'ended');
        expect(last()).toEqual({ kind: 'ended', byUser: true, reason: 'user requested' });
        expect(ui.calls).toContain('shutdown');
        expect(mount.childElementCount).toBe(0);
        // The gateway hears it was the user, before the session goes...
        expect(socket.emitted).toContainEqual(['rdp-disconnect', { sessionId: 'session-1', cause: 'user' }]);
        // ...and the socket stays until the gateway saw the end (its sessions end with it).
        expect(socket.disconnected).toBe(false);
        socket.fire('rdp-status', { sessionId: 'session-1', phase: 'closed' } satisfies RdpStatusEvent);
        expect(socket.disconnected).toBe(true);

        ui = new FakeUi();
        socket = new FakeSocket();
        socket.openResult = OPENED;
        await connectWith();
        ui.connected.resolve({ initialDesktopSize: { width: 1000, height: 700 }, run: () => ui.ended.promise });
        await waitFor(() => last().kind === 'connected');
        ui.ended.resolve({ reason: () => 'server-initiated disconnect\ndetails' });
        await waitFor(() => last().kind === 'ended');
        expect(last()).toEqual({ kind: 'ended', byUser: false, reason: 'server-initiated disconnect' });
        // The client may keep its WebSocket open: the gateway hears it from the page.
        expect(socket.emitted).toContainEqual(['rdp-disconnect', { sessionId: 'session-1', cause: 'remote', detail: 'server-initiated disconnect' }]);
    });

    it('tells the gateway a session ended on a client error, unless the gateway reported the end itself', async () => {
        await connectWith();
        ui.connected.reject({ kind: () => 2, backtrace: () => 'logon failure' });
        await waitFor(() => last().kind === 'failed');
        expect(socket.emitted).toContainEqual(['rdp-disconnect', { sessionId: 'session-1', cause: 'error', detail: 'RDP_LOGON_FAILURE' }]);

        ui = new FakeUi();
        socket = new FakeSocket();
        socket.openResult = OPENED;
        await connectWith();
        socket.fire('rdp-status', { sessionId: 'session-1', phase: 'failed', error: { code: 'RDP_TLS_FAILED', message: 'handshake' } } satisfies RdpStatusEvent);
        ui.connected.reject({ kind: () => 4, backtrace: () => 'RDCleanPath error' });
        await waitFor(() => last().kind === 'failed');
        expect(socket.emitted.filter(([event]) => event === 'rdp-disconnect')).toEqual([]);
        expect(socket.disconnected).toBe(true);
    });

    it('sends keys, Ctrl+Alt+Del and size changes to the live session only', async () => {
        const connection = await connectWith();
        connection.ctrlAltDel();
        connection.resize({ width: 1201, height: 801 });
        expect(ui.calls).not.toContain('ctrlAltDel');
        ui.connected.resolve({ initialDesktopSize: { width: 1000, height: 700 }, run: () => ui.ended.promise });
        await waitFor(() => last().kind === 'connected');

        const element = mount.querySelector('iron-remote-desktop') as HTMLElement;
        const seen: string[] = [];
        element.addEventListener('keydown', (event) => seen.push(`down:${event.code}`));
        element.addEventListener('keyup', (event) => seen.push(`up:${event.code}`));
        connection.sendKeys(['MetaLeft', 'KeyR']);
        expect(seen).toEqual(['down:MetaLeft', 'down:KeyR', 'up:KeyR', 'up:MetaLeft']);
        connection.ctrlAltDel();
        connection.resize({ width: 1201, height: 801 });
        connection.resize({ width: 1000, height: 700 });
        connection.resize({ width: 50, height: 50 });
        expect(ui.calls.filter((call) => /^(ctrlAltDel|resize)/.test(call))).toEqual(['ctrlAltDel', 'resize:1200x801', 'resize:200x200']);
        connection.syncClipboard();
        expect(ui.calls).toContain('sendClipboard');
        ui.remoteClipboardChanged?.();
        expect(ui.calls).toContain('saveRemoteClipboard');
    });

    it('follows desktop size changes of the server', async () => {
        await connectWith();
        ui.connected.resolve({ initialDesktopSize: { width: 1000, height: 700 }, run: () => ui.ended.promise });
        await waitFor(() => last().kind === 'connected');
        const canvas = mount.querySelector('iron-remote-desktop')!.shadowRoot!.querySelector('canvas')!;
        canvas.width = 1280;
        canvas.height = 720;
        await waitFor(() => last().kind === 'connected' && (last() as Extract<RdpStatus, { kind: 'connected' }>).desktop.width === 1280);
        // The element's own outline and window-sized layout are replaced.
        expect(mount.querySelector('iron-remote-desktop')!.shadowRoot!.querySelector('style')?.textContent).toContain('.screen-wrapper');
    });

    it('releases everything when it is disposed', async () => {
        RDP_TIMEOUTS.linger = 50;
        const connection = await connectWith();
        connection.dispose();
        expect(mount.childElementCount).toBe(0);
        // Closing the tab or the server is the user ending the session too.
        expect(socket.emitted).toContainEqual(['rdp-disconnect', { sessionId: 'session-1', cause: 'user' }]);
        // The gateway said nothing: the socket goes after a moment anyway.
        await waitFor(() => socket.disconnected);
        const count = statuses.length;
        ui.connected.resolve({ initialDesktopSize: { width: 1000, height: 700 }, run: () => ui.ended.promise });
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(statuses.length).toBe(count);
    });

    it('asks for the ticket (and the saved password) only once the client is loaded and ready', async () => {
        // A slow link: the ~6 MB client takes longer than a ticket lives.
        const client = deferred<typeof CLIENT>();
        loadClient = () => client.promise;
        const connection = create();
        void connection.start(OPTIONS);
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(socket.emitted).toEqual([]);
        expect(statuses).toEqual([{ kind: 'connecting', step: 'loading', via: null, account: null }]);
        client.resolve(CLIENT);
        await waitFor(() => ui.calls.includes('connect'));
        // The element was ready (its setup ran) before the ticket was asked for.
        expect(ui.calls.indexOf('unicode:true')).toBeGreaterThanOrEqual(0);
        expect(socket.emitted[0]).toEqual(['rdp-open', { serverId: 3, credentials: 'saved' }]);
        expect(ui.config).toMatchObject({ password: 'Saved$ecret', token: 'ticket/+1' });
    });

    it('reports a connection the user cancels as cancelled, and stops it at the gateway', async () => {
        const loading = deferred<typeof CLIENT>();
        loadClient = () => loading.promise;
        const early = create();
        void early.start(OPTIONS);
        early.disconnect();
        expect(last()).toEqual({ kind: 'cancelled' });
        // No ticket yet: nothing to tell the gateway, the socket goes at once.
        expect(socket.emitted).toEqual([]);
        expect(socket.disconnected).toBe(true);
        loading.resolve(CLIENT);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(last()).toEqual({ kind: 'cancelled' });
        expect(mount.childElementCount).toBe(0);

        socket = new FakeSocket();
        socket.openResult = OPENED;
        loadClient = async () => CLIENT;
        const signingIn = await connectWith();
        signingIn.disconnect();
        expect(last()).toEqual({ kind: 'cancelled' });
        expect(ui.calls).not.toContain('shutdown');
        expect(socket.emitted).toContainEqual(['rdp-disconnect', { sessionId: 'session-1', cause: 'user' }]);
    });

    it('never shows the gateway ticket in an error', async () => {
        await connectWith();
        ui.connected.reject({ kind: () => 5, backtrace: () => 'failed to connect to ws://127.0.0.1:3001/api/rdp/gateway?ticket=ticket%2F%2B1 (WebSocket is `Closed`)' });
        await waitFor(() => last().kind === 'failed');
        const failure = (last() as Extract<RdpStatus, { kind: 'failed' }>).failure;
        expect(failure).toMatchObject({ code: 'RDP_GATEWAY' });
        expect(failure.message).toBe('failed to connect to ws://127.0.0.1:3001/api/rdp/gateway?ticket=… (WebSocket is `Closed`)');
        expect(failure.message).not.toContain('ticket%2F');
    });
});

describe('redactSecrets', () => {
    it('blanks out ticket parameters and the given values', () => {
        expect(redactSecrets('GET /api/rdp/gateway?ticket=abc-DEF_1&x=1 failed')).toBe('GET /api/rdp/gateway?ticket=…&x=1 failed');
        expect(redactSecrets('url "wss://h/api/rdp/gateway?a=1&ticket=Zz9" closed')).toBe('url "wss://h/api/rdp/gateway?a=1&ticket=…" closed');
        expect(redactSecrets('token Zz9 was refused', ['Zz9'])).toBe('token … was refused');
        expect(redactSecrets('nothing here', [''])).toBe('nothing here');
    });
});

describe('gatewayUrl', () => {
    it('turns the API base into a WebSocket URL with the ticket', () => {
        expect(gatewayUrl('https://shellmind.example/base/', { gatewayPath: '/api/rdp/gateway', ticket: 'a b' }))
            .toBe('wss://shellmind.example/base/api/rdp/gateway?ticket=a%20b');
        expect(gatewayUrl('http://127.0.0.1:3001', { gatewayPath: '/api/rdp/gateway', ticket: 't' })).toBe('ws://127.0.0.1:3001/api/rdp/gateway?ticket=t');
    });
});

vi.setConfig({ testTimeout: 15_000 });
