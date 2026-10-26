import { describe, expect, it } from 'vitest';
import { t } from '@/i18n';
import { PANE_SHORTCUTS, paneKeyAction, type KeyLike } from '@/features/terminal/keyboard';
import { CLOSE_TERMINAL_TAB_SHORTCUT, NEW_TERMINAL_TAB_SHORTCUT } from '@/features/terminal/platform';
import { actionRegistry, formatShortcut, matchesShortcut } from '@/workspace/actions/registry';
import { buildShortcutGroups } from './shortcutList';
import { APP_SHORTCUTS, PALETTE_ALT_SHORTCUT, matchAppShortcut, tabShortcut } from './shortcuts';

const ARROWS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

// The single key combinations the app answers to, per platform: the shell's,
// the global actions' (the terminal tab ones exist in the desktop app only),
// the terminal's own (Ctrl+Shift, or Cmd on macOS) and the panel's.
function appCombos(): string[] {
    return [
        ...Object.values(APP_SHORTCUTS),
        PALETTE_ALT_SHORTCUT,
        ...Array.from({ length: 9 }, (_, index) => tabShortcut(index)),
        ...actionRegistry.actions.flatMap((action) => (action.shortcut ? [action.shortcut] : [])),
        NEW_TERMINAL_TAB_SHORTCUT,
        CLOSE_TERMINAL_TAB_SHORTCUT
    ];
}

function terminalCombos(mac: boolean): string[] {
    return ['C', 'V', 'F'].map((letter) => (mac ? `Mod+${letter}` : `Mod+Shift+${letter}`));
}

// UX-09: Alt+Shift+arrows also move the focus off macOS (GNOME and some
// graphics drivers take Ctrl+Alt+arrows before the app sees them).
function paneCombos(mac = false): string[] {
    return [
        ...Object.values(PANE_SHORTCUTS),
        ...ARROWS.map((arrow) => `Mod+Alt+${arrow}`),
        ...ARROWS.map((arrow) => `Mod+Alt+Shift+${arrow}`),
        ...(mac ? [] : ARROWS.map((arrow) => `Alt+Shift+${arrow}`))
    ];
}

// The keydown a shortcut is pressed with.
function press(shortcut: string, mac: boolean): KeyLike {
    const parts = shortcut.split('+');
    const name = parts.pop() ?? '';
    const mods = new Set(parts.map((part) => part.toLowerCase()));
    const shift = mods.has('shift');
    const letter = /^[a-z]$/i.test(name);
    return {
        type: 'keydown',
        key: letter ? (shift ? name.toUpperCase() : name.toLowerCase()) : name,
        code: letter ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : name,
        ctrlKey: mods.has('ctrl') || (mods.has('mod') && !mac),
        metaKey: mods.has('meta') || (mods.has('mod') && mac),
        altKey: mods.has('alt'),
        shiftKey: shift
    };
}

describe.each([false, true])('the keyboard shortcuts (mac: %s)', (mac) => {
    it('are all different key combinations', () => {
        const all = [...appCombos(), ...terminalCombos(mac), ...paneCombos(mac)].map((shortcut) => formatShortcut(shortcut, mac));
        expect(all.filter((combo, index) => all.indexOf(combo) !== index)).toEqual([]);
    });

    it('keep the panel keys (panes, broadcast) apart from the shell and the global actions', () => {
        for (const shortcut of paneCombos(mac)) {
            const event = press(shortcut, mac);
            expect(paneKeyAction(event, mac), shortcut).not.toBeNull();
            expect(matchAppShortcut(event, mac, { inTerminal: true }), shortcut).toBeNull();
            expect(actionRegistry.actions.filter((action) => action.shortcut && matchesShortcut(event, action.shortcut, mac)).map((action) => action.id), shortcut).toEqual([]);
        }
        for (const shortcut of [...appCombos(), ...terminalCombos(mac)]) {
            expect(paneKeyAction(press(shortcut, mac), mac), shortcut).toBeNull();
        }
    });

    it('are all listed in Settings, each once', () => {
        const items = buildShortcutGroups(t, actionRegistry.actions, mac).flatMap((group) => group.items);
        const ids = items.map((item) => item.id);
        expect(ids.filter((id, index) => ids.indexOf(id) !== index)).toEqual([]);
        expect(ids).toEqual(expect.arrayContaining([
            'palette', 'palette-terminal', 'chat', 'settings', 'tabs',
            'action-fleet', 'action-snippets', 'action-multiexec', 'action-audit',
            'terminal-copy', 'terminal-paste', 'terminal-search',
            'terminal-split-right', 'terminal-split-down', 'terminal-focus-pane', 'terminal-resize-pane', 'terminal-broadcast'
        ]));
        const keys = Object.fromEntries(items.map((item) => [item.id, item.keys]));
        expect(keys['action-fleet']).toBe(formatShortcut('Mod+Shift+H', mac));
        expect(keys['terminal-broadcast']).toBe(formatShortcut('Mod+Shift+B', mac));
        expect(keys.chat).toBe(formatShortcut(APP_SHORTCUTS.toggleChat, mac));
    });
});

// UX-08: Spanish keyboards say Mayús, Supr, Intro; the shortcut list and the
// tooltips said "Shift" and "Delete" next to the chat's "Mayús+Intro".
describe('key names in the UI language', () => {
    it('names the keys as Spanish keyboards label them, and leaves the macOS symbols alone', async () => {
        const { setLanguage, languageReady } = await import('@/i18n');
        setLanguage('es');
        await languageReady();
        try {
            const items = buildShortcutGroups(t, actionRegistry.actions, false).flatMap((group) => group.items);
            const keys = items.map((item) => item.keys).join(' ');
            expect(keys).not.toMatch(/\bShift\b|\bDelete\b/);
            expect(keys).toContain('Mayús');
            expect(Object.fromEntries(items.map((item) => [item.id, item.keys]))['terminal-close']).toBe('Supr');
            expect(formatShortcut('Mod+Shift+H', false)).toBe('Ctrl+Mayús+H');
            expect(formatShortcut('Shift+Enter', false)).toBe('Mayús+Intro');
            expect(formatShortcut('Mod+Shift+H', true)).toBe('⇧⌘H');
        } finally {
            setLanguage('en');
            await languageReady();
        }
        expect(formatShortcut('Mod+Shift+H', false)).toBe('Ctrl+Shift+H');
    });
});
