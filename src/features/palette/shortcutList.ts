// Every keyboard shortcut of the app, as Settings → General lists them: the
// shell's own (shortcuts.ts), each global action that has one (from the
// action registry, so a new action shows up by itself), and the keys of the
// terminal and its tabs.
import type { TranslateFn } from '@/i18n';
import type { GlobalAction } from '@/workspace/actions/types';
import { formatShortcut } from '@/workspace/actions/registry';
import { APP_SHORTCUTS, PALETTE_ALT_SHORTCUT, REGION_SHORTCUTS, tabShortcut } from './shortcuts';
// --- W8-T1 split panes and broadcast input ---
import { paneShortcutEntries } from '@/features/terminal/keyboard';

export type ShortcutEntry = { id: string; label: string; keys: string };
export type ShortcutGroup = { id: 'general' | 'actions' | 'terminal'; title: string; items: ShortcutEntry[] };

export function buildShortcutGroups(t: TranslateFn, actions: readonly GlobalAction[], mac: boolean): ShortcutGroup[] {
    const key = (shortcut: string) => formatShortcut(shortcut, mac);
    const either = (...shortcuts: string[]) => shortcuts.map(key).join(' / ');

    const general: ShortcutEntry[] = [
        { id: 'palette', label: t('app.shortcuts.palette'), keys: key(APP_SHORTCUTS.palette) },
        { id: 'palette-terminal', label: t('app.shortcuts.paletteTerminal'), keys: key(PALETTE_ALT_SHORTCUT) },
        { id: 'chat', label: t('app.shortcuts.toggleChat'), keys: key(APP_SHORTCUTS.toggleChat) },
        { id: 'settings', label: t('app.shortcuts.settings'), keys: key(APP_SHORTCUTS.settings) },
        { id: 'tabs', label: t('app.shortcuts.tabs'), keys: `${key(tabShortcut(0))} … ${key(tabShortcut(8))}` },
        { id: 'regions', label: t('app.shortcuts.regions'), keys: either(REGION_SHORTCUTS.next, REGION_SHORTCUTS.previous) },
        { id: 'regions-terminal', label: t('app.shortcuts.regionsTerminal'), keys: either(REGION_SHORTCUTS.inTerminalNext, REGION_SHORTCUTS.inTerminalPrevious) },
        { id: 'menus', label: t('app.shortcuts.contextMenu'), keys: `${key('Shift+F10')} / ${t('app.shortcuts.menuKey')}` }
    ];

    const fromActions: ShortcutEntry[] = actions
        .filter((action): action is GlobalAction & { shortcut: string } => typeof action.shortcut === 'string')
        .map((action) => ({ id: `action-${action.id}`, label: t(action.labelKey), keys: key(action.shortcut) }));

    // features/terminal/keyboard.ts: on macOS Cmd plays the part of Ctrl+Shift.
    const terminalKey = (letter: string) => key(mac ? `Mod+${letter}` : `Ctrl+Shift+${letter}`);
    const terminal: ShortcutEntry[] = [
        { id: 'terminal-copy', label: t('app.shortcuts.terminal.copy'), keys: terminalKey('C') },
        { id: 'terminal-paste', label: t('app.shortcuts.terminal.paste'), keys: `${terminalKey('V')} / ${key('Shift+Insert')}` },
        { id: 'terminal-search', label: t('app.shortcuts.terminal.search'), keys: terminalKey('F') },
        { id: 'terminal-toolbar', label: t('app.shortcuts.terminal.toolbar'), keys: key('Alt+F10') },
        { id: 'terminal-rename', label: t('app.shortcuts.terminal.renameTab'), keys: 'F2' },
        { id: 'terminal-close', label: t('app.shortcuts.terminal.closeTab'), keys: key('Delete') }
    ];
    // --- W8-T1 split panes and broadcast input (features/terminal/keyboard.ts) ---
    terminal.push(...paneShortcutEntries(t, key, mac));

    return [
        { id: 'general', title: t('app.shortcuts.groups.general'), items: general },
        ...(fromActions.length ? [{ id: 'actions' as const, title: t('app.shortcuts.groups.actions'), items: fromActions }] : []),
        { id: 'terminal', title: t('app.shortcuts.groups.terminal'), items: terminal }
    ];
}
