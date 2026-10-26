import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatAttachment, ChatEvidence } from '@shared/chat';
import { fetchEvidence } from '../lib/evidence';

// The attachment of the message being written: what an "Ask AI" button
// pointed the chat at, and the evidence the backend collects for it as soon
// as it is attached. A new attachment replaces the previous one (and cancels
// its collection); so do removing it and leaving the chat. `id` tells
// attachments apart (the evidence of selected log lines names them
// differently from the request: see ChatAttachment).
export type PendingAttachment =
    | { id: number; status: 'collecting'; attachment: ChatAttachment }
    | { id: number; status: 'ready'; attachment: ChatAttachment; evidence: ChatEvidence }
    | { id: number; status: 'error'; attachment: ChatAttachment; error: unknown };

export function useAttachment(serverId: number | null, onSettled?: (pending: PendingAttachment) => void) {
    const [pending, setPending] = useState<PendingAttachment | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const nextIdRef = useRef(0);
    const onSettledRef = useRef(onSettled);
    useEffect(() => {
        onSettledRef.current = onSettled;
    });

    const attach = useCallback((attachment: ChatAttachment) => {
        controllerRef.current?.abort();
        if (serverId == null) return;
        const controller = new AbortController();
        controllerRef.current = controller;
        const id = ++nextIdRef.current;
        setPending({ id, status: 'collecting', attachment });
        fetchEvidence(serverId, attachment, controller.signal).then(
            (evidence) => {
                if (controllerRef.current !== controller) return;
                controllerRef.current = null;
                const next: PendingAttachment = { id, status: 'ready', attachment: evidence.attachment, evidence };
                setPending(next);
                onSettledRef.current?.(next);
            },
            (error: unknown) => {
                if (controllerRef.current !== controller || controller.signal.aborted) return;
                controllerRef.current = null;
                const next: PendingAttachment = { id, status: 'error', attachment, error };
                setPending(next);
                onSettledRef.current?.(next);
            }
        );
    }, [serverId]);

    const remove = useCallback(() => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        setPending(null);
    }, []);

    useEffect(() => () => controllerRef.current?.abort(), []);

    return { pending, attach, remove };
}
