import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '../types';
import { BATCH_TARGET_MS, batchStart, MAX_BATCH_CHARS, MIN_BATCH_CHARS, nextBatchBudget, RENDER_BATCH_CHARS } from './useProgressiveMessages';

const message = (id: number, size: number): ChatMessage => ({ id: String(id), role: 'assistant', kind: 'chat', content: 'x'.repeat(size) });

describe('batchStart', () => {
    it('takes as many of the newest messages as fit in the budget', () => {
        const messages = Array.from({ length: 20 }, (_, i) => message(i, 1800));
        // 2000 per message (content + fixed cost): four fit in 8000.
        expect(batchStart(messages, messages.length, 8000)).toBe(16);
        expect(batchStart(messages, 16, 8000)).toBe(12);
        expect(batchStart(messages, 2, 8000)).toBe(0);
    });

    it('always takes at least one message, even an oversized one', () => {
        const messages = [message(0, 10), message(1, RENDER_BATCH_CHARS * 3)];
        expect(batchStart(messages, 2)).toBe(1);
        expect(batchStart(messages, 1)).toBe(0);
        expect(batchStart([], 0)).toBe(0);
    });
});

describe('nextBatchBudget', () => {
    it('sizes the next batch to take about the target time on this machine', () => {
        // 4000 chars took 40 ms (100 per ms): the next batch is 1600.
        expect(nextBatchBudget(4000, 40)).toBe(100 * BATCH_TARGET_MS);
        // A fast machine gets larger batches, a slow one smaller ones.
        expect(nextBatchBudget(4000, 8)).toBeGreaterThan(nextBatchBudget(4000, 40));
    });

    it('stays within bounds, also for a batch that took no measurable time', () => {
        expect(nextBatchBudget(4000, 0)).toBe(MAX_BATCH_CHARS);
        expect(nextBatchBudget(500, 400)).toBe(MIN_BATCH_CHARS);
    });
});
