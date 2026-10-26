import { lazyWithRetry } from '@/lib/lazy';
import { ShipWheel } from 'lucide-react';
import { isKubernetesTabShown } from '@/features/k8s/presence';
import type { WorkspaceTab } from '../types';

const KubernetesPanel = lazyWithRetry(() => import('@/features/k8s/KubernetesPanel'));

// W8-T2: contexts, workloads, pods, events, logs and pod shells, with the
// kubectl of a Linux SSH server or, for a local connection with the kubectl
// preset, of this computer. A Linux server shows the tab once kubectl has
// been found on it (src/features/k8s/presence.ts: looked for when its
// terminal connects, or from the command palette); the panel says what is
// missing (with the install guide) when kubectl or a kubeconfig is not there.
const kubernetesTab: WorkspaceTab = {
    id: 'kubernetes',
    order: 37,
    labelKey: 'k8s.tab',
    icon: ShipWheel,
    isAvailable: isKubernetesTabShown,
    Component: ({ server, isActive }) => <KubernetesPanel server={server} isActive={isActive} />
};

export default kubernetesTab;
