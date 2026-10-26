import { describe, expect, it, vi } from 'vitest';
import { AiProviderError } from './errors';
import { generateWithFallback } from './fallback';

const ok = (text: string) => ({ text, stopReason: 'end_turn' as const });
const options = (overrides: Partial<{ signal: AbortSignal; hasStreamed: () => boolean }> = {}) => ({
    signal: new AbortController().signal,
    hasStreamed: () => false,
    ...overrides
});

// The model table itself (fallbacks, aliases) is tested in shared/models.test.ts.
describe('generateWithFallback', () => {
    it('returns the first model answer', async () => {
        const run = vi.fn(async () => ok('hi'));
        await expect(generateWithFallback(run, 'MiniMax-M3', options())).resolves.toEqual({ text: 'hi', stopReason: 'end_turn', usedModel: 'MiniMax-M3' });
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('falls back once on a retryable error', async () => {
        const run = vi.fn(async (model: string) => {
            if (model === 'MiniMax-M3') throw new AiProviderError('minimax', '529 overloaded', { status: 529 });
            return ok('from fallback');
        });
        await expect(generateWithFallback(run, 'MiniMax-M3', options())).resolves.toMatchObject({ text: 'from fallback', usedModel: 'MiniMax-M3.1-Flash' });
        expect(run.mock.calls.map(([model]) => model)).toEqual(['MiniMax-M3', 'MiniMax-M3.1-Flash']);
    });

    it('does not fall back for input errors, unknown errors or a model without fallback', async () => {
        const badRequest = vi.fn(async () => { throw new AiProviderError('minimax', '400 prompt too long', { status: 400 }); });
        await expect(generateWithFallback(badRequest, 'MiniMax-M3', options())).rejects.toThrow('400 prompt too long');
        expect(badRequest).toHaveBeenCalledTimes(1);

        const bug = vi.fn(async () => { throw new TypeError('x is undefined'); });
        await expect(generateWithFallback(bug, 'MiniMax-M3', options())).rejects.toThrow(TypeError);
        expect(bug).toHaveBeenCalledTimes(1);

        const overloaded = vi.fn(async () => { throw new AiProviderError('minimax', 'overloaded', { retryable: true }); });
        await expect(generateWithFallback(overloaded, 'self-hosted-model', options())).rejects.toThrow('overloaded');
        expect(overloaded).toHaveBeenCalledTimes(1);
    });

    it('does not fall back once text reached the client', async () => {
        const run = vi.fn(async () => { throw new AiProviderError('minimax', 'stream cut', { retryable: true }); });
        await expect(generateWithFallback(run, 'MiniMax-M3', options({ hasStreamed: () => true }))).rejects.toThrow('stream cut');
        expect(run).toHaveBeenCalledTimes(1);
    });

    it('reports both failures', async () => {
        const run = vi.fn(async (model: string) => { throw new AiProviderError('gemini', `${model} 503`, { status: 503 }); });
        await expect(generateWithFallback(run, 'gemini-4-argon', options())).rejects.toThrow(
            'All models failed. gemini-4-argon: gemini-4-argon 503 gemini-3.8-flash: gemini-3.8-flash 503'
        );
    });

    it('resolves null when the client aborted', async () => {
        const controller = new AbortController();
        const run = vi.fn(async () => {
            controller.abort();
            throw new Error('aborted');
        });
        await expect(generateWithFallback(run, 'MiniMax-M3', options({ signal: controller.signal }))).resolves.toBeNull();
    });
});
