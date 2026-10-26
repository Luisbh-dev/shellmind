import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, waitFor } from '@testing-library/react';
import type { K8sStatus } from '@shared/k8s';
import type { ServerSummary } from '@shared/types';
import { useAppStore } from '@/store/appStore';
import { resetServersStore, useServersStore } from '@/store/servers';
import kubernetesAction from '@/workspace/actions/kubernetes';
import { useTabAvailability } from '@/workspace/tabAvailability';
import { isKubernetesTabShown, k8sPresence, recordK8sPresence, resetK8sPresence, showKubernetesTab, useOpenK8sPanel, useRedetectRequests } from './presence';

// W8-T2: where the Kubernetes tab shows (src/features/k8s/presence.ts).

const STATUS: K8sStatus = {
    runner: 'ssh', available: true, problem: null, kubectl: { path: '/usr/local/bin/kubectl', version: 'v1.31.4' }, sudo: false,
    contexts: [{ name: 'default', cluster: 'default', server: 'https://k3s:6443', namespace: null, user: 'default' }],
    currentContext: 'default', unsupportedContexts: [], installUrl: '', detectedAt: 0
};
const missing = (code: 'KUBECTL_MISSING' | 'NO_CONTEXTS' | 'KUBECONFIG_ERROR' | 'UNSUPPORTED'): K8sStatus => ({ ...STATUS, available: false, problem: { code, message: '' }, contexts: [], currentContext: null });

const linux = (id: number, extra: Partial<ServerSummary> = {}): ServerSummary => ({ id, name: `host-${id}`, ip: '10.0.0.1', type: 'linux', updated_at: 1000, ...extra });

const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
    localStorage.clear();
    resetK8sPresence();
    useAppStore.setState(useAppStore.getInitialState(), true);
    resetServersStore();
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('Kubernetes tab presence', () => {
    it('shows the tab of a local kubectl connection always, of a Linux server once kubectl was found', () => {
        expect(isKubernetesTabShown({ id: 9, type: 'local', cli_preset: 'kubectl' })).toBe(true);
        expect(isKubernetesTabShown({ id: 9, type: 'local', cli_preset: 'shell' })).toBe(false);
        expect(isKubernetesTabShown({ id: 9, type: 'windows' })).toBe(false);

        const server = linux(1);
        expect(isKubernetesTabShown(server)).toBe(false);
        recordK8sPresence(server, STATUS);
        expect(isKubernetesTabShown(server)).toBe(true);
        // kubectl there, its kubeconfig to fix: the tab says what to do.
        recordK8sPresence(server, missing('NO_CONTEXTS'));
        expect(k8sPresence(server)).toBe('present');
        recordK8sPresence(server, missing('KUBECTL_MISSING'));
        expect(isKubernetesTabShown(server)).toBe(false);
        // Forgotten once the server is edited (another host, maybe).
        recordK8sPresence(server, STATUS);
        expect(isKubernetesTabShown({ ...server, updated_at: 2000 })).toBe(false);
        // Something that is not a status records nothing.
        recordK8sPresence(linux(2), {} as K8sStatus);
        expect(k8sPresence(linux(2))).toBeNull();
    });

    it('tells the workspace when the tab appears or goes, and keeps a tab whose panel is open', () => {
        const server = linux(1);
        const { result } = renderHook(() => useTabAvailability());
        const before = result.current;
        act(() => recordK8sPresence(server, STATUS));
        expect(result.current).toBe(before + 1);
        // The same finding again changes nothing.
        act(() => recordK8sPresence(server, STATUS));
        expect(result.current).toBe(before + 1);

        const panel = renderHook(() => useOpenK8sPanel(server.id));
        act(() => recordK8sPresence(server, missing('KUBECTL_MISSING')));
        expect(isKubernetesTabShown(server)).toBe(true);
        expect(result.current).toBe(before + 1);
        panel.unmount();
        expect(isKubernetesTabShown(server)).toBe(false);
    });

    it('shows the tab from the command palette and asks its panel to look again', () => {
        const server = linux(4);
        const request = vi.spyOn(useAppStore.getState(), 'requestServerTab');
        const { result } = renderHook(() => useRedetectRequests(server.id));
        expect(result.current).toBe(0);
        act(() => showKubernetesTab(server.id));
        expect(isKubernetesTabShown(server)).toBe(true);
        expect(result.current).toBe(1);
        expect(request).toHaveBeenCalledWith(4, 'kubernetes');
    });

    it('looks for kubectl on a Linux server once its terminal connects, again when it is opened again', async () => {
        const fetchMock = vi.fn(async (url: string) => json(url.includes('/servers/1/') ? STATUS : missing('KUBECTL_MISSING')));
        vi.stubGlobal('fetch', fetchMock);
        useServersStore.setState({ servers: [linux(1), linux(2), { id: 3, name: 'win', ip: '10.0.0.3', type: 'windows' }], status: 'ready', error: null });
        const Watcher = kubernetesAction.Background!;
        render(<Watcher />);
        const statusCalls = () => fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.endsWith('/k8s/status'));
        const connect = (id: number) => act(() => {
            const store = useAppStore.getState();
            store.activateServer(id);
            store.setTerminalSessionState(id, store.openTerminalSession(id), { state: 'connected' });
        });

        act(() => useAppStore.getState().activateServer(1));
        expect(statusCalls()).toEqual([]);
        connect(1);
        await waitFor(() => expect(isKubernetesTabShown(linux(1))).toBe(true));
        connect(2);
        connect(3);
        await waitFor(() => expect(statusCalls()).toHaveLength(2));
        expect(statusCalls()[1]).toMatch(/\/servers\/2\/k8s\/status$/);
        await waitFor(() => expect(k8sPresence(linux(2))).toBe('absent'));
        // Only once while the server stays open...
        connect(1);
        expect(statusCalls()).toHaveLength(2);
        act(() => {
            useAppStore.getState().closeServer(1);
        });
        // ...again when it opens again,
        connect(1);
        await waitFor(() => expect(statusCalls()).toHaveLength(3));
        // and when it was edited (another host, maybe): its tab stays.
        act(() => useServersStore.setState((state) => ({ servers: state.servers.map((entry) => (entry.id === 1 ? { ...entry, updated_at: 2000 } : entry)) })));
        await waitFor(() => expect(statusCalls()).toHaveLength(4));
        await waitFor(() => expect(isKubernetesTabShown(linux(1, { updated_at: 2000 }))).toBe(true));
    });
});
