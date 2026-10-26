/* eslint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex --
   A focusable separator is a widget (the WAI-ARIA window splitter pattern);
   jsx-a11y classifies every separator as static content. */
import { useCallback, useRef, useState } from "react";
import { cn } from "@/lib/cn";

const KEY_STEP = 16;

interface ResizeHandleProps {
    /** Current size of the panel, in px. */
    value: number;
    min: number;
    max: number;
    onChange: (size: number) => void;
    /** Double click / Enter: back to the default size. */
    onReset?: () => void;
    /** Where the resized panel is: dragging towards it makes it smaller. */
    panel: "before" | "after";
    label: string;
    /** Id of the resized panel. */
    controls?: string;
    className?: string;
}

const clamp = (value: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, value)));

/**
 * Vertical splitter between two columns (WAI-ARIA window splitter): drag it,
 * or focus it and use the arrow keys, Home/End and Enter.
 */
export function ResizeHandle({ value, min, max, onChange, onReset, panel, label, controls, className }: ResizeHandleProps) {
    const drag = useRef<{ startX: number; startSize: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const direction = panel === "before" ? 1 : -1;

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture?.(event.pointerId);
        drag.current = { startX: event.clientX, startSize: value };
        setDragging(true);
    };

    const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
        if (!drag.current) return;
        onChange(clamp(drag.current.startSize + (event.clientX - drag.current.startX) * direction, min, max));
    };

    const endDrag = () => {
        drag.current = null;
        setDragging(false);
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
        let next: number | null = null;
        if (event.key === "ArrowRight") next = value + KEY_STEP * direction;
        else if (event.key === "ArrowLeft") next = value - KEY_STEP * direction;
        else if (event.key === "Home") next = min;
        else if (event.key === "End") next = max;
        else if (event.key === "Enter" && onReset) {
            event.preventDefault();
            onReset();
            return;
        }
        if (next === null) return;
        event.preventDefault();
        onChange(clamp(next, min, max));
    };

    return (
        <div
            role="separator"
            aria-orientation="vertical"
            aria-label={label}
            aria-controls={controls}
            aria-valuenow={Math.round(value)}
            aria-valuemin={min}
            aria-valuemax={max}
            tabIndex={0}
            title={label}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onDoubleClick={onReset}
            onKeyDown={onKeyDown}
            className={cn(
                "group relative z-20 w-1 shrink-0 cursor-col-resize touch-none outline-none",
                "before:absolute before:inset-y-0 before:-left-1 before:-right-1 before:content-['']",
                className
            )}
        >
            <span
                aria-hidden="true"
                className={cn(
                    "absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-white/5 transition-colors",
                    "group-hover:bg-brand-500/50 group-focus-visible:w-0.5 group-focus-visible:bg-brand-400",
                    dragging && "w-0.5 bg-brand-400"
                )}
            />
        </div>
    );
}

function readStored(key: string): number | null {
    try {
        const value = Number(window.localStorage.getItem(key));
        return Number.isFinite(value) && value > 0 ? value : null;
    } catch {
        return null;
    }
}

/** A panel size remembered on this device (localStorage), clamped to its bounds. */
export function usePersistentSize(key: string, fallback: number, min: number, max: number): [number, (size: number) => void, () => void] {
    const [size, setSize] = useState(() => clamp(readStored(key) ?? fallback, min, max));

    const update = useCallback((next: number) => {
        const value = clamp(next, min, max);
        setSize(value);
        try {
            window.localStorage.setItem(key, String(value));
        } catch {
            // Not remembered; the size still applies until reload.
        }
    }, [key, min, max]);

    const reset = useCallback(() => update(fallback), [update, fallback]);

    return [size, update, reset];
}
