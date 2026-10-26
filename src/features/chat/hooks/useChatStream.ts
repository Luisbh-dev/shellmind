import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatRequestBody, ChatStopReason } from '@shared/chat';
import { apiStream } from '@/lib/api';
import { describeChatFailure, type ChatFailure } from '../lib/chatErrors';
import { readChatResponse } from '../lib/chatStream';

// The answer being streamed. Only this object changes while tokens arrive,
// at most once per animation frame; finished messages are not re-rendered.
export type LiveAnswer = { text: string; model: string | null };

export type StreamOutcome =
    | { kind: 'done'; text: string; usedModel: string | null; stopReason?: ChatStopReason; fallbackFrom?: string }
    | { kind: 'aborted'; partial: string }
    | { kind: 'error'; failure: ChatFailure; partial: string };

const nextFrame = (callback: () => void): number =>
    typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 16);
const cancelFrame = (handle: number) => {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
    window.clearTimeout(handle);
};

export function useChatStream() {
    const [live, setLive] = useState<LiveAnswer | null>(null);
    const controllerRef = useRef<AbortController | null>(null);
    const textRef = useRef('');
    const frameRef = useRef<number | null>(null);

    const flush = useCallback(() => {
        frameRef.current = null;
        const text = textRef.current;
        setLive((current) => (current && current.text !== text ? { ...current, text } : current));
    }, []);

    // Streams one answer. `onComplete` runs before the live answer is cleared,
    // so the final message replaces it in the same render.
    const run = useCallback(async (body: ChatRequestBody, onComplete: (outcome: StreamOutcome) => void) => {
        controllerRef.current?.abort();
        const controller = new AbortController();
        controllerRef.current = controller;
        textRef.current = '';
        setLive({ text: '', model: null });

        let outcome: StreamOutcome;
        try {
            const res = await apiStream('/api/chat', { ...body, stream: true }, { signal: controller.signal });
            const answer = await readChatResponse(res, {
                onModel: (model) => setLive((current) => (current ? { ...current, model } : current)),
                onDelta: (text) => {
                    textRef.current += text;
                    if (frameRef.current === null) frameRef.current = nextFrame(flush);
                }
            });
            outcome = {
                kind: 'done',
                text: answer.text,
                usedModel: answer.usedModel,
                stopReason: answer.stopReason,
                fallbackFrom: answer.models.length > 1 ? answer.models[0] : undefined
            };
        } catch (error) {
            outcome = controller.signal.aborted
                ? { kind: 'aborted', partial: textRef.current }
                : { kind: 'error', failure: describeChatFailure(error), partial: textRef.current };
        }

        // A newer request replaced this one: it owns the live answer now.
        if (controllerRef.current !== controller) return;
        controllerRef.current = null;
        if (frameRef.current !== null) cancelFrame(frameRef.current);
        frameRef.current = null;
        onComplete(outcome);
        setLive(null);
    }, [flush]);

    const stop = useCallback(() => controllerRef.current?.abort(), []);

    useEffect(() => () => {
        controllerRef.current?.abort();
        controllerRef.current = null;
        if (frameRef.current !== null) cancelFrame(frameRef.current);
    }, []);

    return { live, isStreaming: live !== null, run, stop };
}
