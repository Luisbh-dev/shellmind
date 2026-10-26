import { matchesShortcut } from '@/workspace/actions/registry';

// Shortcuts of the app shell itself. The shell listens in the capture phase,
// so they also work while the terminal has focus, except plain Ctrl+letter
// (see isShellKey). Global actions bring their own shortcuts
// (src/workspace/actions); these take precedence.
export const APP_SHORTCUTS = {
    palette: 'Mod+K',
    toggleChat: 'Mod+Shift+A',
    settings: 'Mod+,'
} as const;

// Also opens the palette, and works inside the terminal, where Ctrl+K
// belongs to the shell.
export const PALETTE_ALT_SHORTCUT = 'Mod+Shift+P';

export type AppCommand = keyof typeof APP_SHORTCUTS;

export type AppShortcutMatch =
    | { command: AppCommand }
    | { command: 'tab'; index: number }
    // Focus moves to the next (1) or previous (-1) region of the window.
    | { command: 'region'; direction: 1 | -1 };

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

// Mod+1 … Mod+9 select the workspace tab at that position.
export const tabShortcut = (index: number) => `Mod+${index + 1}`;

// F6 / Shift+F6 move between the connections, the workspace and the AI chat
// (the keyboard route out of the terminal, which keeps Tab for the shell).
// Inside the terminal plain F6 belongs to the program (Midnight Commander's
// Move), so there it takes Ctrl; Ctrl+F6 works everywhere.
export const REGION_SHORTCUTS = { next: 'F6', previous: 'Shift+F6', inTerminalNext: 'Ctrl+F6', inTerminalPrevious: 'Ctrl+Shift+F6' } as const;

// Ctrl + a letter, nothing else: a control character for the program in the
// terminal (Ctrl+K cuts the line in nano and readline, Ctrl+A goes to its
// start…). Inside the terminal these keys are left to the shell.
export function isShellKey(event: ShortcutEvent): boolean {
    return event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && /^[a-z]$/i.test(event.key);
}

// Whether a key event comes from the terminal (xterm's input element).
export function isTerminalTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('.xterm') !== null;
}

// W7-S6: whether a key event comes from an element that takes the whole
// keyboard while it has the focus (the embedded remote desktop marks its
// screen with data-keyboard-capture): app shortcuts leave those keys alone.
export function isKeyboardCaptureTarget(target: EventTarget | null): boolean {
    return target instanceof Element && target.closest('[data-keyboard-capture]') !== null;
}

export function matchAppShortcut(
    event: ShortcutEvent,
    mac?: boolean,
    { inTerminal = false }: { inTerminal?: boolean } = {}
): AppShortcutMatch | null {
    if (inTerminal && isShellKey(event)) return null;
    if (matchesShortcut(event, PALETTE_ALT_SHORTCUT, mac)) return { command: 'palette' };
    for (const command of Object.keys(APP_SHORTCUTS) as AppCommand[]) {
        if (matchesShortcut(event, APP_SHORTCUTS[command], mac)) return { command };
    }
    if (/^[1-9]$/.test(event.key) && matchesShortcut(event, tabShortcut(Number(event.key) - 1), mac)) {
        return { command: 'tab', index: Number(event.key) - 1 };
    }
    if (event.key === 'F6' && !event.altKey && !event.metaKey && (event.ctrlKey || !inTerminal)) {
        return { command: 'region', direction: event.shiftKey ? -1 : 1 };
    }
    return null;
}
