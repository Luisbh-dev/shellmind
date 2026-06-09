import { cn } from "@/lib/cn";

export type ConnState = "idle" | "connecting" | "connected" | "disconnected" | "error";

const STYLE: Record<ConnState, { dot: string; ring: string; label: string }> = {
    idle: { dot: "bg-zinc-500", ring: "", label: "Idle" },
    connecting: { dot: "bg-amber-400 animate-pulse", ring: "shadow-[0_0_0_3px_rgba(251,191,36,0.18)]", label: "Connecting" },
    connected: { dot: "bg-emerald-400", ring: "shadow-[0_0_0_3px_rgba(52,211,153,0.18)]", label: "Connected" },
    disconnected: { dot: "bg-zinc-500", ring: "", label: "Disconnected" },
    error: { dot: "bg-rose-500", ring: "shadow-[0_0_0_3px_rgba(244,63,94,0.18)]", label: "Error" }
};

export function StatusDot({ state, className }: { state: ConnState; className?: string }) {
    const s = STYLE[state];
    return <span className={cn("inline-block w-2 h-2 rounded-full shrink-0", s.dot, s.ring, className)} />;
}

export function statusLabel(state: ConnState) {
    return STYLE[state].label;
}
