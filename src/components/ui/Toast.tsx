import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { CheckCircle2, AlertTriangle, Info, X, XCircle } from "lucide-react";
import { cn } from "@/lib/cn";

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
    success: <CheckCircle2 className="w-4 h-4 text-emerald-400" />,
    error: <XCircle className="w-4 h-4 text-rose-400" />,
    warning: <AlertTriangle className="w-4 h-4 text-amber-400" />,
    info: <Info className="w-4 h-4 text-brand-400" />
};

const ACCENT: Record<ToastKind, string> = {
    success: "border-l-emerald-500",
    error: "border-l-rose-500",
    warning: "border-l-amber-500",
    info: "border-l-brand-500"
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
    const [toasts, setToasts] = useState<ToastItem[]>([]);
    const counter = useRef(0);

    const dismiss = useCallback((id: string) => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
    }, []);

    const show = useCallback((kind: ToastKind, title: string, description?: string) => {
        counter.current += 1;
        const id = `toast-${Date.now()}-${counter.current}`;
        setToasts((prev) => [...prev.slice(-3), { id, kind, title, description }]);
        window.setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3800);
    }, [dismiss]);

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
            <div className="fixed bottom-4 right-4 z-[100] flex flex-col gap-2 w-[340px] max-w-[calc(100vw-2rem)]">
                {toasts.map((t) => (
                    <div
                        key={t.id}
                        className={cn(
                            "group flex items-start gap-3 rounded-xl border border-white/10 border-l-2 bg-ink-700/95 backdrop-blur px-3.5 py-3 shadow-panel animate-slide-in-right",
                            ACCENT[t.kind]
                        )}
                    >
                        <span className="mt-0.5 shrink-0">{ICONS[t.kind]}</span>
                        <div className="min-w-0 flex-1">
                            <div className="text-sm font-medium text-zinc-100 leading-tight">{t.title}</div>
                            {t.description && (
                                <div className="mt-0.5 text-xs text-zinc-400 break-words">{t.description}</div>
                            )}
                        </div>
                        <button
                            onClick={() => dismiss(t.id)}
                            className="shrink-0 rounded-md p-1 text-zinc-400 opacity-0 group-hover:opacity-100 hover:text-zinc-200 hover:bg-white/5 transition"
                            aria-label="Dismiss"
                        >
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                ))}
            </div>
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
