import type { K8sEvent, K8sNode, K8sPodDetail, K8sPodList, K8sWorkloadList } from "../../shared/k8s";
import { AppError } from "../errors";
import { extractJson, isRecord } from "../ops/remote";
import { kubectlFailure, kubectlMessage } from "./errors";
import { mapEvents, mapNamespaces, mapNodes, mapPodDetail, mapPods, mapWorkloads } from "./parse";
import type { KubectlResult, KubectlRunner } from "./runner";
import { decodeTemplateJson, EVENT_LIST_TEMPLATE, goTemplateArgs, POD_LIST_TEMPLATE } from "./templates";
import { namespaceArgs } from "./validate";

// The read-only views of the Kubernetes tab. Every call names its context
// (`--context`, never kubectl's current context) and a request timeout for
// the API server, and asks for JSON; the backend maps it to compact rows.
// Pods and events, the lists that grow with the cluster, are printed with
// the compact templates of ./templates.

// What kubectl waits for the API server (credential plugins included) before
// the process timeout below steps in.
const REQUEST_TIMEOUT = "--request-timeout=20s";
export const READ_TIMEOUT_MS = 30_000;

export type ReadOptions = { signal?: AbortSignal };

export function contextArgs(context: string): string[] {
    return ["--context", context, REQUEST_TIMEOUT];
}

type ReadJsonOptions = ReadOptions & {
    // A listing of several kinds can print the ones it could read and fail
    // for the others (RBAC); those are kept, with kubectl's message as a warning.
    partial?: boolean;
    // How the output becomes a document (default: `-o json`'s).
    decode?: (stdout: string) => unknown;
};

// The JSON document kubectl printed, or its failure.
async function readJson(runner: KubectlRunner, args: string[], options: ReadJsonOptions): Promise<{ document: unknown; warning: string | null }> {
    const result: KubectlResult = await runner.run(args, { timeoutMs: READ_TIMEOUT_MS, signal: options.signal });
    const document = result.stdout.trim() ? (options.decode ?? extractJson)(result.stdout) : null;
    if (result.code === 0 && isRecord(document)) return { document, warning: null };
    if (options.partial && isRecord(document) && Array.isArray(document.items) && document.items.length) {
        return { document, warning: kubectlMessage(result) || null };
    }
    if (result.code === 0 && result.stdout.trim()) throw new AppError("K8S_COMMAND_FAILED", "kubectl printed something ShellMind could not read as a list.", 502);
    throw kubectlFailure(result);
}

const compact = (template: string): Pick<ReadJsonOptions, "decode"> & { args: string[] } => ({ args: goTemplateArgs(template), decode: decodeTemplateJson });

export async function listNamespaces(runner: KubectlRunner, context: string, options: ReadOptions = {}): Promise<string[]> {
    const { document } = await readJson(runner, [...contextArgs(context), "get", "namespaces", "-o", "json"], options);
    return mapNamespaces(document);
}

export async function listWorkloads(runner: KubectlRunner, context: string, scope: string, options: ReadOptions = {}): Promise<K8sWorkloadList> {
    const args = [...contextArgs(context), "get", "deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch", ...namespaceArgs(scope), "-o", "json"];
    const { document, warning } = await readJson(runner, args, { ...options, partial: true });
    return { workloads: mapWorkloads(document), warnings: warning ? warning.split("\n").slice(0, 5) : [] };
}

// Every pod is read, then the list is cut to K8S_MAX_PODS (`truncated`).
export async function listPods(runner: KubectlRunner, context: string, scope: string, options: ReadOptions = {}): Promise<K8sPodList> {
    const { args, decode } = compact(POD_LIST_TEMPLATE);
    const { document } = await readJson(runner, [...contextArgs(context), "get", "pods", ...namespaceArgs(scope), ...args], { ...options, decode });
    return mapPods(document);
}

// Warnings first, then the most recent, cut to K8S_MAX_EVENTS.
export async function listEvents(runner: KubectlRunner, context: string, scope: string, options: ReadOptions = {}): Promise<K8sEvent[]> {
    const { args, decode } = compact(EVENT_LIST_TEMPLATE);
    const { document } = await readJson(runner, [...contextArgs(context), "get", "events", ...namespaceArgs(scope), ...args], { ...options, decode });
    return mapEvents(document);
}

export async function listNodes(runner: KubectlRunner, context: string, options: ReadOptions = {}): Promise<K8sNode[]> {
    const { document } = await readJson(runner, [...contextArgs(context), "get", "nodes", "-o", "json"], options);
    return mapNodes(document);
}

// The events of one pod, printed with the compact event template (read the
// output with decodeTemplateJson).
export function podEventArgs(context: string, namespace: string, pod: string): string[] {
    return [...contextArgs(context), "get", "events", "-n", namespace, "--field-selector", `involvedObject.kind=Pod,involvedObject.name=${pod}`, ...goTemplateArgs(EVENT_LIST_TEMPLATE)];
}

// The pod and its own events (fetched together; events the user may not
// list leave the detail without them).
export async function podDetail(runner: KubectlRunner, context: string, namespace: string, pod: string, options: ReadOptions = {}): Promise<K8sPodDetail> {
    const [document, events] = await Promise.all([
        readJson(runner, [...contextArgs(context), "get", "pod", pod, "-n", namespace, "-o", "json"], options),
        readJson(runner, podEventArgs(context, namespace, pod), { ...options, decode: decodeTemplateJson }).catch(() => null)
    ]);
    return mapPodDetail(document.document, events?.document ?? null);
}
