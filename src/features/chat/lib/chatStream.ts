import type { ChatJsonResponse, ChatStopReason, ChatStreamEvent } from '@shared/chat';
import { createSseParser } from '@shared/sse';
import { t } from '@/i18n';

export type ChatAnswer = {
    text: string;
    usedModel: string | null;
    stopReason?: ChatStopReason;
    // Models announced by the server, in order (more than one: a fallback).
    models: string[];
};

export class ChatStreamError extends Error {
    readonly code?: string;

    constructor(message: string, code?: string) {
        super(message);
        this.name = 'ChatStreamError';
        this.code = code;
    }
}

type DoneEvent = Extract<ChatStreamEvent, { type: 'done' }>;

export type StreamCallbacks = {
    onModel?: (model: string) => void;
    onDelta?: (text: string) => void;
};

function parseEvent(data: string): ChatStreamEvent | null {
    try {
        const event = JSON.parse(data) as ChatStreamEvent;
        return event && typeof event === 'object' && typeof event.type === 'string' ? event : null;
    } catch {
        return null;
    }
}

// Reads the answer of POST /api/chat: Server-Sent Events (stream: true) or a
// plain JSON body. Rejects with ChatStreamError for an "error" event or a
// stream that ends without "done".
export async function readChatResponse(res: Response, callbacks: StreamCallbacks = {}): Promise<ChatAnswer> {
    const contentType = res.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream') || !res.body) {
        const data = (await res.json()) as ChatJsonResponse;
        const text = typeof data?.response === 'string' ? data.response : '';
        if (text) callbacks.onDelta?.(text);
        return { text, usedModel: data?.usedModel ?? null, stopReason: data?.stopReason, models: data?.usedModel ? [data.usedModel] : [] };
    }

    const models: string[] = [];
    // Filled by the parser callback.
    const outcome: { text: string; done: DoneEvent | null; failure: ChatStreamError | null } = { text: '', done: null, failure: null };

    const parser = createSseParser(({ data }) => {
        const event = parseEvent(data);
        if (!event || outcome.done || outcome.failure) return;
        if (event.type === 'model') {
            models.push(event.model);
            callbacks.onModel?.(event.model);
        } else if (event.type === 'delta' && event.text) {
            outcome.text += event.text;
            callbacks.onDelta?.(event.text);
        } else if (event.type === 'done') {
            outcome.done = event;
        } else if (event.type === 'error') {
            outcome.failure = new ChatStreamError(event.message || t('chat.errors.generic'), event.code);
        }
    });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
        const { done: finished, value } = await reader.read();
        if (finished) break;
        parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.end();

    if (outcome.failure) throw outcome.failure;
    if (!outcome.done) throw new ChatStreamError(t('chat.errors.streamEnded'));
    return { text: outcome.done.fullText || outcome.text, usedModel: outcome.done.usedModel, stopReason: outcome.done.stopReason, models };
}
