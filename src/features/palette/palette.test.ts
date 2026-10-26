import { describe, expect, it } from 'vitest';
import { Command } from 'lucide-react';
import { fuzzyMatch } from './fuzzy';
import { rankItems, type PaletteItem } from './items';
import { isShellKey, matchAppShortcut } from './shortcuts';

const item = (id: string, label: string, section: PaletteItem['section'] = 'commands', extra: Partial<PaletteItem> = {}): PaletteItem =>
    ({ id, label, section, icon: Command, run: () => undefined, ...extra });

describe('fuzzy matching', () => {
    it('needs every character in order and reports where they matched', () => {
        expect(fuzzyMatch('pdb', 'prod-db')).toMatchObject({ positions: [0, 5, 6] });
        expect(fuzzyMatch('dbp', 'prod-db')).toBeNull();
        expect(fuzzyMatch('', 'anything')).toEqual({ score: 0, positions: [] });
        expect(fuzzyMatch('db', 'prod-db')?.positions).toEqual([5, 6]);
    });

    it('ignores case and accents', () => {
        expect(fuzzyMatch('CONEXION', 'Nueva conexión')).not.toBeNull();
        expect(fuzzyMatch('conexión', 'Nueva conexion')).not.toBeNull();
    });

    it('ranks word starts and contiguous runs higher, and drops characters scattered mid-word', () => {
        expect(fuzzyMatch('pd', 'prod-db')!.score).toBeGreaterThan(fuzzyMatch('pd', 'Product')!.score);
        expect(fuzzyMatch('pd', 'upload')).toBeNull();
        expect(fuzzyMatch('db', 'Edit web-01')).toBeNull();
        expect(fuzzyMatch('web', 'web-1')!.score).toBeGreaterThan(fuzzyMatch('web', 'my-web-1')!.score);
        expect(fuzzyMatch('ns', 'New settings')?.positions).toEqual([0, 4]);
    });

    it('matches each word of the query on its own', () => {
        expect(fuzzyMatch('go stat', 'Go to Status')).not.toBeNull();
        expect(fuzzyMatch('stat go', 'Go to Status')).not.toBeNull();
        expect(fuzzyMatch('go files', 'Go to Status')).toBeNull();
    });
});

describe('ranking palette items', () => {
    const ITEMS = [
        item('s1', 'web-1', 'servers', { keywords: '10.0.0.5 prod' }),
        item('s2', 'db-1', 'servers'),
        item('c1', 'Open settings'),
        item('c2', 'New connection'),
    ];

    it('lists everything (capped per section) without a query', () => {
        expect(rankItems(ITEMS, '').map((r) => r.item.id)).toEqual(['s1', 's2', 'c1', 'c2']);
        expect(rankItems(ITEMS, ' ', 1).map((r) => r.item.id)).toEqual(['s1', 'c1']);
    });

    it('puts label matches first and also finds items by their keywords', () => {
        expect(rankItems(ITEMS, 'set').map((r) => r.item.id)).toEqual(['c1']);
        expect(rankItems(ITEMS, 'prod').map((r) => r.item.id)).toEqual(['s1']);
        expect(rankItems(ITEMS, 'prod')[0].positions).toEqual([]);
        // Keywords match literally, not as scattered characters.
        expect(rankItems(ITEMS, '1005')).toEqual([]);
        expect(rankItems(ITEMS, 'zzz')).toEqual([]);
    });
});

describe('app shortcuts', () => {
    const key = (k: string, mods: Partial<Record<'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey', boolean>> = {}) =>
        ({ key: k, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

    it('maps Mod+K, Mod+Shift+A, Mod+, and Mod+1…9', () => {
        expect(matchAppShortcut(key('k', { ctrlKey: true }), false)).toEqual({ command: 'palette' });
        expect(matchAppShortcut(key('k', { metaKey: true }), true)).toEqual({ command: 'palette' });
        expect(matchAppShortcut(key('A', { ctrlKey: true, shiftKey: true }), false)).toEqual({ command: 'toggleChat' });
        expect(matchAppShortcut(key(',', { ctrlKey: true }), false)).toEqual({ command: 'settings' });
        expect(matchAppShortcut(key('3', { ctrlKey: true }), false)).toEqual({ command: 'tab', index: 2 });
        expect(matchAppShortcut(key('0', { ctrlKey: true }), false)).toBeNull();
        expect(matchAppShortcut(key('k'), false)).toBeNull();
        expect(matchAppShortcut(key('a', { ctrlKey: true }), false)).toBeNull();
    });

    it('leaves plain Ctrl+letter to the shell inside the terminal, with Mod+Shift+P as the palette there', () => {
        const inTerminal = { inTerminal: true };
        expect(matchAppShortcut(key('k', { ctrlKey: true }), false, inTerminal)).toBeNull();
        expect(isShellKey(key('k', { ctrlKey: true }))).toBe(true);
        // Cmd+K on macOS never reaches the shell as a control character.
        expect(matchAppShortcut(key('k', { metaKey: true }), true, inTerminal)).toEqual({ command: 'palette' });
        expect(matchAppShortcut(key('P', { ctrlKey: true, shiftKey: true }), false, inTerminal)).toEqual({ command: 'palette' });
        expect(matchAppShortcut(key('p', { metaKey: true, shiftKey: true }), true)).toEqual({ command: 'palette' });
        expect(matchAppShortcut(key('A', { ctrlKey: true, shiftKey: true }), false, inTerminal)).toEqual({ command: 'toggleChat' });
        expect(matchAppShortcut(key('2', { ctrlKey: true }), false, inTerminal)).toEqual({ command: 'tab', index: 1 });
        // F6 cycles the regions; inside the terminal it needs Ctrl (mc's F6 is Move).
        expect(matchAppShortcut(key('F6'), false)).toEqual({ command: 'region', direction: 1 });
        expect(matchAppShortcut(key('F6', { shiftKey: true }), false)).toEqual({ command: 'region', direction: -1 });
        expect(matchAppShortcut(key('F6'), false, inTerminal)).toBeNull();
        expect(matchAppShortcut(key('F6', { ctrlKey: true }), false, inTerminal)).toEqual({ command: 'region', direction: 1 });
        expect(matchAppShortcut(key('F6', { ctrlKey: true, shiftKey: true }), true, inTerminal)).toEqual({ command: 'region', direction: -1 });
        expect(matchAppShortcut(key('F6', { altKey: true }), false)).toBeNull();
        expect(isShellKey(key('2', { ctrlKey: true }))).toBe(false);
        expect(isShellKey(key('k', { ctrlKey: true, altKey: true }))).toBe(false);
    });
});
