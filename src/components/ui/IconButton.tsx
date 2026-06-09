import { forwardRef } from "react";
import { cn } from "@/lib/cn";

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    active?: boolean;
    /** Tooltip text shown via the native title attribute. */
    label?: string;
    size?: "sm" | "md";
}

/** Compact square icon button used across toolbars. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
    ({ className, active, label, size = "md", children, ...props }, ref) => (
        <button
            ref={ref}
            title={label}
            aria-label={label}
            className={cn(
                "inline-flex items-center justify-center rounded-lg border transition-all duration-150 focus-ring",
                size === "sm" ? "h-7 w-7" : "h-8 w-8",
                active
                    ? "bg-brand-500/15 text-brand-300 border-brand-500/40"
                    : "bg-white/[0.03] text-zinc-400 border-white/5 hover:bg-white/[0.08] hover:text-zinc-100",
                "disabled:opacity-40 disabled:pointer-events-none",
                className
            )}
            {...props}
        >
            {children}
        </button>
    )
);
IconButton.displayName = "IconButton";
