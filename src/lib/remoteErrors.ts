import type { ConnectionCause } from '@shared/terminal';
import type { TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';
import { describeConnectionError } from '@/lib/connectionErrors';

// Error codes the status and operations endpoints (and the log socket) use,
// with a translated headline; the backend's own message (often the remote
// command's output) is kept as the detail. A connection failure (SSH_FAILED)
// that names its cause gets that cause as the detail instead, in the words
// the terminal uses for it.
const KNOWN_CODES = [
    'EXEC_TIMEOUT',
    'EXEC_STREAMS_BUSY',
    'EXEC_OUTPUT_TOO_LARGE',
    'EXEC_ABORTED',
    'SSH_CHANNEL_REFUSED',
    'SSH_FAILED',
    'SSH_CLOSED',
    'HOST_KEY_MISMATCH',
    'SECRET_UNREADABLE',
    'OPS_PERMISSION_DENIED',
    'OPS_COMMAND_FAILED',
    'OPS_UNSUPPORTED',
    'OPS_INVALID_INPUT',
    'OPS_NOT_FOUND',
    'STATUS_UNAVAILABLE',
    'LOGS_LIMIT',
    // The API error envelope (server/http/respond.ts) codes every failure.
    'SERVER_NOT_FOUND',
    'UNSUPPORTED_PURPOSE',
    'JUMP_HOST',
    'PRIVATE_KEY_FILE',
    'INTERNAL'
] as const;

export type DescribedError = { title: string; detail: string | null; code: string | null };

export function errorCode(error: unknown): string | null {
    return error instanceof ApiError ? error.code : null;
}

// The cause of a connection failure (`details.connection` of an API error),
// when it is well formed: a code and flat string/number details.
export function connectionCause(error: unknown): ConnectionCause | null {
    const cause = error instanceof ApiError ? error.details?.connection : undefined;
    if (!cause || typeof cause !== 'object') return null;
    const { code, details } = cause as { code?: unknown; details?: unknown };
    if (typeof code !== 'string' || !code) return null;
    if (!details || typeof details !== 'object' || Array.isArray(details)) return { code };
    const flat: Record<string, string | number> = {};
    for (const [name, value] of Object.entries(details)) {
        if (typeof value === 'string' || typeof value === 'number') flat[name] = value;
    }
    return { code, details: flat };
}

export function describeCode(code: string | null, message: string, t: TranslateFn, connection?: ConnectionCause | null): DescribedError {
    const known = code && (KNOWN_CODES as readonly string[]).includes(code) ? code : null;
    if (!known) return { title: message || t('ops.errors.unknown'), detail: null, code };
    const title = t(`ops.errors.${known}`);
    const reason = connection ? describeConnectionError({ ...connection, message }, t) : message;
    return { title, detail: reason && reason !== title ? reason : null, code };
}

export function describeError(error: unknown, t: TranslateFn): DescribedError {
    if (error instanceof ApiError && error.isNetworkError) return { title: error.message, detail: null, code: null };
    const message = error instanceof Error ? error.message : String(error ?? '');
    return describeCode(errorCode(error), message, t, connectionCause(error));
}
