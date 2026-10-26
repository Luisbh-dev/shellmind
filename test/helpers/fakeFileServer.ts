import type { FileEntry, FileResult, FileSessionInfo } from '../../shared/files';
import type { ConnectionError, TrustHostKeyResult } from '../../shared/terminal';

// A stand-in for the backend in file manager component tests: sockets that
// answer the files-* requests from an in-memory tree. Tests override single
// requests with `handle()` (delays, errors, out-of-order replies).

type Listener = (...args: unknown[]) => void;
// What a request is answered with: a FileResult, or the result of trust-host-key.
type Answer = FileResult<unknown> | TrustHostKeyResult;
type RequestHandler = (payload: Record<string, unknown>) => Answer | Promise<Answer>;

export type SessionBehaviour =
    | { kind: 'ready' }
    // `error`: the coded second argument the backend sends with the message.
    | { kind: 'error'; message: string; error?: ConnectionError }
    | { kind: 'host-key-mismatch'; host: string; port: number; keyType: string; expected: string; actual: string };

export const entry = (name: string, overrides: Partial<FileEntry> = {}): FileEntry => ({
    name, isDir: false, isLink: false, size: 1024, mtime: 1_700_000_000, permissions: 0o644, ...overrides,
});
export const folder = (name: string, overrides: Partial<FileEntry> = {}): FileEntry => entry(name, { isDir: true, size: 0, permissions: 0o755, ...overrides });

export class FakeSocket {
    connected = false;
    readonly emitted: Array<{ event: string; payload: unknown }> = [];
    private readonly listeners = new Map<string, Set<Listener>>();

    constructor(private readonly server: FakeFileServer) {}

    on(event: string, listener: Listener): this {
        if (!this.listeners.has(event)) this.listeners.set(event, new Set());
        this.listeners.get(event)!.add(listener);
        return this;
    }

    off(event: string, listener?: Listener): this {
        if (listener) this.listeners.get(event)?.delete(listener);
        else this.listeners.delete(event);
        return this;
    }

    emit(event: string, payload?: unknown): this {
        this.emitted.push({ event, payload });
        this.server.receive(this, event, payload);
        return this;
    }

    timeout(ms: number) {
        return {
            emitWithAck: (event: string, payload?: unknown) => new Promise<unknown>((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('operation has timed out')), ms);
                this.emitted.push({ event, payload });
                void Promise.resolve(this.server.answer(event, (payload ?? {}) as Record<string, unknown>)).then((result) => {
                    clearTimeout(timer);
                    resolve(result);
                });
            }),
        };
    }

    disconnect(): this {
        this.connected = false;
        this.server.closed.push(this);
        this.fire('disconnect', 'io client disconnect');
        return this;
    }

    // Server -> client event.
    fire(event: string, ...args: unknown[]): void {
        for (const listener of [...(this.listeners.get(event) ?? [])]) listener(...args);
    }

    open(): void {
        this.connected = true;
        this.fire('connect');
    }
}

export class FakeFileServer {
    readonly sockets: FakeSocket[] = [];
    readonly closed: FakeSocket[] = [];
    readonly tree = new Map<string, FileEntry[]>();
    // File contents for files-read / files-write, by path.
    readonly contents = new Map<string, Uint8Array>();
    readonly requests: Array<{ event: string; payload: Record<string, unknown> }> = [];
    session: SessionBehaviour = { kind: 'ready' };
    info: FileSessionInfo = { protocol: 'sftp', transport: 'ssh', secure: true, home: '/home/demo', maxEditBytes: 2 * 1024 * 1024 };
    private readonly overrides = new Map<string, RequestHandler>();

    connect(): FakeSocket {
        const socket = new FakeSocket(this);
        this.sockets.push(socket);
        setTimeout(() => socket.open(), 0);
        return socket;
    }

    get socket(): FakeSocket {
        return this.sockets[this.sockets.length - 1];
    }

    handle(event: string, handler: RequestHandler): void {
        this.overrides.set(event, handler);
    }

    receive(socket: FakeSocket, event: string, payload: unknown): void {
        if (event !== 'start-ssh') return;
        setTimeout(() => {
            const behaviour = this.session;
            if (behaviour.kind === 'ready') {
                socket.fire('connection-ready');
            } else if (behaviour.kind === 'error') {
                socket.fire('ssh-error', behaviour.message, behaviour.error);
            } else {
                const { kind: _kind, ...mismatch } = behaviour;
                socket.fire('host-key-mismatch', { code: 'HOST_KEY_MISMATCH', ...mismatch });
                socket.fire('ssh-error', `The host key of ${behaviour.host}:${behaviour.port} has changed`);
            }
        }, 0);
        void payload;
    }

    answer(event: string, payload: Record<string, unknown>): Answer | Promise<Answer> {
        this.requests.push({ event, payload });
        const override = this.overrides.get(event);
        if (override) return override(payload);
        switch (event) {
            case 'files-session':
                return { ok: true, data: this.info };
            case 'files-list': {
                const path = String(payload.path);
                const entries = this.tree.get(path);
                if (!entries) return { ok: false, error: { code: 'NOT_FOUND', message: `${path}: no such file or folder` } };
                return { ok: true, data: { path, entries, truncated: false } };
            }
            case 'files-read': {
                const path = String(payload.path);
                const data = this.contents.get(path);
                if (!data) return { ok: false, error: { code: 'NOT_FOUND', message: `${path}: no such file or folder` } };
                return { ok: true, data: { path, data, stat: { isDir: false, isLink: false, size: data.length, mtime: 1_700_000_000, permissions: 0o644 } } };
            }
            case 'files-write': {
                const path = String(payload.path);
                const data = payload.data as Uint8Array;
                this.contents.set(path, data);
                return { ok: true, data: { path, stat: { isDir: false, isLink: false, size: data.length, mtime: 1_700_000_100, permissions: 0o644 } } };
            }
            case 'files-count':
                return { ok: true, data: { files: 3, dirs: 1, bytes: 4096, truncated: false } };
            case 'files-delete':
                return { ok: true, data: { deleted: (payload.items as unknown[]).length, failures: [], failureCount: 0 } };
            case 'files-mkdir':
                return { ok: true, data: { path: payload.path } };
            case 'files-rename':
                return { ok: true, data: { from: payload.from, to: payload.to } };
            case 'files-upload-start':
                return { ok: true, data: { transferId: `up-${this.requests.length}`, chunkSize: 4, window: 2 } };
            case 'files-upload-chunk':
                return { ok: true, data: { seq: payload.seq, received: 0 } };
            case 'files-upload-end':
                return { ok: true, data: { path: '', size: 0 } };
            case 'files-upload-cancel':
                return { ok: true, data: { transferId: payload.transferId } };
            case 'trust-host-key':
                return { ok: true };
            default:
                return { ok: false, error: { code: 'UNSUPPORTED', message: `no fake for ${event}` } };
        }
    }

    requestsOf(event: string): Array<Record<string, unknown>> {
        return this.requests.filter((request) => request.event === event).map((request) => request.payload);
    }
}
