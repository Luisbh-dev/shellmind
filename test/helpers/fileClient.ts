import { io as connect, type Socket } from 'socket.io-client';
import type { DownloadFailure, FileReply, FileResult } from '../../shared/files';
import type { ClientToServerEvents, ServerToClientEvents } from '../../shared/protocol';
import type { TestServer } from './testServer';

// Socket helpers for file manager tests: one socket per file session, typed
// request/ack calls and whole-file transfers through the files-* protocol.
// The helpers are checked against the protocol maps (event names, request
// and result types). The socket itself stays untyped, so a test can still
// send what the protocol does not allow (a request without its ack, say).

export type FileSocket = Socket;
type ProtocolSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

type Events = ClientToServerEvents;
// The files-* requests answered through an ack: `(request?, reply) => void`.
export type FileRequestEvent = {
    [E in keyof Events]: Parameters<Events[E]> extends [...unknown[], FileReply<never>] ? E : never;
}[keyof Events];
// Distributive over a union of events (`E extends unknown`).
export type ResultOf<E extends FileRequestEvent> = E extends unknown
    ? Parameters<Events[E]> extends [...unknown[], FileReply<infer Result>] ? Result : never
    : never;
// The request argument, absent for a request without one (files-session).
type RequestArgs<E extends FileRequestEvent> = E extends unknown
    ? Parameters<Events[E]> extends [infer Request, FileReply<never>] ? [request: Request] : []
    : never;
// An explicit result type (`ok<ListResult>(…)`), else the protocol's.
type Answer<T, E extends FileRequestEvent> = [T] extends [never] ? ResultOf<E> : T;

const REQUEST_TIMEOUT_MS = 15_000;

export async function openFileSession(server: TestServer, serverId: number): Promise<FileSocket> {
    const socket: ProtocolSocket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('file session did not open')), REQUEST_TIMEOUT_MS);
        socket.once('connection-ready', () => {
            clearTimeout(timer);
            resolve();
        });
        socket.once('ssh-error', (message) => {
            clearTimeout(timer);
            reject(new Error(message));
        });
        socket.once('connect_error', reject);
        socket.on('connect', () => socket.emit('start-ssh', { serverId, purpose: 'files' }));
    });
    return socket;
}

// `request<T>` / `ok<T>` with an explicit T check the event name and that the
// request is one of the protocol's; without T, the request and result types
// are the event's own.
export async function request<T = never, E extends FileRequestEvent = FileRequestEvent>(
    socket: FileSocket,
    event: E,
    ...args: RequestArgs<E>
): Promise<FileResult<Answer<T, E>>> {
    const untyped: Socket = socket;
    return untyped.timeout(REQUEST_TIMEOUT_MS).emitWithAck(event, ...args) as Promise<FileResult<Answer<T, E>>>;
}

export async function ok<T = never, E extends FileRequestEvent = FileRequestEvent>(
    socket: FileSocket,
    event: E,
    ...args: RequestArgs<E>
): Promise<Answer<T, E>> {
    const result = await request<T, E>(socket, event, ...args);
    if (!result.ok) throw new Error(`${event} failed: ${result.error.code} ${result.error.message}`);
    return result.data;
}

export async function uploadBytes(
    socket: FileSocket,
    path: string,
    data: Buffer,
    options: { overwrite?: boolean; inPlace?: boolean; chunkSize?: number; window?: number } = {},
): Promise<FileResult<ResultOf<'files-upload-end'>>> {
    const start = await request(socket, 'files-upload-start', {
        path, size: data.length, overwrite: options.overwrite ?? false, inPlace: options.inPlace,
    });
    if (!start.ok) return start;
    const { transferId } = start.data;
    const chunkSize = options.chunkSize ?? start.data.chunkSize;
    const window = options.window ?? start.data.window;
    const inflight = new Set<Promise<FileResult<unknown>>>();
    let failure: FileResult<never> | null = null;
    for (let offset = 0, seq = 0; offset < data.length && !failure; offset += chunkSize, seq += 1) {
        const pending = request(socket, 'files-upload-chunk', { transferId, seq, data: data.subarray(offset, offset + chunkSize) });
        inflight.add(pending);
        void pending.then((result) => {
            inflight.delete(pending);
            if (!result.ok) failure ??= result;
        });
        if (inflight.size >= window) await Promise.race(inflight);
    }
    await Promise.all(inflight);
    if (failure) return failure;
    return request(socket, 'files-upload-end', { transferId });
}

export async function downloadBytes(
    socket: FileSocket,
    path: string,
    options: { cancelAfterChunks?: number; delayAckMs?: number } = {},
): Promise<{ data: Buffer; chunks: number; maxUnacked: number; error?: DownloadFailure['error']; cancelled?: boolean }> {
    const typed: ProtocolSocket = socket;
    const start = await request(socket, 'files-download-start', { path });
    if (!start.ok) return { data: Buffer.alloc(0), chunks: 0, maxUnacked: 0, error: start.error };
    const { transferId } = start.data;
    const parts: Buffer[] = [];
    let unacked = 0;
    let maxUnacked = 0;
    return new Promise((resolve) => {
        const cleanup = () => {
            typed.off('files-download-chunk', onChunk);
            typed.off('files-download-end', onEnd);
            typed.off('files-download-error', onError);
        };
        const onChunk: ServerToClientEvents['files-download-chunk'] = (chunk) => {
            if (chunk.transferId !== transferId) return;
            parts.push(Buffer.from(chunk.data as Uint8Array));
            unacked += 1;
            maxUnacked = Math.max(maxUnacked, unacked);
            if (options.cancelAfterChunks !== undefined && parts.length >= options.cancelAfterChunks) {
                typed.emit('files-download-cancel', { transferId });
                cleanup();
                setTimeout(() => resolve({ data: Buffer.concat(parts), chunks: parts.length, maxUnacked, cancelled: true }), 300);
                return;
            }
            setTimeout(() => {
                unacked -= 1;
                typed.emit('files-download-ack', { transferId, seq: chunk.seq });
            }, options.delayAckMs ?? 0);
        };
        const onEnd: ServerToClientEvents['files-download-end'] = (end) => {
            if (end.transferId !== transferId) return;
            cleanup();
            resolve({ data: Buffer.concat(parts), chunks: parts.length, maxUnacked });
        };
        const onError: ServerToClientEvents['files-download-error'] = (failure) => {
            if (failure.transferId !== transferId) return;
            cleanup();
            resolve({ data: Buffer.concat(parts), chunks: parts.length, maxUnacked, error: failure.error });
        };
        typed.on('files-download-chunk', onChunk);
        typed.on('files-download-end', onEnd);
        typed.on('files-download-error', onError);
    });
}
