import { describe, expect, it } from 'vitest';
import { buildOutOfScopeResponse, isOutOfScopeAiRequest, looksSpanish } from './scope';

describe('looksSpanish', () => {
    it('detects Spanish keywords, ignoring case and accents', () => {
        expect(looksSpanish('Hola, necesito ayuda')).toBe(true);
        expect(looksSpanish('Configura el firewall')).toBe(true);
        expect(looksSpanish('MONITORIZACIÓN de discos')).toBe(true);
    });

    it('returns false for English text and empty input', () => {
        expect(looksSpanish('Hello, I need help with nginx')).toBe(false);
        expect(looksSpanish('')).toBe(false);
    });

    it('counts English words that are in the keyword list', () => {
        // "script", "scraping", "docker"... are in the list, so this English
        // request gets the Spanish refusal.
        expect(looksSpanish('write a web scraping script in python')).toBe(true);
    });

    it('matches whole words only', () => {
        // "servidores" is not in the word list (only "servidor").
        expect(looksSpanish('los servidores')).toBe(false);
        expect(looksSpanish('el servidor')).toBe(true);
    });
});

describe('buildOutOfScopeResponse', () => {
    it('answers in Spanish when the request looks Spanish', () => {
        expect(buildOutOfScopeResponse('Hola, hazme un juego')).toMatch(/^Solo puedo ayudar con tareas de SysAdmin/);
    });

    it('answers in English otherwise', () => {
        expect(buildOutOfScopeResponse('Write me a poem')).toMatch(/^I can only help with SysAdmin, server management, and DevOps tasks\./);
    });
});

describe('isOutOfScopeAiRequest', () => {
    it('flags disallowed requests with no infrastructure keyword', () => {
        expect(isOutOfScopeAiRequest('write a web scraping script in python')).toBe(true);
        expect(isOutOfScopeAiRequest('build me a react app')).toBe(true);
        expect(isOutOfScopeAiRequest('Write me a poem about cats')).toBe(true);
    });

    it('flags generic coding requests with no infrastructure keyword', () => {
        expect(isOutOfScopeAiRequest('write javascript code for a calculator')).toBe(true);
    });

    it('allows requests that mention infrastructure', () => {
        expect(isOutOfScopeAiRequest('Write a python script to rotate nginx logs')).toBe(false);
        expect(isOutOfScopeAiRequest('How do I restart docker?')).toBe(false);
        expect(isOutOfScopeAiRequest('df shows the disk is full')).toBe(false);
    });

    it('lets the server context provide the infrastructure keyword', () => {
        expect(isOutOfScopeAiRequest('write javascript code', 'Connected to web01 (Ubuntu - 10.0.0.1)')).toBe(true);
        expect(isOutOfScopeAiRequest('write javascript code', 'Connected to server web01')).toBe(false);
    });

    it('does not flag plain questions', () => {
        expect(isOutOfScopeAiRequest('')).toBe(false);
        expect(isOutOfScopeAiRequest('what is uptime?')).toBe(false);
    });

    it('matches keywords as substrings', () => {
        // "support" contains the infrastructure keyword "port", so this
        // disallowed "translate" request passes the filter.
        expect(isOutOfScopeAiRequest('Translate this support ticket')).toBe(false);
        // "app" inside "happy" counts as a generic coding keyword.
        expect(isOutOfScopeAiRequest('happy birthday')).toBe(true);
    });
});
