import { K8S_ALL_NAMESPACES, type K8sHealth, type K8sPod, type K8sPodProblem, type K8sStatus, type K8sWorkload } from '@shared/k8s';
import type { BadgeTone } from '@/features/ops/ui';

// Pure helpers of the Kubernetes tab: ages, tones, sorting, filtering and
// the context/namespace a server's tab remembers.

// kubectl's AGE column: "45s", "12m", "3h", "5d", "2y".
export function formatAge(iso: string | null | undefined, now = Date.now()): string {
    const at = iso ? Date.parse(iso) : NaN;
    if (!Number.isFinite(at)) return '—';
    const seconds = Math.max(0, Math.floor((now - at) / 1000));
    if (seconds < 120) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 120) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 48) return `${hours}h`;
    const days = Math.floor(hours / 24);
    return days < 730 ? `${days}d` : `${Math.floor(days / 365)}y`;
}

export const PROBLEM_TONE: Record<K8sPodProblem, BadgeTone> = {
    'crash-loop': 'bad',
    'image-pull': 'bad',
    'config-error': 'bad',
    'oom-killed': 'bad',
    failed: 'bad',
    evicted: 'warn',
    pending: 'warn',
    'not-ready': 'warn',
    terminating: 'idle'
};

export function podTone(pod: Pick<K8sPod, 'problem' | 'phase'>): BadgeTone {
    if (pod.problem) return PROBLEM_TONE[pod.problem];
    return pod.phase === 'Running' ? 'ok' : 'idle';
}

export const HEALTH_TONE: Record<K8sHealth, BadgeTone> = {
    ok: 'ok',
    progressing: 'warn',
    degraded: 'bad',
    failed: 'bad',
    idle: 'idle',
    suspended: 'idle'
};

// Problems that need someone, first in the "problems" filter.
export const SERIOUS: ReadonlySet<K8sPodProblem> = new Set(['crash-loop', 'image-pull', 'config-error', 'oom-killed', 'failed']);

export type PodSortKey = 'name' | 'status' | 'restarts' | 'age' | 'node';
export type SortState<K extends string> = { key: K; direction: 'asc' | 'desc' };

const PROBLEM_RANK: Record<K8sPodProblem, number> = {
    'crash-loop': 0, 'image-pull': 1, 'config-error': 2, 'oom-killed': 3, failed: 4, evicted: 5, pending: 6, 'not-ready': 7, terminating: 8
};
const rank = (pod: K8sPod) => (pod.problem ? PROBLEM_RANK[pod.problem] : 9);
const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);

export function sortPods(pods: K8sPod[], sort: SortState<PodSortKey>): K8sPod[] {
    const sign = sort.direction === 'asc' ? 1 : -1;
    const byName = (a: K8sPod, b: K8sPod) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name);
    const compare: Record<PodSortKey, (a: K8sPod, b: K8sPod) => number> = {
        name: byName,
        // Ascending: what needs attention first.
        status: (a, b) => rank(a) - rank(b) || a.status.localeCompare(b.status),
        restarts: (a, b) => a.restarts - b.restarts,
        // Ascending: the youngest first (like a smaller AGE).
        age: (a, b) => time(b.createdAt) - time(a.createdAt),
        node: (a, b) => (a.node ?? '').localeCompare(b.node ?? '')
    };
    return [...pods].sort((a, b) => sign * compare[sort.key](a, b) || byName(a, b));
}

export type PodFilter = 'all' | 'problems' | 'running' | 'completed';

export function filterPods(pods: K8sPod[], filter: PodFilter, query: string): K8sPod[] {
    const needle = query.trim().toLowerCase();
    return pods.filter((pod) => {
        if (filter === 'problems' && !pod.problem) return false;
        if (filter === 'running' && pod.phase !== 'Running') return false;
        if (filter === 'completed' && pod.phase !== 'Succeeded' && pod.phase !== 'Failed') return false;
        if (!needle) return true;
        return [pod.name, pod.namespace, pod.status, pod.node ?? '', pod.owner?.name ?? '', ...pod.containers].some((value) => value.toLowerCase().includes(needle));
    });
}

// The pods a workload runs: by its selector, or (a cronjob) through the
// jobs it created, which are named after it.
export function workloadPods(workload: K8sWorkload, pods: K8sPod[]): K8sPod[] {
    const inNamespace = pods.filter((pod) => pod.namespace === workload.namespace);
    if (workload.kind === 'cronjob') {
        return inNamespace.filter((pod) => pod.owner?.kind === 'Job' && pod.owner.name.startsWith(`${workload.name}-`));
    }
    const selector = Object.entries(workload.selector);
    if (!selector.length) return inNamespace.filter((pod) => pod.owner?.name === workload.name);
    return inNamespace.filter((pod) => selector.every(([key, value]) => pod.labels[key] === value));
}

// The container a pod's logs open on before its detail is known: while it
// initializes, the init container running now; else its first container.
export function defaultLogContainer(pod: Pick<K8sPod, 'status' | 'containers' | 'running'>): string | null {
    if (pod.status.startsWith('Init:')) {
        const init = pod.running.find((name) => !pod.containers.includes(name));
        if (init) return init;
    }
    return pod.containers[0] ?? null;
}

// What deleting a pod leads to, for its confirmation:
// replaced      a controller that keeps a number of pods running starts a new one
// cleanup       such a pod that has already stopped (evicted, completed):
//               its controller replaced it before; deleting only clears it away
// job-running   a Job's pod at work: the Job may retry (within its limit)
// job-finished  a Job's pod that ended: nothing runs it again
// mirror        a static pod's mirror: its node's kubelet puts it back
// other-owner   another controller (an operator's resource) decides
// unowned       a bare pod: gone for good
export type PodDeletion = 'replaced' | 'cleanup' | 'job-running' | 'job-finished' | 'mirror' | 'other-owner' | 'unowned';

const REPLACING_OWNERS = new Set(['Deployment', 'ReplicaSet', 'StatefulSet', 'DaemonSet', 'ReplicationController']);

export function podDeletion(pod: Pick<K8sPod, 'owner' | 'phase'>): PodDeletion {
    const finished = pod.phase === 'Succeeded' || pod.phase === 'Failed';
    if (!pod.owner) return 'unowned';
    if (pod.owner.kind === 'Node') return 'mirror';
    if (REPLACING_OWNERS.has(pod.owner.kind)) return finished ? 'cleanup' : 'replaced';
    if (pod.owner.kind === 'Job') return finished ? 'job-finished' : 'job-running';
    return 'other-owner';
}

// --- the context and namespace a server's tab shows ---

export type K8sView = { context: string; namespace: string };

const prefsKey = (serverId: number) => `shellmind.k8s.view.${serverId}`;

export function loadView(serverId: number): Partial<K8sView> {
    try {
        const raw = localStorage.getItem(prefsKey(serverId));
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return {};
        const { context, namespace } = parsed as Record<string, unknown>;
        return { ...(typeof context === 'string' ? { context } : {}), ...(typeof namespace === 'string' ? { namespace } : {}) };
    } catch {
        return {};
    }
}

export function saveView(serverId: number, view: K8sView): void {
    try {
        localStorage.setItem(prefsKey(serverId), JSON.stringify(view));
    } catch {
        // Storage full or disabled: the tab forgets the choice.
    }
}

// The context to show: the remembered one if the kubeconfig still has it,
// else kubectl's current context, else the first one.
export function initialContext(status: K8sStatus, remembered?: string): string | null {
    const names = status.contexts.map((context) => context.name);
    if (remembered && names.includes(remembered)) return remembered;
    if (status.currentContext && names.includes(status.currentContext)) return status.currentContext;
    return names[0] ?? null;
}

// The namespace a context starts on: its own default, else "default".
export function defaultNamespace(status: K8sStatus, context: string): string {
    return status.contexts.find((entry) => entry.name === context)?.namespace ?? 'default';
}

export const isAllNamespaces = (namespace: string) => namespace === K8S_ALL_NAMESPACES;
