import type { K8sPod } from '@shared/k8s';
import type { TranslateFn, TranslationParams } from '@/i18n';

// Kubernetes words the views show, in the UI language where they have one.

// A count's text: `<key>One` for exactly one ("1 pod"), `<key>` otherwise.
export function plural(t: TranslateFn, key: string, count: number, params: TranslationParams = {}): string {
    return t(count === 1 ? `${key}One` : key, { ...params, count });
}

const OWNER_KINDS = new Set(['Deployment', 'StatefulSet', 'DaemonSet', 'Job', 'CronJob', 'ReplicaSet', 'ReplicationController', 'Node']);

// "Deployment web" / "Deployment web" (the kind is translated when known).
export function ownerLabel(t: TranslateFn, owner: NonNullable<K8sPod['owner']>): string {
    return OWNER_KINDS.has(owner.kind) ? t(`k8s.owners.${owner.kind}`, { name: owner.name }) : `${owner.kind} ${owner.name}`;
}
