import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasOpenOverlay, pushOverlay } from './overlayStack';

const opened: Array<{ remove: () => void }> = [];
const open = (...args: Parameters<typeof pushOverlay>) => {
    const entry = pushOverlay(...args);
    opened.push(entry);
    return entry;
};

const escape = (target: EventTarget = window) => {
    const event = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true, bubbles: true });
    target.dispatchEvent(event);
    return event;
};

afterEach(() => {
    while (opened.length) opened.pop()?.remove();
});

describe('overlay stack', () => {
    it('gives Escape to the topmost overlay only', () => {
        const below = vi.fn();
        const top = vi.fn();
        open(below);
        open(top);
        expect(escape().defaultPrevented).toBe(true);
        expect(top).toHaveBeenCalledTimes(1);
        expect(below).not.toHaveBeenCalled();
    });

    it('lets an Escape through when the topmost overlay says its content handles it', () => {
        const inner = document.createElement('div');
        document.body.appendChild(inner);
        const onEscape = vi.fn();
        const reached = vi.fn();
        inner.addEventListener('keydown', reached);
        open(onEscape, { passEscape: (event) => event.target === inner });
        try {
            expect(escape(inner).defaultPrevented).toBe(false);
            expect(reached).toHaveBeenCalledTimes(1);
            expect(onEscape).not.toHaveBeenCalled();
            // Anywhere else it is the overlay's again, and it still blocks the app.
            escape();
            expect(onEscape).toHaveBeenCalledTimes(1);
            expect(hasOpenOverlay()).toBe(true);
        } finally {
            inner.remove();
        }
    });
});
