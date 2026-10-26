import { describe, expect, it } from 'vitest';
import {
    APPEARANCE_STORAGE_KEY, DEFAULT_APPEARANCE, TERMINAL_FONT_SIZE, clampFontSize, parseAppearance, readStoredAppearance,
    resolveTerminalTheme, resolveTheme
} from './model';

describe('resolveTheme', () => {
    it('follows the OS for "system" and the choice otherwise', () => {
        expect(resolveTheme('system', true)).toBe('dark');
        expect(resolveTheme('system', false)).toBe('light');
        expect(resolveTheme('light', true)).toBe('light');
        expect(resolveTheme('dark', false)).toBe('dark');
    });
});

describe('resolveTerminalTheme', () => {
    it('makes "auto" ShellMind dark or light after the app theme', () => {
        expect(resolveTerminalTheme('auto', 'dark')).toBe('shellmind-dark');
        expect(resolveTerminalTheme('auto', 'light')).toBe('shellmind-light');
    });

    it('keeps a chosen scheme whatever the app theme', () => {
        expect(resolveTerminalTheme('dracula', 'light')).toBe('dracula');
        expect(resolveTerminalTheme('solarized-light', 'dark')).toBe('solarized-light');
    });
});

describe('parseAppearance', () => {
    it('defaults to the dark theme, teal and the comfortable density', () => {
        expect(parseAppearance(null)).toEqual(DEFAULT_APPEARANCE);
        expect(DEFAULT_APPEARANCE).toMatchObject({ theme: 'dark', accent: 'teal', density: 'comfortable', terminalTheme: 'auto' });
    });

    it('keeps valid values and replaces unknown ones field by field', () => {
        expect(parseAppearance({
            theme: 'light', accent: 'violet', density: 'compact', terminalTheme: 'nord', terminalFontSize: 16,
            cursorStyle: 'bar', cursorBlink: false
        })).toEqual({
            theme: 'light', accent: 'violet', density: 'compact', terminalTheme: 'nord', terminalFontSize: 16,
            cursorStyle: 'bar', cursorBlink: false
        });
        expect(parseAppearance({ theme: 'sepia', accent: 'chartreuse', density: 1, cursorStyle: 'beam', cursorBlink: 'yes' }))
            .toEqual(DEFAULT_APPEARANCE);
    });

    it('clamps and rounds the terminal font size', () => {
        expect(clampFontSize(3)).toBe(TERMINAL_FONT_SIZE.min);
        expect(clampFontSize(99)).toBe(TERMINAL_FONT_SIZE.max);
        expect(clampFontSize(15.4)).toBe(15);
        expect(clampFontSize('16')).toBe(TERMINAL_FONT_SIZE.default);
        expect(clampFontSize(Number.NaN)).toBe(TERMINAL_FONT_SIZE.default);
    });
});

describe('readStoredAppearance', () => {
    const storage = (value: string | null) => ({ getItem: (key: string) => (key === APPEARANCE_STORAGE_KEY ? value : null) });

    it('reads the saved preferences', () => {
        expect(readStoredAppearance(storage(JSON.stringify({ theme: 'system', accent: 'fuchsia' }))))
            .toEqual({ ...DEFAULT_APPEARANCE, theme: 'system', accent: 'fuchsia' });
    });

    it('falls back to the defaults without storage or with garbage in it', () => {
        expect(readStoredAppearance(null)).toEqual(DEFAULT_APPEARANCE);
        expect(readStoredAppearance(storage('{not json'))).toEqual(DEFAULT_APPEARANCE);
        expect(readStoredAppearance({ getItem: () => { throw new Error('blocked'); } })).toEqual(DEFAULT_APPEARANCE);
    });
});
