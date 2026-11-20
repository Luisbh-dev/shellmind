import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { Badge } from "./Badge";
import { useFieldContext } from "./Field";
import { useOverlay } from "./overlayStack";
import { usePopoverStyle } from "./popover";

interface TagInputProps {
    value: string[];
    onChange: (tags: string[]) => void;
    /** Existing tags offered while typing. */
    suggestions?: string[];
    placeholder?: string;
    maxTags?: number;
    maxLength?: number;
}

/**
 * Tags as removable chips; Enter, comma or Tab adds what was typed. Existing
 * tags are offered in a themed list (ArrowUp/Down and Enter, or a click, pick
 * one; Escape closes it).
 */
export function TagInput({ value, onChange, suggestions = [], placeholder, maxTags = 32, maxLength = 64 }: TagInputProps) {
    const [draft, setDraft] = useState("");
    const [listOpen, setListOpen] = useState(false);
    const [activeIndex, setActiveIndex] = useState(-1);
    const containerRef = useRef<HTMLDivElement>(null);
    const listRef = useRef<HTMLDivElement>(null);
    const field = useFieldContext();
    const listId = useId();
    const optionId = (index: number) => `${listId}-option-${index}`;
    const t = useT();

    const add = (raw: string) => {
        const tag = raw.trim().slice(0, maxLength);
        if (!tag || value.length >= maxTags) return false;
        if (!value.some((existing) => existing.toLowerCase() === tag.toLowerCase())) onChange([...value, tag]);
        return true;
    };

    const query = draft.trim().toLowerCase();
    const options = suggestions.filter((tag) => !value.includes(tag) && tag.toLowerCase().includes(query));
    const open = listOpen && options.length > 0;
    const style = usePopoverStyle(containerRef, open);

    const close = () => {
        setListOpen(false);
        setActiveIndex(-1);
    };
    useOverlay(open, close);

    const pick = (tag: string) => {
        add(tag);
        setDraft("");
        close();
    };

    const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            if (options.length === 0) return;
            event.preventDefault();
            if (!open) {
                setListOpen(true);
                setActiveIndex(event.key === "ArrowDown" ? 0 : options.length - 1);
            } else {
                const step = event.key === "ArrowDown" ? 1 : -1;
                setActiveIndex((index) => (index + step + options.length) % options.length);
            }
            return;
        }
        if (event.nativeEvent.isComposing) return;
        const chosen = open ? options[activeIndex] : undefined;
        if (chosen !== undefined && (event.key === "Enter" || event.key === "Tab")) {
            event.preventDefault();
            pick(chosen);
        } else if (event.key === "Enter" || event.key === "," || (event.key === "Tab" && draft.trim())) {
            if (add(draft) || event.key !== "Tab") event.preventDefault();
            setDraft("");
            close();
        } else if (event.key === "Backspace" && !draft && value.length) {
            onChange(value.slice(0, -1));
        }
    };

    // The list is fixed in <body>: scrolling an ancestor would detach it.
    useEffect(() => {
        if (!open) return;
        const onScroll = (event: Event) => {
            if (!(event.target instanceof Node && listRef.current?.contains(event.target))) close();
        };
        window.addEventListener("scroll", onScroll, true);
        return () => window.removeEventListener("scroll", onScroll, true);
    }, [open]);

    useEffect(() => {
        if (!open || activeIndex < 0) return;
        document.getElementById(optionId(activeIndex))?.scrollIntoView?.({ block: "nearest" });
    });

    return (
        <div
            ref={containerRef}
            className={cn(
                "flex min-h-[38px] w-full flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-ink-900/70 px-2 py-1.5 transition-colors",
                "focus-field focus-within:bg-ink-900"
            )}
        >
            {value.map((tag) => (
                <Badge
                    key={tag}
                    tone="brand"
                    onRemove={() => onChange(value.filter((other) => other !== tag))}
                    removeLabel={t("app.ui.removeTag", { tag })}
                >
                    {tag}
                </Badge>
            ))}
            <input
                id={field?.id}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={open}
                aria-controls={open ? listId : undefined}
                aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
                aria-describedby={field?.describedBy}
                autoComplete="off"
                value={draft}
                onChange={(event) => {
                    const next = event.target.value;
                    setListOpen(true);
                    setActiveIndex(-1);
                    // Pasting "a, b, c" adds three tags.
                    if (next.includes(",")) {
                        const parts = next.split(",");
                        parts.slice(0, -1).forEach(add);
                        setDraft(parts[parts.length - 1]);
                    } else {
                        setDraft(next);
                    }
                }}
                onFocus={() => setListOpen(true)}
                onClick={() => setListOpen(true)}
                onKeyDown={onKeyDown}
                onBlur={() => {
                    close();
                    if (add(draft)) setDraft("");
                }}
                placeholder={value.length ? undefined : placeholder}
                className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none"
            />
            {open && style && createPortal(
                <div
                    ref={listRef}
                    id={listId}
                    role="listbox"
                    aria-label={field?.labelId ? undefined : t("app.ui.tagSuggestions")}
                    aria-labelledby={field?.labelId}
                    style={{ position: "fixed", ...style }}
                    className="z-[70] overflow-y-auto scrollbar-thin rounded-xl border border-white/10 bg-ink-700 p-1 shadow-panel animate-slide-up"
                >
                    {options.map((tag, index) => {
                        const isActive = index === activeIndex;
                        return (
                            <button
                                key={tag}
                                id={optionId(index)}
                                type="button"
                                role="option"
                                tabIndex={-1}
                                aria-selected={isActive}
                                // Keep focus (and the typed draft) in the input.
                                onMouseDown={(event) => event.preventDefault()}
                                onMouseMove={() => { if (!isActive) setActiveIndex(index); }}
                                onClick={() => pick(tag)}
                                className={cn(
                                    "flex w-full cursor-pointer items-center rounded-lg px-2.5 py-2 text-left text-sm text-zinc-200 transition-colors",
                                    isActive && "bg-white/[0.08]"
                                )}
                            >
                                <span className="truncate">{tag}</span>
                            </button>
                        );
                    })}
                </div>,
                document.body
            )}
        </div>
    );
}
