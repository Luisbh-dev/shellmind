import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DEFAULT_TITLE_BAR, loadTitleBar, saveTitleBar, titleBarFor } from '../../electron/titleBar';
import { CHROME_COLORS } from '../../src/features/appearance/model';
import { INK } from '../../src/features/appearance/palette';

const LIGHT_BAR = { color: CHROME_COLORS.light, symbolColor: '#27272a', background: INK.light[900] };

describe('titleBarFor', () => {
    it('draws light symbols on the dark title bar and dark ones on the light bar', () => {
        expect(titleBarFor(CHROME_COLORS.dark)).toEqual(DEFAULT_TITLE_BAR);
        expect(titleBarFor(CHROME_COLORS.light)).toEqual(LIGHT_BAR);
        expect(titleBarFor('#FFFFFF')).toEqual({ ...LIGHT_BAR, color: '#ffffff' });
    });

    it("gives the window the page's background (ink-900) of the theme, not the title bar's", () => {
        expect(DEFAULT_TITLE_BAR.background).toBe(INK.dark[900]);
        expect(titleBarFor(CHROME_COLORS.dark)?.background).toBe(INK.dark[900]);
        expect(titleBarFor(CHROME_COLORS.light)?.background).toBe(INK.light[900]);
    });

    it.each([null, undefined, '', 'red', '#fff', 'rgb(0, 0, 0)', '#0b0d11; background:url(x)', '#0b0d1', 42, {}])(
        'ignores %j',
        (value) => expect(titleBarFor(value)).toBeNull()
    );
});

describe('remembered title bar', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-titlebar-'));
    afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

    it('starts dark without a saved colour and reopens in the last one', () => {
        const file = path.join(dir, 'window-theme.json');
        expect(loadTitleBar(file)).toEqual(DEFAULT_TITLE_BAR);
        saveTitleBar(file, titleBarFor(CHROME_COLORS.light)!);
        expect(loadTitleBar(file)).toEqual(LIGHT_BAR);
    });

    it('falls back to the dark bar for a damaged or tampered file', () => {
        for (const content of ['', '{', 'null', '[]', '{"color":"red"}', '{"color":"#fff;x"}']) {
            const file = path.join(dir, `bad-${content.length}.json`);
            fs.writeFileSync(file, content);
            expect(loadTitleBar(file), content).toEqual(DEFAULT_TITLE_BAR);
        }
    });

    it('never throws when the file cannot be written', () => {
        expect(() => saveTitleBar(path.join(dir, 'missing', 'deeper', 'window-theme.json'), DEFAULT_TITLE_BAR)).not.toThrow();
    });
});
