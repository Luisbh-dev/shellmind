import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { cn } from "@/lib/cn";
import { Spinner } from "./Spinner";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "subtle";
type Size = "sm" | "md" | "icon" | "icon-sm";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: Size;
    loading?: boolean;
}

const variants: Record<Variant, string> = {
    primary:
        "bg-brand-500 text-on-brand font-semibold hover:bg-brand-400 active:bg-brand-600 shadow-soft",
    secondary:
        "bg-ink-650 text-zinc-100 border border-zinc-700/70 hover:bg-ink-600 hover:border-zinc-600",
    ghost:
        "text-zinc-400 hover:text-zinc-100 hover:bg-white/5",
    subtle:
        "bg-white/[0.04] text-zinc-300 border border-white/5 hover:bg-white/[0.08] hover:text-zinc-100",
    danger:
        "bg-rose-600 text-fixed-white font-semibold hover:bg-rose-700 active:bg-rose-800"
};

const sizes: Record<Size, string> = {
    sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
    md: "h-9 px-4 text-sm gap-2 rounded-lg",
    icon: "h-9 w-9 rounded-lg",
    "icon-sm": "h-8 w-8 rounded-lg"
};

// While `loading` the button keeps keyboard focus: a disabled element loses
// it (focus would fall to <body> mid-save and the user's place with it), so it
// is only marked busy, and clicks, and submits of its form, are ignored
// until the work is done.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "secondary", size = "md", loading, disabled, children, onClick, ...props }, ref) => {
        const innerRef = useRef<HTMLButtonElement>(null);
        useImperativeHandle(ref, () => innerRef.current as HTMLButtonElement);
        const busy = Boolean(loading) && !disabled;

        // Enter in a field submits the form even while its submit button is
        // busy (only a disabled default button stops that): drop those
        // submits before they reach the form's handler.
        useEffect(() => {
            const form = innerRef.current?.form;
            if (!busy || !form || innerRef.current?.type !== "submit") return undefined;
            const block = (event: Event) => {
                event.preventDefault();
                event.stopImmediatePropagation();
            };
            form.addEventListener("submit", block);
            return () => form.removeEventListener("submit", block);
        }, [busy]);

        return (
            <button
                ref={innerRef}
                disabled={disabled}
                aria-disabled={busy || undefined}
                aria-busy={busy || undefined}
                data-loading={busy ? "true" : undefined}
                onClick={(event) => {
                    if (busy) {
                        event.preventDefault();
                        return;
                    }
                    onClick?.(event);
                }}
                className={cn(
                    "inline-flex items-center justify-center font-medium transition-all duration-150 focus-ring",
                    "disabled:opacity-50 disabled:pointer-events-none select-none",
                    "data-[loading=true]:cursor-progress data-[loading=true]:opacity-70",
                    variants[variant],
                    sizes[size],
                    className
                )}
                {...props}
            >
                {loading && <Spinner className="w-4 h-4" />}
                {children}
            </button>
        );
    }
);
Button.displayName = "Button";
