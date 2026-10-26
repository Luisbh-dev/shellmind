// The file session of one server: a socket opened once per server id (not per
// render, tab switch or server-object change) running `start-ssh` with
// purpose "files", and the state the explorer shows for it.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileSessionInfo } from '@shared/files';
import type { HostKeyMismatchPayload } from '@shared/protocol';
import type { TrustHostKeyResult } from '@shared/terminal';
import { describeConnectionError, plainText } from '@/lib/connectionErrors';
import { createSocket, type AppSocket } from '@/lib/socket';
import { t } from '@/i18n';
import { useAppStore, type ConnectionInfo } from '@/store/appStore';
import { FileClient } from './client';

// The backend gives up on SSH handshakes after 20 s; this covers the rest.
const CONNECT_TIMEOUT_MS = 30_000;
const TRUST_TIMEOUT_MS = 15_000;

export type FileSessionState =
    | { status: 'connecting' }
    | { status: 'ready'; info: FileSessionInfo }
    // `hostKey`: the connection was refused because the host key changed.
    | { status: 'error'; message: string; hostKey?: HostKeyMismatchPayload }
    | { status: 'closed'; message?: string };

export type FileSession = {
    state: FileSessionState;
    client: FileClient | null;
    reconnect: () => void;
    // Replaces the pinned key by exactly the one the user compared
    // (`mismatch.actual`); refused when the pin changed meanwhile.
    trustHostKey: (mismatch: HostKeyMismatchPayload) => Promise<TrustHostKeyResult>;
};

export function useFileSession(serverId: number): FileSession {
    const [state, setState] = useState<FileSessionState>({ status: 'connecting' });
    const [client, setClient] = useState<FileClient | null>(null);
    const [attempt, setAttempt] = useState(0);
    const socketRef = useRef<AppSocket | null>(null);

    useEffect(() => {
        const socket = createSocket();
        socketRef.current = socket;
        const fileClient = new FileClient(socket);
        let mismatch: HostKeyMismatchPayload | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        let disposed = false;

        const armTimeout = () => {
            clearTimeout(timer);
            timer = setTimeout(() => setState({ status: 'error', message: t('files.connection.timeout') }), CONNECT_TIMEOUT_MS);
        };

        setClient(fileClient);
        setState({ status: 'connecting' });
        armTimeout();

        // Also after an automatic reconnect of the socket: the backend
        // session died with the old socket.
        socket.on('connect', () => {
            mismatch = undefined;
            setState({ status: 'connecting' });
            armTimeout();
            socket.emit('start-ssh', { serverId, purpose: 'files' });
        });
        socket.on('connection-ready', () => {
            fileClient.session().then(
                (info) => {
                    clearTimeout(timer);
                    if (!disposed) setState({ status: 'ready', info });
                },
                (error: unknown) => {
                    clearTimeout(timer);
                    if (!disposed) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
                }
            );
        });
        socket.on('host-key-mismatch', (payload) => { mismatch = payload; });
        socket.on('ssh-error', (message, coded) => {
            clearTimeout(timer);
            // The coded error in the user's language, with the server's own
            // words after it when they say more (as the terminal shows them).
            const text = coded ? describeConnectionError(coded) : plainText(message);
            const detail = coded ? plainText(coded.message) : '';
            setState({ status: 'error', message: detail && detail !== text ? `${text} (${detail})` : text, hostKey: mismatch });
        });
        socket.on('ssh-closed', () => {
            setState((previous) => (previous.status === 'error' ? previous : { status: 'closed' }));
        });
        socket.on('connect_error', (error) => {
            // socket.io keeps retrying on its own; "unauthorized" will not heal.
            setState({ status: 'error', message: error.message === 'unauthorized' ? t('files.connection.unauthorized') : t('files.connection.lost') });
        });
        socket.on('disconnect', (reason) => {
            if (disposed) return;
            // The server ended it on purpose: socket.io will not reconnect.
            if (reason === 'io server disconnect') setState({ status: 'closed' });
            else setState({ status: 'connecting' });
        });

        return () => {
            disposed = true;
            clearTimeout(timer);
            if (socketRef.current === socket) socketRef.current = null;
            fileClient.dispose();
            socket.disconnect();
        };
    }, [serverId, attempt]);

    const reconnect = useCallback(() => setAttempt((value) => value + 1), []);

    // Sent on the socket that saw the mismatch: the backend checks that the
    // host is on the route to this server and swaps the pin in one step.
    const trustHostKey = useCallback(async (mismatch: HostKeyMismatchPayload): Promise<TrustHostKeyResult> => {
        const socket = socketRef.current;
        if (!socket?.connected) return { ok: false, code: 'NOT_CONNECTED', error: t('files.connection.lost') };
        const { host, port, keyType, expected, actual } = mismatch;
        try {
            return await socket.timeout(TRUST_TIMEOUT_MS).emitWithAck('trust-host-key', { serverId, host, port, keyType, expected, actual });
        } catch {
            return { ok: false, code: 'TIMEOUT', error: t('files.client.noAnswer') };
        }
    }, [serverId]);

    return { state, client, reconnect, trustHostKey };
}

// The session state as the header and the sidebar show a connection.
export function connectionInfoOf(state: FileSessionState): ConnectionInfo {
    switch (state.status) {
        case 'connecting': return { state: 'connecting' };
        case 'ready': return { state: 'connected' };
        case 'error': return { state: 'error', error: state.message };
        case 'closed': return { state: 'disconnected', error: state.message };
    }
}

// An S3 session opens without contacting the bucket, so the first listing is
// what shows that the endpoint, the bucket and the keys work: until one
// succeeds the bucket is still connecting, or failed with the listing's error.
export function bucketConnectionInfo(state: FileSessionState, listed: boolean, listingError: string | null): ConnectionInfo {
    if (state.status !== 'ready' || listed) return connectionInfoOf(state);
    return listingError ? { state: 'error', error: listingError } : { state: 'connecting' };
}

// Publishes `info` as the server's connection state (null: the server's
// terminal reports it instead), and withdraws it when the panel goes away.
export function useConnectionReport(serverId: number, info: ConnectionInfo | null): void {
    const enabled = info !== null;
    const state = info?.state;
    const error = info?.error;
    useEffect(() => {
        if (state) useAppStore.getState().setConnection(serverId, error === undefined ? { state } : { state, error });
    }, [serverId, state, error]);

    useEffect(() => {
        if (!enabled) return undefined;
        return () => useAppStore.getState().clearConnection(serverId);
    }, [serverId, enabled]);
}
