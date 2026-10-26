// W8-T2 Kubernetes workspace: the HTTP payloads of /api/servers/:id/k8s/*,
// the pod log source and pod terminal of the socket protocol, and the name
// rules shared by the backend (which builds every kubectl command line) and
// the frontend (which checks input before sending it). The client only ever
// sends names: a context, a namespace, a pod... never kubectl arguments.
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

export const K8S_INSTALL_URL = "https://kubernetes.io/docs/tasks/tools/";

// Where kubectl runs: on the backend's own machine (a local server with the
// kubectl preset) or on the saved SSH server.
export type K8sRunner = "local" | "ssh";

// --- names ---

// RFC 1123 label: namespaces and container names.
export const K8S_LABEL_PATTERN = /^[a-z0-9](?:[-a-z0-9]{0,61}[a-z0-9])?$/;
// RFC 1123 subdomain: pods, workloads and nodes ("ip-10-0-1-2.ec2.internal").
export const K8S_SUBDOMAIN_PATTERN = /^(?=.{1,253}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
// kubeconfig context names are free text. ShellMind passes those without
// blanks, quotes or shell characters, which covers what the tools write:
// "kind-dev", "k3d-lab", "gke_project_zone_cluster", "admin@cluster",
// "arn:aws:eks:eu-west-1:123456789012:cluster/prod".
export const K8S_CONTEXT_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.:@/+=,-]{0,252}$/;

export function isValidK8sContext(name: string): boolean {
    return K8S_CONTEXT_PATTERN.test(name);
}

export function isValidK8sNamespace(name: string): boolean {
    return K8S_LABEL_PATTERN.test(name);
}

// Pods, workloads, nodes.
export function isValidK8sName(name: string): boolean {
    return K8S_SUBDOMAIN_PATTERN.test(name);
}

export function isValidK8sContainer(name: string): boolean {
    return K8S_LABEL_PATTERN.test(name);
}

// The namespace query value that lists every namespace (`--all-namespaces`).
export const K8S_ALL_NAMESPACES = "*";

// --- status (GET /api/servers/:id/k8s/status) ---

export type K8sContext = {
    name: string;
    cluster: string | null;
    // The API server URL of its cluster.
    server: string | null;
    // Its default namespace (null: "default").
    namespace: string | null;
    user: string | null;
};

// KUBECTL_MISSING     kubectl is not installed (or not on PATH)
// NO_CONTEXTS         kubectl runs but its kubeconfig has no contexts
// KUBECONFIG_ERROR    the kubeconfig cannot be read (details in `message`)
// UNSUPPORTED         a server type ShellMind does not run kubectl for
export type K8sProblemCode = "KUBECTL_MISSING" | "NO_CONTEXTS" | "KUBECONFIG_ERROR" | "UNSUPPORTED";

export type K8sStatus = {
    runner: K8sRunner;
    available: boolean;
    problem: { code: K8sProblemCode; message: string } | null;
    kubectl: { path: string | null; version: string | null } | null;
    // kubectl runs through `sudo -n`: the login user's kubeconfig has no
    // contexts, root's has (a k3s node's /etc/rancher/k3s/k3s.yaml).
    sudo: boolean;
    contexts: K8sContext[];
    // What kubectl itself would use (never changed unless the user asks).
    currentContext: string | null;
    // Contexts left out: their names have blanks, quotes or shell characters.
    unsupportedContexts: string[];
    installUrl: string;
    detectedAt: number;
};

// --- workloads (GET .../k8s/workloads?context=&namespace=) ---

export const K8S_WORKLOAD_KINDS = ["deployment", "statefulset", "daemonset", "job", "cronjob"] as const;
export type K8sWorkloadKind = typeof K8S_WORKLOAD_KINDS[number];
// `rollout restart` and `scale` targets.
export const K8S_RESTARTABLE_KINDS: readonly K8sWorkloadKind[] = ["deployment", "statefulset", "daemonset"];
export const K8S_SCALABLE_KINDS: readonly K8sWorkloadKind[] = ["deployment", "statefulset"];
export const K8S_MAX_REPLICAS = 1000;

export function isK8sWorkloadKind(value: string): value is K8sWorkloadKind {
    return (K8S_WORKLOAD_KINDS as readonly string[]).includes(value);
}

// ok           every desired pod is ready (a job: it completed)
// progressing  a rollout is under way (or a job is running)
// degraded     some desired pods are not ready
// failed       the rollout or the job failed (deadline exceeded, back-off limit)
// idle         nothing is desired (scaled to 0, a cronjob between runs)
// suspended    a suspended cronjob or job
export type K8sHealth = "ok" | "progressing" | "degraded" | "failed" | "idle" | "suspended";

export type K8sWorkload = {
    kind: K8sWorkloadKind;
    name: string;
    namespace: string;
    // Pods ready / desired (jobs: succeeded / completions; cronjobs: active jobs).
    ready: number | null;
    desired: number | null;
    upToDate: number | null;
    available: number | null;
    images: string[];
    createdAt: string | null;
    health: K8sHealth;
    // The condition that explains a problem (ProgressDeadlineExceeded,
    // BackoffLimitExceeded...).
    condition: { type: string; reason: string | null; message: string | null } | null;
    // The labels its pods are selected by (matchLabels only).
    selector: Record<string, string>;
    // CronJobs.
    schedule?: string;
    suspended?: boolean;
    lastScheduleAt?: string | null;
    // Jobs.
    failed?: number;
    completedAt?: string | null;
};

export type K8sWorkloadList = {
    workloads: K8sWorkload[];
    // Kinds kubectl could not list (RBAC), with its message.
    warnings: string[];
};

// --- pods (GET .../k8s/pods?context=&namespace=) ---

// What needs attention, for highlighting and the "problems" filter.
export type K8sPodProblem = "crash-loop" | "image-pull" | "config-error" | "oom-killed" | "failed" | "evicted" | "pending" | "not-ready" | "terminating";

export type K8sPod = {
    name: string;
    namespace: string;
    // Pending, Running, Succeeded, Failed, Unknown.
    phase: string;
    // What `kubectl get pods` shows in STATUS: CrashLoopBackOff,
    // ImagePullBackOff, Init:0/1, Completed, Terminating, Running...
    status: string;
    ready: number;
    total: number;
    restarts: number;
    lastRestartAt: string | null;
    node: string | null;
    ip: string | null;
    createdAt: string | null;
    // Regular containers (not init containers), in order.
    containers: string[];
    // The containers running now, where a shell can open: regular ones
    // first, then init containers (one still initializing the pod, sidecars).
    running: string[];
    // The workload it belongs to (a Deployment for a ReplicaSet's pod).
    owner: { kind: string; name: string } | null;
    problem: K8sPodProblem | null;
    labels: Record<string, string>;
};

export const K8S_MAX_PODS = 3000;

export type K8sPodList = {
    pods: K8sPod[];
    // More pods than K8S_MAX_PODS: the list was cut.
    truncated: boolean;
};

// --- events (GET .../k8s/events?context=&namespace=) ---

export type K8sEvent = {
    // "Warning" or "Normal".
    type: string;
    reason: string;
    message: string;
    namespace: string | null;
    object: { kind: string; name: string };
    count: number;
    firstAt: string | null;
    lastAt: string | null;
    source: string | null;
};

export const K8S_MAX_EVENTS = 500;

// --- nodes (GET .../k8s/nodes?context=) ---

export type K8sNode = {
    name: string;
    // The Ready condition (null: not reported).
    ready: boolean | null;
    unschedulable: boolean;
    roles: string[];
    version: string | null;
    internalIp: string | null;
    osImage: string | null;
    kernel: string | null;
    runtime: string | null;
    createdAt: string | null;
    // Pressure conditions that are true (MemoryPressure, DiskPressure...).
    pressures: string[];
    capacity: { cpu: string | null; memory: string | null; pods: string | null };
    taints: number;
};

// --- pod detail (GET .../k8s/pods/:pod?context=&namespace=) ---

export type K8sContainerState = {
    state: "running" | "waiting" | "terminated" | "unknown";
    reason: string | null;
    message: string | null;
    exitCode: number | null;
    signal: number | null;
    startedAt: string | null;
    finishedAt: string | null;
};

// A variable set in the pod spec: `value` for a literal (shown masked),
// `from` for a reference ("secret db/password", "configmap app/MODE",
// "field metadata.name"); the referenced value itself is never read.
export type K8sEnvVar = { name: string; value: string | null; from: string | null };

export type K8sContainerDetail = {
    name: string;
    image: string;
    init: boolean;
    // An init container that keeps running next to the others
    // (restartPolicy: Always).
    sidecar: boolean;
    ready: boolean;
    restarts: number;
    state: K8sContainerState;
    lastState: K8sContainerState | null;
    ports: string[];
    env: K8sEnvVar[];
    // envFrom sources ("secret db-creds", "configmap app-config").
    envFrom: string[];
    requests: Record<string, string>;
    limits: Record<string, string>;
    command: string | null;
};

export type K8sCondition = { type: string; status: string; reason: string | null; message: string | null; lastTransitionAt: string | null };

export type K8sPodDetail = {
    pod: K8sPod;
    hostIp: string | null;
    qosClass: string | null;
    serviceAccount: string | null;
    startedAt: string | null;
    conditions: K8sCondition[];
    containers: K8sContainerDetail[];
    initContainers: K8sContainerDetail[];
    volumes: Array<{ name: string; type: string; source: string | null }>;
    events: K8sEvent[];
};

const completed = (container: K8sContainerDetail) => container.state.state === "terminated" && container.state.exitCode === 0;

// The container whose logs and state explain the pod best (the logs view's
// first choice and the AI evidence's): the one asked for; while the pod
// initializes (STATUS Init:...), the init container it waits for; else the
// first regular container waiting, crashed, restarting or not ready; else
// the first one.
export function pickPodContainer(detail: Pick<K8sPodDetail, "pod" | "containers" | "initContainers">, wanted?: string): K8sContainerDetail | null {
    if (wanted) return [...detail.containers, ...detail.initContainers].find((container) => container.name === wanted) ?? null;
    if (detail.pod.status.startsWith("Init:")) {
        const waitedFor = detail.initContainers.find((container) => !container.sidecar && !completed(container))
            ?? detail.initContainers.find((container) => container.sidecar && container.state.state !== "running");
        if (waitedFor) return waitedFor;
    }
    const trouble = detail.containers.find((container) => container.state.state !== "running" || container.restarts > 0 || !container.ready);
    return trouble ?? detail.containers[0] ?? detail.initContainers[0] ?? null;
}

// --- actions (POST .../k8s/...) ---

// restart      `rollout restart <kind>/<name>`
// scale        `scale <kind>/<name> --replicas=<n>`
// delete-pod   `delete pod <name> --wait=false`
// cordon / uncordon `<action> <node>`
// use-context  `config use-context <context>` (changes kubectl's own default)
export type K8sAction = "restart" | "scale" | "delete-pod" | "cordon" | "uncordon" | "use-context";

export type K8sActionResult = {
    ok: true;
    // The command as it ran (also what the audit log records).
    command: string;
    output: string;
};

// --- live pod logs (socket.io "logs-start", see shared/ops.ts) ---

export const POD_LOG_TAIL_OPTIONS = [100, 500, 2000, 10_000] as const;
export const POD_LOG_MAX_TAIL = 50_000;

export type PodLogSource = {
    kind: "pod";
    context: string;
    namespace: string;
    pod: string;
    container: string;
    // The logs of the previous (crashed) instance of the container.
    previous?: boolean;
    // Lines of backlog (POD_LOG_TAIL_OPTIONS; 100 by default).
    tail?: number;
    // Keep streaming new lines (`-f`); off: the backlog only.
    follow?: boolean;
    timestamps?: boolean;
};

// --- pod terminal (StartSshPayload.attach) ---

// A shell inside a container of a pod: `kubectl exec -it` on a pty of the
// server's SSH connection, or on this machine for a local kubectl server.
// bash when the container has it, else sh.
export type PodTerminalAttach = {
    kind: "pod";
    context: string;
    namespace: string;
    pod: string;
    container: string;
};
