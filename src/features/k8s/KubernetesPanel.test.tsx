import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { K8sEvent, K8sNode, K8sPod, K8sPodDetail, K8sStatus, K8sWorkload } from '@shared/k8s';
import type { LogStreamSource } from '@shared/ops';
import { ConfirmProvider } from '@/components/ui';
import { setLanguage } from '@/i18n';
import { useAppStore } from '@/store/appStore';
import type { WorkspaceServer } from '@/workspace/types';
import KubernetesPanel from './KubernetesPanel';
import { resetK8sPresence, showKubernetesTab } from './presence';

// The pod logs run over a socket; the log hook is replaced by a recorder
// (its functions stable, like the real hook's).
const logStarts: LogStreamSource[] = [];
const startLog = (source: LogStreamSource) => {
    logStarts.push(source);
};
const noop = () => undefined;
vi.mock('@/features/ops/useLogStream', () => ({
    useLogStream: () => ({
        status: 'idle', error: null, exitCode: null, buffer: { lines: [], partial: '', discarded: 0 }, pending: 0, droppedBytes: 0, paused: false, source: null,
        start: startLog, stop: noop, setPaused: noop, clear: noop
    })
}));

const STATUS: K8sStatus = {
    runner: 'ssh',
    available: true,
    problem: null,
    kubectl: { path: '/usr/local/bin/kubectl', version: 'v1.31.4' },
    sudo: false,
    contexts: [
        { name: 'prod', cluster: 'prod', server: 'https://prod:6443', namespace: 'shop', user: 'admin' },
        { name: 'staging', cluster: 'staging', server: 'https://staging:6443', namespace: null, user: 'admin' }
    ],
    currentContext: 'staging',
    unsupportedContexts: [],
    installUrl: 'https://kubernetes.io/docs/tasks/tools/',
    detectedAt: 0
};

const pod = (name: string, extra: Partial<K8sPod> = {}): K8sPod => ({
    name, namespace: 'shop', phase: 'Running', status: 'Running', ready: 1, total: 1, restarts: 0, lastRestartAt: null, node: 'node-1', ip: '10.0.0.1',
    createdAt: '2026-10-24T10:00:00Z', containers: ['app'], running: ['app'], owner: { kind: 'Deployment', name: name.split('-')[0] }, problem: null, labels: { app: name.split('-')[0] }, ...extra
});

const PODS: K8sPod[] = [
    pod('web-1', { containers: ['nginx', 'sidecar'], running: ['nginx', 'sidecar'], ready: 2, total: 2 }),
    pod('api-1', { status: 'CrashLoopBackOff', ready: 0, restarts: 7, lastRestartAt: '2026-10-24T11:00:00Z', running: [], problem: 'crash-loop' }),
    pod('migrate-1', { phase: 'Succeeded', status: 'Completed', ready: 0, running: [], owner: { kind: 'Job', name: 'migrate' }, labels: {} })
];

const DETAIL: K8sPodDetail = {
    pod: PODS[1],
    hostIp: '192.168.1.10', qosClass: 'BestEffort', serviceAccount: 'default', startedAt: '2026-10-24T10:00:00Z',
    conditions: [{ type: 'Ready', status: 'False', reason: 'ContainersNotReady', message: null, lastTransitionAt: null }],
    containers: [{
        name: 'app', image: 'api:1.2', init: false, sidecar: false, ready: false, restarts: 7,
        state: { state: 'waiting', reason: 'CrashLoopBackOff', message: 'back-off 5m0s', exitCode: null, signal: null, startedAt: null, finishedAt: null },
        lastState: { state: 'terminated', reason: 'OOMKilled', message: null, exitCode: 137, signal: null, startedAt: null, finishedAt: '2026-10-24T11:00:00Z' },
        ports: ['8080/TCP'], env: [{ name: 'DB_PASSWORD', value: 'hunter2', from: null }, { name: 'TOKEN', value: null, from: 'secret api/token' }], envFrom: [],
        requests: { memory: '64Mi' }, limits: { memory: '128Mi' }, command: 'api --serve'
    }],
    initContainers: [],
    volumes: [],
    events: [{ type: 'Warning', reason: 'BackOff', message: 'Back-off restarting failed container', namespace: 'shop', object: { kind: 'Pod', name: 'api-1' }, count: 9, firstAt: null, lastAt: '2026-10-24T11:00:00Z', source: 'kubelet' }]
};

const WORKLOADS: K8sWorkload[] = [
    { kind: 'deployment', name: 'web', namespace: 'shop', ready: 1, desired: 1, upToDate: 1, available: 1, images: ['nginx:1.27'], createdAt: null, health: 'ok', condition: null, selector: { app: 'web' } },
    { kind: 'deployment', name: 'api', namespace: 'shop', ready: 0, desired: 1, upToDate: 1, available: 0, images: ['api:1.2'], createdAt: null, health: 'degraded', condition: { type: 'Available', reason: 'MinimumReplicasUnavailable', message: 'Deployment does not have minimum availability.' }, selector: { app: 'api' } },
    { kind: 'job', name: 'migrate', namespace: 'shop', ready: 1, desired: 1, upToDate: null, available: null, images: ['busybox'], createdAt: null, health: 'ok', condition: null, selector: {}, failed: 0, completedAt: null }
];

const EVENTS: K8sEvent[] = [
    DETAIL.events[0],
    { type: 'Normal', reason: 'Pulled', message: 'Image pulled', namespace: 'shop', object: { kind: 'Pod', name: 'web-1' }, count: 1, firstAt: null, lastAt: '2026-10-24T10:00:00Z', source: 'kubelet' }
];

const NODES: K8sNode[] = [{
    name: 'node-1', ready: true, unschedulable: false, roles: ['worker'], version: 'v1.31.4', internalIp: '10.0.0.10', osImage: 'Ubuntu', kernel: '6.1', runtime: 'containerd://1.7',
    createdAt: null, pressures: [], capacity: { cpu: '4', memory: '8Gi', pods: '110' }, taints: 0
}];

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

let fetchMock: ReturnType<typeof vi.fn>;
let status: K8sStatus;
let pods: K8sPod[];
let detail: K8sPodDetail;

function route(url: string, init?: RequestInit): Response {
    const { pathname, searchParams } = new URL(url);
    const method = init?.method ?? 'GET';
    const tail = pathname.replace(/^\/api\/servers\/\d+\/k8s\//, '');
    if (tail === 'status') return json(status);
    if (tail === 'namespaces') return json({ namespaces: ['default', 'shop'] });
    if (tail === 'pods') return json({ pods: searchParams.get('context') === 'staging' ? [] : pods, truncated: false });
    if (tail === `pods/${detail.pod.name}`) return json(detail);
    if (tail === 'workloads') return json({ workloads: WORKLOADS, warnings: [] });
    if (tail === 'events') return json({ events: EVENTS });
    if (tail === 'nodes') return json({ nodes: NODES });
    if (method === 'POST') return json({ ok: true, command: `kubectl ${tail}`, output: '' });
    return json({ error: `unexpected ${method} ${pathname}` }, 404);
}

const server: WorkspaceServer = { id: 7, name: 'bastion', ip: '10.0.0.7', type: 'linux' };

function renderPanel(isActive = true) {
    return render(<ConfirmProvider><KubernetesPanel server={server} isActive={isActive} /></ConfirmProvider>);
}

const calls = (method: string, pattern: RegExp) => fetchMock.mock.calls.filter(([url, init]) => (init?.method ?? 'GET') === method && pattern.test(String(url)));
const bodyOf = (call: unknown[]) => JSON.parse(String((call[1] as RequestInit).body)) as Record<string, unknown>;

beforeEach(() => {
    setLanguage('en');
    status = STATUS;
    pods = PODS;
    detail = DETAIL;
    logStarts.length = 0;
    localStorage.clear();
    resetK8sPresence();
    fetchMock = vi.fn(async (url: string, init?: RequestInit) => route(url, init));
    vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setLanguage('system');
});

describe('KubernetesPanel', () => {
    it('looks for kubectl only once the tab is opened, then lists the pods of the remembered context', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        const { rerender } = renderPanel(false);
        await act(async () => { await Promise.resolve(); });
        expect(fetchMock).not.toHaveBeenCalled();
        rerender(<ConfirmProvider><KubernetesPanel server={server} isActive /></ConfirmProvider>);
        expect(await screen.findByText('api-1')).toBeInTheDocument();
        expect(calls('GET', /\/k8s\/pods\?context=prod&namespace=shop$/)).toHaveLength(1);
        expect(screen.getByRole('combobox', { name: 'Kubeconfig context' })).toHaveTextContent('prod');
        expect(screen.getByText('kubectl v1.31.4 on the server')).toBeInTheDocument();
        // The count of failing pods on the Pods tab.
        expect(screen.getByRole('tab', { name: /Pods/ })).toHaveTextContent('1');
        expect(screen.getByRole('tab', { name: /Pods/ })).toHaveAccessibleName(/1 pod failing/);
    });

    it("starts on kubectl's current context and its namespace", async () => {
        renderPanel();
        await waitFor(() => expect(calls('GET', /\/k8s\/pods\?/)).toHaveLength(1));
        expect(calls('GET', /\/k8s\/pods\?context=staging&namespace=default$/)).toHaveLength(1);
        expect(await screen.findByText('No pods here')).toBeInTheDocument();
    });

    it('says what is missing, with the install guide, and checks again on demand', async () => {
        status = { ...STATUS, available: false, problem: { code: 'KUBECTL_MISSING', message: 'kubectl was not found' }, kubectl: null, contexts: [], currentContext: null };
        renderPanel();
        expect(await screen.findByText('kubectl is not installed on this server')).toBeInTheDocument();
        expect(screen.getByRole('link', { name: 'How to install kubectl' })).toHaveAttribute('href', 'https://kubernetes.io/docs/tasks/tools/');
        status = STATUS;
        fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
        await waitFor(() => expect(calls('GET', /\/k8s\/status\?refresh=1$/)).toHaveLength(1));
        expect(await screen.findByRole('tab', { name: /Workloads/ })).toBeInTheDocument();
    });

    it('filters, searches and sorts the pods', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        await screen.findByText('api-1');
        const rows = () => screen.getAllByRole('row').slice(1).map((row) => within(row).getAllByRole('button')[0].textContent);
        // Problems first by default.
        expect(rows()[0]).toContain('api-1');

        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Show pods' })).getByRole('radio', { name: /Needs attention/ }));
        expect(rows()).toHaveLength(1);
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Show pods' })).getByRole('radio', { name: /All/ }));

        fireEvent.change(screen.getByRole('searchbox', { name: 'Search pods, nodes, containers' }), { target: { value: 'sidecar' } });
        expect(rows()).toEqual([expect.stringContaining('web-1')]);
        fireEvent.change(screen.getByRole('searchbox', { name: 'Search pods, nodes, containers' }), { target: { value: '' } });

        fireEvent.click(screen.getByRole('button', { name: 'Name' }));
        expect(screen.getByRole('columnheader', { name: /Name/ })).toHaveAttribute('aria-sort', 'ascending');
        expect(rows()[0]).toContain('api-1');
        expect(rows()[2]).toContain('web-1');
    });

    it('opens a pod: last state, masked environment, logs of the container in trouble', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /^api-1/ }));
        const detail = await screen.findByRole('region', { name: 'Pod api-1' });
        expect(await within(detail).findByText('Terminated: OOMKilled')).toBeInTheDocument();
        expect(within(detail).getByText('exit code 137')).toBeInTheDocument();
        expect(within(detail).queryByText('hunter2')).toBeNull();
        expect(within(detail).getByText('from secret api/token')).toBeInTheDocument();
        fireEvent.click(within(detail).getByText('Environment'));
        fireEvent.click(within(detail).getByRole('button', { name: 'Show DB_PASSWORD' }));
        expect(within(detail).getByText('hunter2')).toBeInTheDocument();

        fireEvent.click(within(detail).getByRole('tab', { name: 'Logs' }));
        await waitFor(() => expect(logStarts).toHaveLength(1));
        expect(logStarts[0]).toEqual({ kind: 'pod', context: 'prod', namespace: 'shop', pod: 'api-1', container: 'app', previous: false, tail: 500, follow: true, timestamps: true });
        fireEvent.click(within(detail).getByRole('button', { name: 'Previous instance' }));
        await waitFor(() => expect(logStarts).toHaveLength(2));
        expect(logStarts[1]).toMatchObject({ previous: true, follow: false });
    });

    it('deletes a pod only after confirming, telling what replaces it', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /^api-1/ }));
        const detail = await screen.findByRole('region', { name: 'Pod api-1' });
        fireEvent.click(within(detail).getByRole('button', { name: 'Delete pod' }));
        expect(await screen.findByText(/Its Deployment api creates a new pod to replace it/)).toBeInTheDocument();
        expect(calls('POST', /delete$/)).toHaveLength(0);
        const buttons = screen.getAllByRole('button', { name: 'Delete pod' });
        fireEvent.click(buttons[buttons.length - 1]);
        await waitFor(() => expect(calls('POST', /\/k8s\/pods\/api-1\/delete$/)).toHaveLength(1));
        expect(bodyOf(calls('POST', /delete$/)[0])).toEqual({ context: 'prod', namespace: 'shop' });
    });

    it("opens a shell in the pod's container as a terminal tab of the server", async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        const open = vi.spyOn(useAppStore.getState(), 'openTerminalSession');
        const tab = vi.spyOn(useAppStore.getState(), 'requestServerTab');
        renderPanel();
        await screen.findByText('web-1');
        expect(screen.getByRole('button', { name: 'Open a shell in api-1' })).toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Open a shell in web-1' }));
        expect(open).toHaveBeenCalledWith(7, { attach: { kind: 'pod', context: 'prod', namespace: 'shop', pod: 'web-1', container: 'nginx' } });
        expect(tab).toHaveBeenCalledWith(7, 'terminal');
    });

    it('scales a deployment with the number entered, and shows its pods', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        await screen.findByText('api-1');
        fireEvent.click(screen.getByRole('tab', { name: /Workloads/ }));
        expect(await screen.findByText('Degraded')).toBeInTheDocument();
        expect(screen.getByText('Complete')).toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Actions for web' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: 'Scale…' }));
        const dialog = await screen.findByRole('dialog', { name: 'Scale Deployment web' });
        fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '0' } });
        expect(within(dialog).getByText(/every pod of it stops/)).toBeInTheDocument();
        fireEvent.change(within(dialog).getByRole('spinbutton', { name: 'Replicas' }), { target: { value: '3' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Scale' }));
        await waitFor(() => expect(calls('POST', /\/k8s\/workloads\/deployment\/web\/scale$/)).toHaveLength(1));
        expect(bodyOf(calls('POST', /scale$/)[0])).toEqual({ context: 'prod', namespace: 'shop', replicas: 3 });

        fireEvent.click(screen.getByRole('button', { name: /^api/ }));
        expect(screen.getByRole('tab', { name: /Pods/ })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByText('Pods of Deployment api')).toBeInTheDocument();
        expect(screen.queryByText('web-1')).toBeNull();
    });

    it('lists events warnings first and opens the pod an event is about', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        await screen.findByText('api-1');
        fireEvent.click(screen.getByRole('tab', { name: /Events/ }));
        expect(await screen.findByText('BackOff')).toBeInTheDocument();
        fireEvent.click(within(screen.getByRole('radiogroup', { name: 'Show events' })).getByRole('radio', { name: /Warnings/ }));
        expect(screen.queryByText('Pulled')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Pod/api-1' }));
        expect(await screen.findByRole('region', { name: 'Pod api-1' })).toBeInTheDocument();
    });

    it('cordons a node after confirming', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        await screen.findByText('api-1');
        fireEvent.click(screen.getByRole('tab', { name: /Nodes/ }));
        fireEvent.click(await screen.findByRole('button', { name: 'Cordon' }));
        expect(await screen.findByText(/cordoning does not drain the node/)).toBeInTheDocument();
        const buttons = screen.getAllByRole('button', { name: 'Cordon' });
        fireEvent.click(buttons[buttons.length - 1]);
        await waitFor(() => expect(calls('POST', /\/k8s\/nodes\/node-1\/cordon$/)).toHaveLength(1));
    });

    it('opens a namespace typed by hand (one the user may not list)', async () => {
        renderPanel();
        await screen.findByText('No pods here');
        fireEvent.click(screen.getByRole('combobox', { name: 'Namespace' }));
        fireEvent.click(await screen.findByRole('option', { name: 'Other namespace…' }));
        const dialog = await screen.findByRole('dialog', { name: 'Open another namespace' });
        const input = within(dialog).getByRole('textbox', { name: 'Namespace' });
        fireEvent.change(input, { target: { value: 'Team_A' } });
        expect(within(dialog).getByText(/Lowercase letters/)).toBeInTheDocument();
        fireEvent.change(input, { target: { value: 'team-a' } });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Open' }));
        await waitFor(() => expect(calls('GET', /\/k8s\/pods\?context=staging&namespace=team-a$/)).toHaveLength(1));
        expect(screen.getByRole('combobox', { name: 'Namespace' })).toHaveTextContent('team-a');
    });

    it("switches contexts for the tab only; kubectl's own changes only when asked", async () => {
        renderPanel();
        await screen.findByText('No pods here');
        fireEvent.click(screen.getByRole('combobox', { name: 'Kubeconfig context' }));
        fireEvent.click(await screen.findByRole('option', { name: /^prod/ }));
        expect(await screen.findByText('api-1')).toBeInTheDocument();
        expect(calls('GET', /\/k8s\/pods\?context=prod&namespace=shop$/)).toHaveLength(1);
        expect(calls('POST', /use-context/)).toHaveLength(0);
        expect(JSON.parse(localStorage.getItem('shellmind.k8s.view.7') ?? '{}')).toEqual({ context: 'prod', namespace: 'shop' });

        fireEvent.click(screen.getByRole('button', { name: 'More' }));
        fireEvent.click(await screen.findByRole('menuitem', { name: "Make it kubectl's current context" }));
        expect(await screen.findByText(/also outside ShellMind/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Make current' }));
        await waitFor(() => expect(calls('POST', /\/k8s\/use-context$/)).toHaveLength(1));
        expect(bodyOf(calls('POST', /use-context$/)[0])).toEqual({ context: 'prod' });
    });

    it('lets a listing slower than the auto-refresh finish, and refreshes a while after its answer', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
        try {
            localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
            // A cluster whose credential plugin takes 15 s (aws eks get-token, a big namespace...).
            // Each pods request: whether it was cut short (aborted before its answer).
            const requests: Array<{ cut: boolean }> = [];
            fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
                if (/\/k8s\/pods\?/.test(url)) {
                    const request = { cut: false, answered: false };
                    requests.push(request);
                    init?.signal?.addEventListener('abort', () => {
                        if (!request.answered) request.cut = true;
                    });
                    await new Promise((resolve) => setTimeout(resolve, 15_000));
                    request.answered = true;
                }
                return route(url, init);
            });
            // Fake time passes; the real event loop turns too (response bodies,
            // React), on Node's setImmediate, which stays real.
            const { setImmediate: nextTurn } = globalThis as unknown as { setImmediate: (callback: () => void) => void };
            const pass = async (ms: number) => {
                await act(async () => {
                    await vi.advanceTimersByTimeAsync(ms);
                    for (let turn = 0; turn < 20; turn++) await new Promise<void>((resolve) => nextTurn(resolve));
                });
            };
            renderPanel();
            // kubectl found, the pods asked for.
            await pass(0);
            expect(requests).toHaveLength(1);
            await pass(14_000);
            expect(requests).toHaveLength(1);
            await pass(2_000);
            expect(screen.getByText('api-1')).toBeInTheDocument();
            // The next load 10 s after the answer, not while it was coming.
            await pass(8_000);
            expect(requests).toHaveLength(1);
            await pass(3_000);
            expect(requests).toHaveLength(2);
            // Refresh while that load runs leaves it to finish.
            fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
            await pass(100);
            expect(requests).toHaveLength(2);
            await pass(15_000);
            expect(requests.filter((request) => request.cut)).toHaveLength(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it('opens a shell in a running pod that is not ready (failing its readiness probe)', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        pods = [pod('notready-1', { ready: 0, problem: 'not-ready', running: ['app'] })];
        const open = vi.spyOn(useAppStore.getState(), 'openTerminalSession');
        renderPanel();
        const button = await screen.findByRole('button', { name: 'Open a shell in notready-1' });
        expect(button).not.toHaveAttribute('aria-disabled', 'true');
        fireEvent.click(button);
        expect(open).toHaveBeenCalledWith(7, { attach: { kind: 'pod', context: 'prod', namespace: 'shop', pod: 'notready-1', container: 'app' } });
    });

    it('offers the running init container of a pod that is initializing, for its shell and its logs', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        const initPod = pod('init-stuck', { phase: 'Pending', status: 'Init:0/1', ready: 0, running: ['wait-db'], problem: 'pending', owner: null });
        const waiting = { state: 'waiting' as const, reason: 'PodInitializing', message: null, exitCode: null, signal: null, startedAt: null, finishedAt: null };
        const running = { state: 'running' as const, reason: null, message: null, exitCode: null, signal: null, startedAt: '2026-10-24T10:00:00Z', finishedAt: null };
        const container = DETAIL.containers[0];
        pods = [initPod];
        detail = {
            ...DETAIL,
            pod: initPod,
            containers: [{ ...container, restarts: 0, state: waiting, lastState: null, env: [] }],
            initContainers: [{ ...container, name: 'wait-db', init: true, restarts: 0, state: running, lastState: null, env: [] }],
            events: []
        };
        const open = vi.spyOn(useAppStore.getState(), 'openTerminalSession');
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /^init-stuck/ }));
        const pane = await screen.findByRole('region', { name: 'Pod init-stuck' });
        await within(pane).findByText('PodInitializing', { exact: false });
        fireEvent.click(within(pane).getByRole('button', { name: 'Shell' }));
        expect(open).toHaveBeenCalledWith(7, { attach: { kind: 'pod', context: 'prod', namespace: 'shop', pod: 'init-stuck', container: 'wait-db' } });
        fireEvent.click(within(pane).getByRole('tab', { name: 'Logs' }));
        await waitFor(() => expect(logStarts).toHaveLength(1));
        expect(logStarts[0]).toMatchObject({ pod: 'init-stuck', container: 'wait-db' });
    });

    it("says a finished Job's pod is gone for good when deleted", async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /^migrate-1/ }));
        const pane = await screen.findByRole('region', { name: 'Pod migrate-1' });
        fireEvent.click(within(pane).getByRole('button', { name: 'Delete pod' }));
        expect(await screen.findByText('The pod has finished and its Job migrate will not run it again: the pod and its logs are gone for good.')).toBeInTheDocument();
        expect(screen.queryByText(/creates a new pod to replace it/)).toBeNull();
    });

    it('lists the contexts it cannot use, disabled and explained, instead of leaving them out', async () => {
        status = { ...STATUS, unsupportedContexts: ['my ctx'] };
        renderPanel();
        await screen.findByText('No pods here');
        fireEvent.click(screen.getByRole('combobox', { name: 'Kubeconfig context' }));
        const option = await screen.findByRole('option', { name: /my ctx/ });
        expect(option).toHaveAttribute('aria-disabled', 'true');
        expect(option).toHaveTextContent('Cannot be used: its name has blanks, quotes or shell characters');
        fireEvent.click(option);
        expect(screen.getByRole('combobox', { name: 'Kubeconfig context' })).toHaveTextContent('staging');
    });

    it('looks for kubectl again, past the backend cache, when the command palette asks', async () => {
        status = { ...STATUS, available: false, problem: { code: 'KUBECTL_MISSING', message: 'kubectl was not found' }, kubectl: null, contexts: [], currentContext: null };
        renderPanel();
        expect(await screen.findByText('kubectl is not installed on this server')).toBeInTheDocument();
        expect(calls('GET', /\/k8s\/status$/)).toHaveLength(1);
        status = STATUS;
        act(() => showKubernetesTab(7));
        await waitFor(() => expect(calls('GET', /\/k8s\/status\?refresh=1$/)).toHaveLength(1));
        expect(await screen.findByRole('tab', { name: /Workloads/ })).toBeInTheDocument();
    });

    it('points every view tab and pod tab at a panel that exists', async () => {
        localStorage.setItem('shellmind.k8s.view.7', JSON.stringify({ context: 'prod', namespace: 'shop' }));
        renderPanel();
        fireEvent.click(await screen.findByRole('button', { name: /^api-1/ }));
        await screen.findByRole('region', { name: 'Pod api-1' });
        const tabs = screen.getAllByRole('tab');
        expect(tabs.length).toBe(7);
        for (const tab of tabs) {
            const id = tab.getAttribute('aria-controls');
            expect(id && document.getElementById(id), `${tab.textContent} controls ${id}`).toBeTruthy();
            expect(document.getElementById(id ?? '')).toHaveAttribute('role', 'tabpanel');
        }
    });
});
