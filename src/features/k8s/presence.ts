import { useEffect, useSyncExternalStore } from 'react';
import type { K8sStatus } from '@shared/k8s';
import { scopedPresetKey } from '@shared/shells';
import type { ServerSummary } from '@shared/types';
import { useAppStore } from '@/store/appStore';
import { notifyTabAvailability } from '@/workspace/tabAvailability';

// Where the Kubernetes tab shows. A local connection with the kubectl preset
// always has it (that is what it is for). A Linux server has it once kubectl
// has been found on it: looked for in the background when the server's
// terminal connects (KubectlWatcher, src/workspace/actions/kubernetes.tsx),
// remembered in this browser per server until the server is edited, and on
// demand from the command palette ("Look for kubectl on this server", which
// shows the tab whatever it finds: its "not installed" state says what to
// do). A tab in use is not taken away: once its panel is open it stays
// until the server is closed.
//
// Light on purpose: the watcher loads with the app.

type Presence = 'present' | 'absent';
type Stored = { presence: Presence; version: number | null };

const storageKey = (serverId: number) => `shellmind.k8s.presence.${serverId}`;

// Panels open now, and servers the palette asked for (this session).
const openPanels = new Set<number>();
const requested = new Set<number>();
// Servers whose panel must look for kubectl again, bypassing the backend's cache.
const redetect = new Map<number, number>();
const redetectListeners = new Set<() => void>();

function read(serverId: number): Stored | null {
    try {
        const raw = localStorage.getItem(storageKey(serverId));
        const parsed: unknown = raw ? JSON.parse(raw) : null;
        if (!parsed || typeof parsed !== 'object') return null;
        const { presence, version } = parsed as Record<string, unknown>;
        if (presence !== 'present' && presence !== 'absent') return null;
        return { presence, version: typeof version === 'number' ? version : null };
    } catch {
        return null;
    }
}

function write(serverId: number, value: Stored): void {
    try {
        localStorage.setItem(storageKey(serverId), JSON.stringify(value));
    } catch {
        // Storage full or disabled: the server is looked at again next time.
    }
}

const versionOf = (server: Pick<ServerSummary, 'updated_at'>) => server.updated_at ?? null;

// What was found on the server (null: not looked for since it was last edited).
export function k8sPresence(server: Pick<ServerSummary, 'id' | 'updated_at'>): Presence | null {
    const stored = read(server.id);
    return stored && stored.version === versionOf(server) ? stored.presence : null;
}

function isLocalKubectl(server: Pick<ServerSummary, 'type' | 'cli_preset'>): boolean {
    return server.type === 'local' && scopedPresetKey(server.cli_preset) === 'kubectl';
}

export function isKubernetesTabShown(server: Pick<ServerSummary, 'id' | 'type' | 'cli_preset' | 'updated_at'>): boolean {
    if (isLocalKubectl(server)) return true;
    if (server.type !== 'linux') return false;
    return openPanels.has(server.id) || requested.has(server.id) || k8sPresence(server) === 'present';
}

// Whether a detection found kubectl installed (a kubeconfig without
// contexts, or one it cannot read, still makes a tab worth showing: its
// state says what to fix).
export function presenceOf(status: K8sStatus): Presence {
    const code = status.problem?.code;
    return status.available || code === 'NO_CONTEXTS' || code === 'KUBECONFIG_ERROR' ? 'present' : 'absent';
}

export function recordK8sPresence(server: Pick<ServerSummary, 'id' | 'type' | 'cli_preset' | 'updated_at'>, status: K8sStatus): void {
    if (server.type !== 'linux' || typeof status?.available !== 'boolean') return;
    const shown = isKubernetesTabShown(server);
    write(server.id, { presence: presenceOf(status), version: versionOf(server) });
    if (isKubernetesTabShown(server) !== shown) notifyTabAvailability();
}

// The panel of a server is open (the tab stays while it is).
export function useOpenK8sPanel(serverId: number): void {
    useEffect(() => {
        openPanels.add(serverId);
        return () => {
            openPanels.delete(serverId);
        };
    }, [serverId]);
}

// From the command palette: the server's tab, shown at once, looking for
// kubectl again.
export function showKubernetesTab(serverId: number): void {
    requested.add(serverId);
    redetect.set(serverId, (redetect.get(serverId) ?? 0) + 1);
    redetectListeners.forEach((listener) => listener());
    notifyTabAvailability();
    useAppStore.getState().requestServerTab(serverId, 'kubernetes');
}

function subscribeRedetect(listener: () => void): () => void {
    redetectListeners.add(listener);
    return () => {
        redetectListeners.delete(listener);
    };
}

// How many times the palette asked to look again for this server (the panel
// looks again when it moves on).
export function useRedetectRequests(serverId: number): number {
    return useSyncExternalStore(subscribeRedetect, () => redetect.get(serverId) ?? 0, () => 0);
}

// For tests: forget the session's open panels and requests.
export function resetK8sPresence(): void {
    openPanels.clear();
    requested.clear();
    redetect.clear();
}
