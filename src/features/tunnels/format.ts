import { formatHostPort, presetForPort, type TunnelErrorDetails, type TunnelErrorInfo } from '@shared/tunnels';
import type { Tunnel } from '@shared/types';
import type { Language, TranslateFn } from '@/i18n';
import { ApiError, apiErrorCode } from '@/lib/api';

export function formatTime(epochMs: number, language: Language): string {
    return new Intl.DateTimeFormat(language, { timeStyle: 'medium' }).format(epochMs);
}

type Endpoints = Pick<Tunnel, 'name' | 'local_host' | 'local_port' | 'remote_host' | 'remote_port'>;

// The saved name, else the service it points at ("PostgreSQL"), else its remote address.
export function tunnelName(tunnel: Endpoints): string {
    return tunnel.name || presetForPort(tunnel.remote_port)?.name || formatHostPort(tunnel.remote_host, tunnel.remote_port);
}

// Failure codes explained in the user's language. For the ones whose precise
// reason only the backend knows (an SSH error, a file path...), its message is
// kept as a detail line.
const TRANSLATED = new Set([
    'PORT_IN_USE',
    'PORT_ACCESS_DENIED',
    'BIND_ADDRESS_UNAVAILABLE',
    'LISTEN_FAILED',
    'SSH_CONNECT_FAILED',
    'SSH_DISCONNECTED',
    'REMOTE_UNREACHABLE',
    'FORWARDING_DENIED',
    'TUNNEL_START_CANCELLED',
    'INVALID_TUNNEL',
    'PUBLIC_BIND_UNCONFIRMED',
    'HOST_KEY_MISMATCH',
    'SECRET_UNREADABLE',
    'UNSUPPORTED_SERVER',
    'UNSUPPORTED_PURPOSE',
    'JUMP_HOST',
    'PRIVATE_KEY_FILE',
    'SERVER_NOT_FOUND',
    'TUNNEL_NOT_FOUND'
]);
const WITH_DETAIL = new Set([
    'LISTEN_FAILED',
    'SSH_CONNECT_FAILED',
    'SSH_DISCONNECTED',
    'REMOTE_UNREACHABLE',
    'HOST_KEY_MISMATCH',
    'JUMP_HOST',
    'PRIVATE_KEY_FILE'
]);

// Form label of each field an INVALID_TUNNEL error can name.
const FIELD_LABELS: Record<string, string> = {
    name: 'tunnels.form.name',
    local_host: 'tunnels.form.localHost',
    local_port: 'tunnels.form.localPort',
    remote_host: 'tunnels.form.remoteHost',
    remote_port: 'tunnels.form.remotePort',
    auto_start: 'tunnels.form.autoStart'
};

export type TunnelProblem = { text: string; detail?: string };

function translatedText(t: TranslateFn, code: string, tunnel: Endpoints, details: TunnelErrorDetails | undefined): string {
    // The address the failure is about, which may predate an edit.
    const port = details?.port ?? tunnel.local_port;
    const host = details?.host ?? tunnel.local_host;
    if (code === 'PORT_IN_USE' && details?.tunnelName) return t('tunnels.errors.PORT_IN_USE_TUNNEL', { port, tunnel: details.tunnelName });
    if (code === 'INVALID_TUNNEL') {
        const label = details?.field ? FIELD_LABELS[details.field] : undefined;
        return label ? t('tunnels.errors.INVALID_TUNNEL', { field: t(label) }) : t('tunnels.errors.INVALID_TUNNEL_ANY');
    }
    return t(`tunnels.errors.${code}`, { port, host, remote: formatHostPort(tunnel.remote_host, tunnel.remote_port) });
}

export function describeProblem(
    t: TranslateFn,
    code: string | undefined,
    message: string,
    tunnel: Endpoints,
    details?: TunnelErrorDetails
): TunnelProblem {
    if (!code || !TRANSLATED.has(code)) return { text: message };
    const text = translatedText(t, code, tunnel, details);
    return WITH_DETAIL.has(code) && message ? { text, detail: message } : { text };
}

export function describeLastError(t: TranslateFn, error: TunnelErrorInfo, tunnel: Endpoints): TunnelProblem {
    return describeProblem(t, error.code, error.message, tunnel, error.details);
}

// Both lines in one, for a toast.
export function problemText(problem: TunnelProblem): string {
    return problem.detail ? `${problem.text} ${problem.detail}` : problem.text;
}

// The details of an API error that explain it (see TunnelErrorDetails).
export function apiErrorDetails(err: unknown): TunnelErrorDetails | undefined {
    const raw = err instanceof ApiError ? err.details : null;
    if (!raw) return undefined;
    const { field, host, local_host: localHost, port, tunnelId, tunnelName } = raw;
    const boundHost = typeof host === 'string' ? host : typeof localHost === 'string' ? localHost : undefined;
    return {
        ...(typeof field === 'string' ? { field } : {}),
        ...(boundHost !== undefined ? { host: boundHost } : {}),
        ...(typeof port === 'number' ? { port } : {}),
        ...(typeof tunnelId === 'number' ? { tunnelId } : {}),
        ...(typeof tunnelName === 'string' ? { tunnelName } : {})
    };
}

export function problemFromError(t: TranslateFn, err: unknown, tunnel: Endpoints): TunnelProblem {
    const message = err instanceof Error ? err.message : String(err);
    return describeProblem(t, apiErrorCode(err) ?? undefined, message, tunnel, apiErrorDetails(err));
}
