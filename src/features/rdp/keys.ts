import type { TranslateFn } from '@/i18n';

// Key combinations the local system keeps for itself (Ctrl+Alt+Del, the
// Windows key, Alt+Tab...) or that are awkward to type into a browser: the
// toolbar sends them to the remote desktop instead. The web component turns
// keyboard events into scancodes by their `code`, so a combination is a list
// of KeyboardEvent codes pressed in order and released in reverse.

// A key as it is written on the keyboard: a name under rdp.keyNames (the
// labels differ between languages: Inicio, Impr Pant, Mayús) or a letter.
export type KeyLabel = 'win' | 'ctrl' | 'alt' | 'shift' | 'esc' | 'tab' | 'printScreen' | 'home' | 'F4' | 'R' | 'E' | 'X' | 'D' | 'L';

export type SpecialKey = {
    id: string;
    // i18n key under rdp.keys.
    labelKey: string;
    // How it is written (Win+R): see formatKeys.
    hint: readonly KeyLabel[];
    codes: string[];
};

export const SPECIAL_KEYS: readonly SpecialKey[] = [
    { id: 'win', labelKey: 'rdp.keys.start', hint: ['win'], codes: ['MetaLeft'] },
    { id: 'win-r', labelKey: 'rdp.keys.run', hint: ['win', 'R'], codes: ['MetaLeft', 'KeyR'] },
    { id: 'win-e', labelKey: 'rdp.keys.explorer', hint: ['win', 'E'], codes: ['MetaLeft', 'KeyE'] },
    { id: 'win-x', labelKey: 'rdp.keys.quickLink', hint: ['win', 'X'], codes: ['MetaLeft', 'KeyX'] },
    { id: 'win-d', labelKey: 'rdp.keys.desktop', hint: ['win', 'D'], codes: ['MetaLeft', 'KeyD'] },
    { id: 'win-l', labelKey: 'rdp.keys.lock', hint: ['win', 'L'], codes: ['MetaLeft', 'KeyL'] },
    { id: 'ctrl-shift-esc', labelKey: 'rdp.keys.taskManager', hint: ['ctrl', 'shift', 'esc'], codes: ['ControlLeft', 'ShiftLeft', 'Escape'] },
    { id: 'alt-tab', labelKey: 'rdp.keys.switchWindow', hint: ['alt', 'tab'], codes: ['AltLeft', 'Tab'] },
    { id: 'alt-f4', labelKey: 'rdp.keys.closeWindow', hint: ['alt', 'F4'], codes: ['AltLeft', 'F4'] },
    { id: 'print-screen', labelKey: 'rdp.keys.printScreen', hint: ['printScreen'], codes: ['PrintScreen'] }
];

const MODIFIERS: Record<string, 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'> = {
    ControlLeft: 'ctrlKey',
    ControlRight: 'ctrlKey',
    AltLeft: 'altKey',
    AltRight: 'altKey',
    ShiftLeft: 'shiftKey',
    ShiftRight: 'shiftKey',
    MetaLeft: 'metaKey',
    MetaRight: 'metaKey'
};

const KEY_NAMES: Record<string, string> = {
    ControlLeft: 'Control', ControlRight: 'Control', AltLeft: 'Alt', AltRight: 'Alt', ShiftLeft: 'Shift', ShiftRight: 'Shift',
    MetaLeft: 'Meta', MetaRight: 'Meta', Escape: 'Escape', Tab: 'Tab', F4: 'F4', PrintScreen: 'PrintScreen', Delete: 'Delete', Home: 'Home'
};

function keyName(code: string): string {
    if (KEY_NAMES[code]) return KEY_NAMES[code];
    const letter = /^Key([A-Z])$/.exec(code);
    return letter ? letter[1].toLowerCase() : code;
}

// The keydown/keyup events of a combination, in the order they are sent.
export function comboEvents(codes: readonly string[]): KeyboardEvent[] {
    const held = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    const events: KeyboardEvent[] = [];
    const event = (type: 'keydown' | 'keyup', code: string) =>
        new KeyboardEvent(type, { code, key: keyName(code), bubbles: true, cancelable: true, ...held });
    for (const code of codes) {
        const modifier = MODIFIERS[code];
        if (modifier) held[modifier] = true;
        events.push(event('keydown', code));
    }
    for (const code of [...codes].reverse()) {
        const modifier = MODIFIERS[code];
        if (modifier) held[modifier] = false;
        events.push(event('keyup', code));
    }
    return events;
}

const NAMED_KEYS = new Set<KeyLabel>(['win', 'ctrl', 'alt', 'shift', 'esc', 'tab', 'printScreen', 'home']);

// "Win+R", "Ctrl+Alt+Inicio": a combination as the user's keyboard labels it.
export function formatKeys(t: TranslateFn, keys: readonly KeyLabel[]): string {
    return keys.map((key) => (NAMED_KEYS.has(key) ? t(`rdp.keyNames.${key}`) : key)).join('+');
}

// Ctrl+Alt+Home gives the keyboard back to the app (like mstsc's connection
// bar shortcut): it never reaches the remote desktop.
export const RELEASE_SHORTCUT: readonly KeyLabel[] = ['ctrl', 'alt', 'home'];

export function isReleaseShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'metaKey' | 'type'>): boolean {
    return event.type === 'keydown' && event.ctrlKey && event.altKey && !event.metaKey && event.key === 'Home';
}
