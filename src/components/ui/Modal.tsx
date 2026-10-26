import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { holdAppInert } from "./appInert";
import { focusableElements, restoreFocus, trapTab } from "./focus";
import { useOverlay } from "./overlayStack";

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
    /** Extra classes of the scrollable body (padding, spacing). */
    bodyClassName?: string;
    /** "alertdialog" for confirmations that interrupt the user. */
    role?: "dialog" | "alertdialog";
    /** Accessible name when there is no visible title. */
    ariaLabel?: string;
    /** Id of the element that describes the dialog (default: `description`). */
    ariaDescribedBy?: string;
    /** "top" places the dialog near the top (command palette). */
    align?: "center" | "top";
    /** Escape on the dialog: true when the dialog handled it itself (closed a pane of its own) and stays open. */
    onEscape?: () => boolean;
}

/**
 * Accessible dialog: role="dialog" + aria-modal, labelled by its title, focus
 * moved inside on open (an element with `data-autofocus`, else the first
 * field or button of the body), Tab kept inside, focus restored to the opener
 * on close. Escape and backdrop clicks close only the topmost overlay.
 */
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
    className,
    bodyClassName,
    role = "dialog",
    ariaLabel,
    ariaDescribedBy,
    align = "center",
    onEscape
}: ModalProps) {
    const t = useT();
    const titleId = useId();
    const descriptionId = useId();
    const panelRef = useRef<HTMLDivElement>(null);
    const bodyRef = useRef<HTMLDivElement>(null);
    const isTop = useOverlay(open, () => {
        if (onEscape?.()) return;
        if (dismissible) onClose();
    });

    useEffect(() => {
        if (!open) return;
        const opener = document.activeElement;
        // While it is open the app behind it is inert (see appInert.ts).
        const releaseApp = holdAppInert();
        const panel = panelRef.current;
        // Fields with autoFocus already took focus while mounting.
        if (panel && !panel.contains(document.activeElement)) {
            const preferred = panel.querySelector<HTMLElement>("[data-autofocus]");
            const target = preferred ?? (bodyRef.current && focusableElements(bodyRef.current)[0]) ?? focusableElements(panel)[0] ?? panel;
            target.focus({ preventScroll: true });
        }
        return () => {
            releaseApp();
            restoreFocus(opener);
        };
    }, [open]);

    if (!open) return null;

    return createPortal(
        <div
            role="presentation"
            className={cn(
                "fixed inset-0 z-50 flex justify-center bg-scrim/70 backdrop-blur-sm animate-fade-in p-4",
                align === "top" ? "items-start pt-[12vh]" : "items-center"
            )}
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && dismissible && isTop()) onClose();
            }}
        >
            <div
                ref={panelRef}
                role={role}
                aria-modal="true"
                aria-labelledby={title ? titleId : undefined}
                aria-label={title ? undefined : ariaLabel}
                aria-describedby={ariaDescribedBy ?? (description ? descriptionId : undefined)}
                tabIndex={-1}
                onKeyDown={(e) => {
                    if (panelRef.current && isTop()) trapTab(e, panelRef.current);
                }}
                className={cn(
                    "flex max-h-[calc(100vh-2rem)] w-full flex-col overflow-hidden rounded-2xl border border-white/10 bg-ink-800 shadow-panel outline-none animate-scale-in",
                    widthClass,
                    className
                )}
            >
                {(title || icon) && (
                    <div className="flex shrink-0 items-start justify-between gap-3 px-5 py-4 border-b border-white/5">
                        <div className="flex items-start gap-2.5 min-w-0">
                            {icon && <span className="mt-0.5 text-brand-400 shrink-0" aria-hidden="true">{icon}</span>}
                            <div className="min-w-0">
                                <h2 id={titleId} className="text-sm font-semibold text-zinc-100 break-words">{title}</h2>
                                {description && (
                                    <div id={descriptionId} className="text-xs text-zinc-400 mt-0.5 break-words">{description}</div>
                                )}
                            </div>
                        </div>
                        <button
                            type="button"
                            onClick={() => { if (dismissible) onClose(); }}
                            disabled={!dismissible}
                            className="shrink-0 -mr-1 rounded-lg p-1.5 text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors focus-ring disabled:opacity-30 disabled:pointer-events-none"
                            aria-label={t("common.close")}
                        >
                            <X className="w-4 h-4" aria-hidden="true" />
                        </button>
                    </div>
                )}

                <div ref={bodyRef} className={cn("min-h-0 flex-1 overflow-y-auto scrollbar-thin px-5 py-4", bodyClassName)}>
                    {children}
                </div>

                {footer && (
                    <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 px-5 py-4 border-t border-white/5 bg-white/[0.02]">
                        {footer}
                    </div>
                )}
            </div>
        </div>,
        document.body
    );
}
