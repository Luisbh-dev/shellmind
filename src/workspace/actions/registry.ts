import { t } from '@/i18n';
import type { WorkspaceServer } from '../types';
import type { GlobalAction } from './types';

const modules = import.meta.glob<GlobalAction>(['./*.tsx', '!./*.test.tsx'], { eager: true, import: 'default' });

type ShortcutEvent = Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'>;

export const isMacPlatform = () =>
    typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent);

function parseShortcut(shortcut: string) {
    const parts = shortcut.split('+').map((part) => part.trim()).filter(Boolean);
    const key = parts.pop()?.toLowerCase() ?? '';
    const modifiers = new Set(parts.map((part) => part.toLowerCase()));
    return { key, modifiers };
}

// Exact match: "Mod+K" fires on Ctrl+K (Cmd+K on macOS) but not on Ctrl+Shift+K.
export function matchesShortcut(event: ShortcutEvent, shortcut: string, mac = isMacPlatform()): boolean {
    const { key, modifiers } = parseShortcut(shortcut);
    const mod = modifiers.has('mod');
    const wants = {
        ctrl: modifiers.has('ctrl') || (mod && !mac),
        meta: modifiers.has('meta') || modifiers.has('cmd') || (mod && mac),
        alt: modifiers.has('alt'),
        shift: modifiers.has('shift')
    };
    return Boolean(key)
        && event.key.toLowerCase() === key
        && event.ctrlKey === wants.ctrl
        && event.metaKey === wants.meta
        && event.altKey === wants.alt
        && event.shiftKey === wants.shift;
}

// Keys whose names are words, as the keyboard of the UI language labels them
// (common.keys: "Mayús", "Supr", "Intro" in Spanish).
const NAMED_KEYS = new Set(['shift', 'delete', 'insert', 'enter', 'escape', 'backspace', 'space', 'tab']);

function keyName(key: string): string {
    const lower = key.toLowerCase();
    if (NAMED_KEYS.has(lower)) return t(`common.keys.${lower}`);
    return key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1);
}

// "Mod+Shift+K" -> "Ctrl+Shift+K" ("Ctrl+Mayús+K" in Spanish), or "⌘⇧K" on macOS.
export function formatShortcut(shortcut: string, mac = isMacPlatform()): string {
    const { key, modifiers } = parseShortcut(shortcut);
    const labels: Array<[string, string, string]> = [
        ['ctrl', 'Ctrl', '⌃'],
        ['alt', 'Alt', '⌥'],
        ['shift', keyName('shift'), '⇧'],
        ['meta', 'Meta', '⌘']
    ];
    const names = labels
        .filter(([name]) => modifiers.has(name)
            || (name === 'ctrl' && modifiers.has('mod') && !mac)
            || (name === 'meta' && (modifiers.has('cmd') || (modifiers.has('mod') && mac))))
        .map(([, text, symbol]) => (mac ? symbol : text));
    const keyLabel = keyName(key);
    return mac ? [...names, keyLabel].join('') : [...names, keyLabel].join('+');
}

export function isActionAvailable(action: GlobalAction, server: WorkspaceServer | null): boolean {
    if (action.requiresServer && !server) return false;
    return action.isAvailable?.(server) ?? true;
}

export function createActionRegistry(list: readonly GlobalAction[]) {
    const actions = [...list].sort((a, b) => a.order - b.order);
    const duplicate = actions.find((action, index) => actions.findIndex((other) => other.id === action.id) !== index);
    if (duplicate) throw new Error(`Duplicate global action id "${duplicate.id}"`);

    const available = (server: WorkspaceServer | null) => actions.filter((action) => isActionAvailable(action, server));

    return {
        actions: actions as readonly GlobalAction[],
        // W7-S4: the always-mounted companions (GlobalAction.Background).
        backgrounds: actions.flatMap((action) => (action.Background ? [{ id: action.id, Background: action.Background }] : [])),
        get: (id: string) => actions.find((action) => action.id === id),
        // Everything the command palette may list.
        available,
        header: (server: WorkspaceServer | null) => available(server).filter((action) => action.placement === 'header'),
        forShortcut: (event: ShortcutEvent, server: WorkspaceServer | null) =>
            available(server).find((action) => action.shortcut && matchesShortcut(event, action.shortcut))
    };
}

export type ActionRegistry = ReturnType<typeof createActionRegistry>;

export const actionRegistry: ActionRegistry = createActionRegistry(Object.values(modules));
