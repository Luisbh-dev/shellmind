import type { PodLogSource } from "../../shared/k8s";
import { createLogger } from "../logger";
import type { StreamFlow } from "../ssh/exec";
import { kubectlFailure, kubectlMessage } from "./errors";
import { openKubectl, requireKnownContext } from "./session";

const log = createLogger("k8s");
import { DEFAULT_LOG_TAIL } from "./validate";

// A pod container's logs for the live log view (server/sockets/logs.ts
// batches them like the other log sources): `kubectl logs`, followed or not,
// of the current or the previous instance of the container.

// A backlog without -f: the API server sends it at once.
const BACKLOG_REQUEST_TIMEOUT = "--request-timeout=60s";

export function podLogArgs(source: PodLogSource): string[] {
    const follow = source.follow !== false && !source.previous;
    return [
        "--context", source.context,
        ...(follow ? [] : [BACKLOG_REQUEST_TIMEOUT]),
        "-n", source.namespace,
        "logs", source.pod,
        "-c", source.container,
        `--tail=${source.tail ?? DEFAULT_LOG_TAIL}`,
        ...(source.previous ? ["--previous"] : []),
        ...(follow ? ["-f"] : []),
        ...(source.timestamps === false ? [] : ["--timestamps"])
    ];
}

export type PodLogIo = {
    signal: AbortSignal;
    push: (text: string) => void;
    attach: (flow: StreamFlow) => void;
    // kubectl started: the client may show the stream as live.
    onStarted: () => void;
    // The SSH connection it ran on dropped.
    onConnectionLost: () => void;
};

// What is kept of kubectl's own messages (its stderr) for the error.
const MAX_STDERR_CHARS = 8000;

// Resolves with kubectl's exit status once the logs end (or the signal
// stops them, which rejects). kubectl's messages stay out of the log lines:
// when it fails (a container that has not started, an expired sign-in...)
// it rejects with them as a coded error (./errors), which the log view
// shows as an error, not as a line of the container's output.
export async function streamPodLogs(serverId: unknown, source: PodLogSource, io: PodLogIo): Promise<number | null> {
    const session = await openKubectl(serverId, { signal: io.signal });
    try {
        requireKnownContext(session.status, source.context);
        session.lease?.onClose(() => io.onConnectionLost());
        io.onStarted();
        let stderr = "";
        const onStderr = (text: string) => {
            if (stderr.length < MAX_STDERR_CHARS) stderr = (stderr + text).slice(0, MAX_STDERR_CHARS);
        };
        const { code } = await session.runner.stream(podLogArgs(source), { signal: io.signal, onData: io.push, onStderr, onFlow: io.attach });
        if (code !== 0 && code !== null && !io.signal.aborted) throw kubectlFailure({ stdout: "", stderr, code }, "kubectl logs failed");
        if (stderr.trim()) log.debug(`kubectl logs of ${source.namespace}/${source.pod} said: ${kubectlMessage({ stdout: "", stderr }).slice(0, 300)}`);
        return code;
    } finally {
        session.release();
    }
}
