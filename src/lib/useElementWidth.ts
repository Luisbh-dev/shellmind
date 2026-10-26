import { useLayoutEffect, useState } from 'react';

// Width of an element, through a callback ref (so an element that mounts
// later, or is replaced, is measured too). 0 until measured; `fallback` where
// ResizeObserver is missing.
export function useElementWidth<T extends HTMLElement>(fallback = 1024): [(element: T | null) => void, number] {
    const [element, setElement] = useState<T | null>(null);
    const [width, setWidth] = useState(0);
    useLayoutEffect(() => {
        if (!element) return;
        if (typeof ResizeObserver === 'undefined') {
            setWidth(element.getBoundingClientRect().width || fallback);
            return;
        }
        setWidth(Math.round(element.getBoundingClientRect().width) || fallback);
        const observer = new ResizeObserver((entries) => {
            const entry = entries[entries.length - 1];
            if (entry) setWidth(Math.round(entry.contentRect.width));
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [element, fallback]);
    return [setElement, width];
}
