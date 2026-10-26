import { forwardRef, useRef } from "react";
import { cn } from "@/lib/cn";
import { rovingIndex } from "./focus";

export interface TabItem {
    id: string;
    label: React.ReactNode;
    icon?: React.ReactNode;
    /** Tooltip, e.g. with the keyboard shortcut. */
    title?: string;
}

export const tabDomId = (prefix: string, id: string) => `${prefix}-tab-${id}`;
export const tabPanelDomId = (prefix: string, id: string) => `${prefix}-panel-${id}`;

interface TabsProps {
    items: TabItem[];
    value: string;
    onChange: (id: string) => void;
    /** Prefix of the tab / panel element ids (see TabPanel). */
    idPrefix: string;
    "aria-label": string;
    orientation?: "horizontal" | "vertical";
    /** "bar" is the workspace tab strip, "pills" the settings navigation. */
    variant?: "bar" | "pills";
    className?: string;
}

/**
 * WAI-ARIA tabs with automatic activation: one Tab stop, arrow keys (and
 * Home/End) move between tabs and show their panel.
 */
export const Tabs = forwardRef<HTMLDivElement, TabsProps>(function Tabs(
    { items, value, onChange, idPrefix, "aria-label": ariaLabel, orientation = "horizontal", variant = "pills", className },
    ref
) {
    const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
    const selectedIndex = Math.max(0, items.findIndex((item) => item.id === value));

    const onKeyDown = (event: React.KeyboardEvent) => {
        const next = rovingIndex(event.key, selectedIndex, items.length, orientation);
        if (next === null) return;
        event.preventDefault();
        onChange(items[next].id);
        tabRefs.current[next]?.focus();
        tabRefs.current[next]?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    };

    return (
        <div
            ref={ref}
            role="tablist"
            aria-label={ariaLabel}
            aria-orientation={orientation}
            className={cn(
                "flex",
                orientation === "vertical" ? "flex-col gap-0.5" : variant === "bar" ? "h-full items-stretch" : "gap-1",
                className
            )}
        >
            {items.map((item, index) => {
                const selected = index === selectedIndex;
                return (
                    <button
                        key={item.id}
                        ref={(element) => { tabRefs.current[index] = element; }}
                        id={tabDomId(idPrefix, item.id)}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        aria-controls={tabPanelDomId(idPrefix, item.id)}
                        tabIndex={selected ? 0 : -1}
                        title={item.title}
                        onClick={() => onChange(item.id)}
                        onKeyDown={onKeyDown}
                        className={cn(
                            "flex shrink-0 items-center gap-2 whitespace-nowrap text-xs font-medium transition-colors focus-ring",
                            variant === "bar"
                                ? cn(
                                    "relative h-full px-3.5 border-r border-white/5",
                                    selected
                                        ? "bg-white/[0.06] text-zinc-100 after:absolute after:inset-x-0 after:bottom-0 after:h-0.5 after:bg-brand-400"
                                        : "text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200"
                                )
                                : cn(
                                    "rounded-lg px-3 py-2",
                                    orientation === "vertical" && "w-full justify-start",
                                    selected ? "bg-brand-500/10 text-brand-200" : "text-zinc-400 hover:bg-white/5 hover:text-zinc-200"
                                )
                        )}
                    >
                        {item.icon && <span className="shrink-0" aria-hidden="true">{item.icon}</span>}
                        {item.label}
                    </button>
                );
            })}
        </div>
    );
});

export function TabPanel({
    idPrefix,
    id,
    active,
    children,
    className
}: {
    idPrefix: string;
    id: string;
    active: boolean;
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            id={tabPanelDomId(idPrefix, id)}
            role="tabpanel"
            aria-labelledby={tabDomId(idPrefix, id)}
            hidden={!active}
            className={className}
        >
            {children}
        </div>
    );
}
