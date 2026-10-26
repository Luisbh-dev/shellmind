import type { TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';
import { describeCode, describeError, errorCode, type DescribedError } from '@/lib/remoteErrors';

// The Kubernetes endpoints' errors in the user's language: kubectl's own
// failures get a translated headline (its message stays the detail), the
// rest (SSH, the server row) the shared wording of src/lib/remoteErrors.ts.

export const K8S_ERROR_CODES = [
    'K8S_AUTH_REQUIRED',
    'K8S_FORBIDDEN',
    'K8S_CONTEXT_NOT_FOUND',
    'K8S_NOT_FOUND',
    'K8S_UNREACHABLE',
    'K8S_TIMEOUT',
    'K8S_COMMAND_FAILED',
    'K8S_INVALID_INPUT',
    'K8S_UNSUPPORTED',
    'K8S_UNAVAILABLE',
    'K8S_CONTAINER_NOT_RUNNING',
    'KUBECTL_MISSING'
] as const;

export function describeK8sCode(code: string | null, message: string, t: TranslateFn): DescribedError {
    if (code && (K8S_ERROR_CODES as readonly string[]).includes(code)) {
        const title = t(`k8s.errors.${code}`);
        return { title, detail: message && message !== title ? message : null, code };
    }
    return describeCode(code, message, t);
}

export function describeK8sError(error: unknown, t: TranslateFn): DescribedError {
    const code = errorCode(error);
    if (code && (K8S_ERROR_CODES as readonly string[]).includes(code) && error instanceof ApiError) return describeK8sCode(code, error.message, t);
    return describeError(error, t);
}

// "Title. Detail" for a toast.
export function k8sErrorText(error: unknown, t: TranslateFn): string {
    const { title, detail } = describeK8sError(error, t);
    return detail ? `${title} ${detail}` : title;
}
