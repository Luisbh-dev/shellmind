// Selection of the explorer list, keyed by entryKey() (unique in a folder).
// `names` is always the visible order of those keys. Like desktop file
// managers: a click selects one item, Ctrl/Cmd toggles, Shift extends from the
// anchor; arrows move and select, Ctrl+arrows only move the focus.

export type Selection = {
    selected: ReadonlySet<string>;
    // Where Shift ranges start.
    anchor: string | null;
    // The keyboard cursor (the active row).
    focus: string | null;
};

export const EMPTY_SELECTION: Selection = { selected: new Set(), anchor: null, focus: null };

export type Modifiers = { ctrl?: boolean; shift?: boolean };

function range(names: readonly string[], from: string | null, to: string): Set<string> {
    const end = names.indexOf(to);
    const start = from === null ? -1 : names.indexOf(from);
    if (start < 0 || end < 0) return new Set([to]);
    const [low, high] = start < end ? [start, end] : [end, start];
    return new Set(names.slice(low, high + 1));
}

export function clickSelect(state: Selection, names: readonly string[], name: string, modifiers: Modifiers = {}): Selection {
    if (modifiers.shift) {
        const anchor = state.anchor ?? name;
        const extended = range(names, anchor, name);
        if (modifiers.ctrl) for (const kept of state.selected) extended.add(kept);
        return { selected: extended, anchor, focus: name };
    }
    if (modifiers.ctrl) return toggle(state, name);
    return { selected: new Set([name]), anchor: name, focus: name };
}

export function toggle(state: Selection, name: string): Selection {
    const selected = new Set(state.selected);
    if (selected.has(name)) selected.delete(name);
    else selected.add(name);
    return { selected, anchor: name, focus: name };
}

export type Move = number | 'first' | 'last';

export function moveFocus(state: Selection, names: readonly string[], move: Move, modifiers: Modifiers = {}): Selection {
    if (!names.length) return state;
    const current = state.focus === null ? -1 : names.indexOf(state.focus);
    let index: number;
    if (move === 'first') index = 0;
    else if (move === 'last') index = names.length - 1;
    else if (current < 0) index = move > 0 ? 0 : names.length - 1;
    else index = Math.min(names.length - 1, Math.max(0, current + move));
    const name = names[index];
    if (modifiers.shift) return { selected: range(names, state.anchor ?? state.focus ?? name, name), anchor: state.anchor ?? state.focus ?? name, focus: name };
    if (modifiers.ctrl) return { ...state, focus: name };
    return { selected: new Set([name]), anchor: name, focus: name };
}

export function selectAll(names: readonly string[], state: Selection): Selection {
    return { selected: new Set(names), anchor: state.anchor, focus: state.focus ?? names[0] ?? null };
}

// Drops names that are no longer listed (after a refresh or a filter change).
export function prune(state: Selection, names: readonly string[]): Selection {
    const listed = new Set(names);
    const selected = [...state.selected].filter((name) => listed.has(name));
    const focus = state.focus !== null && listed.has(state.focus) ? state.focus : null;
    const anchor = state.anchor !== null && listed.has(state.anchor) ? state.anchor : null;
    if (selected.length === state.selected.size && focus === state.focus && anchor === state.anchor) return state;
    return { selected: new Set(selected), anchor, focus };
}

// The index of the next name starting with `prefix` after the focused index
// `from` (-1: none focused), or -1 (type-ahead over the display names).
export function findByPrefix(names: readonly string[], prefix: string, from: number): number {
    const needle = prefix.toLocaleLowerCase();
    const start = from < 0 ? 0 : from + (prefix.length === 1 ? 1 : 0);
    for (let offset = 0; offset < names.length; offset += 1) {
        const index = (start + offset) % names.length;
        if (names[index].toLocaleLowerCase().startsWith(needle)) return index;
    }
    return -1;
}
