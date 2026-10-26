import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useStickToBottom } from './useStickToBottom';

// A scrollable list whose height the test controls, counting scroll writes.
function fakeList(height: number) {
    const state = { height, top: 0, writes: 0 };
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { get: () => state.height });
    Object.defineProperty(el, 'clientHeight', { get: () => 400 });
    Object.defineProperty(el, 'scrollTop', {
        get: () => state.top,
        set: (value: number) => {
            state.top = value;
            state.writes++;
        }
    });
    Object.defineProperty(el, 'scrollTo', {
        value: (options: ScrollToOptions) => {
            state.top = options.top ?? state.top;
            state.writes++;
        }
    });
    return { el, state };
}

let frames: FrameRequestCallback[];

beforeEach(() => {
    frames = [];
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal('cancelAnimationFrame', () => undefined);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const runFrame = () => act(() => {
    const pending = frames;
    frames = [];
    pending.forEach((callback) => callback(performance.now()));
});

describe('useStickToBottom', () => {
    it('pins a discrete update before it paints', () => {
        const { el, state } = fakeList(1000);
        const ref = { current: el };
        const { rerender } = renderHook(({ content }) => useStickToBottom(ref, content), { initialProps: { content: 'a' } });
        state.height = 1500;
        rerender({ content: 'b' });
        expect(state.top).toBe(1500);
    });

    it('follows a streaming answer once per frame, not in every update', () => {
        const { el, state } = fakeList(1000);
        const ref = { current: el };
        const { rerender } = renderHook(({ stream }) => useStickToBottom(ref, 'same', stream), { initialProps: { stream: 0 } });
        runFrame();
        state.writes = 0;

        for (let length = 1; length <= 5; length++) {
            state.height = 1000 + length * 20;
            rerender({ stream: length });
        }
        // Nothing is laid out or written while the updates commit...
        expect(state.writes).toBe(0);
        // ...and the next frame pins the list once, to its latest height.
        runFrame();
        expect(state.writes).toBe(1);
        expect(state.top).toBe(1100);
    });

    it('stops following once the user scrolls up to read', () => {
        const { el, state } = fakeList(2000);
        const ref = { current: el };
        const { result, rerender } = renderHook(({ content, stream }) => useStickToBottom(ref, content, stream), { initialProps: { content: 'a', stream: 0 } });
        runFrame();
        el.dispatchEvent(new WheelEvent('wheel', { deltaY: -120 }));
        state.top = 200;
        act(() => result.current.onScroll());
        expect(result.current.showJump).toBe(true);

        state.writes = 0;
        state.height = 2600;
        rerender({ content: 'b', stream: 1 });
        runFrame();
        expect(state.writes).toBe(0);

        act(() => result.current.scrollToBottom());
        expect(state.top).toBe(2600);
        expect(result.current.showJump).toBe(false);
    });

    // A restored conversation: messages lay out (Markdown, content-visibility)
    // after they were added, and the browser moves the scroll position to keep
    // its anchor. None of that is the reader scrolling away.
    it('stays at the end when the content moves under it without a scroll gesture', () => {
        const { el, state } = fakeList(1000);
        const ref = { current: el };
        const { result } = renderHook(() => useStickToBottom(ref, 'a'));
        expect(state.top).toBe(1000);
        state.height = 2400;
        state.top = 250;
        act(() => result.current.onScroll());
        expect(state.top).toBe(2400);
        expect(result.current.showJump).toBe(false);

        // A key or a touch counts as the reader's own scrolling.
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageUp' }));
        state.top = 1500;
        act(() => result.current.onScroll());
        expect(result.current.showJump).toBe(true);
    });

    // Shift+Tab from the composer to an earlier answer's button: the browser
    // scrolls the button into view, and that scroll must stay where it is.
    it('lets keyboard focus scroll an earlier item into view', () => {
        const { el, state } = fakeList(2000);
        const button = document.createElement('button');
        el.appendChild(button);
        document.body.appendChild(el);
        try {
            const ref = { current: el };
            const { result, rerender } = renderHook(({ content }) => useStickToBottom(ref, content), { initialProps: { content: 'a' } });
            expect(state.top).toBe(2000);

            button.focus();
            state.top = 300;
            act(() => result.current.onScroll());
            expect(state.top).toBe(300);
            expect(result.current.showJump).toBe(true);

            // Released: new content no longer pulls the list down.
            state.writes = 0;
            state.height = 2600;
            rerender({ content: 'b' });
            expect(state.writes).toBe(0);
            expect(state.top).toBe(300);
        } finally {
            el.remove();
        }
    });
});
