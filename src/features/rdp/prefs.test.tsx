import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, fixedSize, readPrefs, writePrefs } from './prefs';

afterEach(() => localStorage.clear());

describe('RDP preferences', () => {
    it('defaults to a panel-sized desktop, scaled to fit, sharing the clipboard, typing characters', () => {
        expect(readPrefs(1)).toEqual({ resolution: 'auto', fit: true, clipboard: true, keyboard: 'unicode' });
    });

    it('are kept per server and never hold a credential, nor the password option the backend enforces', () => {
        writePrefs(1, { ...DEFAULT_PREFS, resolution: '1920x1080', keyboard: 'scancode' });
        expect(readPrefs(1)).toMatchObject({ resolution: '1920x1080', keyboard: 'scancode' });
        expect(readPrefs(2)).toEqual(DEFAULT_PREFS);
        expect(Object.keys(JSON.parse(localStorage.getItem('shellmind.rdp.prefs.1') ?? '{}')).sort()).toEqual(['clipboard', 'fit', 'keyboard', 'resolution']);
    });

    it('ignores stored values it does not know', () => {
        localStorage.setItem('shellmind.rdp.prefs.3', JSON.stringify({ askPassword: true, resolution: '99x99', fit: false, keyboard: 'morse' }));
        expect(readPrefs(3)).toEqual({ ...DEFAULT_PREFS, fit: false });
        localStorage.setItem('shellmind.rdp.prefs.4', '{not json');
        expect(readPrefs(4)).toEqual(DEFAULT_PREFS);
    });

    it('turns a fixed resolution into a size', () => {
        expect(fixedSize('1600x900')).toEqual({ width: 1600, height: 900 });
        expect(fixedSize('auto')).toBeNull();
    });
});
