import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { useFieldContext } from "./Field";
import { useOverlay } from "./overlayStack";
import { usePopoverStyle } from "./popover";

export interface SelectOption {
    value: string;
    label: string;
    description?: string;
    disabled?: boolean;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    className?: string;
    /** Accessible name when the Select is not inside a labelled Field. */
    "aria-label"?: string;
    id?: string;
    disabled?: boolean;
}

const TYPEAHEAD_RESET_MS = 600;

/**
 * Themed dropdown with the keyboard model of a native <select> (the WAI-ARIA
 * select-only combobox): ArrowUp/Down/Enter/Space open it, arrows, Home/End
 * and typing move the active option, Enter/Space pick it, Escape/Tab close it.
 * Focus stays on the trigger; the list renders in <body> and opens upwards
 * when there is no room below.
 */
export function Select({ value, onChange, options, placeholder, className, "aria-label": ariaLabel, id, disabled }: SelectProps) {
    const [open, setOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const triggerRef = useRef<HTMLButtonElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const typeahead = useRef({ text: "", at: 0 });
    const field = useFieldContext();
    const listId = useId();
    const valueId = useId();
    const optionId = (index: number) => `${listId}-option-${index}`;
    const t = useT();
    const selectedIndex = options.findIndex((o) => o.value === value);
    const selected = options[selectedIndex];
    const style = usePopoverStyle(triggerRef, open, { minWidth: 224 });

    const close = () => {
        setOpen(false);
        triggerRef.current?.focus({ preventScroll: true });
    };
    useOverlay(open, close);

    const enabledIndexes = options.flatMap((option, index) => (option.disabled ? [] : [index]));

    const openList = (index = selectedIndex) => {
        if (disabled) return;
        typeahead.current = { text: "", at: 0 };
        setActiveIndex(index >= 0 && !options[index]?.disabled ? index : enabledIndexes[0] ?? -1);
        setOpen(true);
    };

    const choose = (index: number) => {
        const option = options[index];
        if (!option || option.disabled) return;
        if (option.value !== value) onChange(option.value);
        close();
    };

    const move = (delta: number) => {
        if (enabledIndexes.length === 0) return;
        const position = enabledIndexes.indexOf(activeIndex);
        const next = position === -1
            ? (delta > 0 ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1])
            : enabledIndexes[Math.max(0, Math.min(enabledIndexes.length - 1, position + delta))];
        setActiveIndex(next);
    };

    // Typing selects the next option whose label starts with what was typed.
    const typeAhead = (key: string): number | undefined => {
        const now = Date.now();
        const state = typeahead.current;
        state.text = now - state.at > TYPEAHEAD_RESET_MS ? key : state.text + key;
        state.at = now;
        const query = state.text.toLowerCase();
        const start = open ? activeIndex : selectedIndex;
        const ordered = [...enabledIndexes.filter((index) => index > start), ...enabledIndexes.filter((index) => index <= start)];
        // A repeated letter cycles through the options starting with it.
        const repeated = query.length > 1 && [...query].every((char) => char === query[0]);
        return ordered.find((index) => options[index].label.toLowerCase().startsWith(repeated ? query[0] : query));
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>) => {
        if (disabled) return;
        const { key } = event;
        if (!open) {
            if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
                event.preventDefault();
                openList(key === "ArrowUp" && selectedIndex === -1 ? enabledIndexes[enabledIndexes.length - 1] : selectedIndex);
            } else if (key === "Home" || key === "End") {
                event.preventDefault();
                openList(key === "Home" ? enabledIndexes[0] : enabledIndexes[enabledIndexes.length - 1]);
            } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                const match = typeAhead(key);
                if (match !== undefined) onChange(options[match].value);
            }
            return;
        }
        switch (key) {
            case "ArrowDown": event.preventDefault(); move(1); break;
            case "ArrowUp": event.preventDefault(); move(-1); break;
            case "PageDown": event.preventDefault(); move(10); break;
            case "PageUp": event.preventDefault(); move(-10); break;
            case "Home": event.preventDefault(); setActiveIndex(enabledIndexes[0] ?? -1); break;
            case "End": event.preventDefault(); setActiveIndex(enabledIndexes[enabledIndexes.length - 1] ?? -1); break;
            case "Enter":
            case " ":
                event.preventDefault();
                choose(activeIndex);
                break;
            case "Tab":
                setOpen(false);
                break;
            default:
                if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
                    const match = typeAhead(key);
                    if (match !== undefined) setActiveIndex(match);
                }
        }
    };

    // Clicks outside close the list; scrolling an ancestor would detach it.
    useEffect(() => {
        if (!open) return;
        const inside = (target: EventTarget | null) =>
            target instanceof Node && (triggerRef.current?.contains(target) || listRef.current?.contains(target));
        const onPointerDown = (event: MouseEvent) => {
            if (!inside(event.target)) setOpen(false);
        };
        const onScroll = (event: Event) => {
            if (!inside(event.target)) setOpen(false);
        };
        window.addEventListener("mousedown", onPointerDown);
        window.addEventListener("scroll", onScroll, true);
        return () => {
            window.removeEventListener("mousedown", onPointerDown);
            window.removeEventListener("scroll", onScroll, true);
        };
    }, [open]);

    // Keep the active option in view.
    useEffect(() => {
        if (!open || activeIndex < 0) return;
        document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
    });

    const labelledBy = ariaLabel ? undefined : [field?.labelId, valueId].filter(Boolean).join(" ");

    return (
        <>
            <button
                ref={triggerRef}
                id={id ?? field?.id}
                type="button"
                role="combobox"
                aria-haspopup="listbox"
                aria-expanded={open}
                aria-controls={listId}
                aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
                aria-label={ariaLabel}
                aria-labelledby={labelledBy}
                aria-describedby={field?.describedBy}
                aria-invalid={field?.invalid ? true : undefined}
                disabled={disabled}
                onClick={() => (open ? setOpen(false) : openList())}
                onKeyDown={onKeyDown}
                className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm outline-none transition-colors hover:border-white/20 focus-ring",
                    "aria-[invalid=true]:border-rose-500/60 disabled:opacity-50 disabled:pointer-events-none",
                    open && "border-brand-500/70",
                    className
                )}
            >
                <span id={valueId} className={cn("truncate", selected ? "text-zinc-100" : "text-zinc-400")}>
                    {selected?.label || placeholder || t("common.select")}
                </span>
                <ChevronDown className={cn("h-4 w-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-180")} aria-hidden="true" />
            </button>

            {open && style && createPortal(
                <div
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    aria-labelledby={labelledBy}
                    aria-label={ariaLabel}
                    style={{ position: "fixed", ...style }}
                    className="z-[70] overflow-y-auto scrollbar-thin rounded-xl border border-white/10 bg-ink-700 p-1 shadow-panel animate-slide-up"
                >
                    {options.map((opt, index) => {
                        const isSelected = opt.value === value;
                        const isActive = index === activeIndex;
                        return (
                            <button
                                key={opt.value}
                                id={optionId(index)}
                                type="button"
                                role="option"
                                tabIndex={-1}
                                aria-selected={isSelected}
                                aria-disabled={opt.disabled || undefined}
                                // Keep focus on the trigger.
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseMove={() => { if (!opt.disabled && !isActive) setActiveIndex(index); }}
                                onClick={() => choose(index)}
                                className={cn(
                                    "flex w-full cursor-pointer items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                                    isActive ? "bg-white/[0.08]" : isSelected && "bg-brand-500/10",
                                    opt.disabled && "cursor-not-allowed opacity-50"
                                )}
                            >
                                <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", isSelected ? "text-brand-300" : "opacity-0")} aria-hidden="true" />
                                <span className="min-w-0 flex-1">
                                    <span className={cn("block truncate text-sm", isSelected ? "text-brand-200" : "text-zinc-200")}>{opt.label}</span>
                                    {opt.description && (
                                        <span className="mt-0.5 block text-[11px] leading-snug text-zinc-400">{opt.description}</span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>,
                document.body
            )}
        </>
    );
}
