import { useEffect, useState, type RefObject } from 'react';

// The current height of an element, in px (0 until measured), following
// resizes of the element itself (window, split panes).
export function useElementHeight(ref: RefObject<HTMLElement | null>): number {
    const [height, setHeight] = useState(0);

    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const measure = () => setHeight(el.clientHeight);
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(el);
        return () => observer.disconnect();
    }, [ref]);

    return height;
}
