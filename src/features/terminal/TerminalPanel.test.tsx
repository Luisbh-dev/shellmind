import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { Terminal } from '@xterm/xterm';
import type { SearchAddon } from '@xterm/addon-search';
import { encodePowerShellBlock } from '@shared/powershell';
import { ConfirmProvider } from '@/components/ui/Confirm';
import { ToastProvider } from '@/components/ui/Toast';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import { actionRegistry, isActionAvailable } from '@/workspace/actions/registry';
import type { WorkspaceServer } from '@/workspace/types';
import { hasOpenOverlay } from '@/components/ui/overlayStack';
import type { ServerSummary } from '@shared/types';
import { useServersStore } from '@/store/servers';
import { resetBroadcast, useBroadcast } from './broadcast';
import { onCommandUndelivered } from './commandDelivery';
import { useCommandHistory } from './history';
import { leaves } from './layout';
import { SESSION_DRAG_TYPE } from './Pane';
import { usePanes } from './panes';
import { useTerminalPrefs } from './preferences';
import TerminalPanel from './TerminalPanel';

// The panel with a fake socket per tab and a fake xterm: tabs, the output
// pipeline (acks), queued commands and audit, banners and host keys.

type Listener = (...args: unknown[]) => void;

class FakeSocket {
    connected = false;
    disconnected = false;
    emitted: Array<[string, ...unknown[]]> = [];
    private listeners = new Map<string, Set<Listener>>();

    on(event: string, listener: Listener) {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(listener);
        return this;
    }

    off(event?: string) {
        if (event) this.listeners.delete(event);
        else this.listeners.clear();
        return this;
    }

    emit(event: string, ...args: unknown[]) {
        this.emitted.push([event, ...args]);
        return this;
    }

    // emit() with an acknowledgement: the test answers through acks.
    acks: Array<{ event: string; answer: (result: unknown) => void }> = [];
    timeout() {
        return {
            emit: (event: string, payload: unknown, ack: (err: Error | null, result?: unknown) => void) => {
                this.emitted.push([event, payload]);
                this.acks.push({ event, answer: (result) => act(() => ack(null, result)) });
            }
        };
    }

    disconnect() {
        this.connected = false;
        this.disconnected = true;
        return this;
    }

    // The backend side.
    fire(event: string, ...args: unknown[]) {
        if (event === 'connect') this.connected = true;
        act(() => {
            for (const listener of this.listeners.get(event) ?? []) listener(...args);
        });
    }

    sent(event: string) {
        return this.emitted.filter(([name]) => name === event).map(([, ...args]) => args);
    }
}

const sockets: FakeSocket[] = [];
vi.mock('@/lib/socket', () => ({
    createSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
    }
}));

type FakeTerm = {
    written: Array<string | Uint8Array>;
    // The line the cursor is on.
    screenLine: string;
    modes: { bracketedPasteMode: boolean };
    keyHandler?: (event: KeyboardEvent) => boolean;
    typeKeys: (data: string) => void;
    // A full-screen program starts (alternate) or ends (normal).
    switchBuffer: (type: 'normal' | 'alternate') => void;
    focus: ReturnType<typeof vi.fn>;
};
const terms: FakeTerm[] = [];
const xtermOptions: Array<{ screenReaderMode?: boolean }> = [];

const decodeAll = (written: Array<string | Uint8Array>) => written.map((item) => (typeof item === 'string' ? item : new TextDecoder().decode(item))).join('');

function createFakeXterm() {
    const dataListeners = new Set<(data: string) => void>();
    const bufferListeners = new Set<(buffer: { type: string }) => void>();
    const active = {
        type: 'normal', baseY: 0, cursorY: 0, length: 1,
        get cursorX() {
            return fake.screenLine.length;
        },
        getLine: () => ({ translateToString: () => fake.screenLine, isWrapped: false })
    };
    const fake: FakeTerm & Record<string, unknown> = {
        cols: 100,
        rows: 30,
        written: [],
        screenLine: '',
        modes: { bracketedPasteMode: false },
        focus: vi.fn(),
        write: (data: string | Uint8Array, done?: () => void) => {
            fake.written.push(data);
            done?.();
        },
        writeln: (data: string) => fake.written.push(`${data}\r\n`),
        onData: (listener: (data: string) => void) => {
            dataListeners.add(listener);
            return { dispose: () => dataListeners.delete(listener) };
        },
        onResize: () => ({ dispose: () => undefined }),
        attachCustomKeyEventHandler: (handler: (event: KeyboardEvent) => boolean) => {
            fake.keyHandler = handler;
        },
        buffer: {
            active,
            onBufferChange: (listener: (buffer: { type: string }) => void) => {
                bufferListeners.add(listener);
                return { dispose: () => bufferListeners.delete(listener) };
            }
        },
        switchBuffer: (type: 'normal' | 'alternate') => {
            active.type = type;
            act(() => bufferListeners.forEach((listener) => listener(active)));
        },
        registerMarker: () => ({ line: 0, isDisposed: false, dispose: () => undefined, onDispose: () => ({ dispose: () => undefined }) }),
        registerDecoration: () => undefined,
        parser: { registerCsiHandler: () => ({ dispose: () => undefined }) },
        clear: vi.fn(),
        paste: vi.fn(),
        getSelection: () => '',
        hasSelection: () => false,
        clearSelection: vi.fn(),
        selectAll: vi.fn(),
        typeKeys: (data: string) => act(() => dataListeners.forEach((listener) => listener(data)))
    };
    terms.push(fake);
    const search = { findNext: vi.fn(() => true), findPrevious: vi.fn(() => true), clearDecorations: vi.fn(), onDidChangeResults: () => ({ dispose: () => undefined }) };
    return { term: fake as unknown as Terminal, search: search as unknown as SearchAddon, fit: () => undefined };
}

vi.mock('./useXterm', async () => {
    const { useState } = await import('react');
    return {
        useXterm: (_ref: unknown, options: { screenReaderMode?: boolean }) => {
            xtermOptions.push(options);
            return useState(createFakeXterm)[0];
        }
    };
});

const SERVER: WorkspaceServer = { id: 1, name: 'web-1', ip: '10.0.0.5', type: 'linux' };

const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    if (url.endsWith('/api/known-hosts') && method === 'GET') {
        return Response.json({ message: 'success', data: [{ id: 9, host: '10.0.0.5', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:old', created_at: 1 }] });
    }
    return Response.json({ message: 'success' });
});

function renderPanel(props: Partial<Parameters<typeof TerminalPanel>[0]> = {}) {
    return render(
        <ToastProvider>
            <ConfirmProvider>
                <TerminalPanel server={SERVER} {...props} />
            </ConfirmProvider>
        </ToastProvider>
    );
}

function connect(socket: FakeSocket) {
    socket.fire('connect');
    socket.fire('connection-ready');
}

// The shell behind `socket` prints its prompt (the fake screen of its
// terminal shows it; a reconnect keeps the terminal).
function showPrompt(socket: FakeSocket, prompt: string, term = terms[0]) {
    term.screenLine = prompt;
    socket.fire('ssh-output', prompt);
}

beforeEach(() => {
    setLanguage('en');
    useAppStore.setState(useAppStore.getInitialState(), true);
    useCommandHistory.setState({ history: {}, favorites: {} });
    localStorage.clear();
    sockets.length = 0;
    terms.length = 0;
    xtermOptions.length = 0;
    useTerminalPrefs.setState({ screenReaderMode: false });
    fetchMock.mockClear();
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('TerminalPanel', () => {
    it('opens a first tab whose socket starts the terminal session of the saved server', () => {
        renderPanel();
        expect(screen.getByRole('tab', { name: /Terminal 1/ })).toHaveAttribute('aria-selected', 'true');
        expect(sockets).toHaveLength(1);

        sockets[0].fire('connect');
        expect(sockets[0].sent('start-ssh')).toEqual([[{ serverId: 1, purpose: 'terminal', cols: 100, rows: 30 }]]);
        expect(useAppStore.getState().connections[1].state).toBe('connecting');
        // The tab spins while connecting (nothing is laid over the terminal's rows).
        const tab = screen.getByRole('tab', { name: /Terminal 1/ });
        expect(tab.querySelector('.animate-spin')).not.toBeNull();
        sockets[0].fire('connection-ready');
        expect(useAppStore.getState().connections[1].state).toBe('connected');
        expect(tab.querySelector('.animate-spin')).toBeNull();
    });

    it('writes output, acknowledges it and forwards only the focused tab’s output', () => {
        const onOutput = vi.fn();
        const onSessionFocused = vi.fn();
        renderPanel({ onOutput, onSessionFocused });
        const first = useAppStore.getState().terminalSessions[1].focusedId;
        expect(onSessionFocused).toHaveBeenLastCalledWith(first, '');
        connect(sockets[0]);
        sockets[0].fire('ssh-output', 'hello\r\n');
        expect(terms[0].written).toContain('hello\r\n');
        expect(sockets[0].sent('ssh-ack')).toEqual([[7]]);
        expect(onOutput).toHaveBeenCalledWith('hello\r\n', first, { cols: 100, rows: 30 });

        fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
        expect(screen.getByRole('tab', { name: /Terminal 2/ })).toHaveAttribute('aria-selected', 'true');
        expect(sockets).toHaveLength(2);
        // The chat's feed follows the newly focused tab.
        const second = useAppStore.getState().terminalSessions[1].focusedId;
        expect(second).not.toBe(first);
        expect(onSessionFocused).toHaveBeenLastCalledWith(second, '');
        onOutput.mockClear();
        sockets[0].fire('ssh-output', 'background\r\n');
        expect(onOutput).not.toHaveBeenCalled();
        // Still acknowledged: the backend must not stall a hidden tab.
        expect(sockets[0].sent('ssh-ack')).toEqual([[7], [12]]);
    });

    it('sends typing to its own socket only', () => {
        renderPanel();
        connect(sockets[0]);
        fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
        connect(sockets[1]);
        terms[1].typeKeys('ls\r');
        expect(sockets[1].sent('ssh-input')).toEqual([['ls\r']]);
        expect(sockets[0].sent('ssh-input')).toEqual([]);
    });

    it('types queued commands into the focused tab once connected, records and audits them', async () => {
        useAppStore.getState().queueCommand(1, 'df -h', 'ai');
        useAppStore.getState().queueCommand(1, 'uptime', 'hint');
        renderPanel();
        expect(sockets[0].sent('ssh-input')).toEqual([]);

        connect(sockets[0]);
        // Typed once the shell shows its prompt.
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        showPrompt(sockets[0], 'root@web-1:~# ');
        expect(sockets[0].sent('ssh-input')).toEqual([['df -h\r'], ['uptime\r']]);
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
        expect(useCommandHistory.getState().history[1].map((entry) => [entry.command, entry.source])).toEqual([['uptime', 'hint'], ['df -h', 'ai']]);

        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toMatch(/\/api\/audit$/);
        expect(JSON.parse(String(init?.body))).toEqual({ serverId: 1, source: 'ai-run', command: 'df -h', meta: { via: 'terminal' } });
    });

    // W7-S4: a snippet's secret values are typed, never recorded.
    it('records a command with secret values only in its masked form', async () => {
        useAppStore.getState().queueCommand(1, ' mysql -pS3cr3t-v4lue', 'snippet', { display: 'mysql -p{{password}}' });
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], 'root@web-1:~# ');
        expect(sockets[0].sent('ssh-input')).toEqual([[' mysql -pS3cr3t-v4lue\r']]);
        // Not in the history (running the masked form again would not work).
        expect(useCommandHistory.getState().history[1] ?? []).toEqual([]);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse(String(init?.body))).toEqual({ serverId: 1, source: 'snippet', command: 'mysql -p{{password}}', meta: { via: 'terminal' } });
        expect(JSON.stringify(fetchMock.mock.calls)).not.toContain('S3cr3t-v4lue');
    });

    it('types a multi-line block the way the shell at the prompt takes it, and records the block as written', async () => {
        const block = 'Get-Process |\n  Sort-Object CPU -Descending |\n  Select-Object -First 5';
        useAppStore.getState().queueCommand(1, block, 'ai-autorun');
        renderPanel({ server: { id: 1, name: 'win-1', ip: '10.0.0.9', type: 'windows' } });
        terms[0].screenLine = 'PS C:\\Users\\admin> ';
        connect(sockets[0]);
        expect(sockets[0].sent('ssh-input')).toEqual([[`${encodePowerShellBlock(block)}\r`]]);
        expect(useCommandHistory.getState().history[1].map((entry) => entry.command)).toEqual([block]);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toMatchObject({ source: 'ai-autorun', command: block });
    });

    it('pastes a block into a shell with bracketed paste on, and types it line by line otherwise', () => {
        const heredoc = "cat > /tmp/t.yml <<'EOF'\nname: test\nEOF";
        renderPanel();
        terms[0].screenLine = 'root@web-1:~# ';
        terms[0].modes.bracketedPasteMode = true;
        connect(sockets[0]);
        act(() => useAppStore.getState().queueCommand(1, heredoc, 'ai'));
        terms[0].modes.bracketedPasteMode = false;
        act(() => useAppStore.getState().queueCommand(1, 'cd /srv\nls', 'snippet'));
        expect(sockets[0].sent('ssh-input')).toEqual([
            ["\x1b[200~cat > /tmp/t.yml <<'EOF'\rname: test\rEOF\x1b[201~\r"],
            ['cd /srv\rls\r']
        ]);
    });

    it('types a block for a shell started from the local PowerShell console the way that shell takes it', () => {
        renderPanel({ server: { id: 1, name: 'PowerShell local', ip: '', type: 'local', osDetail: 'Windows_NT 10.0.26100' } });
        connect(sockets[0]);
        showPrompt(sockets[0], 'PS C:\\Users\\admin> ');
        // docker exec -it <container> sh
        terms[0].screenLine = '/ # ';
        act(() => useAppStore.getState().queueCommand(1, 'cd /tmp\npwd', 'ai'));
        // bash in a container, with a prompt the panel does not know.
        terms[0].screenLine = 'app ❯ ';
        terms[0].modes.bracketedPasteMode = true;
        act(() => useAppStore.getState().queueCommand(1, 'cd /srv\nls', 'ai'));
        expect(sockets[0].sent('ssh-input')).toEqual([['cd /tmp\rpwd\r'], ['\x1b[200~cd /srv\rls\x1b[201~\r']]);
    });

    it('keeps the output visible when the session ends and reconnects in the same terminal', () => {
        renderPanel();
        connect(sockets[0]);
        sockets[0].fire('ssh-output', 'last words\r\n');
        sockets[0].fire('ssh-closed');

        const banner = screen.getByRole('status');
        expect(banner).toHaveTextContent('Session ended');
        expect(useAppStore.getState().connections[1].state).toBe('disconnected');

        fireEvent.click(within(banner).getByRole('button', { name: 'Reconnect' }));
        expect(sockets).toHaveLength(2);
        expect(sockets[0].disconnected).toBe(true);
        expect(terms).toHaveLength(1);
        expect(terms[0].written.join('')).toContain('last words');
        expect(terms[0].written.join('')).toContain('Reconnecting');
    });

    const MISMATCH = { code: 'HOST_KEY_MISMATCH', host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' };

    async function confirmTrust() {
        sockets[0].fire('connect');
        sockets[0].fire('host-key-mismatch', MISMATCH);
        sockets[0].fire('ssh-error', 'The host key of 10.0.0.5:22 has changed');
        const banner = screen.getByRole('alert');
        fireEvent.click(within(banner).getByRole('button', { name: 'Trust the new key' }));
        fireEvent.click(await screen.findByRole('button', { name: 'Trust and reconnect' }));
        await waitFor(() => expect(sockets[0].acks).toHaveLength(1));
        return banner;
    }

    it('shows both fingerprints of a changed host key and replaces it by exactly the confirmed one', async () => {
        renderPanel();
        const banner = await confirmTrust();
        expect(banner).toHaveTextContent('The host key of 10.0.0.5:22 has changed');
        expect(banner).toHaveTextContent('SHA256:old');
        expect(banner).toHaveTextContent('SHA256:new');

        // Not "forget the pinned key, then trust whatever comes next".
        expect(sockets[0].sent('trust-host-key')).toEqual([[{ serverId: 1, host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' }]]);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(sockets).toHaveLength(1);

        sockets[0].acks[0].answer({ ok: true });
        await waitFor(() => expect(sockets).toHaveLength(2));
    });

    it('shows the current keys when the pinned key changed again meanwhile', async () => {
        renderPanel();
        await confirmTrust();
        sockets[0].acks[0].answer({ ok: false, code: 'HOST_KEY_CHANGED', error: 'changed' });
        expect(await screen.findByText('The pinned key changed again in the meantime. Reconnect to compare the current keys.')).toBeInTheDocument();
        await waitFor(() => expect(sockets).toHaveLength(2));
    });

    it('writes backend notices into the terminal in the user’s language', () => {
        setLanguage('es');
        renderPanel();
        sockets[0].fire('connect');
        sockets[0].fire('host-key-trusted', { host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:notices' });
        sockets[0].fire('terminal-notice', { kind: 'connected', target: '10.0.0.5:22', via: [] });
        sockets[0].fire('terminal-notice', { kind: 'connection-closed' });
        const text = terms[0].written.join('');
        expect(text).toContain('Conectando con web-1 (10.0.0.5)…');
        expect(text).toContain('Se ha confiado en la clave de host ssh-ed25519 de 10.0.0.5:22');
        expect(text).toContain('Conectado a 10.0.0.5:22');
        expect(text).toContain('Conexión cerrada.');
    });

    it('names a local console once while it opens', () => {
        renderPanel({ server: { id: 3, name: 'docker-local', ip: '', type: 'local', cli_preset: 'docker' } });
        expect(terms[0].written[0]).toContain('Opening docker-local…');
        expect(terms[0].written[0]).not.toContain('(docker-local)');
    });

    it('offers "close tab" only while the server’s terminal is on screen', () => {
        const close = actionRegistry.get('terminal-close-tab')!;
        const { rerender } = renderPanel({ isActive: false });
        expect(isActionAvailable(close, SERVER)).toBe(false);
        rerender(
            <ToastProvider>
                <ConfirmProvider>
                    <TerminalPanel server={SERVER} isActive />
                </ConfirmProvider>
            </ToastProvider>
        );
        expect(isActionAvailable(close, SERVER)).toBe(true);
        expect(isActionAvailable(close, { ...SERVER, id: 2 })).toBe(false);
    });

    it('announces a host key trusted on first use once', async () => {
        renderPanel();
        const info = { host: '10.0.0.5', port: 22, keyType: 'ssh-ed25519', fingerprint: 'SHA256:first' };
        sockets[0].fire('host-key-trusted', info);
        sockets[0].fire('host-key-trusted', info);
        expect(await screen.findAllByText('Host key trusted')).toHaveLength(1);
    });

    it('keeps the focus in the search box (terminal-search-focus-steal)', async () => {
        renderPanel();
        connect(sockets[0]);
        fireEvent.click(screen.getByRole('button', { name: /^Search terminal/ }));
        const input = await screen.findByRole('searchbox', { name: 'Text to find' });
        await waitFor(() => expect(input).toHaveFocus());
        fireEvent.change(input, { target: { value: 'reboot' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        fireEvent.keyDown(input, { key: 'Escape' });
        expect(screen.queryByRole('searchbox')).toBeNull();
    });

    it('routes keys: Ctrl+Shift+F searches, Ctrl+L and Ctrl+F in full-screen apps go to the remote', () => {
        // The desktop app, which has the terminal tab shortcuts.
        vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Windows NT 10.0) Chrome/138.0 Electron/38.0.0 Safari/537.36');
        renderPanel();
        connect(sockets[0]);
        const handler = terms[0].keyHandler!;
        expect(handler(new KeyboardEvent('keydown', { key: 'l', ctrlKey: true }))).toBe(true);
        let result = true;
        act(() => {
            result = handler(new KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }));
        });
        expect(result).toBe(false);
        expect(screen.getByRole('searchbox')).toBeInTheDocument();
        // App shortcuts (Mod+Shift+T) are left to the window handler.
        expect(handler(new KeyboardEvent('keydown', { key: 'T', ctrlKey: true, shiftKey: true }))).toBe(false);
        expect(screen.getByRole('button', { name: 'New terminal' })).toHaveAttribute('title', 'New terminal (Ctrl+Shift+T)');
    });

    it('advertises no tab shortcut in a browser, which keeps Ctrl+Shift+T for itself', () => {
        renderPanel();
        expect(screen.getByRole('button', { name: 'New terminal' })).toHaveAttribute('title', 'New terminal');
        expect(actionRegistry.get('terminal-new-tab')?.shortcut).toBeUndefined();
    });

    it('renames with a double click, duplicates and closes tabs', () => {
        renderPanel();
        const first = screen.getByRole('tab', { name: /Terminal 1/ });
        fireEvent.doubleClick(first);
        const input = screen.getByRole('textbox', { name: 'Terminal name' });
        fireEvent.change(input, { target: { value: 'logs' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        expect(screen.getByRole('tab', { name: /logs/ })).toBeInTheDocument();

        // The mouse buttons of a tab (the keyboard uses Shift+F10 and Delete).
        fireEvent.click(screen.getByTitle('Options for logs'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['logs', 'logs']);

        fireEvent.click(screen.getAllByTitle('Close logs')[1]);
        expect(screen.getAllByRole('tab')).toHaveLength(1);
        fireEvent.keyDown(screen.getByRole('tab'), { key: 'Delete' });
        expect(screen.queryByRole('tab')).toBeNull();
        expect(screen.getByText('No terminal is open')).toBeInTheDocument();
        expect(sockets.every((socket) => socket.disconnected)).toBe(true);
    });

    it('opens a shell inside a container: start-ssh carries the container, the tab is named after it, a duplicate keeps it (W7-S3)', () => {
        const attach = { kind: 'container' as const, engine: 'docker' as const, container: 'shop-web-1' };
        useAppStore.getState().openTerminalSession(1, { attach });
        renderPanel();
        // The container's tab is the only one: the panel opens no login shell of its own.
        const tab = screen.getByRole('tab', { name: /container: shop-web-1/ });
        expect(tab).toHaveAttribute('aria-selected', 'true');
        expect(sockets).toHaveLength(1);
        expect(decodeAll(terms[0].written)).toContain('Opening a shell in the container shop-web-1 on web-1…');

        sockets[0].fire('connect');
        expect(sockets[0].sent('start-ssh')).toEqual([[{ serverId: 1, purpose: 'terminal', cols: 100, rows: 30, attach }]]);
        sockets[0].fire('connection-ready');
        // The shell ending in the container ends the session.
        sockets[0].fire('terminal-notice', { kind: 'session-ended' });
        expect(decodeAll(terms[0].written)).toContain('[ShellMind] Session ended.');

        fireEvent.click(screen.getByTitle('Options for container: shop-web-1'));
        fireEvent.click(screen.getByRole('menuitem', { name: /Duplicate/ }));
        expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['container: shop-web-1', 'container: shop-web-1']);
        sockets[1].fire('connect');
        expect(sockets[1].sent('start-ssh')[0]).toEqual([expect.objectContaining({ attach })]);

        // A refused container reads in the user's language.
        sockets[1].fire('ssh-error', 'The container shop-web-1 is not running (exited).', { code: 'CONTAINER_NOT_RUNNING', message: 'The container shop-web-1 is not running (exited).', details: { container: 'shop-web-1', state: 'exited' } });
        expect(decodeAll(terms[1].written)).toContain('The container shop-web-1 is not running (exited).');
        act(() => setLanguage('es'));
        expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['contenedor: shop-web-1', 'contenedor: shop-web-1']);
    });

    it('never types the server\'s queued commands into a container\'s shell unless asked: they run on the server, or are audited with the container (W7-S3)', async () => {
        const attach = { kind: 'container' as const, engine: 'docker' as const, container: 'shop-web-1' };
        const undelivered: string[] = [];
        const stop = onCommandUndelivered((report) => undelivered.push(`${report.command}:${report.reason}`));
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], 'root@web-1:~# ');
        act(() => {
            useAppStore.getState().openTerminalSession(1, { attach });
        });
        connect(sockets[1]);
        showPrompt(sockets[1], '/ # ', terms[1]);
        expect(screen.getByRole('tab', { name: /container: shop-web-1/ })).toHaveAttribute('aria-selected', 'true');

        act(() => {
            useAppStore.getState().queueCommand(1, 'systemctl status nginx', 'ai');
            useAppStore.getState().queueCommand(1, 'df -h', 'ai-autorun');
        });
        // Auto-Run is told at once; the other command waits, typed nowhere.
        expect(undelivered).toEqual(['df -h:container-shell']);
        expect(sockets[1].sent('ssh-input')).toEqual([]);
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        const banner = screen.getByText(/A command for web-1 is waiting\. This tab is a shell inside the container shop-web-1/).closest('[role="status"]') as HTMLElement;

        // Run on the server: its login-shell tab takes the focus and types it.
        fireEvent.click(within(banner).getByRole('button', { name: 'Run on web-1' }));
        expect(screen.getByRole('tab', { name: /Terminal 1/ })).toHaveAttribute('aria-selected', 'true');
        expect(sockets[0].sent('ssh-input')).toEqual([['systemctl status nginx\r']]);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
        expect(JSON.parse(String(fetchMock.mock.calls[0][1]?.body))).toEqual({ serverId: 1, source: 'ai-run', command: 'systemctl status nginx', meta: { via: 'terminal' } });

        // Typed into the container only when the user says so, and audited as such.
        fireEvent.click(screen.getByRole('tab', { name: /container: shop-web-1/ }));
        act(() => useAppStore.getState().queueCommand(1, 'nginx -t', 'snippet'));
        fireEvent.click(screen.getByRole('button', { name: 'Type in the container' }));
        expect(sockets[1].sent('ssh-input')).toEqual([['nginx -t\r']]);
        await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
        expect(JSON.parse(String(fetchMock.mock.calls[1][1]?.body))).toEqual({
            serverId: 1, source: 'snippet', command: 'nginx -t', meta: { via: 'terminal', container: 'shop-web-1', engine: 'docker' }
        });

        act(() => useAppStore.getState().queueCommand(1, 'reboot', 'ai'));
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(undelivered).toEqual(['df -h:container-shell', 'reboot:discarded']);
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
        stop();
    });

    it('opens a tab of the server for commands waiting in a container\'s shell when there is none (W7-S3)', () => {
        useAppStore.getState().openTerminalSession(1, { attach: { kind: 'container', engine: 'podman', container: 'db' } });
        useAppStore.getState().queueCommand(1, 'uptime', 'ai');
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], '# ');
        fireEvent.click(screen.getByRole('button', { name: 'Run on web-1' }));
        expect(screen.getAllByRole('tab').map((item) => item.textContent)).toEqual(['container: db', 'Terminal 2']);
        connect(sockets[1]);
        showPrompt(sockets[1], 'root@web-1:~# ', terms[1]);
        expect(sockets[1].sent('ssh-input')).toEqual([['uptime\r']]);
        expect(sockets[0].sent('ssh-input')).toEqual([]);
    });

    it('keeps only tabs in the tab list, with 24 px mouse targets, and asks before Delete closes a live session (UX-07)', async () => {
        renderPanel();
        connect(sockets[0]);
        const tablist = screen.getByRole('tablist', { name: 'Terminal sessions' });
        // No buttons owned by the tab list (axe aria-required-children).
        expect(within(tablist).queryAllByRole('button')).toEqual([]);
        const tab = within(tablist).getByRole('tab', { name: /Terminal 1/ });
        expect(tab).toHaveAccessibleDescription('Delete closes the tab, F2 renames it, Shift+F10 opens its options.');
        for (const title of ['Options for Terminal 1', 'Close Terminal 1']) {
            const button = screen.getByTitle(title);
            expect(button).toHaveAttribute('tabindex', '-1');
            expect(button).toHaveAttribute('aria-hidden', 'true');
            expect(button.className).toMatch(/\bh-6\b/);
            expect(button.className).toMatch(/\bw-6\b/);
        }

        fireEvent.keyDown(tab, { key: 'Delete' });
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Close Terminal 1?');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
        expect(screen.getAllByRole('tab')).toHaveLength(1);

        fireEvent.keyDown(screen.getByRole('tab'), { key: 'Delete' });
        fireEvent.click(await screen.findByRole('button', { name: 'Close tab' }));
        await waitFor(() => expect(screen.queryByRole('tab')).toBeNull());
    });

    it('opens its menus on the app’s overlay stack, so Escape and global shortcuts see them (UX-20)', async () => {
        renderPanel();
        connect(sockets[0]);
        expect(hasOpenOverlay()).toBe(false);
        act(() => {
            terms[0].keyHandler!(new KeyboardEvent('keydown', { key: 'F10', shiftKey: true }));
        });
        expect(screen.getByRole('menu', { name: 'Terminal actions' })).toBeInTheDocument();
        expect(hasOpenOverlay()).toBe(true);
        fireEvent.keyDown(window, { key: 'Escape' });
        await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
        expect(hasOpenOverlay()).toBe(false);

        fireEvent.keyDown(screen.getByRole('tab'), { key: 'F10', shiftKey: true });
        expect(screen.getByRole('menu', { name: 'Options for Terminal 1' })).toBeInTheDocument();
        expect(hasOpenOverlay()).toBe(true);
    });

    it('writes binary output as bytes, acknowledges bytes and feeds the chat decoded text', () => {
        const onOutput = vi.fn();
        renderPanel({ onOutput });
        connect(sockets[0]);
        const bytes = new TextEncoder().encode('héllo €\r\n');
        sockets[0].fire('ssh-output', bytes.buffer);
        expect(terms[0].written.at(-1)).toBeInstanceOf(Uint8Array);
        expect(sockets[0].sent('ssh-ack')).toEqual([[bytes.byteLength]]);
        expect(onOutput).toHaveBeenCalledWith('héllo €\r\n', expect.any(String), { cols: 100, rows: 30 });
    });

    it('explains a coded connection failure in the user’s language, with the backend’s text as detail (UX-11)', () => {
        setLanguage('es');
        renderPanel();
        sockets[0].fire('connect');
        sockets[0].fire('ssh-error', 'Auth failed: the saved credentials were rejected.', { code: 'AUTH_FAILED', message: 'Auth failed: the saved credentials were rejected.' });
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Error de conexión');
        expect(banner).toHaveTextContent('El servidor ha rechazado las credenciales guardadas.');
        expect(banner).toHaveTextContent('Auth failed: the saved credentials were rejected.');
        expect(decodeAll(terms[0].written)).toContain('El servidor ha rechazado las credenciales guardadas.');

        // Codes it does not know: the backend's text, without control characters.
        sockets[0].fire('ssh-error', 'odd', { code: 'SOMETHING_NEW', message: 'Weird \x1b]0;title\x07 failure' });
        expect(screen.getByRole('alert')).toHaveTextContent('Weird ]0;title failure');
        expect(decodeAll(terms[0].written)).not.toContain('\x1b]0;');
    });

    it('does not stay "Connecting" when the backend cannot be reached or refuses the token (FE-01)', async () => {
        renderPanel();
        // The backend is down: socket.io keeps retrying, the tab says so.
        sockets[0].fire('connect_error', new Error('xhr poll error'));
        expect(screen.getByRole('status')).toHaveTextContent('Backend unreachable');
        expect(screen.getByRole('status')).toHaveTextContent('The ShellMind backend cannot be reached. Retrying…');
        expect(useAppStore.getState().connections[1].state).toBe('disconnected');
        // It comes back: the session starts again.
        connect(sockets[0]);
        expect(screen.queryByRole('status')).toBeNull();
        expect(sockets[0].sent('start-ssh')).toHaveLength(1);

        // A rotated token: no retry, the access screen is told through HTTP.
        fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
        sockets[1].fire('connect_error', new Error('unauthorized'));
        expect(screen.getByRole('alert')).toHaveTextContent('no longer accepts this session’s access token');
        expect(sockets[1].disconnected).toBe(true);
        await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/api/session'))).toBe(true));
    });

    it('does not report "run again" after the session ended (FE-11)', async () => {
        useCommandHistory.getState().record(1, 'echo first-run', 'typed');
        renderPanel();
        connect(sockets[0]);
        sockets[0].fire('ssh-closed');
        fireEvent.click(screen.getByRole('button', { name: /^Command history/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Run again/ }));
        expect(await screen.findByText('Not connected')).toBeInTheDocument();
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        expect(screen.queryByText('Command run again')).toBeNull();
    });

    it('holds queued commands while a full-screen program runs, and types them once it exits (FE-08)', () => {
        renderPanel();
        terms[0].screenLine = 'root@web-1:~# ';
        connect(sockets[0]);
        terms[0].switchBuffer('alternate');
        act(() => useAppStore.getState().queueCommand(1, 'echo QUEUED', 'ai'));
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        expect(screen.getByRole('status')).toHaveTextContent('A command is waiting: a full-screen program');

        // vi exits: the shell gets it.
        terms[0].switchBuffer('normal');
        expect(sockets[0].sent('ssh-input')).toEqual([['echo QUEUED\r']]);
        expect(screen.queryByRole('status')).toBeNull();

        // Or the user decides.
        terms[0].switchBuffer('alternate');
        act(() => useAppStore.getState().queueCommand(1, 'echo ONE', 'snippet'));
        act(() => useAppStore.getState().queueCommand(1, 'echo TWO', 'snippet'));
        expect(screen.getByRole('status')).toHaveTextContent('2 commands are waiting');
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
        act(() => useAppStore.getState().queueCommand(1, ':wq', 'ai'));
        fireEvent.click(screen.getByRole('button', { name: 'Type into the program' }));
        expect(sockets[0].sent('ssh-input')).toEqual([['echo QUEUED\r'], [':wq\r']]);
    });

    it('asks before typing a command from the history into a full-screen program (FE-08)', async () => {
        useCommandHistory.getState().record(1, 'df -h', 'typed');
        renderPanel();
        connect(sockets[0]);
        terms[0].switchBuffer('alternate');
        fireEvent.click(screen.getByRole('button', { name: /^Command history/ }));
        fireEvent.click(await screen.findByRole('button', { name: /Run again/ }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('A full-screen program is running');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(await screen.findByText('Command not sent')).toBeInTheDocument();
        expect(sockets[0].sent('ssh-input')).toEqual([]);
    });

    it('asks before typing a block of lines where no shell prompt is in sight (FE-08)', async () => {
        renderPanel();
        terms[0].screenLine = 'mysql> ';
        connect(sockets[0]);
        act(() => useAppStore.getState().queueCommand(1, 'cd /srv\nls', 'ai'));
        const dialog = await screen.findByRole('alertdialog');
        // Named: the server's terminal may not be the one on screen.
        expect(dialog).toHaveTextContent('No shell prompt in sight in web-1');
        expect(dialog).toHaveTextContent('Type these 2 lines anyway?');
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        fireEvent.click(within(dialog).getByRole('button', { name: 'Type anyway' }));
        await waitFor(() => expect(sockets[0].sent('ssh-input')).toEqual([['cd /srv\rls\r']]));

        // Declined: whoever queued it is told.
        const reports = vi.fn();
        const stop = onCommandUndelivered(reports);
        act(() => useAppStore.getState().queueCommand(1, 'cd /tmp\nls', 'snippet'));
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(reports).toHaveBeenCalledWith({ serverId: 1, command: 'cd /tmp\nls', source: 'snippet', reason: 'declined' }));
        stop();
    });

    it('waits for the prompt of a session that just (re)connected before judging a queued block (FE-08 review)', () => {
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], 'demo-server:~$ ');
        // `exit`: the session ends, and a two-line snippet is queued meanwhile.
        sockets[0].fire('ssh-closed');
        act(() => useAppStore.getState().queueCommand(1, 'cd /srv\nls', 'snippet'));
        fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Reconnect' }));

        // Connected, but the shell printed nothing yet (the cursor is on the
        // "Reconnecting…" line's successor), then its banner.
        terms[0].screenLine = '';
        connect(sockets[1]);
        sockets[1].fire('ssh-output', 'Last login: Fri Oct 24 09:12:01 2026\r\n');
        expect(sockets[1].sent('ssh-input')).toEqual([]);
        // The prompt: typed as the shell takes it, nobody asked.
        showPrompt(sockets[1], 'demo-server:~$ ');
        expect(sockets[1].sent('ssh-input')).toEqual([['cd /srv\rls\r']]);
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('starts a reconnected session from a plain terminal, out of the full-screen program the last one ended in', () => {
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], 'demo-server:~$ ');
        terms[0].switchBuffer('alternate');
        // The connection drops while vi is open.
        sockets[0].fire('ssh-closed');
        fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Reconnect' }));
        const written = decodeAll(terms[0].written);
        const reset = written.lastIndexOf('\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1006l');
        expect(reset).toBeGreaterThan(-1);
        expect(written.indexOf('Reconnecting', reset)).toBeGreaterThan(reset);

        // Only a full-screen program's screen is left (that also moves the cursor).
        terms[0].switchBuffer('normal');
        sockets[1].fire('ssh-closed');
        fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Reconnect' }));
        expect(decodeAll(terms[0].written).slice(written.length)).toContain('\x1b[!p');
        expect(decodeAll(terms[0].written).slice(written.length)).not.toContain('\x1b[?1049l');
    });

    it('never holds an Auto-Run step behind a full-screen program: it is dropped and reported (FE-08 review)', () => {
        const reports = vi.fn();
        const stop = onCommandUndelivered(reports);
        renderPanel();
        terms[0].screenLine = 'root@web-1:~# ';
        connect(sockets[0]);
        terms[0].switchBuffer('alternate');
        act(() => useAppStore.getState().queueCommand(1, 'systemctl status nginx', 'ai-autorun'));
        act(() => useAppStore.getState().queueCommand(1, 'echo SNIPPET', 'snippet'));

        expect(reports).toHaveBeenCalledTimes(1);
        expect(reports).toHaveBeenCalledWith({ serverId: 1, command: 'systemctl status nginx', source: 'ai-autorun', reason: 'full-screen' });
        expect(screen.getByText('Auto-Run step not typed: a full-screen program is running')).toBeInTheDocument();
        // The user's own command waits for the program to exit, as before.
        expect(useAppStore.getState().pendingCommands[1].map((entry) => entry.command)).toEqual(['echo SNIPPET']);
        expect(screen.getByRole('status')).toHaveTextContent('A command is waiting');
        terms[0].switchBuffer('normal');
        expect(sockets[0].sent('ssh-input')).toEqual([['echo SNIPPET\r']]);

        // Discarded from the banner: reported too.
        terms[0].switchBuffer('alternate');
        act(() => useAppStore.getState().queueCommand(1, 'echo LATER', 'ai'));
        fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
        expect(reports).toHaveBeenLastCalledWith({ serverId: 1, command: 'echo LATER', source: 'ai', reason: 'discarded' });
        stop();
    });

    it('does not ask about an Auto-Run block where no shell prompt is in sight: it is reported instead (FE-08 review)', () => {
        const reports = vi.fn();
        const stop = onCommandUndelivered(reports);
        renderPanel();
        terms[0].screenLine = 'mysql> ';
        connect(sockets[0]);
        act(() => useAppStore.getState().queueCommand(1, 'cd /srv\nls', 'ai-autorun'));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        expect(sockets[0].sent('ssh-input')).toEqual([]);
        expect(reports).toHaveBeenCalledWith({ serverId: 1, command: 'cd /srv\nls', source: 'ai-autorun', reason: 'no-prompt' });
        expect(useAppStore.getState().pendingCommands[1]).toBeUndefined();
        stop();
    });

    it('drops an Auto-Run step whose session ended before its shell was ready, instead of typing it into the next one', () => {
        const reports = vi.fn();
        const stop = onCommandUndelivered(reports);
        renderPanel();
        connect(sockets[0]);
        act(() => useAppStore.getState().queueCommand(1, 'uptime', 'ai-autorun'));
        act(() => useAppStore.getState().queueCommand(1, 'df -h', 'snippet'));
        sockets[0].fire('ssh-closed');
        expect(reports).toHaveBeenCalledWith({ serverId: 1, command: 'uptime', source: 'ai-autorun', reason: 'not-connected' });

        fireEvent.click(within(screen.getByRole('status')).getByRole('button', { name: 'Reconnect' }));
        connect(sockets[1]);
        showPrompt(sockets[1], 'root@web-1:~# ');
        expect(sockets[1].sent('ssh-input')).toEqual([['df -h\r']]);
        stop();
    });

    it('turns on xterm’s screen reader mode with the preference (UX-10)', () => {
        renderPanel();
        expect(xtermOptions.at(-1)?.screenReaderMode).toBe(false);
        act(() => useTerminalPrefs.getState().setScreenReaderMode(true));
        expect(xtermOptions.at(-1)?.screenReaderMode).toBe(true);
        expect(localStorage.getItem('shellmind.terminal.screenReaderMode')).toBe('on');
    });
});

// --- W8-T1 split panes and broadcast input ---
describe('TerminalPanel: split panes and broadcast input (W8-T1)', () => {
    const SERVER_2: WorkspaceServer = { id: 2, name: 'db-1', ip: '10.0.0.6', type: 'linux' };
    const PROMPT = 'root@web-1:~# ';
    const keys = {
        splitRight: { key: 'D', code: 'KeyD', ctrlKey: true, shiftKey: true },
        splitDown: { key: 'D', code: 'KeyD', ctrlKey: true, altKey: true, shiftKey: true },
        broadcast: { key: 'B', code: 'KeyB', ctrlKey: true, shiftKey: true }
    };
    const visiblePanels = () => Array.from(document.querySelectorAll<HTMLElement>('[id^="terminal-panel-"]')).filter((panel) => !panel.hidden);
    const tablist = (index = 0) => screen.getAllByRole('tablist', { name: 'Terminal sessions' })[index];
    const press = (init: KeyboardEventInit, index = 0) => fireEvent.keyDown(tablist(index), init);
    const sessionIds = (serverId = 1) => useAppStore.getState().terminalSessions[serverId].sessions.map((session) => session.id);
    const focusedId = (serverId = 1) => useAppStore.getState().terminalSessions[serverId].focusedId;
    const inputs = (socket: FakeSocket) => socket.sent('ssh-input').map(([data]) => data).join('');
    const auditBodies = () => fetchMock.mock.calls
        .filter(([url]) => String(url).endsWith('/api/audit'))
        .map(([, init]) => JSON.parse(String(init?.body)));

    // A panel split in two, both shells at a prompt; the second pane has the focus.
    function twoPanes() {
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], PROMPT);
        press(keys.splitRight);
        connect(sockets[1]);
        showPrompt(sockets[1], PROMPT, terms[1]);
    }

    // Mod+Shift+B (starting asks first when it spans servers, so it settles a moment later).
    async function toggleBroadcast(active: boolean) {
        press(keys.broadcast);
        await waitFor(() => expect(useBroadcast.getState().active).toBe(active));
    }

    beforeEach(() => {
        usePanes.setState({ layouts: {} });
        resetBroadcast();
        const summary = (id: number, name: string) => ({ id, name, ip: '10.0.0.5', type: 'linux' }) as ServerSummary;
        useServersStore.setState({ servers: [summary(1, 'web-1'), summary(2, 'db-1')], status: 'ready', error: null });
    });

    afterEach(() => {
        resetBroadcast();
    });

    it('splits from the keyboard into labelled panes, each with its own session, and remembers the layout', () => {
        renderPanel();
        connect(sockets[0]);
        // Mod+Shift+D never reaches the shell; the panel splits.
        expect(terms[0].keyHandler!(new KeyboardEvent('keydown', keys.splitRight))).toBe(false);
        press(keys.splitRight);
        expect(sockets).toHaveLength(2);
        expect(visiblePanels()).toHaveLength(2);
        expect(screen.getAllByRole('tabpanel').map((panel) => panel.getAttribute('aria-labelledby')?.split(' ').length)).toEqual([2, 2]);
        expect(screen.getByRole('tabpanel', { name: 'Pane 2 of 2 Terminal 2' })).toBeInTheDocument();
        expect(screen.getByRole('separator', { name: 'Resize Terminal 1 and Terminal 2' })).toHaveAttribute('aria-valuenow', '50');
        expect(JSON.parse(localStorage.getItem('shellmind.terminal.panes.1')!)).toMatchObject({ type: 'split', direction: 'row' });

        press(keys.splitDown);
        press(keys.splitDown);
        expect(visiblePanels()).toHaveLength(4);
        // Four is the most: a notice, no fifth session.
        press(keys.splitRight);
        expect(sockets).toHaveLength(4);
        expect(screen.getByText('A terminal shows up to 4 panes')).toBeInTheDocument();
    });

    // UX-09: the same from the command palette (requestPaneCommand), and
    // Alt+Shift+arrows where GNOME takes Ctrl+Alt+arrows.
    it('splits, moves to the next pane and toggles broadcast input when the palette asks', async () => {
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], PROMPT);
        // Another server's request is not this panel's.
        act(() => useAppStore.getState().requestPaneCommand(2, 'split-right'));
        expect(visiblePanels()).toHaveLength(1);
        expect(useAppStore.getState().paneCommand).not.toBeNull();
        act(() => useAppStore.getState().requestPaneCommand(1, 'split-right'));
        expect(visiblePanels()).toHaveLength(2);
        expect(useAppStore.getState().paneCommand).toBeNull();
        connect(sockets[1]);
        showPrompt(sockets[1], PROMPT, terms[1]);
        const [first, second] = sessionIds();
        expect(focusedId()).toBe(second);
        act(() => useAppStore.getState().requestPaneCommand(1, 'focus-next'));
        expect(focusedId()).toBe(first);
        expect(screen.getByText('Pane 1 of 2: Terminal 1')).toBeInTheDocument();
        press({ key: 'ArrowRight', altKey: true, shiftKey: true });
        expect(focusedId()).toBe(second);
        act(() => useAppStore.getState().requestPaneCommand(1, 'toggle-broadcast'));
        await waitFor(() => expect(useBroadcast.getState().active).toBe(true));
        act(() => useAppStore.getState().requestPaneCommand(1, 'split-down'));
        expect(visiblePanels()).toHaveLength(3);
    });

    it('moves between panes with Mod+Alt+arrows (announced) and resizes them from the keyboard', () => {
        twoPanes();
        const [first, second] = sessionIds();
        expect(focusedId()).toBe(second);
        press({ key: 'ArrowLeft', ctrlKey: true, altKey: true });
        expect(focusedId()).toBe(first);
        expect(screen.getByRole('tab', { name: /Terminal 1/ })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText('Pane 1 of 2: Terminal 1')).toBeInTheDocument();

        const divider = screen.getByRole('separator', { name: 'Resize Terminal 1 and Terminal 2' });
        press({ key: 'ArrowRight', ctrlKey: true, altKey: true, shiftKey: true });
        expect(divider).toHaveAttribute('aria-valuenow', '55');
        fireEvent.keyDown(divider, { key: 'ArrowLeft' });
        fireEvent.keyDown(divider, { key: 'ArrowLeft' });
        expect(divider).toHaveAttribute('aria-valuenow', '45');
        fireEvent.keyDown(divider, { key: 'Home' });
        expect(divider).toHaveAttribute('aria-valuenow', '15');
        fireEvent.keyDown(divider, { key: 'Enter' });
        expect(divider).toHaveAttribute('aria-valuenow', '50');
    });

    it('closes a pane without ending its session, which stays in the tab strip', () => {
        twoPanes();
        fireEvent.click(screen.getByRole('button', { name: 'Close the pane of Terminal 2 (it keeps running in its tab)' }));
        expect(visiblePanels()).toHaveLength(1);
        expect(screen.getAllByRole('tab')).toHaveLength(2);
        expect(sockets[1].disconnected).toBe(false);
        expect(screen.queryByRole('separator')).toBeNull();
        expect(localStorage.getItem('shellmind.terminal.panes.1')).toBeNull();
    });

    it('shows a tab dropped on a pane there, and offers the panes in the tab menu', () => {
        twoPanes();
        const [first, second] = sessionIds();
        // A third tab shows in the active pane, in the place of the second.
        fireEvent.click(screen.getByRole('button', { name: 'New terminal' }));
        const third = focusedId();
        expect(visiblePanels().map((panel) => panel.id)).toEqual([`terminal-panel-${first}`, `terminal-panel-${third}`]);

        const dataTransfer = { setData: vi.fn(), getData: () => second, types: [SESSION_DRAG_TYPE], effectAllowed: '', dropEffect: '' };
        fireEvent.dragStart(screen.getByRole('tab', { name: /Terminal 2/ }), { dataTransfer });
        const target = document.getElementById(`terminal-panel-${first}`)!.querySelector('[data-drop-target]')!;
        fireEvent.dragOver(target, { dataTransfer });
        fireEvent.drop(target, { dataTransfer });
        expect(visiblePanels().map((panel) => panel.id).sort()).toEqual([`terminal-panel-${second}`, `terminal-panel-${third}`].sort());
        expect(focusedId()).toBe(second);
        expect(document.querySelector('[data-drop-target]')).toBeNull();

        // From the keyboard: the tab's menu (Shift+F10).
        fireEvent.keyDown(screen.getByRole('tab', { name: /Terminal 1/ }), { key: 'F10', shiftKey: true });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Show in pane 1' }));
        expect(visiblePanels().map((panel) => panel.id).sort()).toEqual([`terminal-panel-${first}`, `terminal-panel-${third}`].sort());
    });

    it('types once into every terminal of the group, highlighted, and keeps queued commands to the focused one', async () => {
        twoPanes();
        // Mod+Shift+B from inside the terminal is left to the panel.
        expect(terms[1].keyHandler!(new KeyboardEvent('keydown', keys.broadcast))).toBe(false);
        await toggleBroadcast(true);
        expect(screen.getByRole('status')).toHaveTextContent('Broadcasting to 2 terminals');
        // UX-11: the whole sentence is readable where a narrow pane cuts it.
        const sentence = screen.getByText('Broadcasting to 2 terminals').closest('p');
        expect(sentence).toHaveAttribute('title', 'Broadcasting to 2 terminals. What you type in a highlighted terminal is typed into all of them.');
        expect(sentence?.className).not.toContain('truncate');
        expect(screen.getAllByText('Broadcast')).toHaveLength(2);
        expect(screen.getByRole('button', { name: 'Broadcast input: on, 2 terminals' })).toBeInTheDocument();

        terms[1].typeKeys('uptime');
        terms[1].typeKeys('\r');
        expect(inputs(sockets[0])).toBe('uptime\r');
        expect(inputs(sockets[1])).toBe('uptime\r');

        // Each terminal records the line it ran, with how many got it.
        terms[0].screenLine = `${PROMPT}uptime`;
        terms[1].screenLine = `${PROMPT}uptime`;
        await waitFor(() => expect(auditBodies()).toHaveLength(2), { timeout: 3000 });
        expect(auditBodies()).toEqual([
            { serverId: 1, source: 'terminal', command: 'uptime', meta: { broadcast: 2 } },
            { serverId: 1, source: 'terminal', command: 'uptime', meta: { broadcast: 2 } }
        ]);

        // The AI's commands still go to the focused terminal only.
        terms[0].screenLine = PROMPT;
        terms[1].screenLine = PROMPT;
        act(() => useAppStore.getState().queueCommand(1, 'df -h', 'ai'));
        expect(inputs(sockets[1])).toBe('uptime\rdf -h\r');
        expect(inputs(sockets[0])).toBe('uptime\r');

        await toggleBroadcast(false);
        expect(screen.queryByRole('status')).toBeNull();
        expect(screen.getByText('Broadcast input off')).toBeInTheDocument();
        terms[1].typeKeys('w');
        expect(inputs(sockets[0])).toBe('uptime\r');
    });

    it('never types a password prompt’s answer elsewhere, nor anything into a terminal at a password prompt', async () => {
        twoPanes();
        await toggleBroadcast(true);
        terms[0].screenLine = '[sudo] password for root: ';
        terms[1].typeKeys('ls');
        terms[1].typeKeys('\r');
        expect(inputs(sockets[0])).toBe('');
        expect(screen.getByText('Paused: password prompt')).toBeInTheDocument();

        // Typed into the terminal asking for it: the answer stays there.
        fireEvent.focus(document.getElementById(`terminal-panel-${sessionIds()[0]}`)!.querySelector('[class*="overflow-hidden"]')!);
        terms[0].typeKeys('hunter2');
        terms[0].typeKeys('\r');
        expect(inputs(sockets[0])).toBe('hunter2\r');
        expect(inputs(sockets[1])).toBe('ls\r');
    });

    it('asks before Enter runs a destructive command in several terminals', async () => {
        twoPanes();
        await toggleBroadcast(true);
        terms[1].typeKeys('sudo reboot');
        terms[0].screenLine = `${PROMPT}sudo reboot`;
        terms[1].screenLine = `${PROMPT}sudo reboot`;
        terms[1].typeKeys('\r');
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Run this on 2 terminals?');
        expect(dialog).toHaveTextContent('This command shuts down or restarts the machine: sudo reboot. It runs in: web-1 · Terminal 2, web-1 · Terminal 1.');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        expect(await screen.findByText('Enter not sent: the command stays typed')).toBeInTheDocument();
        expect(inputs(sockets[0])).toBe('sudo reboot');
        expect(inputs(sockets[1])).toBe('sudo reboot');

        terms[1].typeKeys('\r');
        fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Run on 2 terminals' }));
        await waitFor(() => expect(inputs(sockets[0])).toBe('sudo reboot\r'));
        expect(inputs(sockets[1])).toBe('sudo reboot\r');
    });

    it('asks before pasting into several terminals', async () => {
        Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { readText: async () => 'cat /etc/hosts' } });
        twoPanes();
        (terms[1] as unknown as { paste: (text: string) => void }).paste = (text) => terms[1].typeKeys(`\x1b[200~${text}\x1b[201~`);
        await toggleBroadcast(true);
        fireEvent.click(screen.getByRole('button', { name: /^Paste/ }));
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('Paste into 2 terminals?');
        expect(dialog).toHaveTextContent('The text is pasted into: web-1 · Terminal 2, web-1 · Terminal 1.');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Paste into 2 terminals' }));
        await waitFor(() => expect(inputs(sockets[0])).toBe('\x1b[200~cat /etc/hosts\x1b[201~'));
        expect(inputs(sockets[1])).toBe('\x1b[200~cat /etc/hosts\x1b[201~');
    });

    it('stops broadcasting when a terminal of the group ends, and says so', async () => {
        twoPanes();
        await toggleBroadcast(true);
        sockets[0].fire('ssh-closed');
        expect(useBroadcast.getState().active).toBe(false);
        expect(await screen.findByText('Broadcast stopped: the session of web-1 · Terminal 1 ended')).toBeInTheDocument();
        // The group is kept: Mod+Shift+B starts it again.
        await toggleBroadcast(true);
    });

    it('broadcasts across open servers once the user agrees to type into several servers', async () => {
        render(
            <ToastProvider>
                <ConfirmProvider>
                    <TerminalPanel server={SERVER} />
                    <TerminalPanel server={SERVER_2} />
                </ConfirmProvider>
            </ToastProvider>
        );
        connect(sockets[0]);
        connect(sockets[1]);
        showPrompt(sockets[0], PROMPT, terms[0]);
        showPrompt(sockets[1], 'root@db-1:~# ', terms[1]);
        fireEvent.click(screen.getAllByRole('button', { name: 'Broadcast input' })[1]);
        const picker = screen.getByRole('dialog', { name: 'Broadcast input' });
        expect(within(picker).getByRole('group', { name: 'db-1 · on screen' })).toBeInTheDocument();
        for (const box of within(picker).getAllByRole('checkbox')) fireEvent.click(box);
        fireEvent.click(within(picker).getByRole('button', { name: 'Start broadcasting' }));
        const confirm = await screen.findByRole('alertdialog');
        expect(confirm).toHaveTextContent('Broadcast to 2 servers?');
        expect(confirm).toHaveTextContent('db-1 (1), web-1 (1)');
        fireEvent.click(within(confirm).getByRole('button', { name: 'Broadcast' }));
        await waitFor(() => expect(useBroadcast.getState().active).toBe(true));
        expect(screen.queryByRole('dialog', { name: 'Broadcast input' })).toBeNull();

        terms[1].typeKeys('hostname');
        expect(inputs(sockets[0])).toBe('hostname');
        expect(screen.getAllByText('Broadcasting to 2 terminals on 2 servers')).toHaveLength(2);
    });

    // The shell behind `socket` answers: a new line, then `line` at the cursor.
    function answer(socket: FakeSocket, term: FakeTerm, line: string) {
        term.screenLine = line;
        socket.fire('ssh-output', `\r\n${line}`);
    }

    // Two panels side by side (web-1 and db-1), each split in two, at their prompts.
    function twoServersSplit() {
        render(
            <ToastProvider>
                <ConfirmProvider>
                    <TerminalPanel server={SERVER} />
                    <TerminalPanel server={SERVER_2} />
                </ConfirmProvider>
            </ToastProvider>
        );
        connect(sockets[0]);
        connect(sockets[1]);
        press(keys.splitRight, 0);
        press(keys.splitRight, 1);
        connect(sockets[2]);
        connect(sockets[3]);
        sockets.forEach((socket, index) => showPrompt(socket, index % 2 ? 'root@db-1:~# ' : PROMPT, terms[index]));
    }

    it('never types elsewhere what is typed ahead of a password prompt that shows up late (W8-T1 review)', async () => {
        twoPanes();
        await toggleBroadcast(true);
        terms[1].typeKeys('sudo -k; sudo true');
        terms[1].typeKeys('\r');
        // Typed before the source answered: it waits, and the others show it.
        terms[1].typeKeys('Secr3t');
        expect(screen.getByText('On hold until the terminal you type in shows its prompt')).toBeInTheDocument();
        answer(sockets[1], terms[1], '[sudo] password for root: ');
        terms[1].typeKeys('PW');
        terms[1].typeKeys('\r');
        expect(inputs(sockets[1])).toBe('sudo -k; sudo true\rSecr3tPW\r');
        expect(inputs(sockets[0])).toBe('sudo -k; sudo true\r');
        expect(screen.getByText('Paused: password prompt')).toBeInTheDocument();
        await new Promise((resolve) => setTimeout(resolve, 1200));
        expect(JSON.stringify(auditBodies())).not.toContain('Secr3t');

        // A line typed ahead while the source ran something goes out once its prompt shows it.
        answer(sockets[1], terms[1], PROMPT);
        terms[1].typeKeys('sleep 1');
        terms[1].typeKeys('\r');
        terms[1].typeKeys('ls');
        expect(inputs(sockets[0])).toBe('sudo -k; sudo true\rsleep 1\r');
        answer(sockets[1], terms[1], `${PROMPT}ls`);
        expect(inputs(sockets[0])).toBe('sudo -k; sudo true\rsleep 1\rls');
    });

    it('asks before Enter on a line not echoed yet, and waits for the screen after the arrow keys (W8-T1 review)', async () => {
        twoPanes();
        await toggleBroadcast(true);
        // Typed faster than the echo: the keys tell what runs.
        terms[1].typeKeys('sudo reboot');
        terms[1].typeKeys('\r');
        const dialog = await screen.findByRole('alertdialog');
        expect(dialog).toHaveTextContent('This command shuts down or restarts the machine: sudo reboot.');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await screen.findByText('Enter not sent: the command stays typed');
        terms[1].typeKeys('\x03');
        answer(sockets[1], terms[1], PROMPT);
        answer(sockets[0], terms[0], PROMPT);

        // ↑ then Enter before the shell redrew the line: Enter waits for the screen.
        terms[1].typeKeys('\x1b[A');
        terms[1].typeKeys('\r');
        terms[1].typeKeys('w');
        expect(inputs(sockets[0]).endsWith('\x1b[A')).toBe(true);
        expect(screen.queryByRole('alertdialog')).toBeNull();
        terms[1].screenLine = `${PROMPT}sudo reboot`;
        sockets[1].fire('ssh-output', 'sudo reboot');
        const recalled = await screen.findByRole('alertdialog');
        expect(recalled).toHaveTextContent('This command shuts down or restarts the machine: sudo reboot.');
        fireEvent.click(within(recalled).getByRole('button', { name: 'Run on 2 terminals' }));
        // The key typed meanwhile follows the Enter; the others get it once
        // the source shows it at its next prompt (typed ahead).
        await waitFor(() => expect(inputs(sockets[1]).endsWith('\x1b[A\rw')).toBe(true));
        expect(inputs(sockets[0]).endsWith('\x1b[A\r')).toBe(true);
        answer(sockets[1], terms[1], `${PROMPT}w`);
        expect(inputs(sockets[0]).endsWith('\x1b[A\rw')).toBe(true);
    });

    it('asks before Enter on a recalled line the screen did not show in time, and not on a harmless one (W8-T1 review)', async () => {
        twoPanes();
        await toggleBroadcast(true);
        terms[1].typeKeys('\x1b[A');
        terms[1].typeKeys('\r');
        terms[1].screenLine = `${PROMPT}uptime`;
        sockets[1].fire('ssh-output', 'uptime');
        await waitFor(() => expect(inputs(sockets[0])).toBe('\x1b[A\r'));
        expect(screen.queryByRole('alertdialog')).toBeNull();
        answer(sockets[1], terms[1], PROMPT);

        terms[1].typeKeys('\x1b[A');
        terms[1].typeKeys('\r');
        const dialog = await screen.findByRole('alertdialog', {}, { timeout: 3000 });
        expect(dialog).toHaveTextContent('This line could not be checked for destructive commands (the terminal did not show it in time)');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
        await screen.findByText('Enter not sent: the command stays typed');
        expect(inputs(sockets[0])).toBe('\x1b[A\r\x1b[A');

        // A history expansion is never taken as harmless either.
        terms[1].typeKeys('\x03');
        answer(sockets[1], terms[1], PROMPT);
        terms[1].typeKeys('sudo !!');
        terms[1].typeKeys('\r');
        expect(await screen.findByRole('alertdialog')).toHaveTextContent('it recalls a command from the shell history');
    });

    it('starts the kept group again only from one of its terminals, and says where broadcasting happens elsewhere (W8-T1 review)', async () => {
        twoServersSplit();
        const serverOf = () => [...new Set(useBroadcast.getState().members.map((key) => Number(key.split(':')[0])))];
        press(keys.broadcast, 0);
        await waitFor(() => expect(useBroadcast.getState().active).toBe(true));
        // (Both panels are on screen here; the app shows one at a time.)
        expect(screen.getAllByText('Broadcast input on: 2 terminals')).not.toHaveLength(0);
        press(keys.broadcast, 0);
        expect(useBroadcast.getState().active).toBe(false);

        // From db-1, whose terminals are not in the group: its own panes.
        press(keys.broadcast, 1);
        await waitFor(() => expect(useBroadcast.getState().active).toBe(true));
        expect(serverOf()).toEqual([2]);

        // web-1's panel says its typing is not broadcast.
        const [webBar, dbBar] = screen.getAllByRole('status');
        expect(webBar).toHaveTextContent('Broadcasting to 2 terminals on db-1');
        expect(webBar).toHaveTextContent('This terminal is not one of them');
        expect(dbBar).toHaveTextContent('Broadcasting to 2 terminals');
        expect(screen.getByRole('button', { name: 'Broadcast input: on in 2 other terminals, not this one' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Broadcast input: on, 2 terminals' })).toBeInTheDocument();
    });

    it('adds the panes on screen of another server after one question (W8-T1 review)', async () => {
        twoServersSplit();
        press(keys.broadcast, 1);
        await waitFor(() => expect(useBroadcast.getState().active).toBe(true));
        fireEvent.click(screen.getByRole('button', { name: 'Broadcast input: on in 2 other terminals, not this one' }));
        fireEvent.click(within(screen.getByRole('dialog', { name: 'Broadcast input' })).getByRole('button', { name: 'Panes on screen' }));
        const confirm = await screen.findByRole('alertdialog');
        expect(confirm).toHaveTextContent('typed into 4 terminals: db-1 (2), web-1 (2)');
        fireEvent.click(within(confirm).getByRole('button', { name: 'Broadcast' }));
        await waitFor(() => expect(useBroadcast.getState().members).toHaveLength(4));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('frames a paused pane apart, says why, and announces it (W8-T1 review)', async () => {
        twoPanes();
        const [first] = sessionIds();
        const tabOf = () => screen.getByRole('tab', { name: /Terminal 1/ });
        fireEvent.keyDown(tabOf(), { key: 'F10', shiftKey: true });
        fireEvent.click(screen.getByRole('menuitem', { name: 'Include Terminal 1 in the broadcast' }));
        expect(tabOf()).toHaveAccessibleName('Terminal 1, in the broadcast group');
        await toggleBroadcast(true);
        expect(tabOf()).toHaveAccessibleName('Terminal 1, Broadcast');

        // Terminal 1 runs a full-screen program.
        terms[0].switchBuffer('alternate');
        sockets[0].fire('ssh-output', '\x1b[?1049h~');
        await screen.findByText('Terminal 1: Paused: full-screen program', {}, { timeout: 2000 });
        const pane = document.getElementById(`terminal-panel-${first}`)!;
        expect(within(pane).getByText('Paused: full-screen program')).toHaveClass('sr-only');
        expect(within(pane).getByText('Full screen').closest('[title]')).toHaveAttribute('title', 'Terminal 1: Paused: full-screen program. It does not get what you type now.');
        expect(pane.querySelector('.border-dashed')).not.toBeNull();
        // Its buttons leave the keys in the terminal typed into (Terminal 2).
        const typeAnyway = within(pane).getByRole('button', { name: 'Type into Terminal 1 anyway' });
        expect(fireEvent.mouseDown(typeAnyway)).toBe(false);
        fireEvent.focus(typeAnyway);
        expect(focusedId()).toBe(sessionIds()[1]);
        fireEvent.click(typeAnyway);
        await waitFor(() => expect(within(pane).queryByText('Full screen')).toBeNull());
        expect(pane.querySelector('.border-dashed')).toBeNull();
    });

    it('moves a pane by dragging its header, which leaves the mouse press alone so the drag can start (W8-T1 review)', () => {
        twoPanes();
        const [first, second] = sessionIds();
        const strip = within(document.getElementById(`terminal-panel-${first}`)!).getByTitle(/^Drag it onto a pane/);
        // A press the page cancels never starts a native drag in Chromium.
        expect(fireEvent.mouseDown(strip)).toBe(true);
        const dataTransfer = { setData: vi.fn(), getData: () => first, types: [SESSION_DRAG_TYPE], effectAllowed: '', dropEffect: '' };
        fireEvent.dragStart(strip, { dataTransfer });
        expect(dataTransfer.setData).toHaveBeenCalledWith(SESSION_DRAG_TYPE, first);
        const target = document.getElementById(`terminal-panel-${second}`)!.querySelector('[data-drop-target]')!;
        fireEvent.dragOver(target, { dataTransfer });
        fireEvent.drop(target, { dataTransfer });
        expect(leaves(usePanes.getState().layouts[1]!.root).map((pane) => pane.sessionId)).toEqual([second, first]);
        expect(focusedId()).toBe(first);
        // A click on the strip gives its terminal the keys.
        fireEvent.click(within(document.getElementById(`terminal-panel-${second}`)!).getByTitle(/^Drag it onto a pane/));
        expect(focusedId()).toBe(second);
    });

    // W8 integration: a Windows console (ConPTY) asks for focus reports; they
    // are this terminal's own, never broadcast nor taken for typing.
    it('keeps a terminal\'s focus reports to its own program while broadcasting', async () => {
        twoPanes();
        await toggleBroadcast(true);
        terms[1].typeKeys('\x1b[I');
        terms[1].typeKeys('uptime');
        terms[1].typeKeys('\x1b[O');
        terms[1].typeKeys('\x1b[I');
        terms[1].typeKeys('\r');
        expect(inputs(sockets[1])).toBe('\x1b[Iuptime\x1b[O\x1b[I\r');
        expect(inputs(sockets[0])).toBe('uptime\r');
        terms[0].screenLine = `${PROMPT}uptime`;
        terms[1].screenLine = `${PROMPT}uptime`;
        await waitFor(() => expect(auditBodies()).toHaveLength(2), { timeout: 3000 });
        expect(auditBodies().map((body) => body.command)).toEqual(['uptime', 'uptime']);
    });

    // W8 integration: the panes and broadcast input with a shell inside a Kubernetes pod (W8-T2).
    it('splits a pod\'s shell into another shell in the same pod, and a broadcast line is audited with the pod', async () => {
        const attach = { kind: 'pod' as const, context: 'k3s', namespace: 'shop', pod: 'web-7d9f', container: 'app' };
        useAppStore.getState().openTerminalSession(1, { attach });
        renderPanel();
        connect(sockets[0]);
        showPrompt(sockets[0], '/ # ');
        press(keys.splitRight);
        expect(sockets).toHaveLength(2);
        connect(sockets[1]);
        showPrompt(sockets[1], '/ # ', terms[1]);
        expect(sockets[1].sent('start-ssh')[0]).toEqual([expect.objectContaining({ attach })]);
        expect(screen.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['pod: web-7d9f/app', 'pod: web-7d9f/app']);
        expect(visiblePanels()).toHaveLength(2);

        await toggleBroadcast(true);
        terms[1].typeKeys('hostname');
        terms[1].typeKeys('\r');
        expect(inputs(sockets[0])).toBe('hostname\r');
        expect(inputs(sockets[1])).toBe('hostname\r');
        terms[0].screenLine = '/ # hostname';
        terms[1].screenLine = '/ # hostname';
        await waitFor(() => expect(auditBodies()).toHaveLength(2), { timeout: 3000 });
        const pod = { kind: 'k8s', context: 'k3s', namespace: 'shop', pod: 'web-7d9f', container: 'app' };
        expect(auditBodies()).toEqual([
            { serverId: 1, source: 'terminal', command: 'hostname', meta: { broadcast: 2, ...pod } },
            { serverId: 1, source: 'terminal', command: 'hostname', meta: { broadcast: 2, ...pod } }
        ]);
    });
});
