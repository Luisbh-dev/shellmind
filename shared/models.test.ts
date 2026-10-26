import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL, fallbackModelFor, findModel, isKnownModel, maxTokensFor, MODEL_ALIASES, MODELS, resolveModelId } from './models';

describe('model catalogue', () => {
    it('offers the default model and exactly one recommended model', () => {
        expect(MODELS.some((model) => model.id === DEFAULT_MODEL)).toBe(true);
        expect(MODELS.filter((model) => model.recommended)).toHaveLength(1);
        expect(new Set(MODELS.map((model) => model.id)).size).toBe(MODELS.length);
    });

    it('maps retired ids to served models and unknown ids to the default', () => {
        expect(resolveModelId('MiniMax-M2.7')).toBe('MiniMax-M3');
        expect(resolveModelId('MiniMax-M2.7-highspeed')).toBe('MiniMax-M3.1-Flash');
        expect(resolveModelId('gemma-3-27b-it')).toBe('gemini-3.5-flash-lite');
        expect(resolveModelId('gemini-2.5-flash')).toBe('gemini-3.8-flash');
        expect(resolveModelId('gemini-3.8-flash')).toBe('gemini-3.8-flash');
        expect(resolveModelId('something-else')).toBe(DEFAULT_MODEL);
        expect(resolveModelId(null)).toBe(DEFAULT_MODEL);
        expect(isKnownModel('MiniMax-M2.7')).toBe(true);
        expect(isKnownModel('gpt-5')).toBe(false);
        for (const [retired, target] of Object.entries(MODEL_ALIASES)) {
            expect(MODELS.some((model) => model.id === retired)).toBe(false);
            expect(MODELS.some((model) => model.id === target)).toBe(true);
        }
    });

    it('falls back only to other served models of the same provider, never to the same one', () => {
        for (const model of MODELS) {
            if (!model.fallback) continue;
            expect(model.fallback).not.toBe(model.id);
            expect(MODELS.find((other) => other.id === model.fallback)?.provider).toBe(model.provider);
        }
        expect(fallbackModelFor('MiniMax-M3')).toBe('MiniMax-M3.1-Flash');
        expect(fallbackModelFor('gemini-4-argon')).toBe('gemini-3.8-flash');
        // A retired id falls back like its successor, never to itself.
        expect(fallbackModelFor('MiniMax-M2.7-highspeed')).toBe('MiniMax-M3');
    });

    it('gives the thinking model a larger budget and low effort', () => {
        expect(maxTokensFor('MiniMax-M3.1-Flash')).toBe(16384);
        expect(maxTokensFor('MiniMax-M3')).toBe(8192);
        expect(findModel('MiniMax-M3.1-Flash')?.params).toEqual({ output_config: { effort: 'low' } });
    });
});
