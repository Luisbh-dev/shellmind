import { useCallback, useEffect, useRef, useState } from 'react';
import type { StoredChatMessage } from '@shared/chat';
import { api } from '@/lib/api';
import { fromStored, mergeRestored, toPersistedMessages } from '../lib/history';
import type { ChatMessage } from '../types';

const SAVE_DEBOUNCE_MS = 600;

export type HistoryStatus = 'loading' | 'ready' | 'unavailable';

// The conversation of one server: restored from the backend on mount, saved
// (debounced, bounded) whenever the conversation part changes. The chat is
// mounted per server, so `serverId` never changes for one instance.
export function useChatHistory(serverId: number | null, onSaveError: (error: unknown) => void) {
    const [messages, setMessages] = useState<ChatMessage[]>([]);
    const [status, setStatus] = useState<HistoryStatus>(serverId == null ? 'ready' : 'loading');
    // What the backend holds, to skip saves that would change nothing.
    const savedRef = useRef('[]');
    // Bumped by clear(): saves scheduled before it are dropped.
    const epochRef = useRef(0);
    const timerRef = useRef<number | null>(null);
    const pendingRef = useRef<{ epoch: number; payload: StoredChatMessage[] } | null>(null);
    const onSaveErrorRef = useRef(onSaveError);
    useEffect(() => {
        onSaveErrorRef.current = onSaveError;
    });

    const save = useCallback((epoch: number, payload: StoredChatMessage[]) => {
        if (serverId == null || epoch !== epochRef.current) return;
        const body = JSON.stringify(payload);
        if (body === savedRef.current) return;
        savedRef.current = body;
        api.put(`/api/chat/history/${serverId}`, { messages: payload }).catch((error: unknown) => {
            savedRef.current = '';
            onSaveErrorRef.current(error);
        });
    }, [serverId]);

    useEffect(() => {
        if (serverId == null) return;
        const controller = new AbortController();
        api.get<{ messages?: unknown }>(`/api/chat/history/${serverId}`, { signal: controller.signal })
            .then((data) => {
                const restored = fromStored(data?.messages);
                savedRef.current = JSON.stringify(toPersistedMessages(restored));
                setMessages((current) => mergeRestored(current, restored));
                setStatus('ready');
            })
            .catch(() => {
                // Saving now could overwrite a conversation that just failed
                // to load: this session's messages stay unsaved.
                if (!controller.signal.aborted) setStatus('unavailable');
            });
        return () => controller.abort();
    }, [serverId]);

    useEffect(() => {
        if (status !== 'ready') return;
        const payload = toPersistedMessages(messages);
        if (JSON.stringify(payload) === savedRef.current) return;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        const pending = { epoch: epochRef.current, payload };
        pendingRef.current = pending;
        timerRef.current = window.setTimeout(() => {
            timerRef.current = null;
            pendingRef.current = null;
            save(pending.epoch, pending.payload);
        }, SAVE_DEBOUNCE_MS);
    }, [messages, status, save]);

    // Closing the panel or switching servers must not lose the last change.
    useEffect(() => () => {
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        const pending = pendingRef.current;
        if (pending) save(pending.epoch, pending.payload);
    }, [save]);

    // Forgets the conversation here and on the backend; a save that was still
    // pending cannot bring it back.
    const clear = useCallback(async () => {
        epochRef.current += 1;
        if (timerRef.current !== null) window.clearTimeout(timerRef.current);
        timerRef.current = null;
        pendingRef.current = null;
        savedRef.current = '[]';
        setMessages([]);
        if (serverId != null) await api.del(`/api/chat/history/${serverId}`);
    }, [serverId]);

    // Changes on every clear(): answers requested before it are discarded.
    const epoch = useCallback(() => epochRef.current, []);

    return { messages, setMessages, status, clear, epoch };
}
