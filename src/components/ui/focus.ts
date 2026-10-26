// Keyboard focus helpers shared by the dialog, menu and palette primitives.

const FOCUSABLE = [
    'a[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]'
].join(',');

// Elements reachable with Tab inside `container`, in document order. Layout is
// not consulted (jsdom has none): hidden subtrees are recognised by attribute.
export function focusableElements(container: HTMLElement): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((element) =>
        element.tabIndex >= 0 && !element.closest('[hidden], [inert], [aria-hidden="true"]')
    );
}

// Keeps Tab / Shift+Tab inside `container`.
export function trapTab(event: KeyboardEvent | React.KeyboardEvent, container: HTMLElement): void {
    if (event.key !== 'Tab') return;
    const items = focusableElements(container);
    if (items.length === 0) {
        event.preventDefault();
        container.focus();
        return;
    }
    const first = items[0];
    const last = items[items.length - 1];
    const active = document.activeElement;
    if (event.shiftKey && (active === first || !container.contains(active))) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && (active === last || !container.contains(active))) {
        event.preventDefault();
        first.focus();
    }
}

// Arrow-key navigation of a group (tabs, radio buttons, menu items): the
// index `key` moves to, wrapping around, or null for other keys.
export function rovingIndex(
    key: string,
    current: number,
    count: number,
    orientation: 'horizontal' | 'vertical' | 'both' = 'both'
): number | null {
    if (count <= 0) return null;
    const next = (orientation !== 'vertical' && key === 'ArrowRight') || (orientation !== 'horizontal' && key === 'ArrowDown');
    const previous = (orientation !== 'vertical' && key === 'ArrowLeft') || (orientation !== 'horizontal' && key === 'ArrowUp');
    if (next) return (current + 1 + count) % count;
    if (previous) return (current - 1 + count) % count;
    if (key === 'Home') return 0;
    if (key === 'End') return count - 1;
    return null;
}

// Whether `element` is where the user is: not in a hidden panel (App marks
// the panels of background servers and tabs `hidden`, and they stay mounted)
// and not behind a blocking layer (the app is inert). A component's
// window-level key handlers check this, so a background editor never takes
// Ctrl+S or Escape meant for the screen in front.
export function isOnScreen(element: Element | null | undefined): boolean {
    return element != null && element.isConnected && element.closest('[hidden], [inert]') === null;
}

// Restores focus to `element` if it is still part of the page.
export function restoreFocus(element: Element | null): void {
    if (element instanceof HTMLElement && element.isConnected) element.focus({ preventScroll: true });
}
