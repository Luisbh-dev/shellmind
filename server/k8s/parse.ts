import {
    K8S_MAX_EVENTS,
    K8S_MAX_PODS,
    type K8sCondition,
    type K8sContainerDetail,
    type K8sContainerState,
    type K8sEnvVar,
    type K8sEvent,
    type K8sHealth,
    type K8sNode,
    type K8sPod,
    type K8sPodDetail,
    type K8sPodList,
    type K8sPodProblem,
    type K8sWorkload,
    type K8sWorkloadKind
} from "../../shared/k8s";
import { asNumber, asString, isRecord } from "../ops/remote";

// `kubectl get ... -o json` documents as the compact rows the panels show.
// Everything is read defensively: an older or newer API server may leave a
// field out, and nothing here may throw on a document it does not expect.

type Json = Record<string, unknown>;

const obj = (value: unknown): Json => (isRecord(value) ? value : {});
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const str = (value: unknown): string | null => asString(value) || null;
const int = (value: unknown): number => asNumber(value) ?? 0;

function stringMap(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, entry] of Object.entries(obj(value))) {
        if (typeof entry === "string" || typeof entry === "number") out[key] = String(entry);
    }
    return out;
}

const items = (document: unknown): Json[] => list(obj(document).items);

const later = (a: string | null, b: string | null) => (!a ? b : !b ? a : a > b ? a : b);

// --- pods ---

const IMAGE_PULL = new Set(["ErrImagePull", "ImagePullBackOff", "InvalidImageName", "ErrImageNeverPull", "RegistryUnavailable"]);
const CONFIG_ERROR = new Set(["CreateContainerConfigError", "CreateContainerError", "RunContainerError", "PreCreateHookError", "PostStartHookError"]);

function containerStatuses(status: Json, key: "containerStatuses" | "initContainerStatuses"): Json[] {
    return list(status[key]);
}

function waitingReason(container: Json): string | null {
    return str(obj(obj(container.state).waiting).reason);
}

// STATUS as `kubectl get pods` prints it (pkg/printers printPod, simplified):
// a waiting or terminated container's reason wins over the phase, init
// containers show as Init:<reason> or Init:<done>/<all>, and a pod being
// deleted is Terminating.
export function podStatusText(pod: Json): string {
    const metadata = obj(pod.metadata);
    const spec = obj(pod.spec);
    const status = obj(pod.status);
    let reason = str(status.reason) ?? str(status.phase) ?? "Unknown";

    let initializing = false;
    const inits = containerStatuses(status, "initContainerStatuses");
    const initSpecs = list(spec.initContainers);
    for (let index = 0; index < inits.length; index++) {
        const container = inits[index];
        const state = obj(container.state);
        const terminated = isRecord(state.terminated) ? state.terminated : null;
        const waiting = isRecord(state.waiting) ? state.waiting : null;
        // A sidecar (restartPolicy: Always) that has started does not hold the pod.
        const sidecar = asString(initSpecs.find((entry) => entry.name === container.name)?.restartPolicy) === "Always";
        if (terminated && int(terminated.exitCode) === 0) continue;
        if (sidecar && container.started === true) continue;
        if (terminated) {
            reason = str(terminated.reason) ? `Init:${asString(terminated.reason)}` : int(terminated.signal) ? `Init:Signal:${int(terminated.signal)}` : `Init:ExitCode:${int(terminated.exitCode)}`;
        } else if (waiting && str(waiting.reason) && waiting.reason !== "PodInitializing") {
            reason = `Init:${asString(waiting.reason)}`;
        } else {
            reason = `Init:${index}/${initSpecs.length || inits.length}`;
        }
        initializing = true;
        break;
    }

    const initialized = list(status.conditions).some((condition) => condition.type === "Initialized" && condition.status === "True");
    if (!initializing || initialized) {
        let hasRunning = false;
        const containers = containerStatuses(status, "containerStatuses");
        for (let index = containers.length - 1; index >= 0; index--) {
            const container = containers[index];
            const state = obj(container.state);
            const waiting = obj(state.waiting);
            const terminated = isRecord(state.terminated) ? state.terminated : null;
            if (str(waiting.reason)) reason = asString(waiting.reason);
            else if (terminated && str(terminated.reason)) reason = asString(terminated.reason);
            else if (terminated) reason = int(terminated.signal) ? `Signal:${int(terminated.signal)}` : `ExitCode:${int(terminated.exitCode)}`;
            else if (container.ready === true && isRecord(state.running)) hasRunning = true;
        }
        if (reason === "Completed" && hasRunning) {
            const ready = list(status.conditions).some((condition) => condition.type === "Ready" && condition.status === "True");
            reason = ready ? "Running" : "NotReady";
        }
    }

    if (metadata.deletionTimestamp) reason = status.reason === "NodeLost" ? "Unknown" : "Terminating";
    return reason;
}

export function podProblem(pod: Json, statusText: string): K8sPodProblem | null {
    const metadata = obj(pod.metadata);
    const status = obj(pod.status);
    if (metadata.deletionTimestamp) return "terminating";
    const all = [...containerStatuses(status, "initContainerStatuses"), ...containerStatuses(status, "containerStatuses")];
    const reasons = all.map(waitingReason).filter((reason): reason is string => Boolean(reason));
    if (reasons.includes("CrashLoopBackOff")) return "crash-loop";
    // Between two back-offs a crash-looping container reads "Error" (exited,
    // about to restart): it already restarted, so it is the same loop.
    const restartingAfterCrash = all.some((container) => {
        const terminated = obj(obj(container.state).terminated);
        return isRecord(obj(container.state).terminated) && int(terminated.exitCode) !== 0 && int(container.restartCount) > 0;
    });
    if (restartingAfterCrash && asString(status.phase) === "Running") return "crash-loop";
    if (reasons.some((reason) => IMAGE_PULL.has(reason))) return "image-pull";
    if (reasons.some((reason) => CONFIG_ERROR.has(reason))) return "config-error";
    const phase = asString(status.phase);
    if (asString(status.reason) === "Evicted") return "evicted";
    if (phase === "Failed") return "failed";
    const oom = all.some((container) => [obj(obj(container.state).terminated).reason, obj(obj(container.lastState).terminated).reason].includes("OOMKilled"));
    if (oom && phase !== "Succeeded") return "oom-killed";
    if (phase === "Pending") return "pending";
    if (phase === "Running" && statusText !== "Completed") {
        const regular = containerStatuses(status, "containerStatuses");
        if (regular.some((container) => container.ready !== true)) return "not-ready";
    }
    return null;
}

// The workload a pod belongs to: its controller, a ReplicaSet named after
// its Deployment and the pod-template-hash label reported as that Deployment.
export function podOwner(metadata: Json): K8sPod["owner"] {
    const owner = list(metadata.ownerReferences).find((entry) => entry.controller === true) ?? list(metadata.ownerReferences)[0];
    if (!owner) return null;
    const kind = asString(owner.kind);
    const name = asString(owner.name);
    if (!kind || !name) return null;
    const hash = stringMap(metadata.labels)["pod-template-hash"];
    if (kind === "ReplicaSet" && hash && name.endsWith(`-${hash}`)) return { kind: "Deployment", name: name.slice(0, -hash.length - 1) };
    return { kind, name };
}

export function mapPod(pod: Json): K8sPod {
    const metadata = obj(pod.metadata);
    const spec = obj(pod.spec);
    const status = obj(pod.status);
    const containers = containerStatuses(status, "containerStatuses");
    const statusText = podStatusText(pod);
    let lastRestartAt: string | null = null;
    for (const container of [...containerStatuses(status, "initContainerStatuses"), ...containers]) {
        lastRestartAt = later(lastRestartAt, str(obj(obj(container.lastState).terminated).finishedAt));
    }
    const specContainers = list(spec.containers);
    const inits = containerStatuses(status, "initContainerStatuses");
    const restartsOf = (statuses: Json[]) => statuses.reduce((sum, container) => sum + int(container.restartCount), 0);
    const sidecars = new Set(list(spec.initContainers).filter((entry) => asString(entry.restartPolicy) === "Always").map((entry) => asString(entry.name)));
    // RESTARTS like kubectl: an initializing pod's are its init containers';
    // then its containers' and its sidecars'.
    const restarts = statusText.startsWith("Init:")
        ? restartsOf(inits)
        : restartsOf(containers) + restartsOf(inits.filter((container) => sidecars.has(asString(container.name))));
    const runningNow = new Set([...containers, ...inits]
        .filter((container) => isRecord(obj(container.state).running))
        .map((container) => asString(container.name)));
    const running = [...specContainers, ...list(spec.initContainers)].map((container) => asString(container.name)).filter((name) => runningNow.has(name));
    return {
        name: asString(metadata.name),
        namespace: asString(metadata.namespace),
        phase: asString(status.phase) || "Unknown",
        status: statusText,
        ready: containers.filter((container) => container.ready === true).length,
        total: specContainers.length || containers.length,
        restarts,
        lastRestartAt,
        node: str(spec.nodeName),
        ip: str(status.podIP),
        createdAt: str(metadata.creationTimestamp),
        containers: specContainers.map((container) => asString(container.name)).filter(Boolean),
        running,
        owner: podOwner(metadata),
        problem: podProblem(pod, statusText),
        labels: stringMap(metadata.labels)
    };
}

export function mapPods(document: unknown, max = K8S_MAX_PODS): K8sPodList {
    const all = items(document);
    const pods = all.slice(0, max).map(mapPod).filter((pod) => pod.name);
    return { pods, truncated: all.length > max };
}

// --- workloads ---

const WORKLOAD_KINDS: Record<string, K8sWorkloadKind> = {
    Deployment: "deployment",
    StatefulSet: "statefulset",
    DaemonSet: "daemonset",
    Job: "job",
    CronJob: "cronjob"
};

function podTemplate(spec: Json): Json {
    return obj(obj(spec.template).spec);
}

function images(templateSpec: Json): string[] {
    return [...list(templateSpec.initContainers), ...list(templateSpec.containers)].map((container) => asString(container.image)).filter(Boolean);
}

function condition(status: Json, type: string): Json | null {
    return list(status.conditions).find((entry) => entry.type === type) ?? null;
}

function conditionInfo(entry: Json | null): K8sWorkload["condition"] {
    return entry ? { type: asString(entry.type), reason: str(entry.reason), message: str(entry.message) } : null;
}

function replicaHealth(desired: number, ready: number, updated: number, available: number, rolling: boolean): K8sHealth {
    if (desired === 0) return "idle";
    if (rolling) return "progressing";
    if (ready >= desired && available >= desired && updated >= desired) return "ok";
    return "degraded";
}

export function mapWorkload(document: Json): K8sWorkload | null {
    const kind = WORKLOAD_KINDS[asString(document.kind)];
    if (!kind) return null;
    const metadata = obj(document.metadata);
    const spec = obj(document.spec);
    const status = obj(document.status);
    const stale = int(status.observedGeneration) < int(metadata.generation);
    const base = {
        kind,
        name: asString(metadata.name),
        namespace: asString(metadata.namespace),
        createdAt: str(metadata.creationTimestamp),
        selector: stringMap(obj(spec.selector).matchLabels)
    };

    switch (kind) {
        case "deployment": {
            const desired = asNumber(spec.replicas) ?? 1;
            const ready = int(status.readyReplicas);
            const updated = int(status.updatedReplicas);
            const available = int(status.availableReplicas);
            const progressing = condition(status, "Progressing");
            const availableCondition = condition(status, "Available");
            const failed = progressing?.reason === "ProgressDeadlineExceeded";
            // Old and new pods side by side, or a spec the controller has not seen yet.
            const rolling = stale || updated < desired || int(status.replicas) > desired;
            const health = failed ? "failed" : replicaHealth(desired, ready, updated, available, rolling);
            const explain = failed ? progressing : health === "degraded" && availableCondition?.status === "False" ? availableCondition : null;
            return { ...base, ready, desired, upToDate: updated, available, images: images(podTemplate(spec)), health, condition: conditionInfo(explain) };
        }
        case "statefulset": {
            const desired = asNumber(spec.replicas) ?? 1;
            const ready = int(status.readyReplicas);
            const updated = int(status.updatedReplicas);
            const available = asNumber(status.availableReplicas) ?? ready;
            const rolling = stale || (Boolean(status.updateRevision) && status.updateRevision !== status.currentRevision && updated < desired);
            return { ...base, ready, desired, upToDate: updated, available, images: images(podTemplate(spec)), health: replicaHealth(desired, ready, updated, available, rolling), condition: null };
        }
        case "daemonset": {
            const desired = int(status.desiredNumberScheduled);
            const ready = int(status.numberReady);
            const updated = int(status.updatedNumberScheduled);
            const available = int(status.numberAvailable);
            const rolling = stale || updated < desired;
            return { ...base, ready, desired, upToDate: updated, available, images: images(podTemplate(spec)), health: replicaHealth(desired, ready, updated, available, rolling), condition: null };
        }
        case "job": {
            const completions = asNumber(spec.completions) ?? (asNumber(spec.parallelism) && asNumber(spec.parallelism) !== 1 ? null : 1);
            const succeeded = int(status.succeeded);
            const failedPods = int(status.failed);
            const complete = condition(status, "Complete");
            const failedCondition = condition(status, "Failed");
            const health: K8sHealth = failedCondition?.status === "True"
                ? "failed"
                : complete?.status === "True"
                    ? "ok"
                    : spec.suspend === true ? "suspended" : int(status.active) > 0 ? "progressing" : "degraded";
            return {
                ...base,
                ready: succeeded,
                desired: completions,
                upToDate: null,
                available: null,
                images: images(podTemplate(spec)),
                health,
                condition: failedCondition?.status === "True" ? conditionInfo(failedCondition) : null,
                failed: failedPods,
                completedAt: str(status.completionTime)
            };
        }
        case "cronjob": {
            const jobSpec = obj(obj(spec.jobTemplate).spec);
            const active = list(status.active).length;
            const suspended = spec.suspend === true;
            return {
                ...base,
                ready: active,
                desired: null,
                upToDate: null,
                available: null,
                images: images(podTemplate(jobSpec)),
                health: suspended ? "suspended" : active > 0 ? "progressing" : "idle",
                condition: null,
                schedule: asString(spec.schedule),
                suspended,
                lastScheduleAt: str(status.lastScheduleTime)
            };
        }
    }
}

const KIND_ORDER: K8sWorkloadKind[] = ["deployment", "statefulset", "daemonset", "job", "cronjob"];

export function mapWorkloads(document: unknown): K8sWorkload[] {
    return items(document)
        .map(mapWorkload)
        .filter((workload): workload is K8sWorkload => Boolean(workload?.name))
        .sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

// --- events ---

export function mapEvent(event: Json): K8sEvent {
    const metadata = obj(event.metadata);
    const involved = obj(event.involvedObject);
    const series = obj(event.series);
    const source = obj(event.source);
    const firstAt = str(event.firstTimestamp) ?? str(event.eventTime) ?? str(metadata.creationTimestamp);
    return {
        type: asString(event.type) || "Normal",
        reason: asString(event.reason),
        message: asString(event.note) || asString(event.message),
        namespace: str(involved.namespace) ?? str(metadata.namespace),
        object: { kind: asString(involved.kind), name: asString(involved.name) },
        count: asNumber(series.count) ?? asNumber(event.count) ?? 1,
        firstAt,
        lastAt: str(series.lastObservedTime) ?? str(event.lastTimestamp) ?? str(event.eventTime) ?? firstAt,
        source: str(event.reportingComponent) ?? str(source.component)
    };
}

// Warnings first, then the most recent.
export function sortEvents(events: K8sEvent[]): K8sEvent[] {
    return [...events].sort((a, b) => {
        const warning = Number(b.type === "Warning") - Number(a.type === "Warning");
        return warning || (b.lastAt ?? "").localeCompare(a.lastAt ?? "");
    });
}

export function mapEvents(document: unknown, max = K8S_MAX_EVENTS): K8sEvent[] {
    return sortEvents(items(document).map(mapEvent)).slice(0, max);
}

// --- nodes ---

const PRESSURES = ["MemoryPressure", "DiskPressure", "PIDPressure", "NetworkUnavailable"];

export function mapNode(node: Json): K8sNode {
    const metadata = obj(node.metadata);
    const spec = obj(node.spec);
    const status = obj(node.status);
    const info = obj(status.nodeInfo);
    const labels = stringMap(metadata.labels);
    const ready = condition(status, "Ready");
    const roles = Object.keys(labels)
        .filter((key) => key.startsWith("node-role.kubernetes.io/"))
        .map((key) => key.slice("node-role.kubernetes.io/".length))
        .filter(Boolean);
    if (labels["kubernetes.io/role"] && !roles.includes(labels["kubernetes.io/role"])) roles.push(labels["kubernetes.io/role"]);
    const capacity = obj(status.capacity);
    return {
        name: asString(metadata.name),
        ready: ready ? ready.status === "True" : null,
        unschedulable: spec.unschedulable === true,
        roles: roles.sort(),
        version: str(info.kubeletVersion),
        internalIp: str(list(status.addresses).find((address) => address.type === "InternalIP")?.address),
        osImage: str(info.osImage),
        kernel: str(info.kernelVersion),
        runtime: str(info.containerRuntimeVersion),
        createdAt: str(metadata.creationTimestamp),
        pressures: list(status.conditions).filter((entry) => PRESSURES.includes(asString(entry.type)) && entry.status === "True").map((entry) => asString(entry.type)),
        capacity: { cpu: str(capacity.cpu), memory: str(capacity.memory), pods: str(capacity.pods) },
        taints: list(spec.taints).length
    };
}

export function mapNodes(document: unknown): K8sNode[] {
    return items(document).map(mapNode).filter((node) => node.name).sort((a, b) => a.name.localeCompare(b.name));
}

// --- namespaces ---

export function mapNamespaces(document: unknown): string[] {
    return items(document).map((namespace) => asString(obj(namespace.metadata).name)).filter(Boolean).sort((a, b) => a.localeCompare(b));
}

// --- pod detail ---

export function containerState(value: unknown): K8sContainerState | null {
    const state = obj(value);
    const running = isRecord(state.running) ? state.running : null;
    const waiting = isRecord(state.waiting) ? state.waiting : null;
    const terminated = isRecord(state.terminated) ? state.terminated : null;
    if (running) return { state: "running", reason: null, message: null, exitCode: null, signal: null, startedAt: str(running.startedAt), finishedAt: null };
    if (waiting) return { state: "waiting", reason: str(waiting.reason), message: str(waiting.message), exitCode: null, signal: null, startedAt: null, finishedAt: null };
    if (terminated) {
        return {
            state: "terminated",
            reason: str(terminated.reason),
            message: str(terminated.message),
            exitCode: asNumber(terminated.exitCode),
            signal: asNumber(terminated.signal) || null,
            startedAt: str(terminated.startedAt),
            finishedAt: str(terminated.finishedAt)
        };
    }
    return null;
}

// Where a variable's value comes from, without reading it.
function envSource(valueFrom: Json): string | null {
    const secret = obj(valueFrom.secretKeyRef);
    if (secret.name || secret.key) return `secret ${asString(secret.name)}/${asString(secret.key)}`;
    const configMap = obj(valueFrom.configMapKeyRef);
    if (configMap.name || configMap.key) return `configmap ${asString(configMap.name)}/${asString(configMap.key)}`;
    const field = obj(valueFrom.fieldRef);
    if (field.fieldPath) return `field ${asString(field.fieldPath)}`;
    const resource = obj(valueFrom.resourceFieldRef);
    if (resource.resource) return `resource ${asString(resource.resource)}${resource.containerName ? ` (${asString(resource.containerName)})` : ""}`;
    return null;
}

export function mapEnv(value: unknown): K8sEnvVar[] {
    return list(value).map((entry) => ({
        name: asString(entry.name),
        value: typeof entry.value === "string" ? entry.value : isRecord(entry.valueFrom) ? null : "",
        from: isRecord(entry.valueFrom) ? envSource(entry.valueFrom) : null
    })).filter((entry) => entry.name);
}

function envFrom(value: unknown): string[] {
    return list(value).map((entry) => {
        const prefix = entry.prefix ? ` (prefix ${asString(entry.prefix)})` : "";
        if (isRecord(entry.secretRef)) return `secret ${asString(entry.secretRef.name)}${prefix}`;
        if (isRecord(entry.configMapRef)) return `configmap ${asString(entry.configMapRef.name)}${prefix}`;
        return "";
    }).filter(Boolean);
}

function ports(value: unknown): string[] {
    return list(value).map((port) => `${asString(port.containerPort)}/${asString(port.protocol) || "TCP"}${port.name ? ` (${asString(port.name)})` : ""}`);
}

function commandText(container: Json): string | null {
    const parts = [...(Array.isArray(container.command) ? container.command : []), ...(Array.isArray(container.args) ? container.args : [])].map(asString);
    return parts.length ? parts.join(" ") : null;
}

function mapContainer(spec: Json, statuses: Json[], init: boolean): K8sContainerDetail {
    const name = asString(spec.name);
    const status = statuses.find((entry) => entry.name === name) ?? {};
    const resources = obj(spec.resources);
    return {
        name,
        image: asString(spec.image),
        init,
        sidecar: init && asString(spec.restartPolicy) === "Always",
        ready: status.ready === true,
        restarts: int(status.restartCount),
        state: containerState(status.state) ?? { state: "unknown", reason: null, message: null, exitCode: null, signal: null, startedAt: null, finishedAt: null },
        lastState: containerState(status.lastState),
        ports: ports(spec.ports),
        env: mapEnv(spec.env),
        envFrom: envFrom(spec.envFrom),
        requests: stringMap(resources.requests),
        limits: stringMap(resources.limits),
        command: commandText(spec)
    };
}

const VOLUME_SOURCES: Array<[string, (source: Json) => string | null]> = [
    ["secret", (source) => str(source.secretName)],
    ["configMap", (source) => str(source.name)],
    ["persistentVolumeClaim", (source) => str(source.claimName)],
    ["hostPath", (source) => str(source.path)],
    ["emptyDir", (source) => (source.medium ? asString(source.medium) : null)],
    ["projected", () => null],
    ["downwardAPI", () => null],
    ["nfs", (source) => [asString(source.server), asString(source.path)].filter(Boolean).join(":") || null],
    ["csi", (source) => str(source.driver)],
    ["ephemeral", () => null]
];

function mapVolume(volume: Json): K8sPodDetail["volumes"][number] {
    for (const [type, source] of VOLUME_SOURCES) {
        if (isRecord(volume[type])) return { name: asString(volume.name), type, source: source(volume[type] as Json) };
    }
    const type = Object.keys(volume).find((key) => key !== "name") ?? "unknown";
    return { name: asString(volume.name), type, source: null };
}

function mapCondition(entry: Json): K8sCondition {
    return { type: asString(entry.type), status: asString(entry.status), reason: str(entry.reason), message: str(entry.message), lastTransitionAt: str(entry.lastTransitionTime) };
}

export function mapPodDetail(pod: unknown, events: unknown): K8sPodDetail {
    const document = obj(pod);
    const spec = obj(document.spec);
    const status = obj(document.status);
    return {
        pod: mapPod(document),
        hostIp: str(status.hostIP),
        qosClass: str(status.qosClass),
        serviceAccount: str(spec.serviceAccountName) ?? str(spec.serviceAccount),
        startedAt: str(status.startTime),
        conditions: list(status.conditions).map(mapCondition),
        containers: list(spec.containers).map((container) => mapContainer(container, containerStatuses(status, "containerStatuses"), false)),
        initContainers: list(spec.initContainers).map((container) => mapContainer(container, containerStatuses(status, "initContainerStatuses"), true)),
        volumes: list(spec.volumes).map(mapVolume),
        events: mapEvents(events, 100)
    };
}
