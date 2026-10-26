import { describe, expect, it, vi } from 'vitest';
import type { K8sPod, K8sStatus, K8sWorkload } from '@shared/k8s';
import { setLanguage, t } from '@/i18n';
import { defaultLogContainer, defaultNamespace, filterPods, formatAge, initialContext, loadView, podDeletion, saveView, sortPods, workloadPods } from './model';
import { podShellUnavailable } from './shell';

const pod = (name: string, extra: Partial<K8sPod> = {}): K8sPod => ({
    name, namespace: 'ns', phase: 'Running', status: 'Running', ready: 1, total: 1, restarts: 0, lastRestartAt: null, node: null, ip: null,
    createdAt: null, containers: ['app'], running: ['app'], owner: null, problem: null, labels: {}, ...extra
});

const workload = (extra: Partial<K8sWorkload>): K8sWorkload => ({
    kind: 'deployment', name: 'web', namespace: 'ns', ready: 1, desired: 1, upToDate: 1, available: 1, images: [], createdAt: null, health: 'ok', condition: null, selector: {}, ...extra
});

const status = (extra: Partial<K8sStatus> = {}): K8sStatus => ({
    runner: 'ssh', available: true, problem: null, kubectl: null, sudo: false, installUrl: '', detectedAt: 0, unsupportedContexts: [],
    contexts: [{ name: 'a', cluster: null, server: null, namespace: 'apps', user: null }, { name: 'b', cluster: null, server: null, namespace: null, user: null }],
    currentContext: 'b',
    ...extra
});

describe('k8s model', () => {
    it("words ages like kubectl's AGE column", () => {
        const now = Date.parse('2026-10-24T12:00:00Z');
        expect(formatAge('2026-10-24T11:59:15Z', now)).toBe('45s');
        expect(formatAge('2026-10-24T11:48:00Z', now)).toBe('12m');
        expect(formatAge('2026-10-24T09:00:00Z', now)).toBe('3h');
        expect(formatAge('2026-10-19T12:00:00Z', now)).toBe('5d');
        expect(formatAge('2023-10-24T12:00:00Z', now)).toBe('3y');
        expect(formatAge(null, now)).toBe('—');
        expect(formatAge('not a date', now)).toBe('—');
    });

    it('sorts by status with problems first, by restarts and by age', () => {
        const pods = [pod('b'), pod('a', { problem: 'pending', status: 'Pending' }), pod('c', { problem: 'crash-loop', restarts: 9, createdAt: '2026-10-24T10:00:00Z' })];
        expect(sortPods(pods, { key: 'status', direction: 'asc' }).map((entry) => entry.name)).toEqual(['c', 'a', 'b']);
        expect(sortPods(pods, { key: 'restarts', direction: 'desc' })[0].name).toBe('c');
        expect(sortPods(pods, { key: 'name', direction: 'desc' }).map((entry) => entry.name)).toEqual(['c', 'b', 'a']);
    });

    it('filters by state and text', () => {
        const pods = [pod('web', { node: 'n1' }), pod('job', { phase: 'Succeeded' }), pod('bad', { problem: 'image-pull' })];
        expect(filterPods(pods, 'problems', '').map((entry) => entry.name)).toEqual(['bad']);
        expect(filterPods(pods, 'completed', '').map((entry) => entry.name)).toEqual(['job']);
        expect(filterPods(pods, 'all', 'N1').map((entry) => entry.name)).toEqual(['web']);
    });

    it("finds a workload's pods by its selector, a cronjob's through its jobs", () => {
        const pods = [
            pod('web-1', { labels: { app: 'web', tier: 'fe' } }),
            pod('web-2', { labels: { app: 'web' }, namespace: 'other' }),
            pod('report-123-x', { owner: { kind: 'Job', name: 'report-123' } }),
            pod('reporting-1', { owner: { kind: 'Job', name: 'reporting' } })
        ];
        expect(workloadPods(workload({ selector: { app: 'web' } }), pods).map((entry) => entry.name)).toEqual(['web-1']);
        expect(workloadPods(workload({ kind: 'cronjob', name: 'report' }), pods).map((entry) => entry.name)).toEqual(['report-123-x']);
    });

    it("starts on the remembered context, else kubectl's current one, with its namespace", () => {
        expect(initialContext(status(), 'a')).toBe('a');
        expect(initialContext(status(), 'gone')).toBe('b');
        expect(initialContext(status({ currentContext: null }))).toBe('a');
        expect(initialContext(status({ contexts: [] }))).toBeNull();
        expect(defaultNamespace(status(), 'a')).toBe('apps');
        expect(defaultNamespace(status(), 'b')).toBe('default');
    });

    it('opens a shell in any running container, ready or not', () => {
        setLanguage('en');
        // Running 0/1: its readiness probe fails, its container runs.
        expect(podShellUnavailable(pod('notready', { ready: 0, problem: 'not-ready' }), t)).toBeUndefined();
        // Initializing: only the init container runs.
        expect(podShellUnavailable(pod('init', { phase: 'Pending', status: 'Init:0/1', ready: 0, running: ['wait-db'] }), t)).toBeUndefined();
        expect(podShellUnavailable(pod('crash', { ready: 0, running: [], problem: 'crash-loop' }), t)).toBe('The pod has no running container to open a shell in.');
        expect(podShellUnavailable(pod('going', { problem: 'terminating' }), t)).toBe('The pod is being deleted.');
        setLanguage('system');
    });

    it("opens the logs of an initializing pod on the init container it waits for", () => {
        expect(defaultLogContainer(pod('init', { status: 'Init:0/1', running: ['wait-db'] }))).toBe('wait-db');
        // Its init container crashed (not running): the pod's own first container.
        expect(defaultLogContainer(pod('init', { status: 'Init:CrashLoopBackOff', running: [] }))).toBe('app');
        expect(defaultLogContainer(pod('web', { containers: ['nginx', 'sidecar'], running: ['nginx', 'sidecar'] }))).toBe('nginx');
    });

    it('tells what deleting a pod leads to, by its owner and whether it finished', () => {
        expect(podDeletion(pod('web-1', { owner: { kind: 'Deployment', name: 'web' } }))).toBe('replaced');
        expect(podDeletion(pod('db-0', { owner: { kind: 'StatefulSet', name: 'db' } }))).toBe('replaced');
        expect(podDeletion(pod('web-1', { owner: { kind: 'Deployment', name: 'web' }, phase: 'Failed', status: 'Evicted' }))).toBe('cleanup');
        expect(podDeletion(pod('migrate-x', { owner: { kind: 'Job', name: 'migrate' }, phase: 'Succeeded' }))).toBe('job-finished');
        expect(podDeletion(pod('migrate-x', { owner: { kind: 'Job', name: 'migrate' }, phase: 'Failed' }))).toBe('job-finished');
        expect(podDeletion(pod('report-x', { owner: { kind: 'Job', name: 'report-123' } }))).toBe('job-running');
        expect(podDeletion(pod('etcd-node1', { owner: { kind: 'Node', name: 'node1' } }))).toBe('mirror');
        expect(podDeletion(pod('rollout-x', { owner: { kind: 'Rollout', name: 'shop' } }))).toBe('other-owner');
        expect(podDeletion(pod('debug'))).toBe('unowned');
    });

    it('remembers the view per server, ignoring what it cannot read', () => {
        // No storage at all (a node test): nothing is remembered, nothing fails.
        expect(loadView(3)).toEqual({});
        const items = new Map<string, string>();
        vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) });
        expect(loadView(3)).toEqual({});
        saveView(3, { context: 'a', namespace: 'apps' });
        expect(loadView(3)).toEqual({ context: 'a', namespace: 'apps' });
        localStorage.setItem('shellmind.k8s.view.4', '{not json');
        expect(loadView(4)).toEqual({});
        vi.unstubAllGlobals();
    });
});
