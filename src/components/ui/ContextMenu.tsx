import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { restoreFocus, rovingIndex } from "./focus";
import type { MenuItem } from "./Menu";
import { useOverlay } from "./overlayStack";

const MARGIN = 8;

/**
 * A menu at a point (right click, Shift+F10, the Menu key), with the items of
 * the ui Menu. Focus starts on the first item and returns to where it was;
 * arrow keys, Home and End move; Escape, Tab, a click elsewhere or leaving
 * the window close it.
 */
export function ContextMenu({ x, y, label, items, onClose }: {
    x: number;
    y: number;
    label: string;
    items: Array<MenuItem | "separator">;
    onClose: () => void;
}) {
    const menuRef = useRef<HTMLDivElement>(null);
    const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
    const onCloseRef = useRef(onClose);
    useEffect(() => {
        onCloseRef.current = onClose;
    });

    useOverlay(true, () => onCloseRef.current());

    // Inside the window, flipped left/up when it would overflow.
    useLayoutEffect(() => {
        const menu = menuRef.current;
        if (!menu) return;
        const { width, height } = menu.getBoundingClientRect();
        const left = x + width + MARGIN > window.innerWidth ? Math.max(MARGIN, x - width) : x;
        const top = y + height + MARGIN > window.innerHeight ? Math.max(MARGIN, y - height) : y;
        setPosition({ left, top });
    }, [x, y]);

    const buttons = () => Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]:not([disabled])') ?? []);

    // Focus moves in once the menu is placed: until then it is
    // visibility:hidden, and focusing a hidden element does nothing.
    const placed = position !== null;
    useEffect(() => {
        if (placed) buttons()[0]?.focus();
    }, [placed]);

    useEffect(() => {
        const opener = document.activeElement;
        const close = () => onCloseRef.current();
        const onPointerDown = (event: MouseEvent) => {
            if (!menuRef.current?.contains(event.target as Node)) close();
        };
        window.addEventListener("mousedown", onPointerDown);
        window.addEventListener("blur", close);
        window.addEventListener("resize", close);
        return () => {
            window.removeEventListener("mousedown", onPointerDown);
            window.removeEventListener("blur", close);
            window.removeEventListener("resize", close);
            restoreFocus(opener);
        };
    }, []);

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "Tab") {
            event.preventDefault();
            onClose();
            return;
        }
        const list = buttons();
        const next = rovingIndex(event.key, list.indexOf(document.activeElement as HTMLButtonElement), list.length, "vertical");
        if (next === null) return;
        event.preventDefault();
        list[next]?.focus();
    };

    return createPortal(
        <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => event.preventDefault()}
            style={{ position: "fixed", left: position?.left ?? x, top: position?.top ?? y, visibility: position ? "visible" : "hidden" }}
            className="z-[70] min-w-[200px] rounded-xl border border-white/10 bg-ink-700 p-1 shadow-panel outline-none animate-scale-in"
        >
            {items.map((item, index) => item === "separator"
                ? <div key={`separator-${index}`} role="separator" className="mx-1 my-1 h-px bg-white/5" />
                : (
                    <button
                        key={item.id}
                        type="button"
                        role={item.checked === undefined ? "menuitem" : "menuitemcheckbox"}
                        aria-checked={item.checked}
                        tabIndex={-1}
                        disabled={item.disabled}
                        onClick={() => {
                            onClose();
                            item.onSelect();
                        }}
                        className={cn(
                            "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors",
                            "focus-item focus:bg-white/[0.08] hover:bg-white/[0.06] disabled:opacity-40 disabled:pointer-events-none",
                            item.danger ? "text-rose-300" : "text-zinc-200"
                        )}
                    >
                        {item.checked !== undefined && (
                            <Check className={cn("h-3.5 w-3.5 shrink-0 text-brand-300", !item.checked && "invisible")} aria-hidden="true" />
                        )}
                        {item.icon && <span className={cn("shrink-0", item.danger ? "text-rose-300" : "text-zinc-400")} aria-hidden="true">{item.icon}</span>}
                        <span className="min-w-0 flex-1 truncate">{item.label}</span>
                        {item.hint && <span className="shrink-0 pl-3 text-[11px] text-zinc-400">{item.hint}</span>}
                    </button>
                ))}
        </div>,
        document.body
    );
}
