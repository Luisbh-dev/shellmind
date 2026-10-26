// Time limits for an upstream AI request: until the response starts
// (connect), between two chunks of a streamed answer (idle), and overall.
export type UpstreamTimeouts = {
    connectMs: number;
    idleMs: number;
    totalMs: number;
};

// Thinking models can be silent for a while before the first token, and long
// answers stream for minutes.
export const DEFAULT_UPSTREAM_TIMEOUTS: UpstreamTimeouts = {
    connectMs: 30_000,
    idleMs: 90_000,
    totalMs: 300_000
};

// A non-streamed answer only starts once it is fully generated.
export const NON_STREAMING_TIMEOUTS: UpstreamTimeouts = {
    ...DEFAULT_UPSTREAM_TIMEOUTS,
    connectMs: 180_000
};

export function defaultTimeouts(streaming: boolean): UpstreamTimeouts {
    return streaming ? DEFAULT_UPSTREAM_TIMEOUTS : NON_STREAMING_TIMEOUTS;
}

export class UpstreamTimeoutError extends Error {
    readonly phase: "connect" | "idle" | "total";

    constructor(phase: "connect" | "idle" | "total", ms: number) {
        const what = phase === "connect" ? "did not respond" : phase === "idle" ? "stopped sending data" : "took too long";
        super(`The AI provider ${what} (timeout after ${Math.round(ms / 1000)} s).`);
        this.name = "UpstreamTimeoutError";
        this.phase = phase;
    }
}

export type UpstreamWatchdog = {
    // Aborted when the caller aborts or a time limit is hit.
    signal: AbortSignal;
    // The response started: the connect limit gives way to the idle limit.
    connected(): void;
    // Data arrived: restarts the idle limit.
    activity(): void;
    // The limit that fired, if any.
    timeoutError(): UpstreamTimeoutError | null;
    dispose(): void;
};

export function createUpstreamWatchdog(parent: AbortSignal | undefined, timeouts: UpstreamTimeouts = DEFAULT_UPSTREAM_TIMEOUTS): UpstreamWatchdog {
    const controller = new AbortController();
    let fired: UpstreamTimeoutError | null = null;
    let phaseTimer: ReturnType<typeof setTimeout> | null = null;
    let phase: "connect" | "idle" = "connect";

    const fire = (error: UpstreamTimeoutError) => {
        if (controller.signal.aborted) return;
        fired = error;
        controller.abort(error);
    };

    const armPhase = () => {
        if (phaseTimer) clearTimeout(phaseTimer);
        const ms = phase === "connect" ? timeouts.connectMs : timeouts.idleMs;
        phaseTimer = setTimeout(() => fire(new UpstreamTimeoutError(phase, ms)), ms);
    };

    const totalTimer = setTimeout(() => fire(new UpstreamTimeoutError("total", timeouts.totalMs)), timeouts.totalMs);
    armPhase();

    const onParentAbort = () => {
        if (!controller.signal.aborted) controller.abort(parent?.reason);
    };
    if (parent?.aborted) onParentAbort();
    else parent?.addEventListener("abort", onParentAbort, { once: true });

    const dispose = () => {
        if (phaseTimer) clearTimeout(phaseTimer);
        phaseTimer = null;
        clearTimeout(totalTimer);
        parent?.removeEventListener("abort", onParentAbort);
    };
    controller.signal.addEventListener("abort", dispose, { once: true });

    return {
        signal: controller.signal,
        connected() {
            if (controller.signal.aborted) return;
            phase = "idle";
            armPhase();
        },
        activity() {
            if (controller.signal.aborted || phase !== "idle") return;
            armPhase();
        },
        timeoutError: () => fired,
        dispose
    };
}
