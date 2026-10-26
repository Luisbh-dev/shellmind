import { Component, useState, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, Copy, RotateCcw } from "lucide-react";
import { cn } from "@/lib/cn";
import { copyText } from "@/lib/clipboard";
import { isChunkLoadError, resetFailedLoads } from "@/lib/lazy";
import { createLogger } from "@/lib/logger";
import { useT } from "@/i18n";
import { Button } from "./Button";

const log = createLogger("ui");

type Scope = "app" | "panel";

interface ErrorBoundaryProps {
    children: ReactNode;
    /** "app": full-window recovery screen; "panel": compact, inside one panel. */
    scope?: Scope;
    /** Name of the panel, shown in the panel fallback. */
    label?: string;
    /** Called when the user asks to try again (before the children remount). */
    onReset?: () => void;
    /** Called once the fallback replaced the children. */
    onError?: (error: Error) => void;
}

interface ErrorBoundaryState {
    error: Error | null;
    // Bumped on reset so the children mount again from scratch.
    generation: number;
}

/**
 * Catches render errors so one broken panel does not blank the whole window
 * (and drop every open session). "Try again" remounts the children.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    state: ErrorBoundaryState = { error: null, generation: 0 };

    static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
        return { error };
    }

    componentDidCatch(error: Error, info: ErrorInfo) {
        log.error(`${this.props.label ?? this.props.scope ?? "app"} crashed:`, error, info.componentStack);
        this.props.onError?.(error);
    }

    // Code that failed to download is fetched again by the remount.
    reset = () => {
        resetFailedLoads();
        this.props.onReset?.();
        this.setState((state) => ({ error: null, generation: state.generation + 1 }));
    };

    render() {
        const { error, generation } = this.state;
        if (error) {
            return <ErrorFallback error={error} scope={this.props.scope ?? "app"} label={this.props.label} onReset={this.reset} />;
        }
        return <Remount key={generation}>{this.props.children}</Remount>;
    }
}

function Remount({ children }: { children: ReactNode }) {
    return <>{children}</>;
}

function ErrorFallback({ error, scope, label, onReset }: { error: Error; scope: Scope; label?: string; onReset: () => void }) {
    const t = useT();
    const [copied, setCopied] = useState(false);
    const details = `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`;

    const copy = async () => {
        try {
            await copyText(details);
            setCopied(true);
        } catch {
            setCopied(false);
        }
    };

    if (scope === "panel") {
        // Its code did not arrive (offline, or the app was updated since this
        // window loaded): "Reload panel" downloads it again.
        const chunk = isChunkLoadError(error);
        return (
            <div role="alert" className="flex h-full w-full items-center justify-center p-6">
                <div className="max-w-sm text-center">
                    <AlertTriangle className="mx-auto mb-3 h-6 w-6 text-amber-400" aria-hidden="true" />
                    <p className="text-sm font-medium text-zinc-200">
                        {label ? t("app.errorBoundary.panelTitle", { panel: label }) : t("app.errorBoundary.panelTitleGeneric")}
                    </p>
                    <p className="mt-1 text-xs text-zinc-400 break-words">{chunk ? t("app.errorBoundary.chunkFailed") : error.message}</p>
                    <div className="mt-4 flex flex-wrap justify-center gap-2">
                        <Button size="sm" variant="secondary" onClick={onReset}>
                            <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("app.errorBoundary.reloadPanel")}
                        </Button>
                        {chunk && (
                            <Button size="sm" variant="ghost" onClick={() => window.location.reload()}>
                                {t("app.errorBoundary.reload")}
                            </Button>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div role="alert" className="flex h-screen w-screen items-center justify-center bg-ink-900 p-6 text-zinc-300">
            <div className="w-full max-w-lg rounded-2xl border border-white/10 bg-ink-800 p-6 shadow-panel">
                <div className="flex items-start gap-3">
                    <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
                    <div className="min-w-0">
                        <h1 className="text-base font-semibold text-zinc-100">{t("app.errorBoundary.title")}</h1>
                        <p className="mt-1 text-sm text-zinc-400">{t("app.errorBoundary.description")}</p>
                    </div>
                </div>
                <pre className={cn("mt-4 max-h-40 overflow-auto scrollbar-thin rounded-lg border border-white/5 bg-ink-900 p-3",
                    "font-mono text-xs text-rose-200 whitespace-pre-wrap break-words")}>
                    {error.message}
                </pre>
                <div className="mt-5 flex flex-wrap justify-end gap-2">
                    <Button size="sm" variant="ghost" onClick={() => void copy()}>
                        <Copy className="h-3.5 w-3.5" aria-hidden="true" /> {copied ? t("app.errorBoundary.copied") : t("app.errorBoundary.copy")}
                    </Button>
                    <Button size="sm" variant="secondary" onClick={() => window.location.reload()}>
                        {t("app.errorBoundary.reload")}
                    </Button>
                    <Button size="sm" variant="primary" onClick={onReset}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" /> {t("app.errorBoundary.retry")}
                    </Button>
                </div>
            </div>
        </div>
    );
}
