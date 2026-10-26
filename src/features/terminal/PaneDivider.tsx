/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
   A focusable separator is a widget (the WAI-ARIA window splitter pattern);
   jsx-a11y classifies every separator as static content. */
import { useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react';
import { cn } from '@/lib/cn';
import { MAX_RATIO, MIN_RATIO, RATIO_STEP, type PaneSplit, type Rect } from './layout';

const percent = (value: number) => `${value * 100}%`;

// The divider of a split between two panes: drag it, or focus it and use the
// arrow keys along it, Home/End (smallest and largest first pane) and Enter
// (back to halves). `rect`: the area the split divides, as fractions of
// `grid`. `onResize(ratio, done)`: `done` once the drag ends (then the size
// is remembered).
export function PaneDivider({ split, rect, grid, label, controls, onResize }: {
    split: PaneSplit;
    rect: Rect;
    grid: RefObject<HTMLElement | null>;
    label: string;
    controls?: string;
    onResize: (ratio: number, done: boolean) => void;
}) {
    const vertical = split.direction === 'row';
    const drag = useRef<{ box: DOMRect; ratio: number } | null>(null);
    const [dragging, setDragging] = useState(false);

    const ratioAt = (event: PointerEvent<HTMLDivElement>, box: DOMRect) => {
        const position = vertical ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
        const start = vertical ? rect.x : rect.y;
        const size = vertical ? rect.w : rect.h;
        return (position - start) / size;
    };

    const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
        const box = grid.current?.getBoundingClientRect();
        if (event.button !== 0 || !box?.width || !box.height) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { box, ratio: split.ratio };
        setDragging(true);
    };

    const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        drag.current.ratio = ratioAt(event, drag.current.box);
        onResize(drag.current.ratio, false);
    };

    const endDrag = () => {
        if (drag.current) onResize(drag.current.ratio, true);
        drag.current = null;
        setDragging(false);
    };

    const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
        const [less, more] = vertical ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        let next: number | null = null;
        if (event.key === less) next = split.ratio - RATIO_STEP;
        else if (event.key === more) next = split.ratio + RATIO_STEP;
        else if (event.key === 'Home') next = MIN_RATIO;
        else if (event.key === 'End') next = MAX_RATIO;
        else if (event.key === 'Enter') next = 0.5;
        if (next === null) return;
        event.preventDefault();
        onResize(next, true);
    };

    const style = vertical
        ? { left: percent(rect.x + rect.w * split.ratio), top: percent(rect.y), height: percent(rect.h) }
        : { top: percent(rect.y + rect.h * split.ratio), left: percent(rect.x), width: percent(rect.w) };

    return (
        <div
            role="separator"
            aria-orientation={vertical ? 'vertical' : 'horizontal'}
            aria-label={label}
            aria-controls={controls}
            aria-valuenow={Math.round(split.ratio * 100)}
            aria-valuemin={Math.round(MIN_RATIO * 100)}
            aria-valuemax={Math.round(MAX_RATIO * 100)}
            tabIndex={0}
            title={label}
            style={style}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={() => onResize(0.5, true)}
            onKeyDown={onKeyDown}
            className={cn(
                'group absolute z-20 touch-none outline-none',
                vertical ? 'w-2 -translate-x-1/2 cursor-col-resize' : 'h-2 -translate-y-1/2 cursor-row-resize'
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    'absolute rounded-full bg-transparent transition-colors',
                    vertical ? 'inset-y-1 left-1/2 w-0.5 -translate-x-1/2' : 'inset-x-1 top-1/2 h-0.5 -translate-y-1/2',
                    'group-hover:bg-brand-500/60 group-focus-visible:bg-brand-400',
                    dragging && 'bg-brand-400'
                )}
            />
        </div>
    );
}
