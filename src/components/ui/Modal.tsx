import { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";

interface ModalProps {
    open: boolean;
    onClose: () => void;
    title?: React.ReactNode;
    icon?: React.ReactNode;
    description?: React.ReactNode;
    children: React.ReactNode;
    footer?: React.ReactNode;
    /** Tailwind width class, e.g. "max-w-md" */
    widthClass?: string;
    /** Disable closing on backdrop click / Esc (e.g. while a request is in flight) */
    dismissible?: boolean;
    className?: string;
}

export function Modal({
    open,
    onClose,
    title,
    icon,
    description,
    children,
    footer,
    widthClass = "max-w-md",
    dismissible = true,
    className
}: ModalProps) {
    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === "Escape" && dismissible) onClose();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [open, dismissible, onClose]);

    if (!open) return null;

    return (
        <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm animate-fade-in p-4"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && dismissible) onClose();
            }}
        >
            <div
                className={cn(
                    "w-full overflow-hidden rounded-2xl border border-white/10 bg-ink-800 shadow-panel animate-scale-in",
                    widthClass,
                    className
                )}
            >
                {(title || icon) && (
                    <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-white/5">
                        <div className="flex items-center gap-2.5 min-w-0">
                            {icon && <span className="text-brand-400 shrink-0">{icon}</span>}
                            <div className="min-w-0">
                                <div className="text-sm font-semibold text-zinc-100 truncate">{title}</div>
                                {description && (
                                    <div className="text-xs text-zinc-400 mt-0.5">{description}</div>
                                )}
                            </div>
                        </div>
                        <button
                            onClick={() => { if (dismissible) onClose(); }}
                            disabled={!dismissible}
                            className="shrink-0 -mr-1 rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors focus-ring disabled:opacity-30 disabled:pointer-events-none"
                            aria-label="Close"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                )}

                <div className="px-5 py-4">{children}</div>

                {footer && (
                    <div className="flex justify-end gap-2 px-5 py-4 border-t border-white/5 bg-white/[0.02]">
                        {footer}
                    </div>
                )}
            </div>
        </div>
    );
}
