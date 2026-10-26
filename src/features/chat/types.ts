import type { ChatEvidence, ChatStopReason } from '@shared/chat';
import type { TranslationParams } from '@/i18n';

// A message in the chat panel. "chat" and "command-output" messages are the
// conversation (sent to the model as history and saved per server); notices
// and errors are UI-only and never leave the browser.
export type ChatMessageKind = 'chat' | 'command-output' | 'notice' | 'error';

export type ChatMessage = {
    id: string;
    role: 'user' | 'assistant';
    kind: ChatMessageKind;
    content: string;
    // command-output: the command Auto-Run executed, and whether it was still
    // running when its output was captured.
    command?: string;
    stillRunning?: boolean;
    // notice and error: an i18n key (translated when rendered, so it follows
    // the language).
    noticeKey?: string;
    noticeParams?: TranslationParams;
    tone?: 'info' | 'warning';
    // Assistant answers.
    model?: string;
    stopReason?: ChatStopReason;
    // The user stopped the answer before it was complete.
    stopped?: boolean;
    // The question of a diagnosis: the evidence that was sent with it.
    evidence?: ChatEvidence;
};

// An issue the terminal detected (App's TerminalIssue).
export type TerminalIssue = {
    id: string;
    type: 'error' | 'warning';
    message: string;
    details?: string;
    timestamp: number;
};

let sequence = 0;
export const messageId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(sequence += 1)}`;

export const isConversation = (message: ChatMessage) => message.kind === 'chat' || message.kind === 'command-output';

export function notice(noticeKey: string, noticeParams?: TranslationParams, tone: 'info' | 'warning' = 'info'): ChatMessage {
    return { id: messageId('notice'), role: 'assistant', kind: 'notice', content: '', noticeKey, noticeParams, tone };
}

export function errorMessage(noticeKey: string, noticeParams?: TranslationParams): ChatMessage {
    return { id: messageId('error'), role: 'assistant', kind: 'error', content: '', noticeKey, noticeParams };
}
