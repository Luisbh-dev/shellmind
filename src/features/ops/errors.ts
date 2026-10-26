import type { TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';
import { describeError, errorCode, type DescribedError } from '@/lib/remoteErrors';

// The operations panels' errors in the user's language: the shared wording
// (src/lib/remoteErrors.ts), plus the codes of the Compose and image views.
export function describeOpsError(error: unknown, t: TranslateFn): DescribedError {
    const code = errorCode(error);
    if (code === 'COMPOSE_FILES_MISSING') {
        const files = error instanceof ApiError && typeof error.details?.files === 'string' ? error.details.files : '';
        return { title: t('ops.errors.COMPOSE_FILES_MISSING'), detail: files || null, code };
    }
    // --- W8-T4 disk toolkit: its codes, worded in the disk area ---
    if (code === 'DISK_UNKNOWN_MOUNT') return { title: t('disk.errors.DISK_UNKNOWN_MOUNT'), detail: error instanceof Error ? error.message || null : null, code };
    if (code === 'DISK_NOTHING_TO_CLEAN') return { title: t('disk.errors.DISK_NOTHING_TO_CLEAN'), detail: null, code };
    return describeError(error, t);
}

// "Title. Detail" for a toast.
export function errorText(error: unknown, t: TranslateFn): string {
    const { title, detail } = describeOpsError(error, t);
    return detail ? `${title} ${detail}` : title;
}
