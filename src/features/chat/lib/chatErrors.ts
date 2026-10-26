import { CHAT_ERROR_CODES } from '@shared/chat';
import type { TranslationParams } from '@/i18n';
import { ApiError } from '@/lib/api';
import { ChatStreamError } from './chatStream';

// A failed chat request, as an i18n key: the UI language decides the text,
// the backend's (English) detail is only quoted where it helps.
export type ChatFailure = { key: string; params?: TranslationParams };

const PROVIDER_LABELS: Record<string, string> = { gemini: 'Gemini', minimax: 'MiniMax' };

export function describeChatFailure(error: unknown): ChatFailure {
    let message = error instanceof Error ? error.message : '';
    let code: string | undefined;
    let provider: string | undefined;

    if (error instanceof ChatStreamError) {
        code = error.code;
    } else if (error instanceof ApiError) {
        if (error.isNetworkError) return { key: 'chat.errors.network' };
        code = error.code ?? undefined;
        const named = error.details?.provider;
        provider = typeof named === 'string' ? named : undefined;
        message = error.message;
    }

    switch (code) {
        case CHAT_ERROR_CODES.keyMissing:
            return { key: 'chat.errors.keyMissing', params: { provider: PROVIDER_LABELS[provider ?? ''] ?? provider ?? 'Gemini' } };
        case CHAT_ERROR_CODES.keyUnreadable:
            return { key: 'chat.errors.keyUnreadable', params: { provider: PROVIDER_LABELS[provider ?? ''] ?? provider ?? 'Gemini' } };
        case CHAT_ERROR_CODES.provider:
            return { key: 'chat.errors.provider', params: { detail: message } };
        case CHAT_ERROR_CODES.invalidRequest:
            return { key: 'chat.errors.invalidRequest' };
        case CHAT_ERROR_CODES.evidenceExpired:
            return { key: 'chat.errors.evidenceExpired' };
        default:
            return message ? { key: 'chat.errors.withDetail', params: { detail: message } } : { key: 'chat.errors.generic' };
    }
}
