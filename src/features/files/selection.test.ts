import { describe, expect, it } from 'vitest';
import { clickSelect, EMPTY_SELECTION, findByPrefix, moveFocus, prune, selectAll, toggle, type Selection } from './selection';

const names = ['a', 'b', 'c', 'd', 'e'];
const selected = (state: Selection) => [...state.selected].sort();

describe('selection', () => {
    it('selects one item on click, toggles with Ctrl and extends with Shift', () => {
        let state = clickSelect(EMPTY_SELECTION, names, 'b');
        expect(selected(state)).toEqual(['b']);
        state = clickSelect(state, names, 'd', { ctrl: true });
        expect(selected(state)).toEqual(['b', 'd']);
        state = clickSelect(state, names, 'b', { ctrl: true });
        expect(selected(state)).toEqual(['d']);
        // Ctrl+click moved the anchor to "b".
        state = clickSelect(state, names, 'a', { shift: true });
        expect(selected(state)).toEqual(['a', 'b']);
        state = clickSelect(clickSelect(EMPTY_SELECTION, names, 'b'), names, 'd', { shift: true });
        expect(selected(state)).toEqual(['b', 'c', 'd']);
        state = clickSelect(clickSelect(EMPTY_SELECTION, names, 'e'), names, 'c', { shift: true, ctrl: true });
        expect(selected(state)).toEqual(['c', 'd', 'e']);
    });

    it('moves with the keyboard: plain arrows select, Shift extends, Ctrl only moves', () => {
        let state = moveFocus(EMPTY_SELECTION, names, 1);
        expect(state.focus).toBe('a');
        state = moveFocus(state, names, 1);
        expect(selected(state)).toEqual(['b']);
        state = moveFocus(state, names, 2, { shift: true });
        expect(selected(state)).toEqual(['b', 'c', 'd']);
        state = moveFocus(state, names, -1, { ctrl: true });
        expect(state.focus).toBe('c');
        expect(selected(state)).toEqual(['b', 'c', 'd']);
        expect(moveFocus(state, names, 'last').focus).toBe('e');
        expect(moveFocus(state, names, 99).focus).toBe('e');
        expect(moveFocus(state, names, -99).focus).toBe('a');
        expect(moveFocus(EMPTY_SELECTION, [], 1)).toBe(EMPTY_SELECTION);
    });

    it('toggles, selects all and prunes vanished names', () => {
        expect(selected(toggle(EMPTY_SELECTION, 'c'))).toEqual(['c']);
        const all = selectAll(names, EMPTY_SELECTION);
        expect(selected(all)).toEqual(names);
        const pruned = prune({ ...all, focus: 'e', anchor: 'a' }, ['a', 'b']);
        expect(selected(pruned)).toEqual(['a', 'b']);
        expect(pruned.focus).toBeNull();
        const unchanged = clickSelect(EMPTY_SELECTION, names, 'a');
        expect(prune(unchanged, names)).toBe(unchanged);
    });

    it('jumps to names by typed prefix, cycling', () => {
        const list = ['apple', 'banana', 'blueberry', 'cherry'];
        expect(findByPrefix(list, 'b', -1)).toBe(1);
        expect(findByPrefix(list, 'b', 1)).toBe(2);
        expect(findByPrefix(list, 'b', 2)).toBe(1);
        expect(findByPrefix(list, 'bl', 1)).toBe(2);
        expect(findByPrefix(list, 'z', -1)).toBe(-1);
        // Equal names (an S3 object and a prefix) are separate stops.
        expect(findByPrefix(['x', 'x', 'y'], 'x', 0)).toBe(1);
    });
});
