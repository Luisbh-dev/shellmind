import { cn } from "@/lib/cn";

/** What a list or panel shows when it has nothing yet: an icon, a line or two and what to do next. */
export function EmptyState({
    icon,
    title,
    description,
    actions,
    className,
    size = "md"
}: {
    icon?: React.ReactNode;
    title: React.ReactNode;
    description?: React.ReactNode;
    actions?: React.ReactNode;
    className?: string;
    /** "sm" for narrow panels (the sidebar). */
    size?: "sm" | "md";
}) {
    return (
        <div className={cn("flex flex-col items-center text-center animate-fade-in", size === "sm" ? "px-3 py-8" : "px-6 py-12", className)}>
            {icon && (
                <div
                    className={cn(
                        "mb-3 flex items-center justify-center rounded-2xl border border-white/5 bg-white/[0.03] text-zinc-400",
                        size === "sm" ? "h-10 w-10" : "h-12 w-12"
                    )}
                    aria-hidden="true"
                >
                    {icon}
                </div>
            )}
            <p className={cn("font-medium text-zinc-200", size === "sm" ? "text-xs" : "text-sm")}>{title}</p>
            {description && <p className="mt-1 max-w-xs text-xs text-zinc-400">{description}</p>}
            {actions && <div className="mt-4 flex flex-wrap items-center justify-center gap-2">{actions}</div>}
        </div>
    );
}
