// The single HTTP client for the ShellMind backend. Every request goes through
// here so the base URL, the session token and error handling live in one place.
import { t } from '@/i18n';

const ENV_API_BASE: string | undefined = import.meta.env.VITE_API_BASE;
const DEFAULT_API_BASE = 'http://127.0.0.1:3001';

const API_KEY = 'shellmind.api';
const TOKEN_KEY = 'shellmind.token';

type StorageArea = 'session' | 'local';

// Storage can be unavailable (privacy modes, sandboxed frames): treat it as empty.
function storage(area: StorageArea): Storage | undefined {
    try {
        return area === 'session' ? window.sessionStorage : window.localStorage;
    } catch {
        return undefined;
    }
}

function readStored(area: StorageArea, key: string): string | undefined {
    try {
        return storage(area)?.getItem(key) || undefined;
    } catch {
        return undefined;
    }
}

function writeStored(area: StorageArea, key: string, value: string | null) {
    try {
        if (value === null) storage(area)?.removeItem(key);
        else storage(area)?.setItem(key, value);
    } catch {
        // Not persisted: the value only lives as long as the page.
    }
}

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

// Only a loopback backend may be chosen through the URL, so a crafted link to
// a self-hosted instance cannot point its UI at someone else's server.
function loopbackApiBase(value: string): string | undefined {
    try {
        const url = new URL(value);
        if ((url.protocol === 'http:' || url.protocol === 'https:') && LOOPBACK_HOSTNAMES.has(url.hostname)) return url.origin;
    } catch {
        // Not a URL.
    }
    return undefined;
}

// Electron opens the UI with ?api=<backend>&token=<session token>. Both are
// kept for this window's session and removed from the address bar (and its
// history entry) before anything else runs. Call once, before rendering.
export function captureLaunchParams(): void {
    if (typeof window === 'undefined') return;
    const url = new URL(window.location.href);
    const api = url.searchParams.get('api');
    const token = url.searchParams.get('token');
    if (api === null && token === null) return;

    const apiBase = api === null ? undefined : loopbackApiBase(api);
    if (apiBase) writeStored('session', API_KEY, apiBase);
    if (token) writeStored('session', TOKEN_KEY, token);

    url.searchParams.delete('api');
    url.searchParams.delete('token');
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
}

// A setting the server that delivered index.html wrote into it as a <meta>.
function pageSetting(name: string): string | undefined {
    if (typeof document === 'undefined') return undefined;
    return document.querySelector<HTMLMetaElement>(`meta[name="${name}"]`)?.content || undefined;
}

type DevSession = { token?: string; apiBase?: string };

// The backend `npm start` runs, as the Vite dev server describes it in
// index.html (scripts/devSession.ts). Builds never read it.
function devSession(): DevSession {
    if (!import.meta.env.DEV) return {};
    const raw = pageSetting('shellmind-dev-session');
    if (!raw) return {};
    try {
        const { token, apiBase } = JSON.parse(raw) as Record<string, unknown>;
        return {
            token: typeof token === 'string' && token ? token : undefined,
            apiBase: typeof apiBase === 'string' && apiBase ? apiBase : undefined
        };
    } catch {
        return {};
    }
}

// The backend itself served this page (`npm run serve` marks index.html, see
// server/http/static.ts), so it answers on the page's own origin. A build
// opened any other way (vite preview, another static server) does not.
function sameOriginBase(): string | undefined {
    if (pageSetting('shellmind-api') !== 'same-origin' || typeof location === 'undefined') return undefined;
    return location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : undefined;
}

// Where the backend is, in order: the address Electron launched this window
// with, `VITE_API_BASE` (fixed at build time, e.g. an API behind a reverse
// proxy), the backend `npm start` runs, the backend that served this page, and
// finally the default local backend. socket.io shares the same origin.
export function getApiBase(): string {
    const base = readStored('session', API_KEY)
        || ENV_API_BASE?.trim()
        || devSession().apiBase
        || sameOriginBase()
        || DEFAULT_API_BASE;
    return base.replace(/\/+$/, '');
}

// Session token sent as a bearer token and in the socket handshake: the one
// this window was launched (or unlocked) with, the dev server's, or the one
// the user chose to remember on this device.
export function getAuthToken(): string | undefined {
    return readStored('session', TOKEN_KEY) || devSession().token || readStored('local', TOKEN_KEY);
}

export function setAuthToken(token: string, options: { remember: boolean }): void {
    writeStored('session', TOKEN_KEY, token);
    writeStored('local', TOKEN_KEY, options.remember ? token : null);
}

// The backend refused `token`: drop it wherever it is stored, so the next
// candidate (the dev server's or a remembered one) is used. A refusal of some
// other token, e.g. one a crafted ?token= link brought in, leaves the
// remembered token alone.
export function forgetAuthToken(token: string): void {
    for (const area of ['session', 'local'] as const) {
        if (readStored(area, TOKEN_KEY) === token) writeStored(area, TOKEN_KEY, null);
    }
}

// `rejectedToken` is the token the refused request carried, if any.
type UnauthorizedListener = (rejectedToken: string | undefined) => void;
const unauthorizedListeners = new Set<UnauthorizedListener>();

// Called whenever the backend refuses the token (missing, wrong or rotated):
// an HTTP 401, or a socket handshake refused (src/lib/socket.ts).
export function onUnauthorized(listener: UnauthorizedListener): () => void {
    unauthorizedListeners.add(listener);
    return () => {
        unauthorizedListeners.delete(listener);
    };
}

// Reports a refusal of `rejectedToken` to the onUnauthorized listeners.
export function notifyUnauthorized(rejectedToken: string | undefined): void {
    unauthorizedListeners.forEach((listener) => listener(rejectedToken));
}

// A request that failed: `status` is the HTTP status, or 0 when the backend
// could not be reached at all. `body` is the parsed response body, if any.
export class ApiError extends Error {
    readonly status: number;
    readonly body: unknown;

    constructor(status: number, message: string, body?: unknown, options?: ErrorOptions) {
        super(message, options);
        this.name = 'ApiError';
        this.status = status;
        this.body = body;
    }

    get isNetworkError(): boolean {
        return this.status === 0;
    }

    // The backend's machine-readable error code (`{ code }`, e.g.
    // "JUMP_HOST_IN_USE"), if the body carried one.
    get code(): string | null {
        const code = bodyField(this.body, 'code');
        return typeof code === 'string' && code ? code : null;
    }

    // The structured `{ details }` that came with the code, if any.
    get details(): Record<string, unknown> | null {
        const details = bodyField(this.body, 'details');
        return details && typeof details === 'object' && !Array.isArray(details) ? details as Record<string, unknown> : null;
    }
}

function bodyField(body: unknown, name: string): unknown {
    return body && typeof body === 'object' ? (body as Record<string, unknown>)[name] : undefined;
}

// The `code` of a failed request (null for other errors and code-less bodies).
export function apiErrorCode(error: unknown): string | null {
    return error instanceof ApiError ? error.code : null;
}

export interface RequestOptions {
    signal?: AbortSignal;
    headers?: Record<string, string>;
    // Sent instead of the stored token (to check a token before keeping it).
    token?: string;
}

const MAX_TEXT_ERROR_LENGTH = 300;

const isAbortError = (error: unknown) =>
    error instanceof Error && error.name === 'AbortError';

async function readBody(res: Response): Promise<unknown> {
    const text = await res.text();
    if (!text) return undefined;
    if ((res.headers.get('content-type') || '').includes('json')) {
        try {
            return JSON.parse(text);
        } catch {
            return text;
        }
    }
    return text;
}

// Prefers the backend's `{ error }` / `{ message }` text; plain-text and HTML
// bodies (e.g. Express' default 404 page) are reduced to readable text.
function errorMessage(res: Response, body: unknown): string {
    if (body && typeof body === 'object') {
        const { error, message } = body as { error?: unknown; message?: unknown };
        if (typeof error === 'string' && error.trim()) return error;
        if (typeof message === 'string' && message.trim()) return message;
    }
    if (typeof body === 'string') {
        const text = body.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
        if (text) return text.slice(0, MAX_TEXT_ERROR_LENGTH);
    }
    return res.statusText || `HTTP ${res.status}`;
}

async function send(method: string, path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    const headers: Record<string, string> = { ...options.headers };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = options.token ?? getAuthToken();
    if (token) headers.Authorization = `Bearer ${token}`;

    let res: Response;
    try {
        res = await fetch(`${getApiBase()}${path}`, {
            method,
            headers,
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: options.signal
        });
    } catch (error) {
        if (isAbortError(error)) throw error;
        throw new ApiError(0, t('common.errors.backendUnreachable'), undefined, { cause: error });
    }

    if (!res.ok) {
        if (res.status === 401) notifyUnauthorized(token);
        const errorBody = await readBody(res).catch((error: unknown) => {
            if (isAbortError(error)) throw error;
            return undefined;
        });
        throw new ApiError(res.status, errorMessage(res, errorBody), errorBody);
    }
    return res;
}

async function request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T> {
    const res = await send(method, path, body, options);
    const data = await readBody(res);
    if (typeof data === 'string') {
        throw new ApiError(res.status, t('common.errors.invalidResponse'), data);
    }
    return data as T;
}

// The `{ message?, data }` envelope most routes answer with.
export type Envelope<T> = { message?: string; data: T };

// The `data` of an envelope; a body without one is an invalid response.
export function unwrapData<T>(body: unknown): T {
    if (!body || typeof body !== 'object' || !('data' in body)) {
        throw new ApiError(200, t('common.errors.invalidResponse'), body);
    }
    return (body as Envelope<T>).data;
}

// JSON helpers: they resolve with the parsed body and reject with ApiError on
// any non-2xx status. AbortError from a cancelled `signal` is passed through.
// `data` GETs an enveloped route and resolves with its `data`.
export const api = {
    get: <T = unknown>(path: string, options?: RequestOptions) => request<T>('GET', path, undefined, options),
    post: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, body, options),
    put: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PUT', path, body, options),
    patch: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, body, options),
    del: <T = unknown>(path: string, body?: unknown, options?: RequestOptions) => request<T>('DELETE', path, body, options),
    data: async <T = unknown>(path: string, options?: RequestOptions) => unwrapData<T>(await request<unknown>('GET', path, undefined, options))
};

// POSTs JSON and hands back the raw Response so the caller can read a
// Server-Sent Events body (or a plain JSON answer) itself.
export function apiStream(path: string, body: unknown, options: RequestOptions = {}): Promise<Response> {
    return send('POST', path, body, {
        ...options,
        headers: { Accept: 'text/event-stream, application/json', ...options.headers }
    });
}

// W7-S4: like apiStream, for a GET that answers with a Server-Sent Events
// body (following a multi-exec job).
export function apiEventStream(path: string, options: RequestOptions = {}): Promise<Response> {
    return send('GET', path, undefined, {
        ...options,
        headers: { Accept: 'text/event-stream, application/json', ...options.headers }
    });
}
