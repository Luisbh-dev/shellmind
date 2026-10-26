import type {
    K8sActionResult,
    K8sEvent,
    K8sNode,
    K8sPodDetail,
    K8sPodList,
    K8sStatus,
    K8sWorkloadKind,
    K8sWorkloadList
} from '@shared/k8s';
import { api } from '@/lib/api';

// Typed calls of the Kubernetes endpoints (server/http/routes/k8s.ts). Only
// names travel: the backend builds every kubectl command line.

const base = (serverId: number) => `/api/servers/${serverId}/k8s`;
const part = encodeURIComponent;
const scope = (context: string, namespace?: string) =>
    `context=${part(context)}${namespace === undefined ? '' : `&namespace=${part(namespace)}`}`;

export const k8sApi = {
    status: (serverId: number, refresh = false, signal?: AbortSignal) =>
        api.get<K8sStatus>(`${base(serverId)}/status${refresh ? '?refresh=1' : ''}`, { signal }),

    namespaces: (serverId: number, context: string, signal?: AbortSignal) =>
        api.get<{ namespaces: string[] }>(`${base(serverId)}/namespaces?${scope(context)}`, { signal }).then((body) => body.namespaces),

    workloads: (serverId: number, context: string, namespace: string, signal?: AbortSignal) =>
        api.get<K8sWorkloadList>(`${base(serverId)}/workloads?${scope(context, namespace)}`, { signal }),

    pods: (serverId: number, context: string, namespace: string, signal?: AbortSignal) =>
        api.get<K8sPodList>(`${base(serverId)}/pods?${scope(context, namespace)}`, { signal }),

    events: (serverId: number, context: string, namespace: string, signal?: AbortSignal) =>
        api.get<{ events: K8sEvent[] }>(`${base(serverId)}/events?${scope(context, namespace)}`, { signal }).then((body) => body.events),

    nodes: (serverId: number, context: string, signal?: AbortSignal) =>
        api.get<{ nodes: K8sNode[] }>(`${base(serverId)}/nodes?${scope(context)}`, { signal }).then((body) => body.nodes),

    pod: (serverId: number, context: string, namespace: string, pod: string, signal?: AbortSignal) =>
        api.get<K8sPodDetail>(`${base(serverId)}/pods/${part(pod)}?${scope(context, namespace)}`, { signal }),

    restart: (serverId: number, context: string, namespace: string, kind: K8sWorkloadKind, name: string) =>
        api.post<K8sActionResult>(`${base(serverId)}/workloads/${kind}/${part(name)}/restart`, { context, namespace }),

    scale: (serverId: number, context: string, namespace: string, kind: K8sWorkloadKind, name: string, replicas: number) =>
        api.post<K8sActionResult>(`${base(serverId)}/workloads/${kind}/${part(name)}/scale`, { context, namespace, replicas }),

    deletePod: (serverId: number, context: string, namespace: string, pod: string) =>
        api.post<K8sActionResult>(`${base(serverId)}/pods/${part(pod)}/delete`, { context, namespace }),

    cordon: (serverId: number, context: string, node: string, action: 'cordon' | 'uncordon') =>
        api.post<K8sActionResult>(`${base(serverId)}/nodes/${part(node)}/${action}`, { context }),

    useContext: (serverId: number, context: string) =>
        api.post<K8sActionResult>(`${base(serverId)}/use-context`, { context })
};
