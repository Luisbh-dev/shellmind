// Which keys the terminal UI handles itself and which go to the remote
// program. Terminal programs own the plain Ctrl combinations (Ctrl+F
// forward-char and page-down, Ctrl+L redraw, Ctrl+V quoted-insert at a
// readline prompt and literal-next in vim), so the app takes only those with
// Shift (or Cmd on macOS) and Ctrl+C while text is selected.
import type { TranslateFn } from '@/i18n';

export type TerminalKeyAction =
    | 'copy'
    | 'paste'
    | 'search'
    | 'close-search'
    | 'context-menu'
    | 'focus-toolbar'
    // A global shortcut of the app (Mod+Shift+T, Mod+K...): let it bubble up.
    | 'app-shortcut'
    // A key of the terminal panel (panes, broadcast; paneKeyAction): it
    // bubbles up to the panel, never reaching the remote side.
    | 'pane-shortcut'
    // Not handled here: xterm sends it to the remote side.
    | 'pass';

export type KeyLike = Pick<KeyboardEvent, 'type' | 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export type KeyContext = {
    mac: boolean;
    hasSelection: boolean;
    searchOpen: boolean;
    isAppShortcut: boolean;
};

export function terminalKeyAction(event: KeyLike, ctx: KeyContext): TerminalKeyAction {
    if (event.type !== 'keydown') return 'pass';
    if (ctx.isAppShortcut) return 'app-shortcut';
    if (paneKeyAction(event, ctx.mac)) return 'pane-shortcut';

    const key = event.key.toLowerCase();
    const { ctrlKey: ctrl, metaKey: meta, altKey: alt, shiftKey: shift } = event;
    const onlyCtrl = ctrl && !meta && !alt;
    const cmd = ctx.mac && meta && !ctrl && !alt;
    // Ctrl+C over a selection; on macOS Cmd plays that role and Ctrl always
    // belongs to the terminal.
    const plainCtrl = onlyCtrl && !shift && !ctx.mac;

    if (event.key === 'ContextMenu' || (shift && !ctrl && !meta && !alt && event.key === 'F10')) return 'context-menu';
    if (alt && !ctrl && !meta && !shift && event.key === 'F10') return 'focus-toolbar';
    if (event.key === 'Escape' && ctx.searchOpen) return 'close-search';

    // Copy: Cmd+C, Ctrl+Shift+C, or Ctrl+C while text is selected (otherwise
    // Ctrl+C is the interrupt).
    if (key === 'c' && (cmd || (onlyCtrl && shift) || (plainCtrl && ctx.hasSelection))) return 'copy';

    // Paste: Cmd+V, Ctrl+Shift+V, Shift+Insert.
    if (key === 'v' && (cmd || (onlyCtrl && shift))) return 'paste';
    if (event.key === 'Insert' && shift && !ctrl && !meta && !alt) return 'paste';

    // Search: Cmd+F, Ctrl+Shift+F.
    if (key === 'f' && (cmd || (onlyCtrl && shift))) return 'search';

    return 'pass';
}

// The keys of the terminal panel: splitting, moving between panes, resizing
// them, and broadcast input. Mod is Ctrl (Cmd on macOS); none is a plain
// Ctrl+letter, which belongs to the shell. Letters are matched by their key
// position: with Alt (Option) the key's character changes on some layouts.
export const PANE_SHORTCUTS = {
    splitRight: 'Mod+Shift+D',
    splitDown: 'Mod+Alt+Shift+D',
    broadcast: 'Mod+Shift+B'
} as const;

// The pane and broadcast keys as Settings lists them (palette/shortcutList.ts;
// `key` writes a shortcut for the platform). On Windows and Linux, focus
// also moves with Alt+Shift+arrows: GNOME takes Ctrl+Alt+arrows to switch
// workspaces, and some Intel graphics drivers to rotate the screen.
export function paneShortcutEntries(t: TranslateFn, key: (shortcut: string) => string, mac: boolean): Array<{ id: string; label: string; keys: string }> {
    return [
        { id: 'terminal-split-right', label: t('terminal.shortcuts.splitRight'), keys: key(PANE_SHORTCUTS.splitRight) },
        { id: 'terminal-split-down', label: t('terminal.shortcuts.splitDown'), keys: key(PANE_SHORTCUTS.splitDown) },
        { id: 'terminal-focus-pane', label: t('terminal.shortcuts.focusPane'), keys: mac ? key('Mod+Alt+←↑→↓') : `${key('Mod+Alt+←↑→↓')} / ${key('Alt+Shift+←↑→↓')}` },
        { id: 'terminal-resize-pane', label: t('terminal.shortcuts.resizePane'), keys: key('Mod+Alt+Shift+←↑→↓') },
        { id: 'terminal-broadcast', label: t('terminal.shortcuts.broadcast'), keys: key(PANE_SHORTCUTS.broadcast) }
    ];
}

export type PaneDirection = 'left' | 'right' | 'up' | 'down';

export type PaneKeyAction =
    | { kind: 'split'; direction: 'row' | 'column' }
    | { kind: 'focus-pane'; direction: PaneDirection }
    | { kind: 'resize-pane'; direction: PaneDirection }
    | { kind: 'toggle-broadcast' };

const ARROWS: Record<string, PaneDirection> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };

export function paneKeyAction(event: KeyLike, mac: boolean): PaneKeyAction | null {
    if (event.type !== 'keydown') return null;
    // Alt+Shift+arrows: the focus keys that no window manager takes.
    if (!mac && event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && ARROWS[event.key]) return { kind: 'focus-pane', direction: ARROWS[event.key] };
    const mod = mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    if (!mod) return null;
    const direction = ARROWS[event.key];
    if (direction && event.altKey) return { kind: event.shiftKey ? 'resize-pane' : 'focus-pane', direction };
    if (event.code === 'KeyD' && event.shiftKey) return { kind: 'split', direction: event.altKey ? 'column' : 'row' };
    if (event.code === 'KeyB' && event.shiftKey && !event.altKey) return { kind: 'toggle-broadcast' };
    return null;
}
