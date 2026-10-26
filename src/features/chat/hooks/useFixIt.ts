import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatJsonResponse, ChatRequestBody } from '@shared/chat';
import { api } from '@/lib/api';
import { describeChatFailure, type ChatFailure } from '../lib/chatErrors';
import { runnableCommands, type RunTarget } from '../lib/fences';

// "Fix it": asks the AI for the single command that fixes a terminal issue.
// Only a runnable shell block becomes a suggested command; any other answer
// is shown as text, and a failed request as an error. Every state names the
// issue it belongs to, so a suggestion never shows under another issue. It
// has its own AbortController, so it never cancels (or is cancelled by) the
// chat.
export type FixItState =
    | { status: 'idle' }
    | { status: 'loading'; issueId: string }
    | { status: 'command'; issueId: string; command: string }
    | { status: 'explanation'; issueId: string; text: string }
    | { status: 'error'; issueId: string; failure: ChatFailure };

const IDLE: FixItState = { status: 'idle' };

export function useFixIt(buildRequest: () => ChatRequestBody, target: RunTarget) {
    const [state, setState] = useState<FixItState>(IDLE);
    const controllerRef = useRef<AbortController | null>(null);
    const latest = useRef({ buildRequest, target });
    useEffect(() => {
        latest.current = { buildRequest, target };
    });

    const request = useCallback(async (issueId: string) => {
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        setState({ status: 'loading', issueId });
        try {
            const data = await api.post<ChatJsonResponse>('/api/chat', { ...latest.current.buildRequest(), purpose: 'fix-it' }, { signal: controller.signal });
            if (controllerRef.current !== controller) return;
            const text = typeof data?.response === 'string' ? data.response.trim() : '';
            const [command] = runnableCommands(text, latest.current.target, { complete: data?.stopReason !== 'max_tokens' });
            if (command) setState({ status: 'command', issueId, command });
            else if (text) setState({ status: 'explanation', issueId, text });
            else setState({ status: 'error', issueId, failure: { key: 'chat.errors.generic' } });
        } catch (error) {
            if (controller.signal.aborted || controllerRef.current !== controller) return;
            setState({ status: 'error', issueId, failure: describeChatFailure(error) });
        } finally {
            if (controllerRef.current === controller) controllerRef.current = null;
        }
    }, []);

    const cancel = useCallback(() => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setState((current) => (current.status === 'idle' ? current : IDLE));
    }, []);

    useEffect(() => () => controllerRef.current?.abort(), []);

    return { state, request, cancel };
}
