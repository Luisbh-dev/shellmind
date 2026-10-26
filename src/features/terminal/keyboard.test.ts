import { describe, expect, it } from 'vitest';
import { buildShortcutGroups } from '@/features/palette/shortcutList';
import { t } from '@/i18n';
import { paneKeyAction, terminalKeyAction, type KeyContext, type KeyLike } from './keyboard';

const key = (k: string, mods: Partial<Pick<KeyLike, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>> = {}, type = 'keydown'): KeyLike => ({
    type, key: k, code: '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods,
});

const context = (overrides: Partial<KeyContext> = {}): KeyContext => ({
    mac: false, hasSelection: false, searchOpen: false, isAppShortcut: false, ...overrides,
});

const ctrl = { ctrlKey: true };
const ctrlShift = { ctrlKey: true, shiftKey: true };

describe('terminalKeyAction', () => {
    it('leaves Ctrl+L, Ctrl+C without a selection and ordinary keys to the remote program', () => {
        expect(terminalKeyAction(key('l', ctrl), context())).toBe('pass');
        expect(terminalKeyAction(key('c', ctrl), context())).toBe('pass');
        expect(terminalKeyAction(key('a'), context())).toBe('pass');
        expect(terminalKeyAction(key('k', ctrl), context())).toBe('pass');
        // Only key presses count, not their release.
        expect(terminalKeyAction(key('f', ctrl, 'keyup'), context())).toBe('pass');
    });

    it('copies with Ctrl+Shift+C, Cmd+C, or Ctrl+C over a selection', () => {
        expect(terminalKeyAction(key('C', ctrlShift), context())).toBe('copy');
        expect(terminalKeyAction(key('c', ctrl), context({ hasSelection: true }))).toBe('copy');
        expect(terminalKeyAction(key('c', { metaKey: true }), context({ mac: true }))).toBe('copy');
    });

    it('pastes with Ctrl+Shift+V, Shift+Insert and Cmd+V, never with plain Ctrl+V (FE-12)', () => {
        expect(terminalKeyAction(key('V', ctrlShift), context())).toBe('paste');
        expect(terminalKeyAction(key('Insert', { shiftKey: true }), context())).toBe('paste');
        expect(terminalKeyAction(key('v', { metaKey: true }), context({ mac: true }))).toBe('paste');
        // readline's quoted-insert at the prompt, vim's visual block.
        expect(terminalKeyAction(key('v', ctrl), context())).toBe('pass');
    });

    it('opens the search with Ctrl+Shift+F or Cmd+F, never with plain Ctrl+F (FE-12)', () => {
        expect(terminalKeyAction(key('F', ctrlShift), context())).toBe('search');
        expect(terminalKeyAction(key('f', { metaKey: true }), context({ mac: true }))).toBe('search');
        // readline's forward-char at the prompt, less/vim page down.
        expect(terminalKeyAction(key('f', ctrl), context())).toBe('pass');
        expect(terminalKeyAction(key('f', ctrl), context({ mac: true }))).toBe('pass');
    });

    it('opens the context menu from the keyboard and reaches the toolbar', () => {
        expect(terminalKeyAction(key('F10', { shiftKey: true }), context())).toBe('context-menu');
        expect(terminalKeyAction(key('ContextMenu'), context())).toBe('context-menu');
        expect(terminalKeyAction(key('F10', { altKey: true }), context())).toBe('focus-toolbar');
        expect(terminalKeyAction(key('F10'), context())).toBe('pass');
    });

    it('closes the search with Escape only while it is open', () => {
        expect(terminalKeyAction(key('Escape'), context({ searchOpen: true }))).toBe('close-search');
        expect(terminalKeyAction(key('Escape'), context())).toBe('pass');
    });

    it('lets app shortcuts bubble up', () => {
        expect(terminalKeyAction(key('T', ctrlShift), context({ isAppShortcut: true }))).toBe('app-shortcut');
    });

    it('keeps the pane and broadcast keys from the remote program', () => {
        expect(terminalKeyAction(withCode(key('D', ctrlShift), 'KeyD'), context())).toBe('pane-shortcut');
        expect(terminalKeyAction(key('ArrowLeft', { ctrlKey: true, altKey: true }), context())).toBe('pane-shortcut');
        // Ctrl+D is the end of input.
        expect(terminalKeyAction(withCode(key('d', ctrl), 'KeyD'), context())).toBe('pass');
    });
});

const withCode = (event: KeyLike, code: string): KeyLike => ({ ...event, code });

describe('paneKeyAction', () => {
    it('splits with Mod+Shift+D (right) and Mod+Alt+Shift+D (down), whatever character Alt makes', () => {
        expect(paneKeyAction(withCode(key('D', ctrlShift), 'KeyD'), false)).toEqual({ kind: 'split', direction: 'row' });
        expect(paneKeyAction(withCode(key('Î', { metaKey: true, altKey: true, shiftKey: true }), 'KeyD'), true)).toEqual({ kind: 'split', direction: 'column' });
        expect(paneKeyAction(withCode(key('D', { metaKey: true, shiftKey: true }), 'KeyD'), false)).toBeNull();
    });

    it('moves between panes with Mod+Alt+arrows and resizes them with Shift', () => {
        expect(paneKeyAction(key('ArrowRight', { ctrlKey: true, altKey: true }), false)).toEqual({ kind: 'focus-pane', direction: 'right' });
        expect(paneKeyAction(key('ArrowUp', { metaKey: true, altKey: true }), true)).toEqual({ kind: 'focus-pane', direction: 'up' });
        expect(paneKeyAction(key('ArrowDown', { ctrlKey: true, altKey: true, shiftKey: true }), false)).toEqual({ kind: 'resize-pane', direction: 'down' });
        // Ctrl+Arrow moves by word in the shell; Alt+Arrow too.
        expect(paneKeyAction(key('ArrowLeft', ctrl), false)).toBeNull();
        expect(paneKeyAction(key('ArrowLeft', { altKey: true }), false)).toBeNull();
        // On macOS Ctrl is the terminal's.
        expect(paneKeyAction(key('ArrowLeft', { ctrlKey: true, altKey: true }), true)).toBeNull();
        // UX-09: Alt+Shift+arrows too, which GNOME does not take for its
        // workspaces (Ctrl+Alt+arrows); not on macOS, where they select words.
        expect(paneKeyAction(key('ArrowLeft', { altKey: true, shiftKey: true }), false)).toEqual({ kind: 'focus-pane', direction: 'left' });
        expect(paneKeyAction(key('ArrowLeft', { altKey: true, shiftKey: true }), true)).toBeNull();
        expect(terminalKeyAction(key('ArrowDown', { altKey: true, shiftKey: true }), context())).toBe('pane-shortcut');
    });

    it('toggles broadcast input with Mod+Shift+B', () => {
        expect(paneKeyAction(withCode(key('B', ctrlShift), 'KeyB'), false)).toEqual({ kind: 'toggle-broadcast' });
        expect(paneKeyAction(withCode(key('b', ctrl), 'KeyB'), false)).toBeNull();
        expect(paneKeyAction(withCode(key('B', ctrlShift, 'keyup'), 'KeyB'), false)).toBeNull();
    });

    it('lists the pane and broadcast keys in Settings, per platform', () => {
        const terminalKeys = (mac: boolean) => Object.fromEntries(
            (buildShortcutGroups(t, [], mac).find((group) => group.id === 'terminal')?.items ?? []).map((item) => [item.id, item.keys])
        );
        expect(terminalKeys(false)).toMatchObject({
            'terminal-split-right': 'Ctrl+Shift+D',
            'terminal-split-down': 'Ctrl+Alt+Shift+D',
            'terminal-focus-pane': 'Ctrl+Alt+←↑→↓ / Alt+Shift+←↑→↓',
            'terminal-resize-pane': 'Ctrl+Alt+Shift+←↑→↓',
            'terminal-broadcast': 'Ctrl+Shift+B'
        });
        expect(terminalKeys(true)['terminal-broadcast']).toBe('⇧⌘B');
        expect(terminalKeys(true)['terminal-focus-pane']).toBe('⌥⌘←↑→↓');
    });
});
