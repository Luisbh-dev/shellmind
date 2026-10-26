import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { ChatMessage } from '../types';

// The chat mounts per server, so selecting a server rendered its whole saved
// conversation, Markdown of up to 100 answers, in the click's task (~400 ms).
// The newest messages render first, up to a small budget of text; the older
// ones are added above them in batches while the browser is idle. Each batch
// is timed (render, commit and the layout it forces) and the next one is
// sized to take about BATCH_TARGET_MS on this machine, so no batch becomes a
// long task, also on a slow one. Messages added at the end (the live
// conversation) always render at once.

// Rendered in the task that selects the server, next to the terminal.
export const FIRST_BATCH_CHARS = 2500;
// Budget of the first idle batch, before any batch has been timed.
export const RENDER_BATCH_CHARS = 2500;
export const MIN_BATCH_CHARS = 500;
export const MAX_BATCH_CHARS = 12000;
// Leaves room in a 50 ms task for style, paint and a slower machine.
export const BATCH_TARGET_MS = 16;

// Elements, labels and spacing of a message cost something even when short.
const weight = (message: ChatMessage) => message.content.length + (message.command?.length ?? 0) + 200;

// Start of the batch that ends before `end`: at least one message, then as
// many older ones as fit in `budget`.
export function batchStart(messages: ChatMessage[], end: number, budget = RENDER_BATCH_CHARS): number {
    let start = end;
    let total = 0;
    while (start > 0) {
        total += weight(messages[start - 1]);
        if (start < end && total > budget) break;
        start--;
    }
    return start;
}

// The budget of the next batch, from how long `chars` of messages took.
export function nextBatchBudget(chars: number, elapsedMs: number): number {
    const perMs = chars / Math.max(elapsedMs, 1);
    return Math.round(Math.min(MAX_BATCH_CHARS, Math.max(MIN_BATCH_CHARS, perMs * BATCH_TARGET_MS)));
}

const weightBetween = (messages: ChatMessage[], start: number, end: number) =>
    messages.slice(start, end).reduce((total, message) => total + weight(message), 0);

type IdleHandle = { cancel: () => void };

function whenIdle(callback: () => void): IdleHandle {
    if (typeof window.requestIdleCallback === 'function') {
        const id = window.requestIdleCallback(callback, { timeout: 500 });
        return { cancel: () => window.cancelIdleCallback(id) };
    }
    const id = window.setTimeout(callback, 32);
    return { cancel: () => window.clearTimeout(id) };
}

// The messages to render now (the tail of `messages`) and how many older ones
// are still waiting.
export function useProgressiveMessages(messages: ChatMessage[]): { visible: ChatMessage[]; hidden: number } {
    // The oldest message rendered so far. Messages prepended later (a restore
    // that arrived after the user started typing) wait their turn as well.
    const [firstId, setFirstId] = useState<string | null>(null);
    const budgetRef = useRef(RENDER_BATCH_CHARS);
    const kept = firstId === null ? -1 : messages.findIndex((message) => message.id === firstId);
    const start = kept !== -1 ? kept : batchStart(messages, messages.length, FIRST_BATCH_CHARS);
    const startId = messages[start]?.id ?? null;
    // Derived from the render (React re-runs it at once, before committing).
    if (startId !== firstId) setFirstId(startId);

    useEffect(() => {
        if (start === 0) return;
        const handle = whenIdle(() => {
            const next = batchStart(messages, start, budgetRef.current);
            const started = performance.now();
            // Rendered here, synchronously, so the time it takes is known.
            flushSync(() => setFirstId(messages[next].id));
            budgetRef.current = nextBatchBudget(weightBetween(messages, next, start), performance.now() - started);
        });
        return () => handle.cancel();
    }, [messages, start]);

    return { visible: start === 0 ? messages : messages.slice(start), hidden: start };
}
