import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnyTerminalAttach, HostKeyInfo, HostKeyMismatchPayload } from '@shared/protocol';
import type { ConnectionError, TrustHostKeyResult } from '@shared/terminal';
import type { Terminal } from '@xterm/xterm';
import type { ConnState } from '@/components/ui/StatusDot';
import { t } from '@/i18n';
import { api } from '@/lib/api';
import { describeConnectionError, plainText } from '@/lib/connectionErrors';
import { createSocket, type AppSocket } from '@/lib/socket';
import type { TerminalSize } from '@/store/terminalOutput';
import type { WorkspaceServer } from '@/workspace/types';
import { formatTerminalNotice, formatTrustedKey } from './notices';
import type { XtermHandle } from './useXterm';

const TRUST_TIMEOUT_MS = 15_000;

export type SessionEvents = {
    // Output written to the terminal (after xterm processed it), and the
    // terminal's size then.
    onOutput: (data: string, size: TerminalSize) => void;
    onOsDetected: (os: string) => void;
    onHostKeyTrusted: (info: HostKeyInfo) => void;
};

export type TerminalConnection = {
    state: ConnState;
    // Why the session failed, in the user's language, and the backend's own
    // text when that says more ('' otherwise).
    error: string;
    errorDetail: string;
    // The backend cannot be reached (socket.io keeps trying).
    offline: boolean;
    mismatch: HostKeyMismatchPayload | null;
    // A fresh session in the same terminal (its scrollback stays).
    reconnect: () => void;
    // Sends input to the remote side; false when no session is up.
    send: (data: string) => boolean;
    // Input would reach a live session now.
    canSend: () => boolean;
    // Replaces the changed host key by the one presented (the user checked
    // it); the session must then reconnect.
    trustHostKey: (mismatch: HostKeyMismatchPayload) => Promise<TrustHostKeyResult>;
};

const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

// A session that ended inside a full-screen program, or with bracketed paste,
// application cursor keys or mouse reporting on, leaves the terminal in those
// modes: the next session starts from a plain terminal, the scrollback kept.
// (Leaving the alternate screen also puts the cursor back where the program
// started, so it is only done when that screen is active.)
function resetSessionModes(term: Terminal): string {
    const leaveFullScreen = term.buffer.active.type === 'alternate' ? '\x1b[?1049l' : '';
    // DECSTR soft reset; mouse tracking and its SGR encoding off.
    return `${leaveFullScreen}\x1b[!p\x1b[?1000l\x1b[?1006l`;
}

// The output arrives as UTF-8 bytes (an ArrayBuffer in the browser) or, from
// the FTP shell, as text.
function outputBytes(data: string | Uint8Array | ArrayBuffer): Uint8Array | null {
    if (typeof data === 'string') return null;
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

// The socket of one terminal tab: opens the session for `server` (inside a
// container of it with `attach`), writes its output into xterm
// (acknowledging it, for the backend's flow control) and carries input and
// resizes back.
export function useTerminalSocket(server: WorkspaceServer, xterm: XtermHandle | null, events: SessionEvents, attach?: AnyTerminalAttach): TerminalConnection {
    const [state, setState] = useState<ConnState>('connecting');
    const [error, setError] = useState('');
    const [errorDetail, setErrorDetail] = useState('');
    const [offline, setOffline] = useState(false);
    const [mismatch, setMismatch] = useState<HostKeyMismatchPayload | null>(null);
    const [attempt, setAttempt] = useState(0);
    const socketRef = useRef<AppSocket | null>(null);
    // The state as the socket handlers last set it (send() reads it between renders).
    const stateRef = useRef<ConnState>('connecting');
    const eventsRef = useRef(events);
    const serverRef = useRef(server);
    // A tab's container never changes: the one it was opened with.
    const attachRef = useRef(attach);
    useEffect(() => {
        eventsRef.current = events;
        serverRef.current = server;
    });

    const serverId = server.id;
    useEffect(() => {
        if (!xterm) return undefined;
        const { term } = xterm;
        const target = serverRef.current;
        const container = attachRef.current;
        // W8-T2: a pod's container (the k8s area words it).
        const opening = container?.kind === 'pod'
            ? t('k8s.terminal.connecting', { container: container.container, pod: container.pod, namespace: container.namespace, context: container.context })
            : container
                ? t('terminal.connectingContainer', { container: container.container, name: target.name })
                : target.ip
                    ? t('terminal.connecting', { name: target.name, host: target.ip })
                    : t('terminal.connectingLocal', { name: target.name });
        term.writeln(attempt === 0 ? `${DIM}${opening}${RESET}` : `${resetSessionModes(term)}\r\n${DIM}${t('terminal.reconnecting')}${RESET}`);

        const update = (next: ConnState | ((previous: ConnState) => ConnState)) => {
            const value = typeof next === 'function' ? next(stateRef.current) : next;
            stateRef.current = value;
            setState(value);
        };
        const showError = (text: string, detail = '') => {
            setError(text);
            setErrorDetail(detail);
        };
        update('connecting');
        showError('');
        setOffline(false);

        const socket = createSocket();
        socketRef.current = socket;
        const settle = (next: ConnState) => update((prev) => (prev === 'error' ? prev : next));
        // Text for the chat's context and issue detection; a character never
        // spans two messages, but the decoder would cope.
        const decoder = new TextDecoder();

        socket.on('connect', () => {
            update('connecting');
            showError('');
            setOffline(false);
            // The backend builds the connection from the saved server; only
            // the terminal size (and the container to open a shell in)
            // travels from here.
            socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: term.cols, rows: term.rows, ...(container ? { attach: container } : {}) });
        });
        socket.on('connect_error', (err: Error) => {
            if (err.message === 'unauthorized') {
                // A rotated or revoked token: socket.io does not retry this.
                // The HTTP check lets the access screen take over.
                update('error');
                showError(t('terminal.errors.unauthorized'));
                socket.disconnect();
                void api.get('/api/session').catch(() => undefined);
                return;
            }
            // The backend is down or unreachable; socket.io keeps retrying
            // and the 'connect' handler starts the session again.
            setOffline(true);
            settle('disconnected');
            showError(t('terminal.errors.backendUnreachable'));
        });
        socket.on('ssh-output', (data) => {
            const bytes = outputBytes(data);
            const done = () => {
                if (socket.connected) socket.emit('ssh-ack', bytes ? bytes.byteLength : (data as string).length);
                const text = bytes ? decoder.decode(bytes, { stream: true }) : (data as string);
                eventsRef.current.onOutput(text, { cols: term.cols, rows: term.rows });
            };
            if (bytes) term.write(bytes, done);
            else term.write(data as string, done);
        });
        socket.on('connection-ready', () => {
            update('connected');
            showError('');
            setMismatch(null);
        });
        socket.on('ssh-error', (message: string, coded?: ConnectionError) => {
            const text = coded ? describeConnectionError(coded) : plainText(message);
            const detail = coded && plainText(coded.message) !== text ? plainText(coded.message) : '';
            term.write(`\r\n${RED}${text}${RESET}\r\n${detail ? `${DIM}${detail}${RESET}\r\n` : ''}`);
            update('error');
            showError(text, detail);
        });
        socket.on('ssh-closed', () => settle('disconnected'));
        socket.on('disconnect', () => settle('disconnected'));
        // Written in order with the output (xterm queues every write).
        socket.on('terminal-notice', (notice) => term.write(formatTerminalNotice(notice)));
        socket.on('os-detected', (os: string) => eventsRef.current.onOsDetected(os));
        socket.on('host-key-mismatch', (payload) => setMismatch(payload));
        socket.on('host-key-trusted', (info) => {
            term.write(formatTrustedKey(info));
            eventsRef.current.onHostKeyTrusted(info);
        });

        const input = term.onResize(({ cols, rows }) => {
            if (socket.connected) socket.emit('resize', { cols, rows });
        });

        return () => {
            input.dispose();
            socket.off();
            socket.disconnect();
            if (socketRef.current === socket) socketRef.current = null;
        };
    }, [xterm, serverId, attempt]);

    const reconnect = useCallback(() => {
        setMismatch(null);
        setAttempt((value) => value + 1);
    }, []);

    // Only a live session reads input: after "Session ended" the socket is
    // still connected, but nothing would run.
    const canSend = useCallback(() => stateRef.current === 'connected' && Boolean(socketRef.current?.connected), []);

    const send = useCallback((data: string) => {
        const socket = socketRef.current;
        if (!socket || !canSend()) return false;
        socket.emit('ssh-input', data);
        return true;
    }, [canSend]);

    // Works in the 'error' state a host-key mismatch leaves the session in.
    const trustHostKey = useCallback((changed: HostKeyMismatchPayload) => new Promise<TrustHostKeyResult>((resolve) => {
        const socket = socketRef.current;
        if (!socket?.connected) {
            resolve({ ok: false, code: 'NOT_CONNECTED', error: t('terminal.notices.notConnected') });
            return;
        }
        const { host, port, keyType, expected, actual } = changed;
        socket.timeout(TRUST_TIMEOUT_MS).emit('trust-host-key', { serverId, host, port, keyType, expected, actual }, (err, result) => {
            resolve(err ? { ok: false, code: 'TIMEOUT', error: t('terminal.errors.noAnswer') } : result);
        });
    }), [serverId]);

    return { state, error, errorDetail, offline, mismatch, reconnect, send, canSend, trustHostKey };
}
