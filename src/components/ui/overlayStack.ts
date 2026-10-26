import { useCallback, useLayoutEffect, useRef } from 'react';

// Open overlays (dialogs, menus, listboxes, the command palette) in the order
// they were opened. Escape closes only the topmost one, so a dropdown inside a
// dialog, or a confirmation on top of Settings, closes on its own.

export type OverlayOptions = {
    // True when the overlay's own content handles this Escape (a text editor
    // closing its search panel): the stack lets it through, untouched.
    passEscape?: (event: KeyboardEvent) => boolean;
};

type Overlay = { id: number; onEscape: () => void } & OverlayOptions;

const stack: Overlay[] = [];
let nextId = 1;

function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'Escape' || event.isComposing) return;
    const top = stack[stack.length - 1];
    if (!top || top.passEscape?.(event)) return;
    event.preventDefault();
    event.stopPropagation();
    top.onEscape();
}

function sync() {
    // Capture phase: the overlay sees Escape before the terminal or any
    // handler of the page behind it.
    if (stack.length === 1) window.addEventListener('keydown', onKeyDown, true);
    if (stack.length === 0) window.removeEventListener('keydown', onKeyDown, true);
}

export function pushOverlay(onEscape: () => void, options: OverlayOptions = {}): { id: number; remove: () => void } {
    const entry: Overlay = { id: nextId++, onEscape, ...options };
    stack.push(entry);
    sync();
    return {
        id: entry.id,
        remove: () => {
            const index = stack.indexOf(entry);
            if (index === -1) return;
            stack.splice(index, 1);
            sync();
        }
    };
}

export function isTopOverlay(id: number): boolean {
    return stack[stack.length - 1]?.id === id;
}

export function hasOpenOverlay(): boolean {
    return stack.length > 0;
}

// Registers an overlay while `active`; `onEscape` (and `options`) may change
// between renders. Returns a function telling whether this overlay is
// currently the topmost. Registered before the browser paints, so an overlay
// on screen is always on the stack (a shortcut pressed right after it opened
// must not act behind it).
export function useOverlay(active: boolean, onEscape: () => void, options: OverlayOptions = {}): () => boolean {
    const onEscapeRef = useRef(onEscape);
    const optionsRef = useRef(options);
    const idRef = useRef<number | null>(null);

    useLayoutEffect(() => {
        onEscapeRef.current = onEscape;
        optionsRef.current = options;
    });

    useLayoutEffect(() => {
        if (!active) return;
        const entry = pushOverlay(() => onEscapeRef.current(), {
            passEscape: (event) => optionsRef.current.passEscape?.(event) ?? false
        });
        idRef.current = entry.id;
        return () => {
            entry.remove();
            idRef.current = null;
        };
    }, [active]);

    return useCallback(() => idRef.current !== null && isTopOverlay(idRef.current), []);
}
