import { useCallback, useEffect, useRef, useState } from 'react';
import type { LogChunkPayload, LogEndPayload, LogErrorPayload, LogStreamSource } from '@shared/ops';
import type { ConnectionCause } from '@shared/terminal';
import { createSocket, type AppSocket } from '@/lib/socket';
import { EMPTY_BUFFER, appendChunk, trimTo, type LogBuffer } from './logBuffer';

// One live log stream of a server over its own socket (opened on the first
// start, closed when the view unmounts, which also stops the remote command).
// Output is applied to the view at most every RENDER_INTERVAL_MS; while
// paused it keeps arriving but the view stays still until resumed.

export type StreamStatus = 'idle' | 'connecting' | 'streaming' | 'ended' | 'error';

export type StreamError = { code: string; message: string; connection?: ConnectionCause };

const RENDER_INTERVAL_MS = 100;

let sequence = 0;
const nextStreamId = () => `s${Date.now().toString(36)}${(sequence += 1).toString(36)}`;

export type LogStream = {
    status: StreamStatus;
    error: StreamError | null;
    exitCode: number | null;
    // What the view shows (frozen while paused).
    buffer: LogBuffer;
    // Lines received while paused, not shown yet.
    pending: number;
    // Bytes the backend skipped because the view could not keep up.
    droppedBytes: number;
    paused: boolean;
    source: LogStreamSource | null;
    start: (source: LogStreamSource) => void;
    stop: () => void;
    setPaused: (paused: boolean) => void;
    clear: () => void;
};

export function useLogStream(serverId: number, maxLines: number): LogStream {
    const socketRef = useRef<AppSocket | null>(null);
    const streamIdRef = useRef<string | null>(null);
    const bufferRef = useRef<LogBuffer>(EMPTY_BUFFER);
    const maxLinesRef = useRef(maxLines);
    const pausedRef = useRef(false);
    const renderTimer = useRef<number | null>(null);
    // Lines ever shown (kept plus discarded), to count what arrived while paused.
    const shownRef = useRef(0);
    const [buffer, setBuffer] = useState<LogBuffer>(EMPTY_BUFFER);
    const [status, setStatus] = useState<StreamStatus>('idle');
    const [error, setError] = useState<StreamError | null>(null);
    const [exitCode, setExitCode] = useState<number | null>(null);
    const [droppedBytes, setDroppedBytes] = useState(0);
    const [paused, setPausedState] = useState(false);
    const [pending, setPending] = useState(0);
    const [source, setSource] = useState<LogStreamSource | null>(null);

    const render = useCallback(() => {
        if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
        renderTimer.current = null;
        const current = bufferRef.current;
        const total = current.lines.length + current.discarded;
        if (pausedRef.current) {
            setPending(Math.max(0, total - shownRef.current));
            return;
        }
        shownRef.current = total;
        setBuffer(current);
        setPending(0);
    }, []);

    const scheduleRender = useCallback(() => {
        if (renderTimer.current === null) renderTimer.current = window.setTimeout(render, RENDER_INTERVAL_MS);
    }, [render]);

    useEffect(() => {
        maxLinesRef.current = maxLines;
        bufferRef.current = trimTo(bufferRef.current, maxLines);
        render();
    }, [maxLines, render]);

    const connect = useCallback((): AppSocket => {
        if (socketRef.current) return socketRef.current;
        const socket = createSocket();
        socketRef.current = socket;
        const mine = (id: string) => id === streamIdRef.current;

        socket.on('logs-started', ({ id }) => {
            if (mine(id)) setStatus('streaming');
        });
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            ack();
            if (!mine(payload.id)) return;
            bufferRef.current = appendChunk(bufferRef.current, payload.data, maxLinesRef.current);
            if (payload.dropped) setDroppedBytes((value) => value + (payload.dropped ?? 0));
            scheduleRender();
        });
        socket.on('logs-error', (payload: LogErrorPayload) => {
            if (!mine(payload.id)) return;
            streamIdRef.current = null;
            setError({ code: payload.code, message: payload.message, connection: payload.connection });
            setStatus('error');
            render();
        });
        socket.on('logs-end', (payload: LogEndPayload) => {
            if (!mine(payload.id)) return;
            streamIdRef.current = null;
            setExitCode(payload.code);
            setStatus('ended');
            render();
        });
        socket.on('connect_error', (err) => {
            if (!streamIdRef.current) return;
            setError({ code: 'BACKEND', message: err.message });
            setStatus('error');
        });
        socket.on('disconnect', () => {
            if (!streamIdRef.current) return;
            streamIdRef.current = null;
            setError({ code: 'BACKEND', message: '' });
            setStatus('error');
        });
        return socket;
    }, [render, scheduleRender]);

    const stop = useCallback(() => {
        const id = streamIdRef.current;
        if (id) socketRef.current?.emit('logs-stop', { id });
    }, []);

    const start = useCallback((next: LogStreamSource) => {
        stop();
        const socket = connect();
        const id = nextStreamId();
        streamIdRef.current = id;
        bufferRef.current = EMPTY_BUFFER;
        shownRef.current = 0;
        pausedRef.current = false;
        setPausedState(false);
        setPending(0);
        setBuffer(EMPTY_BUFFER);
        setError(null);
        setExitCode(null);
        setDroppedBytes(0);
        setSource(next);
        setStatus('connecting');
        if (!socket.connected) socket.connect();
        socket.emit('logs-start', { id, serverId, source: next });
    }, [connect, serverId, stop]);

    const setPaused = useCallback((value: boolean) => {
        pausedRef.current = value;
        setPausedState(value);
        if (!value) render();
    }, [render]);

    const clear = useCallback(() => {
        bufferRef.current = EMPTY_BUFFER;
        shownRef.current = 0;
        setBuffer(EMPTY_BUFFER);
        setPending(0);
        setDroppedBytes(0);
    }, []);

    useEffect(() => () => {
        if (renderTimer.current !== null) window.clearTimeout(renderTimer.current);
        socketRef.current?.disconnect();
        socketRef.current = null;
    }, []);

    return { status, error, exitCode, buffer, pending, droppedBytes, paused, source, start, stop, setPaused, clear };
}
