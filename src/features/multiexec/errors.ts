import type { MultiExecErrorCode, MultiExecResult, MultiExecTarget } from '@shared/multiexec';
import type { TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';

// Backend failures in the user's language. The backend's own text stays
// available as a technical detail where it says more (an address, the auth
// methods a server accepts, host key fingerprints).

const WITH_DETAIL: ReadonlySet<MultiExecErrorCode> = new Set<MultiExecErrorCode>([
    'HANDSHAKE_TIMEOUT',
    'AUTH_FAILED',
    'HOST_KEY_MISMATCH',
    'CONNECTION_REFUSED',
    'HOST_NOT_FOUND',
    'HOST_UNREACHABLE'
]);

export type ErrorText = { message: string; detail: string | null };

// Why one server did not succeed, or null when there is nothing to say.
export function serverErrorText(result: Pick<MultiExecResult, 'error' | 'errorCode' | 'signal'>, timeoutSec: number, t: TranslateFn): ErrorText | null {
    if (result.errorCode) {
        return {
            message: t(`multiexec.serverErrors.${result.errorCode}`, { seconds: timeoutSec, signal: result.signal ?? '' }),
            detail: WITH_DETAIL.has(result.errorCode) ? result.error : null
        };
    }
    return result.error ? { message: result.error, detail: null } : null;
}

// Why a job could not start (POST /api/multiexec refused it).
export function startErrorText(error: unknown, targets: MultiExecTarget[], t: TranslateFn): string {
    if (error instanceof ApiError) {
        const { code, details } = error;
        const names = (ids: unknown) => (Array.isArray(ids) ? ids : [])
            .map((id) => targets.find((target) => target.serverId === id)?.name ?? `#${String(id)}`)
            .join(', ');
        if (code === 'MULTIEXEC_BUSY') return t('multiexec.errors.busy');
        if (code === 'MULTIEXEC_CLOSING') return t('multiexec.errors.closing');
        if (code === 'DANGEROUS_COMMAND') return t('multiexec.errors.dangerous');
        if (code === 'INVALID_MULTIEXEC') {
            if (details?.missing) return t('multiexec.errors.missing', { list: names(details.missing) });
            if (details?.unsupported) return t('multiexec.errors.unsupported', { list: names(details.unsupported) });
            if (Array.isArray(details?.missingVariables)) return t('snippets.variables.fillIn', { list: details.missingVariables.join(', ') });
            return t('multiexec.errors.rejected', { error: error.message });
        }
    }
    return error instanceof Error ? error.message : String(error);
}

// Why pausing, resuming, cancelling or deleting a job did not work.
export function controlErrorText(error: unknown, t: TranslateFn): string {
    if (error instanceof ApiError) {
        if (error.code === 'MULTIEXEC_JOB_FINISHED') return t('multiexec.errors.finished');
        if (error.code === 'MULTIEXEC_JOB_NOT_FOUND') return t('multiexec.errors.notFound');
        if (error.code === 'MULTIEXEC_JOB_ACTIVE') return t('multiexec.errors.active');
    }
    return error instanceof Error ? error.message : String(error);
}
