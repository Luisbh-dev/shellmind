import type { ChatEvidence, ChatHistoryItem, StoredChatMessage } from '@shared/chat';
import { evidenceChars, parseChatEvidence } from '@shared/chatEvidence';
import {
    MAX_HISTORY_TURN_CHARS,
    MAX_HISTORY_TURNS,
    MAX_PERSISTED_CHAT_MESSAGES,
    MAX_PERSISTED_MESSAGE_CHARS
} from '@shared/models';
import { isConversation, messageId, type ChatMessage } from '../types';

// The history route accepts 8 MB; stay well below it whatever the content.
export const MAX_PERSISTED_PAYLOAD_CHARS = 4_000_000;

// Keeps the head and the tail of an oversized text.
export function clipMiddle(text: string, max: number): string {
    if (text.length <= max) return text;
    const head = Math.floor(max * 0.3);
    return `${text.slice(0, head)}\n[...]\n${text.slice(-(max - head))}`;
}

// An answer that was stopped, broke off or hit the token limit: it renders as
// partial (an open code block stays open, without Run) also once restored.
export const isPartialAnswer = (message: ChatMessage) =>
    message.role === 'assistant' && message.kind === 'chat' && (message.stopped === true || message.stopReason === 'max_tokens');

// The evidence of an earlier diagnosis, as the history sends it: the backend
// keeps only a short share of it (the answer already quotes what mattered).
function historyEvidence(evidence: ChatEvidence): ChatEvidence {
    const share = Math.max(300, Math.floor(MAX_HISTORY_TURN_CHARS / Math.max(1, evidence.sections.length)));
    return { ...evidence, sections: evidence.sections.map((section) => ({ ...section, text: clipMiddle(section.text, share) })) };
}

// Prior turns sent with a chat request: the last few conversation messages,
// each trimmed (the server applies the same limits). Partial answers say so,
// so the model does not take them for finished ones.
export function toHistoryPayload(messages: ChatMessage[]): ChatHistoryItem[] {
    return messages
        .filter(isConversation)
        .slice(-MAX_HISTORY_TURNS)
        .map((message): ChatHistoryItem => {
            if (message.kind === 'command-output') {
                return { role: 'user', kind: 'command-output', command: message.command ?? '', content: clipMiddle(message.content, MAX_HISTORY_TURN_CHARS) };
            }
            const content = message.content.length > MAX_HISTORY_TURN_CHARS ? message.content.slice(0, MAX_HISTORY_TURN_CHARS) : message.content;
            if (message.role === 'user' && message.evidence) return { role: 'user', content, evidence: historyEvidence(message.evidence) };
            return isPartialAnswer(message) ? { role: message.role, content, partial: true } : { role: message.role, content };
        });
}

function toStored(message: ChatMessage): StoredChatMessage {
    const stored: StoredChatMessage = { role: message.role, content: message.content.slice(0, MAX_PERSISTED_MESSAGE_CHARS) };
    if (message.kind === 'command-output') {
        stored.kind = 'command-output';
        stored.command = (message.command ?? '').slice(0, MAX_PERSISTED_MESSAGE_CHARS);
    }
    if (isPartialAnswer(message)) stored.partial = true;
    if (message.role === 'user' && message.evidence) stored.evidence = message.evidence;
    return stored;
}

const storedSize = (message: StoredChatMessage) => message.content.length + (message.command?.length ?? 0) + (message.evidence ? evidenceChars(message.evidence) + 1024 : 0) + 64;

// What is saved for the server: the conversation only (no notices or
// errors), its last messages, each bounded, the whole within the route limit.
export function toPersistedMessages(messages: ChatMessage[]): StoredChatMessage[] {
    const stored = messages.filter((message) => isConversation(message) && message.content.trim()).slice(-MAX_PERSISTED_CHAT_MESSAGES).map(toStored);
    let size = stored.reduce((sum, message) => sum + storedSize(message), 0);
    while (stored.length && size > MAX_PERSISTED_PAYLOAD_CHARS) {
        const dropped = stored.shift()!;
        size -= storedSize(dropped);
    }
    return stored;
}

// Messages from GET /api/chat/history (validated: it is just JSON).
export function fromStored(raw: unknown): ChatMessage[] {
    if (!Array.isArray(raw)) return [];
    return raw.flatMap((item): ChatMessage[] => {
        const entry = (item && typeof item === 'object' ? item : {}) as Partial<StoredChatMessage>;
        if ((entry.role !== 'user' && entry.role !== 'assistant') || typeof entry.content !== 'string' || !entry.content.trim()) return [];
        if (entry.kind === 'command-output' && entry.role === 'user') {
            return [{ id: messageId('hist'), role: 'user', kind: 'command-output', content: entry.content, command: typeof entry.command === 'string' ? entry.command : '' }];
        }
        if (entry.role === 'assistant' && entry.partial === true) {
            return [{ id: messageId('hist'), role: 'assistant', kind: 'chat', content: entry.content, stopped: true }];
        }
        const evidence = entry.role === 'user' && entry.evidence ? parseChatEvidence(entry.evidence) : null;
        if (evidence) return [{ id: messageId('hist'), role: 'user', kind: 'chat', content: entry.content, evidence }];
        return [{ id: messageId('hist'), role: entry.role, kind: 'chat', content: entry.content }];
    });
}

// A restore that arrives after the user already started typing keeps both:
// the saved conversation first, then what happened since.
export function mergeRestored(current: ChatMessage[], restored: ChatMessage[]): ChatMessage[] {
    if (!restored.length) return current;
    const restoredIds = new Set(restored.map((message) => message.id));
    return [...restored, ...current.filter((message) => !restoredIds.has(message.id))];
}
