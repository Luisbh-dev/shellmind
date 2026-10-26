import { cn } from "@/lib/cn";
import { t } from "@/i18n";

export type ConnState = "idle" | "connecting" | "connected" | "disconnected" | "error";

const STYLE: Record<ConnState, { dot: string; ring: string }> = {
    idle: { dot: "bg-zinc-500", ring: "" },
    connecting: { dot: "bg-amber-400 animate-pulse", ring: "shadow-[0_0_0_3px_rgb(var(--c-amber-400)/0.18)]" },
    connected: { dot: "bg-emerald-400", ring: "shadow-[0_0_0_3px_rgb(var(--c-emerald-400)/0.18)]" },
    disconnected: { dot: "bg-zinc-500", ring: "" },
    error: { dot: "bg-rose-500", ring: "shadow-[0_0_0_3px_rgb(var(--c-rose-500)/0.18)]" }
};

/** Connection state dot. With `label` it is announced (and has a tooltip); otherwise it is decorative. */
export function StatusDot({ state, className, label }: { state: ConnState; className?: string; label?: string }) {
    const s = STYLE[state];
    return (
        <span
            role={label ? "img" : undefined}
            aria-label={label}
            aria-hidden={label ? undefined : true}
            title={label}
            className={cn("inline-block w-2 h-2 rounded-full shrink-0", s.dot, s.ring, className)}
        />
    );
}

// Translated in the current language (callers re-render on language change).
export function statusLabel(state: ConnState) {
    return t(`common.status.${state}`);
}
