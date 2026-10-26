import { Component, Suspense, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { isChunkLoadError, resetFailedLoads } from "@/lib/lazy";
import { createLogger } from "@/lib/logger";
import { useT } from "@/i18n";
import { Button } from "./Button";
import { Modal } from "./Modal";

const log = createLogger("ui");

// Placeholders shown while a lazily loaded panel or dialog downloads its code
// (React.lazy + Suspense). They take no focus, so the dialog that replaces
// them still returns focus to whatever opened it.

/** A placeholder block (decorative: the container says it is busy). */
export function Skeleton({ className }: { className?: string }) {
    return <div className={cn("skeleton shimmer", className)} aria-hidden="true" />;
}

const ROW_WIDTHS = ["w-2/3", "w-1/2", "w-3/4", "w-2/5", "w-3/5", "w-1/3"];

/** A workspace panel or the chat while its code loads: a toolbar and a few rows. */
export function PanelSkeleton({ variant = "panel" }: { variant?: "panel" | "chat" }) {
    const t = useT();
    return (
        <div role="status" aria-label={t("common.loading")} className="flex h-full w-full flex-col gap-4 p-4 animate-fade-in">
            {variant === "chat" ? (
                <>
                    <Skeleton className="h-8 w-full" />
                    <div className="flex flex-1 flex-col gap-3">
                        <Skeleton className="h-14 w-4/5" />
                        <Skeleton className="ml-auto h-10 w-3/5" />
                        <Skeleton className="h-20 w-11/12" />
                    </div>
                    <Skeleton className="h-20 w-full" />
                </>
            ) : (
                <>
                    <div className="flex items-center gap-2">
                        <Skeleton className="h-8 w-48" />
                        <Skeleton className="h-8 flex-1" />
                        <Skeleton className="h-8 w-8" />
                        <Skeleton className="h-8 w-8" />
                    </div>
                    <div className="flex flex-col gap-2.5">
                        {ROW_WIDTHS.map((width, index) => (
                            <div key={index} className="flex items-center gap-3">
                                <Skeleton className="h-4 w-4 shrink-0" />
                                <Skeleton className={cn("h-4", width)} />
                            </div>
                        ))}
                    </div>
                </>
            )}
        </div>
    );
}

/** A dialog while its code loads: the backdrop and an empty card. */
export function DialogSkeleton() {
    const t = useT();
    return createPortal(
        <div role="presentation" className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/70 p-4 backdrop-blur-sm animate-fade-in">
            <div
                role="status"
                aria-label={t("common.loading")}
                className="flex w-full max-w-lg flex-col gap-4 rounded-2xl border border-white/10 bg-ink-800 p-5 shadow-panel"
            >
                <Skeleton className="h-5 w-1/3" />
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-4 w-4/5" />
                <Skeleton className="h-4 w-3/5" />
                <div className="flex justify-end gap-2 pt-2">
                    <Skeleton className="h-8 w-20" />
                    <Skeleton className="h-8 w-24" />
                </div>
            </div>
        </div>,
        document.body
    );
}

function DialogLoadError({ error, onClose, onRetry }: { error: Error; onClose: () => void; onRetry: () => void }) {
    const t = useT();
    return (
        <Modal
            open
            onClose={onClose}
            title={t("common.loadFailed")}
            icon={<AlertTriangle className="h-4 w-4 text-amber-400" />}
            footer={(
                <>
                    <Button variant="ghost" onClick={onClose}>{t("common.close")}</Button>
                    <Button variant="secondary" onClick={onRetry}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("common.retry")}
                    </Button>
                </>
            )}
        >
            <p className="text-xs text-zinc-400 break-words">{isChunkLoadError(error) ? t("app.errorBoundary.chunkFailed") : error.message}</p>
        </Modal>
    );
}

interface LazyDialogProps {
    children: ReactNode;
    onClose: () => void;
}

/**
 * Suspense boundary of a lazily loaded dialog, rendered only while the dialog
 * is open. When its code cannot be loaded (an interrupted download), the
 * failure shows in a dialog that closes it instead of taking the whole window
 * down; "Try again", or opening the dialog again, downloads it anew (see
 * src/lib/lazy.tsx).
 */
export class LazyDialog extends Component<LazyDialogProps, { error: Error | null }> {
    state: { error: Error | null } = { error: null };

    static getDerivedStateFromError(error: Error) {
        return { error };
    }

    componentDidCatch(error: Error) {
        log.error("dialog failed to load:", error);
    }

    componentWillUnmount() {
        if (this.state.error) resetFailedLoads();
    }

    retry = () => {
        resetFailedLoads();
        this.setState({ error: null });
    };

    render() {
        if (this.state.error) return <DialogLoadError error={this.state.error} onClose={this.props.onClose} onRetry={this.retry} />;
        return <Suspense fallback={<DialogSkeleton />}>{this.props.children}</Suspense>;
    }
}
