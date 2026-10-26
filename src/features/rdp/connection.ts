import { clampDesktopSize, type RdpCertificate, type RdpEndCause, type RdpGatewayError, type RdpOpenRequest, type RdpOpenResult, type RdpStatusEvent } from '@shared/rdp';
import { getApiBase } from '@/lib/api';
import { createSocket, type AppSocket } from '@/lib/socket';
import { loadIronRdp, type IronRdpClient, type RemoteDesktopElement, type UserInteraction } from './ironRdp';
import { comboEvents } from './keys';

// One embedded Remote Desktop connection: the <iron-remote-desktop> element,
// a ticket from the backend over the authenticated socket (asked for once
// the client is ready, so it is used at once), the connection through the
// backend's RDCleanPath gateway, and the controls of the toolbar. The
// password (the saved one, handed over by the backend for this connection,
// or the one the user typed) only lives in the client's configuration while
// it connects; nothing is stored.

export type DesktopSize = { width: number; height: number };

export type RdpStep = 'loading' | 'server' | 'securing' | 'signing-in';

export type ClipboardState = 'on' | 'off' | 'unavailable';

// `code`: a gateway code (RdpErrorCode), a refusal of "rdp-open" (the
// backend's error codes) or one of the client's (RDP_WRONG_PASSWORD...).
export type RdpFailure = {
    code: string;
    message?: string;
    details?: Record<string, string | number>;
    mismatch?: RdpGatewayError['mismatch'];
};

export type RdpStatus =
    | { kind: 'connecting'; step: RdpStep; via: string | null; account: string | null }
    | {
        kind: 'connected';
        since: number;
        desktop: DesktopSize;
        via: string | null;
        account: string;
        certificate: RdpCertificate | null;
        pinnedNow: boolean;
        clipboard: ClipboardState;
    }
    | { kind: 'ended'; byUser: boolean; reason: string | null }
    // The user stopped it before a session was established.
    | { kind: 'cancelled' }
    | { kind: 'failed'; failure: RdpFailure };

export type RdpCredentials =
    | { kind: 'saved' }
    | { kind: 'typed'; username: string; domain: string; password: string };

export type RdpConnectOptions = {
    serverId: number;
    credentials: RdpCredentials;
    desktop: DesktopSize;
    clipboard: boolean;
    // Characters (Unicode, whatever the remote keyboard layout) or key
    // positions (scancodes, read with the remote layout).
    keyboard: 'unicode' | 'scancode';
};

export type RdpConnectionDeps = {
    loadClient: () => Promise<IronRdpClient>;
    createSocket: () => AppSocket;
    apiBase: () => string;
};

const defaultDeps: RdpConnectionDeps = { loadClient: loadIronRdp, createSocket, apiBase: getApiBase };

export const RDP_TIMEOUTS = {
    open: 15_000,
    ready: 15_000,
    // Gateway, TLS, NLA and the connection sequence of the server.
    connect: 60_000,
    // How long a client error waits for the gateway's reason to arrive.
    gatewayReport: 1_500,
    // A resize the server did not follow (no display control) is undone.
    resize: 2_000,
    // How long the socket outlives a session for the gateway to see it end
    // (it relays the client's last messages, its sign-off, until then).
    linger: 2_000
};

// IronErrorKind of @devolutions/iron-remote-desktop.
const IRON_KIND = { general: 0, wrongPassword: 1, logonFailure: 2, accessDenied: 3, rdCleanPath: 4, proxyConnect: 5, negotiationFailure: 6 } as const;

// The element's shadow DOM sizes the screen from the window; inside a panel
// the panel decides (see RemoteDesktopView), and focus is shown by the app.
const SHADOW_CSS = `
.screen-wrapper { width: auto !important; height: auto !important; overflow: visible !important; }
.capturing-inputs { outline: none !important; }
canvas { display: block; }
`;

class FailureError extends Error {
    constructor(readonly failure: RdpFailure) {
        super(failure.message ?? failure.code);
    }
}

type IronErrorLike = { kind: () => number; backtrace: () => string };

function isIronError(error: unknown): error is IronErrorLike {
    return typeof error === 'object' && error !== null && typeof (error as IronErrorLike).kind === 'function';
}

function firstLine(text: string): string {
    return text.split('\n').map((line) => line.trim()).find(Boolean)?.slice(0, 300) ?? '';
}

// A client error quotes the gateway URL, ticket included: it is shown on
// screen (and ends up in screenshots and bug reports) without it. `secrets`
// are further values to blank out (the ticket itself).
export function redactSecrets(text: string, secrets: readonly string[] = []): string {
    let clean = text.replace(/([?&]ticket=)[^&#\s)'"`]+/gi, '$1…');
    for (const secret of secrets) {
        if (secret) clean = clean.split(secret).join('…');
    }
    return clean;
}

function errorText(error: unknown, secrets: readonly string[] = []): string {
    let text: string;
    if (isIronError(error)) {
        try {
            text = firstLine(error.backtrace());
        } catch {
            text = '';
        }
    } else {
        text = error instanceof Error ? error.message : String(error);
    }
    return redactSecrets(text, secrets);
}

export function gatewayUrl(apiBase: string, opened: { gatewayPath: string; ticket: string }): string {
    const base = apiBase.replace(/\/+$/, '').replace(/^http(s?):/i, 'ws$1:');
    return `${base}${opened.gatewayPath}?ticket=${encodeURIComponent(opened.ticket)}`;
}

// The element sets its clipboard support up after "ready", once the browser
// says whether it may read the clipboard; a session started before that has
// no clipboard. The same question asked here is answered after the element's.
async function settleClipboardInit(): Promise<void> {
    try {
        await navigator.permissions?.query({ name: 'clipboard-read' as PermissionName });
    } catch {
        // Not a permission this browser knows: the element falls back the same way.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => Error): Promise<T> {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(onTimeout()), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            }
        );
    });
}

export class RdpConnection {
    private socket: AppSocket | null = null;
    private element: RemoteDesktopElement | null = null;
    private canvas: HTMLCanvasElement | null = null;
    private ui: UserInteraction | null = null;
    private sessionId: string | null = null;
    private gatewayFailure: RdpGatewayError | null = null;
    private gatewayWaiters: Array<() => void> = [];
    private certificate: RdpCertificate | null = null;
    private pinnedNow = false;
    private desktop: DesktopSize = { width: 0, height: 0 };
    private since = 0;
    private via: string | null = null;
    private account = '';
    private clipboard: ClipboardState = 'off';
    private connected = false;
    private finished = false;
    private disposed = false;
    private userEnded = false;
    // The gateway was told the user ends the session ("rdp-disconnect").
    private endAnnounced = false;
    // The gateway reported the end of its session ("closed" or "failed").
    private gatewayEnded = false;
    // Blanked out of every error text (the ticket, as is and in the URL).
    private secrets: string[] = [];
    private resizeTimer: ReturnType<typeof setTimeout> | null = null;
    private lingerTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly cleanups: Array<() => void> = [];

    constructor(
        private readonly mount: HTMLElement,
        private readonly onStatus: (status: RdpStatus) => void,
        private readonly deps: RdpConnectionDeps = defaultDeps
    ) {}

    get isConnected(): boolean {
        return this.connected && !this.finished;
    }

    // The element keyboard focus goes to for the remote desktop.
    get focusTarget(): HTMLElement | null {
        return this.element;
    }

    async start(options: RdpConnectOptions): Promise<void> {
        this.emit({ kind: 'connecting', step: 'loading', via: null, account: null });
        try {
            const socket = this.deps.createSocket();
            this.socket = socket;
            socket.on('rdp-status', (event) => this.onGatewayStatus(event));
            // The client (WebAssembly, ~6 MB: long on a slow link) and its
            // element first: the ticket expires within seconds, and the saved
            // password is handed over only when the client uses it at once.
            const client = await this.deps.loadClient().catch((error: unknown) => {
                throw new FailureError({ code: 'RDP_CLIENT_LOAD', message: errorText(error) });
            });
            if (this.finished) return;
            const ui = await this.mountElement(client, options);
            if (this.finished) return;
            if (this.clipboard === 'on') await settleClipboardInit();
            if (this.finished) return;

            const opened = await this.open(options);
            if (this.finished) return;
            if (!opened.ok) throw new FailureError({ code: opened.code, message: opened.error });
            this.sessionId = opened.sessionId;
            this.secrets = [opened.ticket, encodeURIComponent(opened.ticket)];
            this.via = opened.via;
            const typed = options.credentials.kind === 'typed' ? options.credentials : null;
            const username = typed ? typed.username : opened.username;
            const domain = typed ? typed.domain : opened.domain;
            this.account = domain ? `${domain}\\${username}` : username;
            this.emit({ kind: 'connecting', step: 'server', via: this.via, account: this.account });

            const desktop = clampDesktopSize(options.desktop.width, options.desktop.height);
            const config = ui.configBuilder()
                .withUsername(username)
                .withPassword(typed ? typed.password : opened.password ?? '')
                .withServerDomain(domain)
                .withDestination(opened.destination)
                .withProxyAddress(gatewayUrl(this.deps.apiBase(), opened))
                .withAuthToken(opened.ticket)
                .withDesktopSize(desktop)
                .withExtension(client.displayControl(true))
                .withExtension(client.enableCredssp(true))
                .build();

            let info;
            try {
                info = await withTimeout(ui.connect(config), RDP_TIMEOUTS.connect, () => new FailureError({ code: 'RDP_SIGN_IN_TIMEOUT' }));
            } catch (error) {
                throw new FailureError(await this.connectFailure(error));
            }
            if (this.finished) {
                ui.shutdown();
                return;
            }
            ui.setVisibility(true);
            this.connected = true;
            this.since = Date.now();
            const size = info.initialDesktopSize;
            this.desktop = { width: size.width, height: size.height };
            this.emitConnected();
            info.run().then(
                (termination) => {
                    let reason: string | null = null;
                    try {
                        reason = firstLine(termination.reason()) || null;
                    } catch {
                        reason = null;
                    }
                    this.finish({ kind: 'ended', byUser: this.userEnded, reason });
                },
                (error: unknown) => {
                    this.finish(this.userEnded
                        ? { kind: 'ended', byUser: true, reason: null }
                        : { kind: 'failed', failure: { code: 'RDP_CONNECTION_LOST', message: errorText(error, this.secrets) } });
                }
            );
        } catch (error) {
            this.finish({ kind: 'failed', failure: error instanceof FailureError ? error.failure : { code: 'RDP_CLIENT_ERROR', message: errorText(error, this.secrets) } });
        }
    }

    // Ends the session (signs nothing out: the Windows session stays, like
    // closing mstsc). Cancels a connection still being made.
    disconnect(): void {
        if (this.finished) return;
        this.userEnded = true;
        this.announceEnd();
        if (this.connected && this.ui) {
            this.ui.shutdown();
            // run() settles with the end of the session; this is the fallback.
            setTimeout(() => this.finish({ kind: 'ended', byUser: true, reason: null }), 3000);
        } else {
            this.finish({ kind: 'cancelled' });
        }
    }

    // Unmounting (the tab or the server was closed): ends everything
    // without reporting.
    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        if (!this.finished) this.announceEnd();
        if (this.connected && !this.finished) {
            try { this.ui?.shutdown(); } catch { /* already ended */ }
        }
        this.finished = true;
        this.cleanup();
    }

    ctrlAltDel(): void {
        if (this.isConnected) this.ui?.ctrlAltDel();
    }

    // Presses and releases `codes` (KeyboardEvent codes) in the remote desktop.
    sendKeys(codes: readonly string[]): void {
        const element = this.element;
        if (!this.isConnected || !element) return;
        element.focus({ preventScroll: true });
        for (const event of comboEvents(codes)) element.dispatchEvent(event);
    }

    // Lets go of every key and mouse button the remote desktop still sees
    // pressed (focus moved away in the middle of a shortcut).
    releaseInputs(): void {
        this.canvas?.dispatchEvent(new MouseEvent('mouseleave'));
    }

    focus(): void {
        if (this.isConnected) this.element?.focus({ preventScroll: true });
    }

    // Asks the server for another desktop size (display control channel).
    resize(size: DesktopSize): void {
        if (!this.isConnected || !this.ui) return;
        const target = clampDesktopSize(size.width, size.height);
        if (target.width === this.desktop.width && target.height === this.desktop.height) return;
        this.ui.resize(target.width, target.height);
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        this.resizeTimer = setTimeout(() => {
            this.resizeTimer = null;
            // The server kept its size: lay the screen out at that size again.
            if (this.ui && (this.desktop.width !== target.width || this.desktop.height !== target.height)) this.ui.setScale(3 as never);
        }, RDP_TIMEOUTS.resize);
    }

    // Offers the local clipboard to the remote desktop (when it gets focus).
    syncClipboard(): void {
        if (!this.isConnected || this.clipboard !== 'on' || !this.ui) return;
        this.ui.sendClipboardData().catch(() => undefined);
    }

    private emit(status: RdpStatus): void {
        if (!this.disposed) this.onStatus(status);
    }

    private emitConnected(): void {
        this.emit({
            kind: 'connected',
            since: this.since,
            desktop: { ...this.desktop },
            via: this.via,
            account: this.account,
            certificate: this.certificate,
            pinnedNow: this.pinnedNow,
            clipboard: this.clipboard
        });
    }

    private finish(status: Extract<RdpStatus, { kind: 'ended' | 'cancelled' | 'failed' }>): void {
        if (this.finished) return;
        this.finished = true;
        if (status.kind === 'ended') this.announceEnd(status.byUser ? 'user' : 'remote', status.reason ?? '');
        else if (status.kind === 'failed') this.announceEnd('error', status.failure.message ? `${status.failure.code}: ${status.failure.message}` : status.failure.code);
        else this.announceEnd();
        this.emit(status);
        this.cleanup();
    }

    private cleanup(): void {
        if (this.resizeTimer) clearTimeout(this.resizeTimer);
        for (const cleanup of this.cleanups.splice(0)) cleanup();
        this.element?.remove();
        this.element = null;
        this.canvas = null;
        this.ui = null;
        // The gateway ends its sessions when their socket goes away: until it
        // reports the end itself (or a moment passes) the socket stays.
        if (this.sessionId && !this.gatewayEnded) this.lingerTimer ??= setTimeout(() => this.releaseSocket(), RDP_TIMEOUTS.linger);
        else this.releaseSocket();
        for (const waiter of this.gatewayWaiters.splice(0)) waiter();
    }

    private releaseSocket(): void {
        if (this.lingerTimer) clearTimeout(this.lingerTimer);
        this.lingerTimer = null;
        this.socket?.disconnect();
        this.socket = null;
    }

    // Tells the gateway how this session ended: the client does not always
    // close its WebSocket when the remote desktop or an error ends it, and
    // the audit log says who ended it. A session still being set up that
    // the user cancels stops at once.
    private announceEnd(cause: RdpEndCause = 'user', detail = ''): void {
        if (this.endAnnounced || this.gatewayEnded || !this.sessionId || !this.socket) return;
        this.endAnnounced = true;
        this.socket.emit('rdp-disconnect', { sessionId: this.sessionId, cause, ...(detail ? { detail } : {}) });
    }

    private open(options: RdpConnectOptions): Promise<RdpOpenResult> {
        const request: RdpOpenRequest = options.credentials.kind === 'typed'
            ? { serverId: options.serverId, credentials: 'prompt', username: options.credentials.username, domain: options.credentials.domain }
            : { serverId: options.serverId, credentials: 'saved' };
        return new Promise((resolve) => {
            this.socket?.timeout(RDP_TIMEOUTS.open).emit('rdp-open', request, (error: Error | null, result: RdpOpenResult) => {
                resolve(error ? { ok: false, code: 'RDP_BACKEND_TIMEOUT', error: 'The backend did not answer in time.' } : result);
            });
        });
    }

    private onGatewayStatus(event: RdpStatusEvent): void {
        if (event.sessionId !== this.sessionId) return;
        if (event.phase === 'closed' || event.phase === 'failed') {
            this.gatewayEnded = true;
            if (this.finished) this.releaseSocket();
        }
        if (this.finished) return;
        if (event.phase === 'failed') {
            this.gatewayFailure = event.error ?? { code: 'RDP_INTERNAL', message: '' };
            for (const waiter of this.gatewayWaiters.splice(0)) waiter();
            return;
        }
        if (this.connected) return;
        if (event.phase === 'established') {
            this.certificate = event.certificate ?? null;
            this.pinnedNow = Boolean(event.pinnedNow);
            this.emit({ kind: 'connecting', step: 'signing-in', via: this.via, account: this.account });
        } else if (event.phase === 'securing') {
            this.emit({ kind: 'connecting', step: 'securing', via: this.via, account: this.account });
        }
    }

    // The gateway's reason when it has one (it may arrive just after the
    // client gives up), else the client's.
    private async connectFailure(error: unknown): Promise<RdpFailure> {
        if (error instanceof FailureError) return error.failure;
        const kind = isIronError(error) ? error.kind() : IRON_KIND.general;
        if (kind === IRON_KIND.wrongPassword) return { code: 'RDP_WRONG_PASSWORD' };
        if (kind === IRON_KIND.logonFailure) return { code: 'RDP_LOGON_FAILURE' };
        if (kind === IRON_KIND.accessDenied) return { code: 'RDP_ACCESS_DENIED' };
        if (!this.gatewayFailure && !this.finished) {
            await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, RDP_TIMEOUTS.gatewayReport);
                this.gatewayWaiters.push(() => {
                    clearTimeout(timer);
                    resolve();
                });
            });
        }
        const gateway = this.gatewayFailure;
        if (gateway) return { code: gateway.code, message: gateway.message, details: gateway.details, mismatch: gateway.mismatch };
        const message = errorText(error, this.secrets);
        if (kind === IRON_KIND.negotiationFailure) return { code: 'RDP_NEGOTIATION_FAILED', message };
        if (kind === IRON_KIND.proxyConnect || kind === IRON_KIND.rdCleanPath) return { code: 'RDP_GATEWAY', message };
        return { code: 'RDP_CLIENT_ERROR', message };
    }

    // Creates the element and waits for it; the clipboard is set up while it
    // announces itself (it starts its clipboard support right after).
    private mountElement(client: IronRdpClient, options: RdpConnectOptions): Promise<UserInteraction> {
        const element = document.createElement('iron-remote-desktop') as RemoteDesktopElement;
        element.module = client.backend;
        element.scale = 'real';
        element.verbose = 'false';
        element.flexcenter = 'false';
        element.style.display = 'block';
        this.element = element;
        const ready = new Promise<UserInteraction>((resolve, reject) => {
            const timer = setTimeout(() => reject(new FailureError({ code: 'RDP_CLIENT_ERROR', message: 'The Remote Desktop component did not start.' })), RDP_TIMEOUTS.ready);
            element.addEventListener('ready', (event) => {
                clearTimeout(timer);
                const ui = (event as CustomEvent<{ irgUserInteraction: UserInteraction }>).detail.irgUserInteraction;
                this.ui = ui;
                this.configureClipboard(ui, options.clipboard);
                ui.setKeyboardUnicodeMode(options.keyboard === 'unicode');
                this.adapt(element);
                resolve(ui);
            }, { once: true });
        });
        this.mount.appendChild(element);
        return ready;
    }

    // Manual clipboard mode: the remote clipboard is copied when it changes,
    // the local one is offered when the remote desktop gets the focus (not
    // polled while the user works elsewhere in the app).
    private configureClipboard(ui: UserInteraction, enabled: boolean): void {
        const available = typeof window !== 'undefined' && window.isSecureContext && typeof navigator.clipboard !== 'undefined';
        if (!enabled || !available) {
            ui.setEnableClipboard(false);
            this.clipboard = enabled ? 'unavailable' : 'off';
            return;
        }
        ui.setEnableClipboard(true);
        ui.setEnableAutoClipboard(false);
        ui.onClipboardRemoteUpdateCallback(() => {
            ui.saveRemoteClipboardData().catch(() => undefined);
        });
        ui.onWarningCallback((message: string) => {
            if (/clipboard/i.test(message) && /not supported|secure contexts/i.test(message)) {
                this.clipboard = 'unavailable';
                if (this.isConnected) this.emitConnected();
            }
        });
        this.clipboard = 'on';
    }

    private adapt(element: RemoteDesktopElement): void {
        const root = element.shadowRoot;
        if (!root) return;
        const style = document.createElement('style');
        style.textContent = SHADOW_CSS;
        root.appendChild(style);
        const canvas = root.querySelector('canvas');
        if (!canvas) return;
        this.canvas = canvas;
        const focused = () => document.activeElement === element;
        // The element takes the keyboard focus when the pointer merely passes
        // over it, which would steal typing from the rest of the app: here it
        // takes it on a click.
        const onEnter = (event: Event) => {
            if (!focused()) event.stopImmediatePropagation();
        };
        const onDown = () => {
            if (!focused()) element.focus({ preventScroll: true });
        };
        canvas.addEventListener('mouseenter', onEnter, true);
        canvas.addEventListener('mousedown', onDown, true);
        const observer = new MutationObserver(() => {
            if (canvas.width === this.desktop.width && canvas.height === this.desktop.height) return;
            this.desktop = { width: canvas.width, height: canvas.height };
            if (this.isConnected) this.emitConnected();
        });
        observer.observe(canvas, { attributes: true, attributeFilter: ['width', 'height'] });
        this.cleanups.push(() => {
            observer.disconnect();
            canvas.removeEventListener('mouseenter', onEnter, true);
            canvas.removeEventListener('mousedown', onDown, true);
        });
    }
}
