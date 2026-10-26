import { forwardRef, useId } from "react";
import { cn } from "@/lib/cn";

interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
    /** Toggle state; also exposed as aria-pressed. */
    active?: boolean;
    /** Accessible name and tooltip (icon-only buttons have no other text). */
    label: string;
    /** Tooltip when it should say more than the name (e.g. the shortcut). */
    tooltip?: string;
    /**
     * Unavailable, and why (e.g. "The AI assistant is not available for S3").
     * Unlike `disabled`, the button stays focusable and hoverable, so the
     * reason shows as its tooltip and is read as its description.
     */
    disabledReason?: string;
    size?: "sm" | "md";
    /** "ghost" has no border or background at rest (toolbars, headers). */
    variant?: "default" | "ghost";
}

/** Compact square icon button used across toolbars. */
export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(
    ({ className, active, label, tooltip, disabledReason, size = "md", variant = "default", type = "button", onClick, children, ...props }, ref) => {
        const unavailable = disabledReason !== undefined;
        const reasonId = useId();
        return (
            <button
                ref={ref}
                type={type}
                title={disabledReason ?? tooltip ?? label}
                aria-label={label}
                aria-pressed={active}
                aria-disabled={unavailable || undefined}
                aria-describedby={unavailable ? reasonId : undefined}
                onClick={(event) => {
                    if (unavailable) {
                        event.preventDefault();
                        return;
                    }
                    onClick?.(event);
                }}
                className={cn(
                    "inline-flex shrink-0 items-center justify-center rounded-lg transition-all duration-150 focus-ring",
                    size === "sm" ? "h-7 w-7" : "h-8 w-8",
                    variant === "default" && "border",
                    active
                        ? "bg-brand-500/15 text-brand-300 border-brand-500/40"
                        : variant === "default"
                            ? "bg-white/[0.03] text-zinc-400 border-white/5 hover:bg-white/[0.08] hover:text-zinc-100"
                            : "text-zinc-400 hover:bg-white/[0.06] hover:text-zinc-100",
                    "disabled:opacity-40 disabled:pointer-events-none",
                    unavailable && "cursor-not-allowed opacity-40 hover:bg-transparent hover:text-zinc-400",
                    className
                )}
                {...props}
            >
                {children}
                {unavailable && <span id={reasonId} hidden>{disabledReason}</span>}
            </button>
        );
    }
);
IconButton.displayName = "IconButton";
