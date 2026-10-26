import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

// Within this distance of the end, the list counts as "at the bottom".
const BOTTOM_THRESHOLD_PX = 80;
// A scroll this soon after a wheel, touch, scrollbar or key gesture, or after
// focus moved into the list (Tab to an earlier message's button, which the
// browser scrolls into view), is the user's; any other one (a message laid out
// late, older ones restored above, the browser keeping its scroll anchor)
// moved the content, not the reader.
const USER_SCROLL_WINDOW_MS = 1000;
const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']);

const nextFrame = (callback: () => void): number =>
    typeof window.requestAnimationFrame === 'function' ? window.requestAnimationFrame(callback) : window.setTimeout(callback, 16);
const cancelFrame = (handle: number) => {
    if (typeof window.cancelAnimationFrame === 'function') window.cancelAnimationFrame(handle);
    window.clearTimeout(handle);
};

// Keeps a scrollable list pinned to its end while new content arrives, but
// only when the user is already there: scrolling up to read stops the
// following, and `showJump` offers the way back.
//
// `contentKey` changes on discrete updates (a message added, older messages
// restored, the list shown again after being hidden): the list is pinned
// before that update paints. `streamKey` changes on every frame of a growing
// answer: pinning reads the list's height, which lays the whole list out, so
// it happens at most once per animation frame instead of in every commit.
// Items that change size after they were added (Markdown loaded late, a
// message laid out once it scrolls into view) keep a pinned list at its end.
export function useStickToBottom(containerRef: RefObject<HTMLElement | null>, contentKey: unknown, streamKey?: unknown) {
    const stickRef = useRef(true);
    const frameRef = useRef<number | null>(null);
    const gestureAtRef = useRef(Number.NEGATIVE_INFINITY);
    const [showJump, setShowJump] = useState(false);

    const onScroll = useCallback(() => {
        const el = containerRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= BOTTOM_THRESHOLD_PX;
        if (!atBottom && stickRef.current && performance.now() - gestureAtRef.current > USER_SCROLL_WINDOW_MS) {
            el.scrollTop = el.scrollHeight;
            return;
        }
        stickRef.current = atBottom;
        setShowJump(!atBottom);
    }, [containerRef]);

    const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
        const el = containerRef.current;
        stickRef.current = true;
        setShowJump(false);
        if (!el) return;
        if (typeof el.scrollTo === 'function') el.scrollTo({ top: el.scrollHeight, behavior });
        else el.scrollTop = el.scrollHeight;
    }, [containerRef]);

    useLayoutEffect(() => {
        const el = containerRef.current;
        if (el && stickRef.current) el.scrollTop = el.scrollHeight;
    }, [containerRef, contentKey]);

    useEffect(() => {
        if (streamKey === undefined || !stickRef.current || frameRef.current !== null) return;
        frameRef.current = nextFrame(() => {
            frameRef.current = null;
            const el = containerRef.current;
            if (el && stickRef.current) el.scrollTop = el.scrollHeight;
        });
    }, [containerRef, streamKey]);

    // What the reader does with the list, and the size of what is in it.
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return undefined;
        const gesture = () => {
            gestureAtRef.current = performance.now();
        };
        const onKey = (event: KeyboardEvent) => {
            if (SCROLL_KEYS.has(event.key)) gesture();
        };
        el.addEventListener('wheel', gesture, { passive: true });
        el.addEventListener('touchmove', gesture, { passive: true });
        el.addEventListener('pointerdown', gesture);
        el.addEventListener('keydown', onKey);
        el.addEventListener('focusin', gesture);

        let resize: ResizeObserver | null = null;
        let children: MutationObserver | null = null;
        if (typeof ResizeObserver !== 'undefined') {
            resize = new ResizeObserver(() => {
                if (stickRef.current) el.scrollTop = el.scrollHeight;
            });
            const observe = () => {
                resize?.disconnect();
                for (const child of el.children) resize?.observe(child);
            };
            observe();
            if (typeof MutationObserver !== 'undefined') {
                children = new MutationObserver(observe);
                children.observe(el, { childList: true });
            }
        }
        return () => {
            el.removeEventListener('wheel', gesture);
            el.removeEventListener('touchmove', gesture);
            el.removeEventListener('pointerdown', gesture);
            el.removeEventListener('keydown', onKey);
            el.removeEventListener('focusin', gesture);
            resize?.disconnect();
            children?.disconnect();
        };
    }, [containerRef]);

    useEffect(() => () => {
        if (frameRef.current !== null) cancelFrame(frameRef.current);
        frameRef.current = null;
    }, []);

    return { onScroll, scrollToBottom, showJump };
}
