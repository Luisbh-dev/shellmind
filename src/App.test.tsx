import { afterEach, beforeAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Suspense, lazy, useEffect, useState } from 'react';
import userEvent from '@testing-library/user-event';
import { EditorView } from '@codemirror/view';
import type { ServerSummary } from '@shared/types';
import type { FileClient } from '@/features/files/client';
import App from './App';
import { setLanguage } from '@/i18n';
import { flushTerminalIssues, useTerminalIssueStore } from '@/lib/terminalIssues';
import { MAX_OPEN_SERVERS, QUEUED_COMMAND_TTL_MS, useAppStore } from '@/store/appStore';
import { resetServersStore } from '@/store/servers';
import { useOrganizationPrefs } from '@/features/organization/prefs';
import { ToastProvider } from '@/components/ui/Toast';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { useRdpStore } from '@/features/rdp/store';

// Panels are replaced by markers: this test covers the shell (registry, store
// and i18n wiring), not xterm or the socket-backed panels.
const crash = { terminal: false };
// What the terminals saw: their callbacks per server, how often their server
// prop changed (a real panel reconnects then) and how often they mounted.
const terminalProbe: {
    onOsDetected: ((os: string) => void) | null;
    onOutput: Record<number, (data: string) => void>;
    serverChanges: number;
    mounts: number;
} = { onOsDetected: null, onOutput: {}, serverChanges: 0, mounts: 0 };
vi.mock('@/features/terminal/TerminalPanel', () => ({
    default: function TerminalMock({ server, onOsDetected, onOutput }: {
        server: ServerSummary;
        onOsDetected: (os: string) => void;
        onOutput: (data: string, sessionId: string, size: { cols: number; rows: number }) => void;
    }) {
        if (crash.terminal) throw new Error('xterm exploded');
        terminalProbe.onOsDetected = onOsDetected;
        terminalProbe.onOutput[server.id] = (data) => onOutput(data, 'term-1', { cols: 80, rows: 24 });
        useEffect(() => {
            terminalProbe.serverChanges += 1;
        }, [server]);
        useEffect(() => {
            terminalProbe.mounts += 1;
        }, []);
        return (
            <div data-testid="panel">
                terminal:{server.id}:{server.name}
                {/* Like xterm: key events come from a textarea inside .xterm. */}
                <div className="xterm"><textarea aria-label="terminal input" /></div>
            </div>
        );
    }
}));
// With editorProbe.enabled a Files panel also opens the real editor on a file
// of its own (/srv/<server id>.txt), to see what one left in the background does.
type EditorClientMock = { read: Mock<() => Promise<unknown>>; write: Mock<(path: string, data: Uint8Array) => Promise<unknown>> };
const editorProbe: { enabled: boolean; clients: Record<number, EditorClientMock>; closed: number[] } = { enabled: false, clients: {}, closed: [] };
const fileStat = (size: number, mtime: number) => ({ isDir: false, isLink: false, size, mtime, permissions: 0o644 });
const editorClient = (serverId: number): EditorClientMock => (editorProbe.clients[serverId] ??= {
    read: vi.fn(async () => ({ path: `/srv/${serverId}.txt`, data: new TextEncoder().encode('line one\n'), stat: fileStat(9, 1000) })),
    write: vi.fn(async (_path: string, data: Uint8Array) => ({ path: `/srv/${serverId}.txt`, stat: fileStat(data.length, 2000) }))
});
const LazyRemoteEditor = lazy(() => import('@/features/editor/RemoteEditor'));
vi.mock('@/features/files/FileExplorer', () => ({
    default: ({ server, isActive }: { server: ServerSummary; isActive: boolean }) => (
        <div data-testid="panel">
            files:{server.id}
            {editorProbe.enabled && (
                <Suspense fallback={null}>
                    <LazyRemoteEditor
                        serverId={server.id}
                        active={isActive}
                        client={editorClient(server.id) as unknown as FileClient}
                        path={`/srv/${server.id}.txt`}
                        name={`${server.id}.txt`}
                        maxBytes={1024}
                        onClose={() => editorProbe.closed.push(server.id)}
                        onDownload={() => undefined}
                    />
                </Suspense>
            )}
        </div>
    )
}));
vi.mock('@/features/status/StatusDashboard', () => ({
    default: ({ server }: { server: ServerSummary }) => <div data-testid="panel">status:{server.id}</div>
}));
vi.mock('@/features/ops/OperationsPanel', () => ({
    default: ({ server }: { server: ServerSummary }) => <div data-testid="panel">operations:{server.id}</div>
}));
vi.mock('@/features/rdp/RdpPanel', () => ({
    default: ({ server }: { server: ServerSummary }) => <div data-testid="panel">rdp:{server.id}</div>
}));
// A chat with local state shows whether it survives being hidden or another
// server being shown.
// The states it is given are kept as data attributes (W7-S6).
vi.mock('@/features/chat/ChatPanel', () => ({
    default: function ChatMock({ activeServer, connectionState, shellState }: { activeServer: ServerSummary | null; connectionState?: string; shellState?: string }) {
        const [draft, setDraft] = useState('');
        return (
            <textarea
                aria-label={`chat draft ${activeServer?.name ?? 'none'}`}
                data-connection={connectionState}
                data-shell={shellState}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
            />
        );
    }
}));

let servers: ServerSummary[];

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const defaultRoutes = async (url: string) => {
    if (url.endsWith('/api/servers')) return json({ message: 'success', data: servers });
    return json({});
};
const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

// The dialogs load their code on first use; transforming it once up front
// keeps the tests that open them from racing their first download.
beforeAll(async () => {
    await Promise.all([import('@/components/AddServerModal'), import('@/components/SettingsModal')]);
}, 60_000);

beforeEach(() => {
    setLanguage('en');
    crash.terminal = false;
    editorProbe.enabled = false;
    editorProbe.clients = {};
    editorProbe.closed = [];
    terminalProbe.onOsDetected = null;
    terminalProbe.onOutput = {};
    terminalProbe.serverChanges = 0;
    terminalProbe.mounts = 0;
    servers = [
        { id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux', username: 'root', tags: ['prod'] },
        { id: 2, name: 'backups', ip: '', type: 's3', s3_bucket: 'nightly' },
        { id: 3, name: 'db-1', ip: '10.0.0.6', type: 'linux', group_name: 'Databases' }
    ];
    useAppStore.setState(useAppStore.getInitialState(), true);
    resetServersStore();
    fetchMock.mockReset();
    fetchMock.mockImplementation(defaultRoutes);
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setLanguage('system');
    localStorage.clear();
});

const renderApp = () => render(<ToastProvider><ConfirmProvider><App /></ConfirmProvider></ToastProvider>);

// The panel on screen: inside no hidden server, no hidden tab.
const visiblePanel = () => screen.queryAllByTestId('panel').find((panel) => !panel.closest('.hidden'));
const expectVisible = (text: string) => waitFor(() => expect(visiblePanel()).toHaveTextContent(text));
const panelTexts = () => screen.queryAllByTestId('panel').map((panel) => panel.textContent);

// Panels, dialogs and the chat load their code first.
const loaded = () => waitFor(() => expect(screen.queryAllByRole('status', { name: 'Loading…' })).toEqual([]));

// The saved connections list (the welcome screen lists some of them too).
const sidebar = () => within(screen.getByRole('navigation', { name: 'Saved connections' }));
const row = (name: string) => sidebar().getByRole('button', { name: new RegExp(`^${name}`) });

async function selectServer(name: string) {
    fireEvent.click(await sidebar().findByRole('button', { name: new RegExp(`^${name}`) }));
    await waitFor(() => expect(row(name)).toHaveAttribute('aria-current', 'true'));
    await loaded();
}

const press = (key: string, mods: Partial<KeyboardEventInit> = {}) =>
    act(() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, cancelable: true, ...mods }));
    });

// A key pressed with the focus on `target` (it bubbles up to window).
const keyOn = (target: Element, init: KeyboardEventInit) => act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }));
});

// The editor a Files panel opened (editorProbe), once its text is there.
async function editorOf(name: string): Promise<EditorView> {
    const content = await screen.findByRole('textbox', { name: `Contents of ${name}` }, { timeout: 5000 });
    const view = EditorView.findFromDOM(content as HTMLElement);
    if (!view) throw new Error(`no editor for ${name}`);
    return view;
}

const typeInto = (view: EditorView, text: string) => act(() => {
    view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
});

// A live terminal session on the server, as its terminal panel reports one.
const connectTerminal = (serverId: number) => act(() => {
    const store = useAppStore.getState();
    const sessionId = store.openTerminalSession(serverId);
    store.setTerminalSessionState(serverId, sessionId, { state: 'connected' });
});

describe('App shell', () => {
    it('shows the empty workspace and the saved connections, grouped', async () => {
        renderApp();

        expect(screen.getAllByText('No connection selected').length).toBeGreaterThan(0);
        expect(await sidebar().findByRole('button', { name: /^web-1/ })).toBeInTheDocument();
        expect(sidebar().getByRole('button', { name: /^backups/ })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /Databases/, expanded: true })).toBeInTheDocument();
    });

    it('builds the tabs from the registry and mounts a tab’s panel when it is first opened', async () => {
        renderApp();
        await selectServer('web-1');

        const tablist = screen.getByRole('tablist', { name: 'Workspace' });
        expect(within(tablist).getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['SSH', 'Files', 'Status', 'Operations', 'Tunnels']);
        expect(within(tablist).getByRole('tab', { name: 'SSH' })).toHaveAttribute('aria-selected', 'true');
        await expectVisible('terminal:1');
        // The hidden tabs have not loaded anything (no file session for Files).
        expect(panelTexts()).toEqual(['terminal:1:web-1']);

        fireEvent.click(within(tablist).getByRole('tab', { name: 'Status' }));
        await expectVisible('status:1');
        expect(panelTexts()).toEqual(['terminal:1:web-1', 'status:1']);

        await selectServer('backups');
        expect(within(screen.getByRole('tablist')).queryByRole('tab', { name: 'SSH' })).toBeNull();
        await expectVisible('files:2');
    });

    // --- W8-T2 Kubernetes ---
    it("shows a Linux server's Kubernetes tab once its terminal is up and kubectl was found there", async () => {
        const status = { runner: 'ssh', available: true, problem: null, kubectl: { path: '/usr/bin/kubectl', version: 'v1.31.4' }, sudo: false, contexts: [], currentContext: null, unsupportedContexts: [], installUrl: '', detectedAt: 0 };
        fetchMock.mockImplementation(async (url: string) => (/\/api\/servers\/[13]\/k8s\/status$/.test(url) ? json(url.includes('/1/') ? status : { ...status, available: false, problem: { code: 'KUBECTL_MISSING', message: '' } }) : defaultRoutes(url)));
        renderApp();
        await selectServer('web-1');
        const tabs = () => within(screen.getByRole('tablist', { name: 'Workspace' })).getAllByRole('tab').map((tab) => tab.textContent);
        expect(tabs()).toEqual(['SSH', 'Files', 'Status', 'Operations', 'Tunnels']);
        // Looked for in the background over the terminal's connection.
        connectTerminal(1);
        await waitFor(() => expect(tabs()).toEqual(['SSH', 'Files', 'Status', 'Operations', 'Kubernetes', 'Tunnels']));
        expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/servers/1/k8s/status'))).toHaveLength(1);
        // A server without kubectl gets none.
        await selectServer('db-1');
        connectTerminal(3);
        await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/servers/3/k8s/status'))).toHaveLength(1));
        expect(tabs()).toEqual(['SSH', 'Files', 'Status', 'Operations', 'Tunnels']);
    });

    // The terminal reports the server's connection (header, sidebar, chat).
    it('mounts the terminal of a server that opens on another tab, hidden', async () => {
        servers = [{ id: 4, name: 'ftp-1', ip: '10.0.0.9', type: 'ftp' }];
        renderApp();
        await selectServer('ftp-1');

        const tablist = screen.getByRole('tablist', { name: 'Workspace' });
        expect(within(tablist).getByRole('tab', { name: 'Files' })).toHaveAttribute('aria-selected', 'true');
        await expectVisible('files:4');
        await waitFor(() => expect(panelTexts()).toEqual(expect.arrayContaining(['files:4', 'terminal:4:ftp-1'])));
        expect(visiblePanel()).toHaveTextContent('files:4');
    });

    it('switches tabs with the arrow keys and with Mod+1…9', async () => {
        renderApp();
        await selectServer('web-1');
        const tablist = screen.getByRole('tablist');

        fireEvent.keyDown(within(tablist).getByRole('tab', { name: 'SSH' }), { key: 'ArrowRight' });
        await expectVisible('files:1');
        expect(within(tablist).getByRole('tab', { name: 'Files' })).toHaveFocus();

        press('3');
        await expectVisible('status:1');
        press('1');
        await expectVisible('terminal:1');
    });

    // UX-06: the tab was scrolled into view before the "All tabs" button
    // appeared and narrowed the strip, which left it half hidden.
    it('keeps the current tab in sight when the strip narrows, and when it is picked again', async () => {
        const observers: Array<() => void> = [];
        vi.stubGlobal('ResizeObserver', class {
            constructor(callback: () => void) {
                observers.push(callback);
            }
            observe() {}
            disconnect() {}
        });
        const frames = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
            callback(0);
            return 0;
        });
        const scrolled: Element[] = [];
        const original = Element.prototype.scrollIntoView;
        Element.prototype.scrollIntoView = function scrollIntoView(this: Element) {
            scrolled.push(this);
        };
        try {
            renderApp();
            await selectServer('web-1');
            const tablist = screen.getByRole('tablist', { name: 'Workspace' });
            const strip = tablist.parentElement!;
            let width = 640;
            Object.defineProperty(strip, 'clientWidth', { configurable: true, get: () => width });
            Object.defineProperty(strip, 'scrollWidth', { configurable: true, get: () => 900 });
            const sshTab = within(tablist).getByRole('tab', { name: 'SSH' });
            scrolled.length = 0;
            width = 600;
            act(() => observers.forEach((check) => check()));
            expect(scrolled).toContain(sshTab);

            scrolled.length = 0;
            fireEvent.click(sshTab);
            expect(scrolled).toContain(sshTab);
        } finally {
            Element.prototype.scrollIntoView = original;
            frames.mockRestore();
            vi.unstubAllGlobals();
        }
    });

    it('translates the shell when the language changes', async () => {
        renderApp();
        await selectServer('web-1');

        act(() => setLanguage('es'));

        const tablist = screen.getByRole('tablist');
        expect(within(tablist).getByRole('tab', { name: 'Archivos' })).toBeInTheDocument();
        expect(within(tablist).getByRole('tab', { name: 'Estado' })).toBeInTheDocument();
        expect(screen.getByText('Ajustes')).toBeInTheDocument();
    });

    it('brings the terminal forward for queued commands and surfaces them until delivered', async () => {
        renderApp();
        await selectServer('web-1');
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Files' }));
        await expectVisible('files:1');

        act(() => useAppStore.getState().queueCommand(1, 'df -h', 'ai'));

        await expectVisible('terminal:1');
        const notice = screen.getByText(/1 command is waiting/).closest('[role="status"]') as HTMLElement;
        expect(notice).toHaveTextContent('dropped after 2 minutes');

        fireEvent.click(within(notice).getByRole('button', { name: 'Discard' }));
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
        expect(screen.queryByText(/1 command is waiting/)).toBeNull();
    });

    it('brings the terminal forward when a terminal tab is opened from another panel', async () => {
        renderApp();
        await selectServer('web-1');
        // The first tab a terminal panel opens when it mounts changes nothing.
        act(() => {
            useAppStore.getState().openTerminalSession(1);
        });
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Status' }));
        await expectVisible('status:1');

        act(() => {
            useAppStore.getState().openTerminalSession(1);
        });
        await expectVisible('terminal:1');
    });

    it('opens the server and the tab another panel asks for', async () => {
        renderApp();
        expect(await sidebar().findByRole('button', { name: /^web-1/ })).toBeInTheDocument();

        act(() => useAppStore.getState().requestServerTab(1, 'status'));
        await waitFor(() => expect(row('web-1')).toHaveAttribute('aria-current', 'true'));
        await loaded();
        await expectVisible('status:1');
        expect(useAppStore.getState().serverTabRequest).toBeNull();

        // A tab the server does not have leaves it on the one it shows.
        act(() => useAppStore.getState().requestServerTab(1, 'rdp'));
        await waitFor(() => expect(useAppStore.getState().serverTabRequest).toBeNull());
        await expectVisible('status:1');
        expect(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Status' })).toHaveAttribute('aria-selected', 'true');
    });

    it('reflects the connection state reported for the active server, also in the sidebar', async () => {
        renderApp();
        await selectServer('web-1');
        const header = screen.getByRole('banner');
        expect(within(header).getByText(/Connecting/)).toBeInTheDocument();

        act(() => useAppStore.getState().setConnection(1, { state: 'error', error: 'Auth failed' }));

        expect(within(header).getByText(/Error/)).toBeInTheDocument();
        expect(within(row('web-1')).getByRole('img', { name: 'Error' })).toBeInTheDocument();
        // No dot for servers without a session.
        expect(within(row('db-1')).queryByRole('img', { name: /Connected|Error|Connecting/ })).toBeNull();
    });

    it('shows the file session of an S3 server as its connection state', async () => {
        renderApp();
        await selectServer('backups');
        const header = screen.getByRole('banner');
        // Nothing is assumed before the files panel reports.
        expect(within(header).getByText(/Connecting/)).toBeInTheDocument();

        act(() => useAppStore.getState().setConnection(2, { state: 'error', error: 'InvalidAccessKeyId' }));
        expect(within(header).getByText(/Error/)).toBeInTheDocument();
        expect(within(row('backups')).getByRole('img', { name: 'Error' })).toBeInTheDocument();

        act(() => useAppStore.getState().setConnection(2, { state: 'connected' }));
        expect(within(header).getByRole('img', { name: 'Connected' })).toBeInTheDocument();
        expect(within(header).queryByText(/Error|Connecting/)).toBeNull();
    });

    it('leaves the session alone when the active server is selected again', async () => {
        renderApp();
        await selectServer('web-1');
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Files' }));
        await expectVisible('files:1');
        act(() => useAppStore.getState().setConnection(1, { state: 'connected' }));

        await selectServer('web-1');

        expect(visiblePanel()).toHaveTextContent('files:1');
        expect(within(screen.getByRole('banner')).queryByText(/Connecting/)).toBeNull();
        expect(row('web-1')).toHaveAttribute('aria-current', 'true');
    });

    it('replaces the open server object after it is edited', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith('/api/servers/1') && init?.method === 'PUT') {
                const body = JSON.parse(String(init.body)) as Partial<ServerSummary>;
                servers = servers.map((server) => (server.id === 1 ? { ...server, name: body.name ?? server.name, ip: body.ip ?? server.ip } : server));
                return json({ message: 'success', changes: 1, data: servers[0] });
            }
            if (url.endsWith('/api/servers')) return json({ message: 'success', data: servers });
            return json({});
        });
        renderApp();
        await selectServer('web-1');
        await expectVisible('terminal:1:web-1');

        fireEvent.click(screen.getByRole('button', { name: 'Edit web-1' }));
        const dialog = await screen.findByRole('dialog', { name: 'Edit connection' });
        fireEvent.change(within(dialog).getByLabelText(/Display name/), { target: { value: 'web-1-renamed' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(within(screen.getByRole('banner')).getByText('web-1-renamed')).toBeInTheDocument());
        expect(visiblePanel()).toHaveTextContent('terminal:1:web-1-renamed');
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('keeps the open server object, and so its sessions, across refreshes that are not an edit of it', async () => {
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url.endsWith('/api/servers/1/os')) {
                const { os_detail } = JSON.parse(String(init?.body)) as { os_detail: string };
                servers = servers.map((server) => (server.id === 1 ? { ...server, os_detail } : server));
                return json({ message: 'success' });
            }
            if (url.endsWith('/api/servers/2') && init?.method === 'DELETE') {
                // The manual order comes back renumbered, as after a reorder.
                servers = servers.filter((server) => server.id !== 2).map((server, index) => ({ ...server, sort_order: index + 5 }));
                return json({ message: 'deleted' });
            }
            if (url.endsWith('/api/servers')) return json({ message: 'success', data: servers });
            return json({});
        });
        const user = userEvent.setup();
        renderApp();
        await selectServer('web-1');
        await expectVisible('terminal:1');
        act(() => terminalProbe.onOsDetected?.('Ubuntu 24.04'));
        await waitFor(() => expect(servers[0].os_detail).toBe('Ubuntu 24.04'));
        const changes = terminalProbe.serverChanges;

        // The row's actions are out of the Tab order; the menu key reaches them too.
        await user.click(screen.getByRole('button', { name: 'More actions for backups' }));
        await user.click(screen.getByRole('menuitem', { name: 'Delete' }));
        await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(sidebar().queryByRole('button', { name: /^backups/ })).toBeNull());

        expect(terminalProbe.serverChanges).toBe(changes);
        expect(within(screen.getByRole('banner')).getByText('web-1')).toBeInTheDocument();
    });

    it('leaves Ctrl+K to the program in the terminal and opens the palette there with Mod+Shift+P', async () => {
        renderApp();
        await selectServer('web-1');
        const input = await screen.findByRole('textbox', { name: 'terminal input' });

        const ctrlK = new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true });
        act(() => {
            input.dispatchEvent(ctrlK);
        });
        expect(ctrlK.defaultPrevented).toBe(false);
        expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();

        const ctrlShiftP = new KeyboardEvent('keydown', { key: 'P', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true });
        act(() => {
            input.dispatchEvent(ctrlShiftP);
        });
        expect(ctrlShiftP.defaultPrevented).toBe(true);
        expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    });


    it('keeps the chat mounted while its panel is closed, and moves the focus with it', async () => {
        renderApp();
        await selectServer('web-1');
        const draft = await screen.findByRole('textbox', { name: 'chat draft web-1' });
        fireEvent.change(draft, { target: { value: 'half-typed question' } });

        const toggle = within(screen.getByRole('banner')).getByRole('button', { name: 'AI chat' });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        // Hidden with the focus inside: the focus goes to the toggle, not to <body>.
        draft.focus();
        press('A', { shiftKey: true });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(document.getElementById('chat-panel')).toHaveClass('hidden');
        expect(toggle).toHaveFocus();

        // Shown from the keyboard: the composer takes the focus.
        press('A', { shiftKey: true });
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('textbox', { name: 'chat draft web-1' })).toHaveValue('half-typed question');
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'chat draft web-1' })).toHaveFocus());
    });

    it('explains why the chat is not available for an S3 bucket', async () => {
        renderApp();
        await selectServer('backups');
        const toggle = within(screen.getByRole('banner')).getByRole('button', { name: 'AI chat' });
        expect(toggle).toBeEnabled();
        expect(toggle).toHaveAttribute('aria-disabled', 'true');
        expect(toggle).toHaveAccessibleDescription('The AI assistant is not available for S3 buckets');
        expect(document.getElementById('chat-panel')).toHaveClass('hidden');
    });

    it('shows a load error with a retry instead of an empty list', async () => {
        fetchMock.mockImplementationOnce(async () => json({ error: 'database is locked' }, 500));
        renderApp();

        const alert = await screen.findByRole('alert');
        expect(alert).toHaveTextContent('Could not load your connections');
        expect(alert).toHaveTextContent('database is locked');

        fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
        expect(await sidebar().findByRole('button', { name: /^web-1/ })).toBeInTheDocument();
    });

    it('contains a crashing panel and reloads it on request', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // React re-throws render errors to window in development builds.
        const silence = (event: ErrorEvent) => event.preventDefault();
        window.addEventListener('error', silence);
        crash.terminal = true;
        renderApp();
        await selectServer('web-1');

        const fallback = await screen.findByRole('alert');
        expect(fallback).toHaveTextContent('SSH stopped working');
        expect(fallback).toHaveTextContent('xterm exploded');
        // Nothing reports the connection now: the header says it failed, not "Connecting".
        const header = within(screen.getByRole('banner'));
        expect(await header.findByRole('img', { name: 'Error' })).toBeInTheDocument();
        expect(header.queryByText(/Connecting/)).toBeNull();
        // The rest of the app still works.
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Files' }));
        await expectVisible('files:1');

        crash.terminal = false;
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'SSH' }));
        fireEvent.click(screen.getByRole('button', { name: 'Reload panel' }));
        await expectVisible('terminal:1');
        expect(header.queryByRole('img', { name: 'Error' })).toBeNull();
        expect(useAppStore.getState().connections[1]).toBeUndefined();
        window.removeEventListener('error', silence);
        vi.mocked(console.error).mockRestore();
    });

    it('names the palette button by its visible text and offers a skip link to the workspace', async () => {
        renderApp();
        await selectServer('web-1');
        expect(within(screen.getByRole('banner')).getByRole('button', { name: /^Search or run a command… Ctrl\+K$/ })).toBeInTheDocument();

        const skip = screen.getByRole('link', { name: 'Skip to the workspace' });
        act(() => document.body.focus());
        await userEvent.tab();
        expect(skip).toHaveFocus();
        fireEvent.click(skip);
        expect(screen.getByRole('main').contains(document.activeElement)).toBe(true);
    });

    it('puts one sidebar entry in the Tab order and moves through the list with the arrows', async () => {
        renderApp();
        await selectServer('web-1');
        const rows = sidebar().getAllByRole('button').filter((button) => button.hasAttribute('data-roving-id'));
        expect(rows.filter((button) => button.tabIndex === 0)).toEqual([row('web-1')]);
        // The floating row actions are reached through the row's menu instead.
        expect(sidebar().getByRole('button', { name: 'Edit web-1' })).toHaveAttribute('tabindex', '-1');

        row('web-1').focus();
        fireEvent.keyDown(row('web-1'), { key: 'ArrowDown' });
        expect(document.activeElement).not.toBe(row('web-1'));
        expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
        expect(row('web-1').tabIndex).toBe(-1);
    });

    it('moves the focus between the connections, the workspace and the chat with F6', async () => {
        renderApp();
        await selectServer('web-1');
        await screen.findByRole('textbox', { name: 'chat draft web-1' });
        await screen.findByRole('textbox', { name: 'terminal input' });
        act(() => document.body.focus());

        press('F6', { ctrlKey: false });
        expect(row('web-1')).toHaveFocus();
        press('F6', { ctrlKey: false });
        expect(screen.getByRole('textbox', { name: 'terminal input' })).toHaveFocus();
        // In the terminal plain F6 belongs to the program; Ctrl+F6 moves on.
        const f6 = new KeyboardEvent('keydown', { key: 'F6', bubbles: true, cancelable: true });
        act(() => {
            document.activeElement?.dispatchEvent(f6);
        });
        expect(f6.defaultPrevented).toBe(false);
        act(() => {
            document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'F6', ctrlKey: true, bubbles: true, cancelable: true }));
        });
        expect(screen.getByRole('textbox', { name: 'chat draft web-1' })).toHaveFocus();
        press('F6', { ctrlKey: false, shiftKey: true });
        expect(screen.getByRole('textbox', { name: 'terminal input' })).toHaveFocus();
    });
});

describe('open servers', () => {
    it('keeps a server open in the background: switching back finds its sessions, chat and tab', async () => {
        renderApp();
        await selectServer('web-1');
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Status' }));
        await expectVisible('status:1');
        fireEvent.change(await screen.findByRole('textbox', { name: 'chat draft web-1' }), { target: { value: 'why is the disk full?' } });
        const mounts = terminalProbe.mounts;

        await selectServer('db-1');
        await expectVisible('terminal:3');
        // web-1 is still mounted, hidden, and marked open in the sidebar.
        expect(panelTexts()).toEqual(expect.arrayContaining(['terminal:1:web-1', 'status:1', 'terminal:3:db-1']));
        expect(row('web-1')).toHaveAccessibleName(/open in the background/);
        expect(row('db-1')).toHaveAttribute('aria-current', 'true');

        await selectServer('web-1');
        await expectVisible('status:1');
        expect(screen.getByRole('textbox', { name: 'chat draft web-1' })).toHaveValue('why is the disk full?');
        // Only db-1's terminal mounted: web-1's kept its session.
        expect(terminalProbe.mounts).toBe(mounts + 1);
    });

    it('keeps terminal output, issues and connection state per server while several are open', async () => {
        renderApp();
        await selectServer('web-1');
        await selectServer('db-1');
        await expectVisible('terminal:3');
        act(() => {
            useAppStore.getState().setConnection(1, { state: 'error', error: 'gone' });
            useAppStore.getState().setConnection(3, { state: 'connected' });
        });

        // The background terminal's output feeds its own server, not the one on screen.
        act(() => {
            terminalProbe.onOutput[1]('bash: htop: command not found\n');
            flushTerminalIssues(1);
            flushTerminalIssues(3);
        });
        expect(useTerminalIssueStore.getState().issues[1]?.map((issue) => issue.message)).toEqual(['bash: htop: command not found']);
        expect(useTerminalIssueStore.getState().issues[3] ?? []).toEqual([]);
        expect(within(screen.getByRole('banner')).getByRole('img', { name: 'Connected' })).toBeInTheDocument();
        expect(within(row('web-1')).getByRole('img', { name: 'Error' })).toBeInTheDocument();
    });

    it('closes a server from the sidebar, asking first when that loses work', async () => {
        const user = userEvent.setup();
        renderApp();
        await selectServer('web-1');
        await selectServer('db-1');
        await expectVisible('terminal:3');
        connectTerminal(1);
        const unregister = useAppStore.getState().registerUnsavedGuard(1, () => 'Unsaved changes to /etc/hosts');
        try {
            await user.click(sidebar().getByRole('button', { name: 'Close web-1' }));
            const dialog = await screen.findByRole('alertdialog', { name: 'Close web-1?' });
            expect(dialog).toHaveTextContent('Unsaved changes to /etc/hosts');
            expect(dialog).toHaveTextContent('1 live terminal session');
            await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
            expect(useAppStore.getState().openServerIds).toContain(1);
            expect(panelTexts()).toContain('terminal:1:web-1');

            await user.click(sidebar().getByRole('button', { name: 'Close web-1' }));
            await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close web-1' }));
            await waitFor(() => expect(panelTexts()).not.toContain('terminal:1:web-1'));
            expect(useAppStore.getState().openServerIds).toEqual([3]);
            expect(row('web-1')).not.toHaveAccessibleName(/open in the background/);
        } finally {
            unregister();
        }

        // Nothing to lose: closed at once, and the welcome screen comes back.
        await user.click(sidebar().getByRole('button', { name: 'Close db-1' }));
        expect(await screen.findByRole('heading', { name: 'Welcome to ShellMind' })).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it(`keeps at most ${MAX_OPEN_SERVERS} open: the least recently used one without work makes room, otherwise after asking`, async () => {
        servers = Array.from({ length: MAX_OPEN_SERVERS + 2 }, (_, index) => ({ id: index + 1, name: `host-${index + 1}`, ip: `10.0.1.${index + 1}`, type: 'linux' as const }));
        const user = userEvent.setup();
        renderApp();
        for (let id = 1; id <= MAX_OPEN_SERVERS; id++) await selectServer(`host-${id}`);
        // host-1 has a live session, host-2 has none: host-2 goes.
        connectTerminal(1);
        await selectServer(`host-${MAX_OPEN_SERVERS + 1}`);
        expect(useAppStore.getState().openServerIds).toHaveLength(MAX_OPEN_SERVERS);
        expect(useAppStore.getState().openServerIds).not.toContain(2);
        expect(useAppStore.getState().openServerIds).toContain(1);

        // Every one has work now: the least recently used (host-1) only goes after asking.
        for (const id of useAppStore.getState().openServerIds) if (id !== 1) connectTerminal(id);
        fireEvent.click(row(`host-${MAX_OPEN_SERVERS + 2}`));
        const dialog = await screen.findByRole('alertdialog', { name: 'Close host-1 to make room?' });
        expect(dialog).toHaveTextContent(`Opening host-${MAX_OPEN_SERVERS + 2} closes the least recently used one, host-1`);
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(useAppStore.getState().openServerIds).toContain(1);
        expect(useAppStore.getState().activeServerId).toBe(MAX_OPEN_SERVERS + 1);

        fireEvent.click(row(`host-${MAX_OPEN_SERVERS + 2}`));
        await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Close host-1' }));
        await waitFor(() => expect(useAppStore.getState().activeServerId).toBe(MAX_OPEN_SERVERS + 2));
        expect(useAppStore.getState().openServerIds).not.toContain(1);
    });

    it('leaves Ctrl+S and Escape to the screen in front: an editor in the background neither saves nor asks', async () => {
        editorProbe.enabled = true;
        renderApp();
        await selectServer('web-1');
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Files' }));
        const first = await editorOf('1.txt');
        typeInto(first, 'EDIT-FROM-1');

        await selectServer('db-1');
        await expectVisible('terminal:3');
        row('db-1').focus();
        keyOn(row('db-1'), { key: 'Escape' });
        keyOn(row('db-1'), { key: 's', ctrlKey: true });
        await act(async () => undefined);
        expect(screen.queryByText('Discard unsaved changes?')).toBeNull();
        expect(editorProbe.closed).toEqual([]);
        expect(editorProbe.clients[1].write).not.toHaveBeenCalled();

        // db-1's own editor: Ctrl+S saves its file only.
        fireEvent.click(within(screen.getByRole('tablist')).getByRole('tab', { name: 'Files' }));
        const second = await editorOf('3.txt');
        typeInto(second, 'EDIT-FROM-3');
        keyOn(second.contentDOM, { key: 's', ctrlKey: true });
        await waitFor(() => expect(editorProbe.clients[3].write).toHaveBeenCalledTimes(1));
        expect(editorProbe.clients[1].write).not.toHaveBeenCalled();

        // web-1's, on screen again, still has its changes and saves them.
        await selectServer('web-1');
        keyOn(first.contentDOM, { key: 's', ctrlKey: true });
        await waitFor(() => expect(editorProbe.clients[1].write).toHaveBeenCalledTimes(1));
        expect(new TextDecoder().decode(editorProbe.clients[1].write.mock.calls[0][1])).toBe('line one\nEDIT-FROM-1');
    });

    it('never closes a server with unsaved editor changes silently, even one without a terminal', async () => {
        const names = ['ash', 'birch', 'cedar', 'elm', 'fir', 'oak'];
        servers = [
            { id: 2, name: 'backups', ip: '', type: 's3', s3_bucket: 'nightly' },
            ...names.map((name, index) => ({ id: 10 + index, name, ip: `10.0.2.${index + 1}`, type: 'linux' as const }))
        ];
        editorProbe.enabled = true;
        const user = userEvent.setup();
        renderApp();
        await selectServer('backups');
        typeInto(await editorOf('2.txt'), 'pending edit');
        for (const name of names.slice(0, MAX_OPEN_SERVERS - 1)) await selectServer(name);
        expect(useAppStore.getState().openServerIds).toHaveLength(MAX_OPEN_SERVERS);

        // backups is the least recently used, but has work: ash makes room instead.
        await selectServer('oak');
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(useAppStore.getState().openServerIds).toContain(2);
        expect(useAppStore.getState().openServerIds).not.toContain(10);

        await user.click(sidebar().getByRole('button', { name: 'Close backups' }));
        const dialog = await screen.findByRole('alertdialog', { name: 'Close backups?' });
        expect(dialog).toHaveTextContent('Unsaved changes to /srv/2.txt');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(useAppStore.getState().openServerIds).toContain(2);
    });

    it('drops the queued commands of a server that is closed, and those nobody ran in time', async () => {
        // The expiry sweep runs on an interval and reads the clock.
        vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setInterval', 'clearInterval', 'Date'] });
        renderApp();
        await selectServer('web-1');
        await selectServer('db-1');
        await expectVisible('terminal:3');
        act(() => {
            useAppStore.getState().queueCommand(1, 'systemctl restart nginx', 'snippet');
            useAppStore.getState().queueCommand(3, 'df -h', 'ai');
        });

        fireEvent.click(sidebar().getByRole('button', { name: 'Close web-1' }));
        await waitFor(() => expect(useAppStore.getState().pendingCommands[1]).toBeUndefined());
        expect(await screen.findByText('Queued commands for web-1 were discarded (1)')).toBeInTheDocument();

        // Two minutes later, still not delivered (db-1 never connected).
        expect(useAppStore.getState().pendingCommands[3]).toHaveLength(1);
        vi.setSystemTime(Date.now() + QUEUED_COMMAND_TTL_MS + 1000);
        await act(async () => {
            vi.advanceTimersByTime(15_000);
        });
        expect(useAppStore.getState().pendingCommands[3]).toBeUndefined();
        expect(await screen.findByText('Queued commands for db-1 did not run within 2 minutes and were dropped (1)')).toBeInTheDocument();
    });
});

describe('command palette', () => {
    // UX-09: the keychain was reachable only through Settings and Tab.
    it('finds the keychain by its English and Spanish words', async () => {
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });
        press('k');
        const dialog = screen.getByRole('dialog', { name: 'Command palette' });
        const input = within(dialog).getByRole('combobox');
        for (const query of ['keychain', 'llavero', 'identidad']) {
            fireEvent.change(input, { target: { value: query } });
            expect(within(dialog).getAllByRole('option')[0], query).toHaveTextContent('Keychain: identities and SSH keys');
        }
    });

    it('opens with Mod+K, finds a server and connects to it', async () => {
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });

        press('k');
        const dialog = screen.getByRole('dialog', { name: 'Command palette' });
        const input = within(dialog).getByRole('combobox');
        expect(input).toHaveFocus();

        fireEvent.change(input, { target: { value: 'db' } });
        const options = within(dialog).getAllByRole('option');
        expect(options[0]).toHaveTextContent('db-1');
        expect(input).toHaveAttribute('aria-activedescendant', options[0].id);

        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.queryByRole('dialog')).toBeNull();
        await expectVisible('terminal:3');
    });

    it('lists the tabs of the active server and app commands, keyboard driven', async () => {
        renderApp();
        await selectServer('web-1');

        fireEvent.click(within(screen.getByRole('banner')).getByRole('button', { name: /Search or run a command/ }));
        const dialog = screen.getByRole('dialog', { name: 'Command palette' });
        expect(within(dialog).getByRole('group', { name: 'Tabs' })).toHaveTextContent('Go to Status');
        expect(within(dialog).getByRole('group', { name: 'Commands' })).toHaveTextContent('Open settings');
        expect(within(dialog).getByRole('group', { name: 'Commands' })).toHaveTextContent('Close web-1');

        const input = within(dialog).getByRole('combobox');
        fireEvent.change(input, { target: { value: 'go status' } });
        fireEvent.keyDown(input, { key: 'ArrowDown' });
        fireEvent.keyDown(input, { key: 'ArrowUp' });
        fireEvent.keyDown(input, { key: 'Enter' });
        await expectVisible('status:1');
    });

    it('marks the theme and the language in effect', async () => {
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });
        press('k');
        const dialog = screen.getByRole('dialog', { name: 'Command palette' });
        const input = within(dialog).getByRole('combobox');

        fireEvent.change(input, { target: { value: 'theme' } });
        expect(within(dialog).getAllByRole('option', { name: /\(current\)/ }).map((option) => option.textContent))
            .toEqual([expect.stringMatching(/^Theme: Dark \(current\)/)]);
        fireEvent.change(input, { target: { value: 'language' } });
        expect(within(dialog).getAllByRole('option', { name: /\(current\)/ }).map((option) => option.textContent))
            .toEqual([expect.stringMatching(/^Language: English \(current\)/)]);
    });

    it('closes with Escape or Mod+K and does not open over another dialog', async () => {
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });

        press('k');
        expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
        press('k');
        expect(screen.queryByRole('dialog')).toBeNull();

        press('k');
        act(() => {
            window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
        });
        expect(screen.queryByRole('dialog')).toBeNull();

        // Settings loads its code on first use (slow on a busy machine).
        press(',');
        expect(await screen.findByRole('dialog', { name: 'Settings' }, { timeout: 5000 })).toBeInTheDocument();
        press('k');
        expect(screen.queryByRole('dialog', { name: 'Command palette' })).toBeNull();
    });
});

describe('welcome screen', () => {
    const welcome = () => within(screen.getByRole('main'));
    // Earlier tests opened servers: nothing is "recent" here.
    beforeEach(() => useOrganizationPrefs.setState({ collapsed: [], sortMode: 'manual', recent: {} }));

    it('offers the quick actions and the saved connections while nothing is open', async () => {
        renderApp();
        expect(await screen.findByRole('heading', { name: 'Welcome to ShellMind' })).toBeInTheDocument();
        const actions = within(screen.getByRole('region', { name: 'Get started' }));
        expect(actions.getAllByRole('button').map((button) => button.textContent)).toEqual([
            expect.stringContaining('New connection'),
            expect.stringContaining('Import ~/.ssh/config'),
            expect.stringContaining('Open a local shell'),
            expect.stringMatching(/Command palette.*Ctrl\+K/)
        ]);
        // Nothing opened yet in this browser: the saved order.
        const saved = within(await screen.findByRole('region', { name: 'Your connections' }));
        expect(saved.getAllByRole('button').map((button) => button.getAttribute('title'))).toEqual(['web-1', 'backups', 'db-1']);

        fireEvent.click(actions.getByRole('button', { name: /Command palette/ }));
        expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    });

    it('opens a listed connection in place of the welcome screen', async () => {
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });
        fireEvent.click(welcome().getByRole('button', { name: /^db-1/ }));
        await loaded();
        await expectVisible('terminal:3:db-1');
        expect(screen.queryByRole('heading', { name: 'Welcome to ShellMind' })).toBeNull();
    });

    it('creates the local shell after asking when there is none, then opens it', async () => {
        const created: unknown[] = [];
        fetchMock.mockImplementation(async (url, init) => {
            if (url.endsWith('/api/servers') && init?.method === 'POST') {
                const body = JSON.parse(String(init.body));
                created.push(body);
                const row: ServerSummary = { id: 9, name: body.name, ip: body.ip, type: 'local', cli_preset: 'shell' };
                servers = [...servers, row];
                return json({ message: 'success', data: row });
            }
            return defaultRoutes(url);
        });
        const user = userEvent.setup();
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });

        await user.click(welcome().getByRole('button', { name: /^Open a local shell/ }));
        const dialog = screen.getByRole('alertdialog');
        expect(dialog).toHaveTextContent('Create “Local shell” and open it?');
        await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(created).toEqual([]);

        await user.click(welcome().getByRole('button', { name: /^Open a local shell/ }));
        await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Create and open' }));
        await expectVisible('terminal:9:Local shell');
        expect(created).toEqual([{ name: 'Local shell', type: 'local', ip: 'local', cli_preset: 'shell' }]);
        expect(row('Local shell')).toHaveAttribute('aria-current', 'true');
    });

    it('waits for the saved connections before it offers to create a local shell', async () => {
        let release = () => undefined as void;
        const gate = new Promise<void>((resolve) => { release = resolve; });
        fetchMock.mockImplementation(async (url) => {
            if (url.endsWith('/api/servers')) await gate;
            return defaultRoutes(url);
        });
        renderApp();
        const local = await welcome().findByRole('button', { name: /^Open a local shell/ });
        expect(local).toBeDisabled();
        // The loading lists are announced: a status with text, not a bare label.
        expect(screen.getAllByRole('status').filter((status) => status.textContent === 'Loading connections')).toHaveLength(2);
        await act(async () => release());
        await sidebar().findByRole('button', { name: /^web-1/ });
        expect(local).toBeEnabled();
    });

    it('loads the saved connections again after a failed load, and says so if that fails too', async () => {
        servers = [...servers, { id: 7, name: 'My shell', ip: 'local', type: 'local', cli_preset: 'shell' }];
        let failures = 2;
        fetchMock.mockImplementation(async (url) => {
            if (url.endsWith('/api/servers') && failures > 0) {
                failures -= 1;
                return json({ error: 'database is locked' }, 500);
            }
            return defaultRoutes(url);
        });
        renderApp();
        await screen.findByRole('alert');

        const local = welcome().getByRole('button', { name: /^Open a local shell/ });
        fireEvent.click(local);
        expect(await screen.findByText(/The local shell opens once your connections have loaded/)).toBeInTheDocument();
        expect(screen.queryByRole('alertdialog')).toBeNull();

        fireEvent.click(local);
        await loaded();
        await expectVisible('terminal:7:My shell');
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('opens the existing local shell without asking', async () => {
        servers = [...servers, { id: 7, name: 'My shell', ip: 'local', type: 'local', cli_preset: 'shell' }];
        renderApp();
        await sidebar().findByRole('button', { name: /^My shell/ });
        fireEvent.click(welcome().getByRole('button', { name: /^Open a local shell/ }));
        await loaded();
        expect(screen.queryByRole('alertdialog')).toBeNull();
        await expectVisible('terminal:7:My shell');
    });
});

describe('favourites', () => {
    const favorites = () => sidebar().queryByRole('region', { name: 'Favorites' });

    it('pins a server at the top at once, saves it, and keeps the open session', async () => {
        const patches: Array<[string, unknown]> = [];
        fetchMock.mockImplementation(async (url, init) => {
            if (init?.method === 'PATCH') {
                patches.push([url.replace(/^.*\/api/, '/api'), JSON.parse(String(init.body))]);
                return json({ message: 'success' });
            }
            return defaultRoutes(url);
        });
        renderApp();
        await selectServer('db-1');
        await expectVisible('terminal:3');
        const changes = terminalProbe.serverChanges;

        fireEvent.click(sidebar().getByRole('button', { name: 'Add db-1 to favorites' }));
        const section = favorites();
        expect(section).not.toBeNull();
        expect(sidebar().getAllByRole('region')[0]).toBe(section);
        expect(within(section!).getByRole('button', { name: /^db-1/ })).toBeInTheDocument();
        await waitFor(() => expect(patches).toEqual([['/api/servers/3/favorite', { favorite: true }]]));
        // Not an edit: the open terminal keeps its server object.
        expect(terminalProbe.serverChanges).toBe(changes);

        fireEvent.click(sidebar().getByRole('button', { name: 'Remove db-1 from favorites' }));
        await waitFor(() => expect(patches).toHaveLength(2));
        expect(patches[1]).toEqual(['/api/servers/3/favorite', { favorite: false }]);
        expect(favorites()).toBeNull();
    });

    it('puts the server back and says so when the change cannot be saved', async () => {
        fetchMock.mockImplementation(async (url, init) => {
            if (init?.method === 'PATCH') return json({ error: 'database is locked' }, 500);
            return defaultRoutes(url);
        });
        renderApp();
        await sidebar().findByRole('button', { name: /^web-1/ });
        fireEvent.click(sidebar().getByRole('button', { name: 'Add web-1 to favorites' }));
        expect(await screen.findByText('Could not update your favorites')).toBeInTheDocument();
        expect(favorites()).toBeNull();
    });
});

// --- W7-S6 embedded RDP ---
describe('a Remote Desktop session', () => {
    it('counts in the header, the sidebar and the chat greeting, while commands still wait for the terminal', async () => {
        servers.push({ id: 4, name: 'win-1', ip: '10.0.0.9', type: 'windows', username: 'admin' });
        renderApp();
        await selectServer('win-1');
        const header = screen.getByRole('banner');
        // No OpenSSH on the server: its terminal fails.
        act(() => useAppStore.getState().setConnection(4, { state: 'error', error: 'ECONNREFUSED' }));
        expect(within(header).getByText(/Error/)).toBeInTheDocument();

        act(() => useRdpStore.getState().setSession(4, { state: 'connected', since: 1 }));
        expect(within(header).getByRole('img', { name: 'Connected' })).toBeInTheDocument();
        expect(within(header).queryByText(/Error/)).toBeNull();
        expect(within(row('win-1')).getByRole('img', { name: 'Connected' })).toBeInTheDocument();
        const chat = screen.getByLabelText('chat draft win-1');
        expect(chat).toHaveAttribute('data-connection', 'connected');
        // Auto-Run types into the terminal, which is not connected.
        expect(chat).toHaveAttribute('data-shell', 'error');

        act(() => useRdpStore.getState().clearSession(4));
        expect(within(header).getByText(/Error/)).toBeInTheDocument();
        expect(within(row('win-1')).getByRole('img', { name: 'Error' })).toBeInTheDocument();
    });
});

// --- W7 integration: a Windows server opens on its Remote Desktop ---
describe('a Windows server', () => {
    beforeEach(() => {
        servers.push({ id: 4, name: 'win-1', ip: '10.0.0.9', type: 'windows', username: 'admin' });
    });

    it('opens on its Remote Desktop and connects its shell only when that tab is opened', async () => {
        renderApp();
        await selectServer('win-1');
        const tablist = screen.getByRole('tablist', { name: 'Workspace' });
        expect(within(tablist).getByRole('tab', { name: 'RDP' })).toHaveAttribute('aria-selected', 'true');
        await expectVisible('rdp:4');
        // No SSH attempt yet: the terminal is not mounted, and nothing claims to connect.
        expect(panelTexts()).toEqual(['rdp:4']);
        expect(terminalProbe.mounts).toBe(0);
        expect(within(screen.getByRole('banner')).getByRole('img', { name: 'Idle' })).toBeInTheDocument();
        expect(screen.getByLabelText('chat draft win-1')).toHaveAttribute('data-connection', 'idle');
        expect(screen.getByLabelText('chat draft win-1')).toHaveAttribute('data-shell', 'idle');

        fireEvent.click(within(tablist).getByRole('tab', { name: 'CMD / PowerShell' }));
        await expectVisible('terminal:4');
        expect(terminalProbe.mounts).toBe(1);
        expect(screen.getByLabelText('chat draft win-1')).toHaveAttribute('data-connection', 'connecting');
    });

    it('opens its shell when a command is sent to it', async () => {
        renderApp();
        await selectServer('win-1');
        await expectVisible('rdp:4');
        act(() => useAppStore.getState().queueCommand(4, 'Get-Date', 'ai'));
        await expectVisible('terminal:4');
        expect(terminalProbe.mounts).toBe(1);
    });

    it('leaves a Linux server on its terminal, mounted as it opens', async () => {
        renderApp();
        await selectServer('web-1');
        await expectVisible('terminal:1');
        expect(screen.getByLabelText('chat draft web-1')).toHaveAttribute('data-connection', 'connecting');
    });
});
