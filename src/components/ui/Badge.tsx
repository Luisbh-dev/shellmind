import { X } from "lucide-react";
import { cn } from "@/lib/cn";

type Tone = "neutral" | "brand" | "success" | "warning" | "danger" | "info";

const TONES: Record<Tone, string> = {
    neutral: "bg-white/[0.05] text-zinc-300 border-white/10",
    brand: "bg-brand-500/10 text-brand-200 border-brand-500/30",
    success: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
    warning: "bg-amber-500/10 text-amber-300 border-amber-500/30",
    danger: "bg-rose-500/10 text-rose-300 border-rose-500/30",
    info: "bg-sky-500/10 text-sky-300 border-sky-500/30"
};

/** Small status / tag label. With `onRemove` it gets a labelled remove button. */
export function Badge({
    children,
    tone = "neutral",
    className,
    title,
    onRemove,
    removeLabel
}: {
    children: React.ReactNode;
    tone?: Tone;
    className?: string;
    title?: string;
    onRemove?: () => void;
    removeLabel?: string;
}) {
    return (
        <span
            title={title}
            className={cn(
                "inline-flex max-w-full items-center gap-1 rounded-md border px-1.5 py-px text-[11px] font-medium leading-4",
                TONES[tone],
                className
            )}
        >
            <span className="truncate">{children}</span>
            {onRemove && (
                <button
                    type="button"
                    onClick={onRemove}
                    aria-label={removeLabel}
                    title={removeLabel}
                    className="-mr-0.5 rounded p-px text-current opacity-70 hover:opacity-100 hover:bg-white/10 focus-ring"
                >
                    <X className="h-3 w-3" aria-hidden="true" />
                </button>
            )}
        </span>
    );
}

/** A keyboard key or shortcut, e.g. <Kbd>Ctrl+K</Kbd>. */
export function Kbd({ children, className }: { children: React.ReactNode; className?: string }) {
    return (
        <kbd className={cn("rounded border border-white/10 bg-white/[0.04] px-1.5 py-px font-mono text-[10px] font-medium text-zinc-300", className)}>
            {children}
        </kbd>
    );
}
