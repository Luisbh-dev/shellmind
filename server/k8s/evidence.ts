import type { ChatAttachment, ChatEvidenceAccess, ChatEvidenceSection } from "../../shared/chat";
import { MAX_USER_CHARS } from "../../shared/chatEvidence";
import { pickPodContainer, type K8sContainerDetail, type K8sContainerState, type K8sEvent } from "../../shared/k8s";
import { EVIDENCE_LOG_LINES, EVIDENCE_OUTPUT_MAX_BYTES } from "../ai/diagnose/context";
import { attempt, logSection, textSection } from "../ai/diagnose/sections";
import { redactArgv } from "../ai/redact";
import { AppError } from "../errors";
import { extractJson, isRecord } from "../ops/remote";
import { kubectlFailure } from "./errors";
import { mapPodDetail } from "./parse";
import { contextArgs, podEventArgs, READ_TIMEOUT_MS } from "./service";
import { openKubectl, requireKnownContext } from "./session";
import { decodeTemplateJson } from "./templates";

// W8-T2: the evidence of a pod diagnosis ("Ask AI" on a pod), read with
// kubectl like the tab's own views: a describe-like summary of the pod built
// from its JSON, its events, and the last log lines of the container in
// trouble (and of its previous instance when it restarted). Environment
// values are left out entirely (only the names and where references point),
// command lines have their credential options masked, and every part is
// redacted and capped (server/ai/diagnose/sections.ts).

export type PodAttachment = Extract<ChatAttachment, { kind: "pod" }>;

const SUMMARY_CHARS = 6000;
const EVENTS_CHARS = 4000;
const LOGS_CHARS = 12_000;
const PREVIOUS_LOGS_CHARS = 8000;
const PREVIOUS_LOG_LINES = 100;
const MAX_EVENTS = 30;

function state(label: string, value: K8sContainerState | null): string | null {
    if (!value) return null;
    const parts = [value.state, value.reason ? `(${value.reason})` : null, value.exitCode !== null ? `exit code ${value.exitCode}` : null, value.signal ? `signal ${value.signal}` : null]
        .filter(Boolean).join(" ");
    const times = [value.startedAt && `started ${value.startedAt}`, value.finishedAt && `finished ${value.finishedAt}`].filter(Boolean).join(", ");
    const message = value.message ? `: ${value.message.replace(/\s+/g, " ").slice(0, 400)}` : "";
    return `  ${label}: ${parts}${times ? `, ${times}` : ""}${message}`;
}

const pairs = (values: Record<string, string>) => Object.entries(values).map(([key, value]) => `${key}=${value}`).join(" ");

function probe(value: unknown): string | null {
    if (!isRecord(value)) return null;
    const http = isRecord(value.httpGet) ? `http-get ${String(value.httpGet.scheme ?? "HTTP").toLowerCase()}://:${String(value.httpGet.port ?? "")}${String(value.httpGet.path ?? "")}` : null;
    const tcp = isRecord(value.tcpSocket) ? `tcp-socket :${String(value.tcpSocket.port ?? "")}` : null;
    const exec = isRecord(value.exec) && Array.isArray(value.exec.command) ? `exec ${redactArgv(value.exec.command.map(String)).join(" ")}` : null;
    const grpc = isRecord(value.grpc) ? `grpc :${String(value.grpc.port ?? "")}` : null;
    const timing = ["initialDelaySeconds", "periodSeconds", "timeoutSeconds", "failureThreshold"]
        .filter((key) => typeof value[key] === "number").map((key) => `${key.replace(/Seconds$/, "")}=${String(value[key])}`).join(" ");
    const kind = http ?? tcp ?? exec ?? grpc;
    return kind ? `${kind}${timing ? ` (${timing})` : ""}` : null;
}

function containerLines(container: K8sContainerDetail, spec: Record<string, unknown> | undefined): string[] {
    const env = container.env.map((entry) => (entry.from ? `${entry.name} (from ${entry.from})` : entry.name));
    const command = Array.isArray(spec?.command) || Array.isArray(spec?.args)
        ? redactArgv([...(Array.isArray(spec?.command) ? spec.command : []), ...(Array.isArray(spec?.args) ? spec.args : [])].map(String)).join(" ")
        : null;
    return [
        `${container.init ? "Init container" : "Container"} ${container.name} (image ${container.image}):`,
        state("State", container.state),
        state("Last state", container.lastState),
        `  Ready: ${container.ready ? "yes" : "no"}, restarts: ${container.restarts}`,
        command ? `  Command: ${command.slice(0, 600)}` : null,
        Object.keys(container.requests).length ? `  Requests: ${pairs(container.requests)}` : null,
        Object.keys(container.limits).length ? `  Limits: ${pairs(container.limits)}` : null,
        container.ports.length ? `  Ports: ${container.ports.join(", ")}` : null,
        probe(spec?.livenessProbe) ? `  Liveness probe: ${probe(spec?.livenessProbe)}` : null,
        probe(spec?.readinessProbe) ? `  Readiness probe: ${probe(spec?.readinessProbe)}` : null,
        probe(spec?.startupProbe) ? `  Startup probe: ${probe(spec?.startupProbe)}` : null,
        env.length ? `  Environment: ${env.length} variable${env.length === 1 ? "" : "s"}, values left out (they may hold secrets): ${env.join(", ").slice(0, 600)}` : null,
        container.envFrom.length ? `  Environment from: ${container.envFrom.join(", ")}` : null
    ].filter((line): line is string => Boolean(line));
}

// A describe-like summary of the pod (no environment values).
export function summarizePod(document: unknown): string {
    const detail = mapPodDetail(document, null);
    const spec = isRecord(document) && isRecord(document.spec) ? document.spec : {};
    const specOf = (list: unknown, name: string) => (Array.isArray(list) ? list.find((entry) => isRecord(entry) && entry.name === name) as Record<string, unknown> | undefined : undefined);
    const { pod } = detail;
    const conditions = detail.conditions
        .map((condition) => `${condition.type}=${condition.status}${condition.reason ? ` (${condition.reason}${condition.message ? `: ${condition.message.replace(/\s+/g, " ").slice(0, 200)}` : ""})` : ""}`)
        .join("; ");
    return [
        `Pod: ${pod.namespace}/${pod.name}`,
        `Status: ${pod.status} (phase ${pod.phase}), ready ${pod.ready}/${pod.total}, restarts ${pod.restarts}${pod.lastRestartAt ? `, last restart ${pod.lastRestartAt}` : ""}`,
        pod.owner ? `Owner: ${pod.owner.kind} ${pod.owner.name}` : null,
        `Node: ${pod.node ?? "(not scheduled)"}${pod.ip ? `, pod IP ${pod.ip}` : ""}`,
        `Created: ${pod.createdAt ?? "unknown"}${detail.qosClass ? `, QoS ${detail.qosClass}` : ""}${detail.serviceAccount ? `, service account ${detail.serviceAccount}` : ""}`,
        conditions ? `Conditions: ${conditions}` : null,
        ...detail.initContainers.flatMap((container) => containerLines(container, specOf(spec.initContainers, container.name))),
        ...detail.containers.flatMap((container) => containerLines(container, specOf(spec.containers, container.name))),
        detail.volumes.length ? `Volumes: ${detail.volumes.map((volume) => `${volume.name} (${volume.type}${volume.source ? ` ${volume.source}` : ""})`).join(", ")}` : null
    ].filter((line): line is string => Boolean(line)).join("\n");
}

export function formatEvents(events: K8sEvent[]): string {
    if (!events.length) return "(no events: the cluster keeps them for about an hour)";
    return events.slice(0, MAX_EVENTS).map((event) =>
        `${event.lastAt ?? "?"} ${event.type} ${event.reason}${event.count > 1 ? ` (x${event.count})` : ""} ${event.object.kind}/${event.object.name}: ${event.message.replace(/\s+/g, " ")}`
    ).join("\n");
}

export async function podEvidence(serverId: number, attachment: PodAttachment, signal: AbortSignal): Promise<{ sections: ChatEvidenceSection[]; access?: ChatEvidenceAccess }> {
    const session = await openKubectl(serverId, { signal });
    try {
        const { runner, status, target } = session;
        requireKnownContext(status, attachment.context);
        const { context, namespace, pod } = attachment;
        // One pod's document, events and last log lines: far below kubectl's
        // default cap, which is sized for whole namespaces.
        const run = (args: string[]) => runner.run(args, { timeoutMs: READ_TIMEOUT_MS, signal, maxOutputBytes: EVIDENCE_OUTPUT_MAX_BYTES });
        const where = `--context ${context} -n ${namespace}`;

        const podArgs = [...contextArgs(context), "get", "pod", pod, "-n", namespace, "-o", "json"];
        const podResult = await run(podArgs);
        if (podResult.code !== 0) throw kubectlFailure(podResult);
        const document = extractJson(podResult.stdout);
        if (!isRecord(document)) throw new AppError("K8S_COMMAND_FAILED", "kubectl returned no pod.", 502);
        const detail = mapPodDetail(document, null);
        const summaryBase = { id: "pod" as const, title: "Pod state", source: `kubectl get pod ${pod} ${where} -o json (summarized)` };
        const summary = textSection(summaryBase, summarizePod(document), SUMMARY_CHARS);

        const eventsBase = { id: "pod-events" as const, title: "Pod events (warnings first)", source: `kubectl get events ${where} --field-selector involvedObject.name=${pod}` };
        const events = await attempt(eventsBase, signal, async () => {
            const result = await run(podEventArgs(context, namespace, pod));
            if (result.code !== 0) throw kubectlFailure(result);
            return textSection(eventsBase, formatEvents(mapPodDetail(document, decodeTemplateJson(result.stdout)).events), EVENTS_CHARS);
        });

        const sections: ChatEvidenceSection[] = [summary, events];
        const container = pickPodContainer(detail, attachment.container);
        if (container) {
            const logArgs = (previous: boolean, lines: number) => [...contextArgs(context), "-n", namespace, "logs", pod, "-c", container.name, `--tail=${lines}`, "--timestamps", ...(previous ? ["--previous"] : [])];
            const logsBase = { id: "pod-logs" as const, title: `Logs of container ${container.name} (last ${EVIDENCE_LOG_LINES} lines)`, source: `kubectl logs ${pod} -c ${container.name} ${where} --tail=${EVIDENCE_LOG_LINES}` };
            sections.push(await attempt(logsBase, signal, async () => {
                const result = await run(logArgs(false, EVIDENCE_LOG_LINES));
                if (result.code !== 0) throw kubectlFailure(result);
                return logSection(logsBase, result.stdout, LOGS_CHARS);
            }));
            // The instance before the last restart, when a new one runs (a
            // container waiting to restart still shows its last instance's
            // logs above): where an intermittent crash says why.
            if (container.lastState?.state === "terminated" && container.state.state === "running") {
                const previousBase = { id: "pod-previous-logs" as const, title: `Logs of the previous instance of ${container.name} (last ${PREVIOUS_LOG_LINES} lines)`, source: `kubectl logs ${pod} -c ${container.name} ${where} --previous --tail=${PREVIOUS_LOG_LINES}` };
                sections.push(await attempt(previousBase, signal, async () => {
                    const result = await run(logArgs(true, PREVIOUS_LOG_LINES));
                    if (result.code !== 0) throw kubectlFailure(result);
                    return logSection(previousBase, result.stdout, PREVIOUS_LOGS_CHARS);
                }));
            }
        }

        // Over SSH a fix runs in the server's terminal as its login user.
        if (target.kind !== "ssh") return { sections };
        // eslint-disable-next-line no-control-regex -- control characters are what it removes
        const user = target.username.replace(/[\0-\x1f\x7f]+/g, " ").trim().slice(0, MAX_USER_CHARS) || "(unknown)";
        return { sections, access: { platform: "linux", user, admin: user === "root" ? true : null, sudo: status.sudo } };
    } finally {
        session.release();
    }
}
