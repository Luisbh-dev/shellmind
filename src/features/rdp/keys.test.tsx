import { afterEach, describe, expect, it } from 'vitest';
import { isKeyboardCaptureTarget } from '@/features/palette/shortcuts';
import { setLanguage, t } from '@/i18n';
import { comboEvents, formatKeys, isReleaseShortcut, RELEASE_SHORTCUT, SPECIAL_KEYS } from './keys';

afterEach(() => setLanguage('system'));

describe('special key combinations', () => {
    it('press in order and release in reverse, with the modifiers held', () => {
        const events = comboEvents(['ControlLeft', 'ShiftLeft', 'Escape']);
        expect(events.map((event) => `${event.type}:${event.code}`)).toEqual([
            'keydown:ControlLeft', 'keydown:ShiftLeft', 'keydown:Escape',
            'keyup:Escape', 'keyup:ShiftLeft', 'keyup:ControlLeft',
        ]);
        expect(events[2]).toMatchObject({ key: 'Escape', ctrlKey: true, shiftKey: true, altKey: false, bubbles: true });
        expect(events[5]).toMatchObject({ ctrlKey: false, shiftKey: false });
        expect(comboEvents(['MetaLeft', 'KeyR'])[1]).toMatchObject({ key: 'r', metaKey: true });
    });

    it('lists combinations made of codes the remote desktop knows', () => {
        for (const key of SPECIAL_KEYS) {
            expect(key.codes.length).toBeGreaterThan(0);
            for (const code of key.codes) expect(code).toMatch(/^(Key[A-Z]|MetaLeft|ControlLeft|ShiftLeft|AltLeft|Escape|Tab|F4|PrintScreen)$/);
        }
        expect(new Set(SPECIAL_KEYS.map((key) => key.id)).size).toBe(SPECIAL_KEYS.length);
    });

    it('are written as the user’s keyboard labels them', () => {
        setLanguage('en');
        const hint = (id: string) => formatKeys(t, SPECIAL_KEYS.find((key) => key.id === id)!.hint);
        expect(hint('win-r')).toBe('Win+R');
        expect(hint('ctrl-shift-esc')).toBe('Ctrl+Shift+Esc');
        expect(hint('print-screen')).toBe('PrtSc');
        expect(formatKeys(t, RELEASE_SHORTCUT)).toBe('Ctrl+Alt+Home');
        setLanguage('es');
        expect(hint('ctrl-shift-esc')).toBe('Ctrl+Mayús+Esc');
        expect(hint('print-screen')).toBe('Impr Pant');
        expect(hint('alt-f4')).toBe('Alt+F4');
        expect(formatKeys(t, RELEASE_SHORTCUT)).toBe('Ctrl+Alt+Inicio');
    });

    it('knows the shortcut that gives the keyboard back', () => {
        expect(isReleaseShortcut(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, altKey: true }))).toBe(true);
        expect(isReleaseShortcut(new KeyboardEvent('keyup', { key: 'Home', ctrlKey: true, altKey: true }))).toBe(false);
        expect(isReleaseShortcut(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true }))).toBe(false);
        expect(isReleaseShortcut(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, altKey: true }))).toBe(false);
    });
});

describe('isKeyboardCaptureTarget', () => {
    it('is true inside an element marked data-keyboard-capture', () => {
        const stage = document.createElement('div');
        stage.setAttribute('data-keyboard-capture', 'true');
        const inner = document.createElement('iron-remote-desktop');
        stage.appendChild(inner);
        expect(isKeyboardCaptureTarget(inner)).toBe(true);
        expect(isKeyboardCaptureTarget(document.createElement('textarea'))).toBe(false);
        expect(isKeyboardCaptureTarget(window)).toBe(false);
        expect(isKeyboardCaptureTarget(null)).toBe(false);
    });
});
