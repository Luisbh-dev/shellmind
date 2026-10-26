import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/i18n";
import { isAppInert, subscribeAppInert } from "./appInert";

type ToastKind = "success" | "error" | "info" | "warning";

interface ToastItem {
    id: string;
    kind: ToastKind;
    title: string;
    description?: string;
}

interface ToastApi {
    show: (kind: ToastKind, title: string, description?: string) => void;
    success: (title: string, description?: string) => void;
    error: (title: string, description?: string) => void;
    info: (title: string, description?: string) => void;
    warning: (title: string, description?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastKind, React.ReactNode> = {
    success: <CheckCircle2 className="w-4 h-4 text-emerald-400" aria-hidden="true" />,
    error: <XCircle className="w-4 h-4 text-rose-400" aria-hidden="true" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-400" aria-hidden="true" />,
    info: <Info className="w-4 h-4 text-brand-400" aria-hidden="true" />
};

const ACCENT: Record<ToastKind, string> = {
    success: "border-l-emerald-500",
    error: "border-l-rose-500",
    warning: "border-l-amber-500",
    info: "border-l-brand-500"
};

// Errors stay long enough to read a full SSH/S3 message; any toast stays
// while the pointer or focus is on it.
export const TOAST_DURATION_MS: Record<ToastKind, number> = {
    success: 4000,
    info: 4000,
    warning: 7000,
    error: 10000
};

const MAX_TOASTS = 4;

function Toast({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
    const t = useT();
    const [paused, setPaused] = useState(false);
    const remaining = useRef(TOAST_DURATION_MS[toast.kind]);

    useEffect(() => {
        if (paused) return;
        const startedAt = Date.now();
        const timer = window.setTimeout(() => onDismiss(toast.id), remaining.current);
        return () => {
            window.clearTimeout(timer);
            remaining.current = Math.max(1000, remaining.current - (Date.now() - startedAt));
        };
    }, [paused, toast.id, onDismiss]);

    return (
        <li
            role={toast.kind === "error" ? "alert" : "status"}
            onMouseEnter={() => setPaused(true)}
            onMouseLeave={() => setPaused(false)}
            onFocus={() => setPaused(true)}
            onBlur={() => setPaused(false)}
            className={cn(
                "pointer-events-auto flex items-start gap-3 rounded-xl border border-white/10 border-l-2 bg-ink-700/95 backdrop-blur px-3.5 py-3 shadow-panel animate-slide-in-right",
                ACCENT[toast.kind]
            )}
        >
            <span className="mt-0.5 shrink-0">{ICONS[toast.kind]}</span>
            <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-zinc-100 leading-tight break-words">{toast.title}</div>
                {toast.description && (
                    <div className="mt-0.5 text-xs text-zinc-300 break-words">{toast.description}</div>
                )}
            </div>
            <button
                type="button"
                onClick={() => onDismiss(toast.id)}
                className="shrink-0 rounded-md p-1 text-zinc-400 opacity-70 hover:opacity-100 focus-visible:opacity-100 hover:text-zinc-200 hover:bg-white/5 transition focus-ring"
                aria-label={t("common.dismiss")}
            >
                <X className="w-4 h-4" aria-hidden="true" />
            </button>
        </li>
    );
}

/**
 * Notifications, announced to screen readers (errors assertively) and placed
 * top-right below the title bar. The app shell moves them left of the chat
 * panel through the --shellmind-toast-right CSS variable. While a dialog is
 * up they go to the bottom-right corner, off the header of the dialog (its
 * filters, its title) that they would otherwise cover.
 */
export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const counter = useRef(0);
    const t = useT();
    const dialogOpen = useSyncExternalStore(subscribeAppInert, isAppInert, () => false);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, []);

    const show = useCallback((kind: ToastKind, title: string, description?: string) => {
        counter.current += 1;
        const id = `toast-${Date.now()}-${counter.current}`;
        setToasts((prev) => [...prev.slice(-(MAX_TOASTS - 1)), { id, kind, title, description }]);
    }, []);

    const api = useMemo<ToastApi>(() => ({
        show,
        success: (title, description) => show("success", title, description),
        error: (title, description) => show("error", title, description),
        info: (title, description) => show("info", title, description),
        warning: (title, description) => show("warning", title, description)
    }), [show]);

    return (
        <ToastContext.Provider value={api}>
            {children}
            {createPortal(
                <section
                    aria-label={t("app.ui.notifications")}
                    className="pointer-events-none fixed z-[100] w-[340px] max-w-[calc(100vw-2rem)]"
                    style={dialogOpen ? { bottom: "1rem", right: "1rem" } : { top: "var(--shellmind-toast-top, 3.25rem)", right: "var(--shellmind-toast-right, 1rem)" }}
                >
                    <ol aria-live="polite" className="flex flex-col gap-2">
                        {toasts.map((toast) => (
                            <Toast key={toast.id} toast={toast} onDismiss={dismiss} />
                        ))}
                    </ol>
                </section>,
                document.body
            )}
        </ToastContext.Provider>
    );
}

export function useToast(): ToastApi {
    const ctx = useContext(ToastContext);
    if (!ctx) {
        // Fail soft so a missing provider never crashes the app.
        return {
            show: () => undefined,
            success: () => undefined,
            error: () => undefined,
            info: () => undefined,
            warning: () => undefined
        };
    }
    return ctx;
}
