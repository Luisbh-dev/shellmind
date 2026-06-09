import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronDown, Check } from "lucide-react";
import { cn } from "@/lib/cn";

export interface SelectOption {
    value: string;
    label: string;
    description?: string;
}

interface SelectProps {
    value: string;
    onChange: (value: string) => void;
    options: SelectOption[];
    placeholder?: string;
    className?: string;
}

/**
 * Themed dropdown that replaces the native <select> (whose expanded list is
 * rendered by the OS and can't be styled to match the dark UI).
 *
 * The menu is rendered with position:fixed anchored to the trigger, so it
 * escapes the modal's overflow clipping.
 */
export function Select({ value, onChange, options, placeholder, className }: SelectProps) {
    const [open, setOpen] = useState(false);
    const [pos, setPos] = useState<{ left: number; top: number; width: number; maxHeight: number } | null>(null);
    const btnRef = useRef<HTMLButtonElement>(null);
    const menuRef = useRef<HTMLDivElement>(null);
    const selected = options.find((o) => o.value === value);

    const reposition = () => {
        const el = btnRef.current;
        if (!el) return;
        const r = el.getBoundingClientRect();
        const maxHeight = Math.max(140, Math.min(320, window.innerHeight - r.bottom - 16));
        // At least as wide as the trigger, but wide enough to read labels,
        // and clamped so it never overflows the viewport edge.
        const width = Math.min(Math.max(r.width, 224), window.innerWidth - 16);
        const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
        setPos({ left, top: r.bottom + 6, width, maxHeight });
    };

    useLayoutEffect(() => {
        if (open) reposition();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [open]);

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => {
            if (btnRef.current?.contains(e.target as Node)) return;
            if (menuRef.current?.contains(e.target as Node)) return;
            setOpen(false);
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
        const onResize = () => setOpen(false);
        const onScroll = (e: Event) => {
            // Don't close when scrolling inside the menu itself — only when an
            // ancestor scrolls (which would leave the fixed menu detached).
            if (menuRef.current && (e.target === menuRef.current || menuRef.current.contains(e.target as Node))) return;
            setOpen(false);
        };
        window.addEventListener("mousedown", onDown);
        window.addEventListener("keydown", onKey);
        window.addEventListener("resize", onResize);
        window.addEventListener("scroll", onScroll, true);
        return () => {
            window.removeEventListener("mousedown", onDown);
            window.removeEventListener("keydown", onKey);
            window.removeEventListener("resize", onResize);
            window.removeEventListener("scroll", onScroll, true);
        };
    }, [open]);

    return (
        <>
            <button
                ref={btnRef}
                type="button"
                onClick={() => setOpen((o) => !o)}
                aria-haspopup="listbox"
                aria-expanded={open}
                className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-ink-900/70 px-3 py-2 text-sm outline-none transition-colors hover:border-white/20 focus:border-brand-500/70 focus-ring",
                    open && "border-brand-500/70",
                    className
                )}
            >
                <span className={cn("truncate", selected ? "text-zinc-100" : "text-zinc-500")}>
                    {selected?.label || placeholder || "Select…"}
                </span>
                <ChevronDown className={cn("h-4 w-4 shrink-0 text-zinc-400 transition-transform", open && "rotate-180")} />
            </button>

            {open && pos && (
                <div
                    ref={menuRef}
                    role="listbox"
                    style={{ position: "fixed", left: pos.left, top: pos.top, width: pos.width, maxHeight: pos.maxHeight }}
                    className="z-[60] overflow-y-auto scrollbar-thin rounded-xl border border-white/10 bg-ink-700 p-1 shadow-panel animate-slide-up"
                >
                    {options.map((opt) => {
                        const active = opt.value === value;
                        return (
                            <button
                                key={opt.value}
                                type="button"
                                role="option"
                                aria-selected={active}
                                onClick={() => { onChange(opt.value); setOpen(false); }}
                                className={cn(
                                    "flex w-full items-start gap-2 rounded-lg px-2.5 py-2 text-left transition-colors",
                                    active ? "bg-brand-500/15" : "hover:bg-white/5"
                                )}
                            >
                                <Check className={cn("mt-0.5 h-3.5 w-3.5 shrink-0", active ? "text-brand-300" : "opacity-0")} />
                                <span className="min-w-0 flex-1">
                                    <span className={cn("block truncate text-sm", active ? "text-brand-200" : "text-zinc-200")}>{opt.label}</span>
                                    {opt.description && (
                                        <span className="mt-0.5 block text-[11px] leading-snug text-zinc-500">{opt.description}</span>
                                    )}
                                </span>
                            </button>
                        );
                    })}
                </div>
            )}
        </>
    );
}
