import { useCallback, useEffect, useRef } from 'react';

type Intent = { to: 'detail' } | { to: 'list'; row: string | null };

// Keyboard focus in the list/detail views. When the detail replaces the list
// (a narrow panel), focus moves to its heading; when the detail closes, back
// to the row it was opened from, else to `fallback` (the search field), so
// it never drops to the page.
export function useListDetailFocus(selected: string | null, detailReplacesList: boolean) {
    const rows = useRef(new Map<string, HTMLElement>());
    const heading = useRef<HTMLHeadingElement | null>(null);
    const fallback = useRef<HTMLInputElement | null>(null);
    const intent = useRef<Intent | null>(null);

    const rowRef = useCallback((name: string) => (element: HTMLElement | null) => {
        if (element) rows.current.set(name, element);
        else rows.current.delete(name);
    }, []);

    // Call before selecting a row.
    const opening = () => {
        intent.current = detailReplacesList ? { to: 'detail' } : null;
    };
    // Call before clearing the selection; `row` is where focus returns (null:
    // the row is gone, e.g. a removed container).
    const closing = (row: string | null) => {
        intent.current = { to: 'list', row };
    };

    // preventScroll: focusing must not shift the page sideways; a row far down
    // the list is brought into view within the list only.
    useEffect(() => {
        const next = intent.current;
        if (!next) return;
        intent.current = null;
        const target = next.to === 'detail' ? heading.current : (next.row ? rows.current.get(next.row) : undefined) ?? fallback.current;
        target?.focus({ preventScroll: true });
        if (next.to === 'list') target?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    }, [selected]);

    return { rowRef, heading, fallback, opening, closing };
}
