import { useEffect, useRef } from 'react';
import { ShipWheel } from 'lucide-react';
import { k8sApi } from '@/features/k8s/api';
import { recordK8sPresence, showKubernetesTab } from '@/features/k8s/presence';
import { useAppStore } from '@/store/appStore';
import { useServersStore } from '@/store/servers';
import type { GlobalAction, GlobalActionProps } from './types';

// W8-T2: "Look for kubectl on this server" from the command palette shows
// the server's Kubernetes tab, which looks for kubectl again (bypassing the
// backend's cache) and says what it found. Runs once and closes.
function LookForKubectl({ onClose, server }: GlobalActionProps) {
    const done = useRef(false);
    useEffect(() => {
        if (done.current) return;
        done.current = true;
        if (server) showKubernetesTab(server.id);
        onClose();
    }, [server, onClose]);
    return null;
}

// Looks for kubectl on each Linux server once its terminal has connected
// (again each time the server is opened, or edited), so the Kubernetes tab
// shows where kubectl is (src/features/k8s/presence.ts). It rides on the
// terminal's pooled SSH connection: nothing signs in again, and a server
// that cannot be reached is not tried.
function KubectlWatcher() {
    const servers = useServersStore((state) => state.servers);
    const open = useAppStore((state) => state.openServerIds.join(','));
    const connected = useAppStore((state) => state.openServerIds.filter((id) => state.connections[id]?.state === 'connected').join(','));
    // Server id → the version (updated_at) looked at.
    const checked = useRef(new Map<number, number | null>());

    // A closed server is looked at again when it opens again.
    useEffect(() => {
        const ids = new Set(open ? open.split(',').map(Number) : []);
        for (const id of checked.current.keys()) if (!ids.has(id)) checked.current.delete(id);
    }, [open]);

    useEffect(() => {
        for (const id of connected ? connected.split(',').map(Number) : []) {
            const server = servers.find((entry) => entry.id === id);
            const version = server?.updated_at ?? null;
            if (!server || server.type !== 'linux' || (checked.current.has(id) && checked.current.get(id) === version)) continue;
            checked.current.set(id, version);
            k8sApi.status(id).then(
                (status) => recordK8sPresence(server, status),
                // Not known: looked for again on the next connection.
                () => checked.current.delete(id)
            );
        }
    }, [connected, servers]);
    return null;
}

const kubernetesAction: GlobalAction = {
    id: 'kubernetes',
    order: 76,
    labelKey: 'k8s.lookForKubectl',
    icon: ShipWheel,
    placement: 'palette',
    requiresServer: true,
    isAvailable: (server) => server?.type === 'linux',
    Component: LookForKubectl,
    Background: KubectlWatcher
};

export default kubernetesAction;
