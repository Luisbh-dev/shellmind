import type { SnippetErrorReason } from '@shared/snippets';
import type { TranslateFn } from '@/i18n';
import { ApiError } from '@/lib/api';

const REASONS: ReadonlySet<SnippetErrorReason> = new Set<SnippetErrorReason>([
    'nameRequired',
    'nameTooLong',
    'commandRequired',
    'commandTooLong',
    'descriptionTooLong',
    'tagTooLong',
    'tooManyTags',
    'serverNotFound'
]);

const isReason = (value: unknown): value is SnippetErrorReason => typeof value === 'string' && REASONS.has(value as SnippetErrorReason);

// What went wrong saving or importing snippets, in the user's language when
// the backend names the reason (INVALID_SNIPPET details), else its message.
export function snippetErrorText(error: unknown, t: TranslateFn): string {
    if (error instanceof ApiError && error.code === 'INVALID_SNIPPET') {
        const reason = error.details?.reason;
        const max = error.details?.max;
        if (isReason(reason)) return t(`snippets.errors.${reason}`, { max: typeof max === 'number' ? max : '' });
    }
    return error instanceof Error ? error.message : String(error);
}
