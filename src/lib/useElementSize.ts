// Size observers: one hook for an element and one for the window, instead of a
// ResizeObserver (or resize listener) per component.
import { useLayoutEffect, useState } from 'react';

export type ElementSize = { width: number; height: number };

const ZERO: ElementSize = { width: 0, height: 0 };

// The content-box size of an element, through a callback ref (so an element
// that mounts later, or is replaced, is measured too). Zero until measured;
// without ResizeObserver it is measured once, and again on window resizes.
export function useElementSize<T extends HTMLElement>(): [(element: T | null) => void, ElementSize] {
    const [element, setElement] = useState<T | null>(null);
    const [size, setSize] = useState<ElementSize>(ZERO);

    useLayoutEffect(() => {
        if (!element) return undefined;
        const update = (width: number, height: number) =>
            setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
        const measure = () => update(Math.round(element.clientWidth), Math.round(element.clientHeight));
        measure();
        if (typeof ResizeObserver === 'undefined') {
            window.addEventListener('resize', measure);
            return () => window.removeEventListener('resize', measure);
        }
        const observer = new ResizeObserver(measure);
        observer.observe(element);
        return () => observer.disconnect();
    }, [element]);

    return [setElement, size];
}

// The window's inner width, following resizes.
export function useViewportWidth(): number {
    const [width, setWidth] = useState(() => (typeof window === 'undefined' ? 0 : window.innerWidth));
    useLayoutEffect(() => {
        const onResize = () => setWidth(window.innerWidth);
        onResize();
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);
    return width;
}
