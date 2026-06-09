import { forwardRef } from "react";
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
        "bg-brand-500 text-ink-900 font-semibold hover:bg-brand-400 active:bg-brand-600 shadow-soft",
    secondary:
        "bg-ink-650 text-zinc-100 border border-zinc-700/70 hover:bg-ink-600 hover:border-zinc-600",
    ghost:
        "text-zinc-400 hover:text-zinc-100 hover:bg-white/5",
    subtle:
        "bg-white/[0.04] text-zinc-300 border border-white/5 hover:bg-white/[0.08] hover:text-zinc-100",
    danger:
        "bg-rose-600 text-white font-semibold hover:bg-rose-500 active:bg-rose-700"
};

const sizes: Record<Size, string> = {
    sm: "h-8 px-3 text-xs gap-1.5 rounded-lg",
    md: "h-9 px-4 text-sm gap-2 rounded-lg",
    icon: "h-9 w-9 rounded-lg",
    "icon-sm": "h-8 w-8 rounded-lg"
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
    ({ className, variant = "secondary", size = "md", loading, disabled, children, ...props }, ref) => {
        return (
            <button
                ref={ref}
                disabled={disabled || loading}
                className={cn(
                    "inline-flex items-center justify-center font-medium transition-all duration-150 focus-ring",
                    "disabled:opacity-50 disabled:pointer-events-none select-none",
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
