import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { focusableElements, rovingIndex } from "./focus";
import { useOverlay } from "./overlayStack";
import { usePopoverStyle } from "./popover";

export interface MenuItem {
    id: string;
    label: string;
    icon?: React.ReactNode;
    onSelect: () => void;
    danger?: boolean;
    disabled?: boolean;
    /** Shown on the right, e.g. a shortcut. */
    hint?: string;
    /** Makes it a radio item (one of several choices) with this state. */
    checked?: boolean;
}

interface MenuProps {
    items: MenuItem[];
    /** Accessible name and tooltip of the trigger. */
    label: string;
    /** Content of the trigger (usually an icon). */
    children: React.ReactNode;
    triggerClassName?: string;
    align?: "start" | "end";
    /** Called when the menu opens or closes. */
    onOpenChange?: (open: boolean) => void;
    /** -1 keeps the button out of the Tab order (when another key reaches its items). */
    triggerTabIndex?: number;
}

/**
 * Menu button (WAI-ARIA menu pattern): focus moves into the menu, arrow keys
 * and Home/End move between items, Enter/Space activate, Escape closes and
 * returns focus to the button, Tab closes and moves on from the button.
 */
export function Menu({ items, label, children, triggerClassName, align = "end", onOpenChange, triggerTabIndex }: MenuProps) {
    const [open, setOpen] = useState(false);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const menuId = useId();
    const triggerId = useId();
    const style = usePopoverStyle(triggerRef, open, { minWidth: 200, align, content: menuRef });
    const enabled = items.filter((item) => !item.disabled);
    const pendingFocus = useRef<"first" | "last">("first");

    const setMenuOpen = (next: boolean, focusTrigger = false) => {
        setOpen(next);
        onOpenChange?.(next);
        if (!next && focusTrigger) triggerRef.current?.focus({ preventScroll: true });
    };

    useOverlay(open, () => setMenuOpen(false, true));

    const focusItem = (item: MenuItem | undefined) => {
        if (item) itemRefs.current[items.indexOf(item)]?.focus();
    };

    // Focus moves into the menu once it is positioned (only when it opens).
    const ready = open && style !== null;
    useEffect(() => {
        if (!ready) return;
        const buttons = itemRefs.current.filter((button): button is HTMLButtonElement => Boolean(button && !button.disabled));
        (pendingFocus.current === "last" ? buttons[buttons.length - 1] : buttons[0])?.focus();
    }, [ready]);

    useEffect(() => {
        if (!open) return;
        const onPointerDown = (event: MouseEvent) => {
            const target = event.target as Node;
            if (triggerRef.current?.contains(target) || menuRef.current?.contains(target)) return;
            setMenuOpen(false);
        };
        window.addEventListener("mousedown", onPointerDown);
        return () => window.removeEventListener("mousedown", onPointerDown);
    });

    const onTriggerKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            pendingFocus.current = event.key === "ArrowUp" ? "last" : "first";
            setMenuOpen(true);
        }
    };

    // Tab leaves the menu as if focus were on its button: the menu sits at the
    // end of <body>, so the browser's own Tab would jump to the page's end.
    const tabOut = (backwards: boolean) => {
        const trigger = triggerRef.current;
        setMenuOpen(false, true);
        if (!trigger) return;
        const scope = trigger.closest<HTMLElement>('[role="dialog"], [role="alertdialog"]') ?? document.body;
        const focusables = focusableElements(scope);
        const index = focusables.indexOf(trigger);
        if (index >= 0) focusables[index + (backwards ? -1 : 1)]?.focus();
    };

    const onMenuKeyDown = (event: React.KeyboardEvent) => {
        if (event.key === "Tab") {
            event.preventDefault();
            tabOut(event.shiftKey);
            return;
        }
        const current = enabled.findIndex((item) => itemRefs.current[items.indexOf(item)] === document.activeElement);
        const next = rovingIndex(event.key, current, enabled.length, "vertical");
        if (next === null) return;
        event.preventDefault();
        focusItem(enabled[next]);
    };

    const select = (item: MenuItem) => {
        if (item.disabled) return;
        setMenuOpen(false, true);
        item.onSelect();
    };

    return (
        <>
            <button
                ref={triggerRef}
                id={triggerId}
                type="button"
                aria-label={label}
                title={label}
                aria-haspopup="menu"
                aria-expanded={open}
                aria-controls={open ? menuId : undefined}
                onClick={() => {
                    pendingFocus.current = "first";
                    setMenuOpen(!open);
                }}
                onKeyDown={onTriggerKeyDown}
                tabIndex={triggerTabIndex}
                className={cn("focus-ring", triggerClassName)}
            >
                {children}
            </button>
            {open && style && createPortal(
                <div
                    ref={menuRef}
                    id={menuId}
                    role="menu"
                    aria-labelledby={triggerId}
                    tabIndex={-1}
                    onKeyDown={onMenuKeyDown}
                    style={{ position: "fixed", ...style }}
                    className="z-[70] overflow-y-auto scrollbar-thin rounded-xl border border-white/10 bg-ink-700 p-1 shadow-panel outline-none animate-slide-up"
                >
                    {items.map((item, index) => (
                        <button
                            key={item.id}
                            ref={(element) => { itemRefs.current[index] = element; }}
                            type="button"
                            role={item.checked === undefined ? "menuitem" : "menuitemradio"}
                            aria-checked={item.checked}
                            tabIndex={-1}
                            disabled={item.disabled}
                            onClick={() => select(item)}
                            className={cn(
                                "flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm outline-none transition-colors",
                                "focus-item focus:bg-white/[0.08] hover:bg-white/[0.06] disabled:opacity-40 disabled:pointer-events-none",
                                item.danger ? "text-rose-300" : "text-zinc-200"
                            )}
                        >
                            {item.checked !== undefined && (
                                <Check className={cn("h-3.5 w-3.5 shrink-0 text-brand-300", !item.checked && "invisible")} aria-hidden="true" />
                            )}
                            {item.icon && <span className="shrink-0 text-zinc-400" aria-hidden="true">{item.icon}</span>}
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            {item.hint && <span className="shrink-0 text-[11px] text-zinc-400">{item.hint}</span>}
                        </button>
                    ))}
                </div>,
                document.body
            )}
        </>
    );
}
