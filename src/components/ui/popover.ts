import { useCallback, useLayoutEffect, useState } from 'react';

// Placement of a floating list (Select, Menu) next to its trigger. The list
// is position:fixed in <body>, so no ancestor's overflow can clip it.

export type PopoverStyle = {
    left: number;
    width: number;
    maxHeight: number;
    top?: number;
    bottom?: number;
};

type Rect = Pick<DOMRect, 'top' | 'bottom' | 'left' | 'right' | 'width'>;
type Viewport = { width: number; height: number };
type PopoverOptions = { minWidth?: number; maxHeight?: number; align?: 'start' | 'end' };

const GAP = 6;
const MARGIN = 8;
const MIN_HEIGHT = 120;

// Below the trigger, or above it when there is clearly more room there. As
// wide as the trigger, minWidth or the content (contentWidth), whichever is
// widest, and never wider than the viewport.
export function popoverStyle(
    anchor: Rect,
    viewport: Viewport,
    options: PopoverOptions & { contentWidth?: number } = {}
): PopoverStyle {
    const maxHeight = options.maxHeight ?? 320;
    const wanted = Math.ceil(Math.max(anchor.width, options.minWidth ?? 0, options.contentWidth ?? 0));
    const width = Math.min(wanted, viewport.width - 2 * MARGIN);
    const preferredLeft = options.align === 'end' ? anchor.right - width : anchor.left;
    const left = Math.max(MARGIN, Math.min(preferredLeft, viewport.width - width - MARGIN));

    const spaceBelow = viewport.height - anchor.bottom - GAP - MARGIN;
    const spaceAbove = anchor.top - GAP - MARGIN;
    const above = spaceBelow < Math.min(maxHeight, 200) && spaceAbove > spaceBelow;
    const room = Math.max(MIN_HEIGHT, Math.min(maxHeight, above ? spaceAbove : spaceBelow));
    return above
        ? { left, width, maxHeight: room, bottom: viewport.height - anchor.top + GAP }
        : { left, width, maxHeight: room, top: anchor.bottom + GAP };
}

// The width the popover's content asks for, whatever width it has now.
function naturalWidth(element: HTMLElement): number {
    const current = element.style.width;
    element.style.width = 'max-content';
    const width = element.getBoundingClientRect().width;
    element.style.width = current;
    return width;
}

// Recomputed when the popover opens and on window resize. With `content`
// (the popover element) it grows to fit its items: measured once the popover
// is in the page, before it is painted.
export function usePopoverStyle(
    anchor: React.RefObject<HTMLElement | null>,
    open: boolean,
    options: PopoverOptions & { content?: React.RefObject<HTMLElement | null> } = {}
): PopoverStyle | null {
    const [style, setStyle] = useState<PopoverStyle | null>(null);
    const { minWidth, maxHeight, align, content } = options;

    const update = useCallback(() => {
        const element = anchor.current;
        if (!element) return;
        const popover = content?.current;
        const contentWidth = popover ? naturalWidth(popover) : undefined;
        setStyle(popoverStyle(element.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }, { minWidth, maxHeight, align, contentWidth }));
    }, [anchor, content, minWidth, maxHeight, align]);

    useLayoutEffect(() => {
        if (!open) return;
        update();
        window.addEventListener('resize', update);
        return () => window.removeEventListener('resize', update);
    }, [open, update]);

    const placed = open && style !== null;
    useLayoutEffect(() => {
        if (placed && content) update();
    }, [placed, content, update]);

    return open ? style : null;
}
