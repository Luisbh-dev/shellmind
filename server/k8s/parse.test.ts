import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { mapEnv, mapEvent, mapEvents, mapNamespaces, mapNodes, mapPod, mapPodDetail, mapPods, mapWorkloads, podStatusText, sortEvents } from './parse';

// Fixtures: `kubectl get ... -o json` of a real k3s cluster (v1.31) running
// the end-to-end workloads (test/e2e/k8s-k3s.test.ts): a healthy two-container
// deployment, a crash-looping one, one with an image that does not exist, a
// statefulset, a daemonset, a completed job and a cronjob.
const fixture = (name: string): unknown => JSON.parse(fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/k8s/${name}`, import.meta.url)), 'utf8'));

const pod = (status: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    metadata: { name: 'p', namespace: 'ns', ...(extra.metadata as object) },
    spec: { containers: [{ name: 'app' }], ...(extra.spec as object) },
    status
});

describe('pods', () => {
    const { pods, truncated } = mapPods(fixture('pods.json'));
    const byPrefix = (prefix: string) => pods.find((entry) => entry.name.startsWith(prefix))!;

    it('reads every pod of the namespace', () => {
        expect(truncated).toBe(false);
        expect(pods.map((entry) => entry.owner?.name).sort()).toEqual(['api', 'broken-image', 'cache', 'migrate', 'node-agent', 'web', 'web']);
        expect(pods.every((entry) => entry.namespace === 'shop')).toBe(true);
    });

    it('shows STATUS as kubectl does and flags what needs attention', () => {
        expect(byPrefix('api')).toMatchObject({ status: 'CrashLoopBackOff', problem: 'crash-loop', ready: 0, total: 1, containers: ['api'] });
        expect(byPrefix('api').restarts).toBeGreaterThan(0);
        expect(byPrefix('api').lastRestartAt).toMatch(/^\d{4}-/);
        expect(byPrefix('broken-image')).toMatchObject({ status: 'ImagePullBackOff', problem: 'image-pull' });
        expect(byPrefix('migrate')).toMatchObject({ status: 'Completed', phase: 'Succeeded', problem: null });
        expect(byPrefix('web')).toMatchObject({ status: 'Running', ready: 2, total: 2, problem: null, containers: ['nginx', 'sidecar'] });
    });

    it('names the workload a pod belongs to, a deployment for a replicaset pod', () => {
        expect(byPrefix('web').owner).toEqual({ kind: 'Deployment', name: 'web' });
        expect(byPrefix('cache').owner).toEqual({ kind: 'StatefulSet', name: 'cache' });
        expect(byPrefix('node-agent').owner).toEqual({ kind: 'DaemonSet', name: 'node-agent' });
        expect(byPrefix('migrate').owner).toEqual({ kind: 'Job', name: 'migrate' });
        expect(byPrefix('web').node).toBe('k3s');
        expect(byPrefix('web').labels.app).toBe('web');
    });

    it('caps a huge list and says so', () => {
        const capped = mapPods(fixture('pods.json'), 2);
        expect(capped.pods).toHaveLength(2);
        expect(capped.truncated).toBe(true);
    });

    it('words init containers, terminating pods and OOM kills', () => {
        const init = pod({ phase: 'Pending', initContainerStatuses: [{ name: 'setup', state: { waiting: { reason: 'PodInitializing' } } }] }, { spec: { initContainers: [{ name: 'setup' }], containers: [{ name: 'app' }] } });
        expect(podStatusText(init)).toBe('Init:0/1');
        const initCrash = pod({ phase: 'Pending', initContainerStatuses: [{ name: 'setup', restartCount: 12, state: { waiting: { reason: 'CrashLoopBackOff' } } }], containerStatuses: [{ name: 'app', restartCount: 0, state: { waiting: { reason: 'PodInitializing' } } }] }, { spec: { initContainers: [{ name: 'setup' }], containers: [{ name: 'app' }] } });
        // RESTARTS as kubectl counts them while the pod initializes: its init containers'.
        expect(mapPod(initCrash)).toMatchObject({ status: 'Init:CrashLoopBackOff', problem: 'crash-loop', restarts: 12, running: [] });
        // Then its containers' and its sidecars' (init containers that keep running).
        const withSidecar = pod(
            { phase: 'Running', conditions: [{ type: 'Initialized', status: 'True' }], initContainerStatuses: [{ name: 'setup', restartCount: 5, state: { terminated: { exitCode: 0, reason: 'Completed' } } }, { name: 'proxy', restartCount: 2, started: true, state: { running: {} } }], containerStatuses: [{ name: 'app', restartCount: 1, ready: true, state: { running: {} } }] },
            { spec: { initContainers: [{ name: 'setup' }, { name: 'proxy', restartPolicy: 'Always' }], containers: [{ name: 'app' }] } }
        );
        expect(mapPod(withSidecar)).toMatchObject({ status: 'Running', restarts: 3, running: ['app', 'proxy'] });
        const deleting = pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: true, state: { running: {} } }] }, { metadata: { deletionTimestamp: '2026-10-24T10:00:00Z' } });
        expect(mapPod(deleting)).toMatchObject({ status: 'Terminating', problem: 'terminating' });
        const oom = pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: true, restartCount: 3, state: { running: {} }, lastState: { terminated: { reason: 'OOMKilled', exitCode: 137, finishedAt: '2026-10-24T09:00:00Z' } } }] });
        expect(mapPod(oom)).toMatchObject({ status: 'Running', problem: 'oom-killed', restarts: 3, lastRestartAt: '2026-10-24T09:00:00Z' });
        const evicted = pod({ phase: 'Failed', reason: 'Evicted', message: 'The node was low on resource: memory.' });
        expect(mapPod(evicted)).toMatchObject({ status: 'Evicted', problem: 'evicted' });
        const config = pod({ phase: 'Pending', containerStatuses: [{ name: 'app', state: { waiting: { reason: 'CreateContainerConfigError', message: 'secret "db" not found' } } }] });
        expect(mapPod(config).problem).toBe('config-error');
        const notReady = pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, state: { running: {} } }] });
        expect(mapPod(notReady)).toMatchObject({ status: 'Running', problem: 'not-ready' });
        const exit = pod({ phase: 'Failed', containerStatuses: [{ name: 'app', state: { terminated: { exitCode: 2 } } }] });
        expect(mapPod(exit)).toMatchObject({ status: 'ExitCode:2', problem: 'failed' });
        // Between two back-offs of a crash loop.
        const between = pod({ phase: 'Running', containerStatuses: [{ name: 'app', ready: false, restartCount: 4, state: { terminated: { reason: 'Error', exitCode: 1 } } }] });
        expect(mapPod(between)).toMatchObject({ status: 'Error', problem: 'crash-loop' });
    });

    it('never throws on a document it does not expect', () => {
        expect(mapPods(null)).toEqual({ pods: [], truncated: false });
        expect(mapPods({ items: [null, 3, { metadata: {} }] }).pods).toEqual([]);
        expect(mapPod({}).status).toBe('Unknown');
    });
});

describe('workloads', () => {
    const workloads = mapWorkloads(fixture('workloads.json'));
    const find = (kind: string, name: string) => workloads.find((entry) => entry.kind === kind && entry.name === name)!;

    it('lists every kind, ordered by kind then name', () => {
        expect(workloads.map((entry) => `${entry.kind}/${entry.name}`)).toEqual([
            'deployment/api', 'deployment/broken-image', 'deployment/web', 'statefulset/cache', 'daemonset/node-agent', 'job/migrate', 'cronjob/report'
        ]);
    });

    it('counts ready pods and tells healthy from degraded', () => {
        expect(find('deployment', 'web')).toMatchObject({ ready: 2, desired: 2, upToDate: 2, available: 2, health: 'ok', images: ['nginx:1.27-alpine', 'busybox:1.36'], selector: { app: 'web' } });
        expect(find('deployment', 'api')).toMatchObject({ ready: 0, desired: 1, health: 'degraded' });
        expect(find('deployment', 'api').condition).toMatchObject({ type: 'Available', reason: 'MinimumReplicasUnavailable' });
        expect(find('statefulset', 'cache')).toMatchObject({ ready: 1, desired: 1, health: 'ok' });
        expect(find('daemonset', 'node-agent')).toMatchObject({ ready: 1, desired: 1, health: 'ok' });
    });

    it('reads jobs and cronjobs', () => {
        expect(find('job', 'migrate')).toMatchObject({ ready: 1, desired: 1, health: 'ok', failed: 0 });
        expect(find('job', 'migrate').completedAt).toMatch(/^\d{4}-/);
        expect(find('cronjob', 'report')).toMatchObject({ schedule: '*/10 * * * *', suspended: false, desired: null, images: ['busybox:1.36'] });
    });

    it('marks failed rollouts, rollouts in progress and scaled-down workloads', () => {
        const deployment = (spec: object, status: object, metadata: object = {}) => mapWorkloads({ items: [{ kind: 'Deployment', metadata: { name: 'd', namespace: 'n', generation: 2, ...metadata }, spec, status: { observedGeneration: 2, ...status } }] })[0];
        expect(deployment({ replicas: 2 }, { replicas: 2, readyReplicas: 1, updatedReplicas: 2, availableReplicas: 1, conditions: [{ type: 'Progressing', status: 'False', reason: 'ProgressDeadlineExceeded', message: 'ReplicaSet "d-1" has timed out progressing.' }] }))
            .toMatchObject({ health: 'failed', condition: { reason: 'ProgressDeadlineExceeded' } });
        expect(deployment({ replicas: 2 }, { replicas: 3, readyReplicas: 2, updatedReplicas: 1, availableReplicas: 2 }).health).toBe('progressing');
        expect(deployment({ replicas: 2 }, { replicas: 2, readyReplicas: 2, updatedReplicas: 2, availableReplicas: 2 }, { generation: 3 }).health).toBe('progressing');
        expect(deployment({ replicas: 0 }, {}).health).toBe('idle');
        const job = mapWorkloads({ items: [{ kind: 'Job', metadata: { name: 'j', namespace: 'n' }, spec: { backoffLimit: 1 }, status: { failed: 2, conditions: [{ type: 'Failed', status: 'True', reason: 'BackoffLimitExceeded', message: 'Job has reached the specified backoff limit' }] } }] })[0];
        expect(job).toMatchObject({ health: 'failed', failed: 2, condition: { reason: 'BackoffLimitExceeded' } });
        const cron = mapWorkloads({ items: [{ kind: 'CronJob', metadata: { name: 'c', namespace: 'n' }, spec: { suspend: true, schedule: '@daily' }, status: {} }] })[0];
        expect(cron).toMatchObject({ health: 'suspended', suspended: true });
        expect(mapWorkloads({ items: [{ kind: 'ReplicaSet', metadata: { name: 'r' } }] })).toEqual([]);
    });
});

describe('events', () => {
    it('puts warnings first, then the most recent', () => {
        const events = mapEvents(fixture('events.json'));
        expect(events.length).toBeGreaterThan(5);
        const firstNormal = events.findIndex((event) => event.type !== 'Warning');
        expect(events.slice(0, firstNormal).every((event) => event.type === 'Warning')).toBe(true);
        expect(events.slice(firstNormal).every((event) => event.type !== 'Warning')).toBe(true);
        expect(events.some((event) => event.reason === 'BackOff' && event.object.name.startsWith('api-'))).toBe(true);
        expect(events.some((event) => /does-not-exist-shellmind/.test(event.message))).toBe(true);
    });

    it('reads core/v1 and events.k8s.io series fields', () => {
        const event = mapEvent({ type: 'Warning', reason: 'BackOff', note: 'Back-off restarting', regarding: {}, involvedObject: { kind: 'Pod', name: 'p', namespace: 'n' }, series: { count: 7, lastObservedTime: '2026-10-24T10:00:00Z' }, eventTime: '2026-10-24T09:00:00Z' });
        expect(event).toMatchObject({ count: 7, lastAt: '2026-10-24T10:00:00Z', firstAt: '2026-10-24T09:00:00Z', message: 'Back-off restarting', namespace: 'n' });
        const old = mapEvent({ type: 'Normal', reason: 'Pulled', message: 'ok', count: 2, lastTimestamp: '2026-10-24T08:00:00Z', involvedObject: { kind: 'Pod', name: 'p' }, source: { component: 'kubelet' } });
        expect(old).toMatchObject({ count: 2, lastAt: '2026-10-24T08:00:00Z', source: 'kubelet' });
        expect(sortEvents([old, event]).map((entry) => entry.type)).toEqual(['Warning', 'Normal']);
    });
});

describe('nodes and namespaces', () => {
    it('reads the node with its roles, readiness and capacity', () => {
        const [node] = mapNodes(fixture('nodes.json'));
        expect(node).toMatchObject({ name: 'k3s', ready: true, unschedulable: false, roles: ['control-plane', 'master'], pressures: [] });
        expect(node.version).toMatch(/^v1\.31/);
        expect(node.capacity.cpu).toBeTruthy();
        expect(node.runtime).toMatch(/^containerd/);
    });

    it('lists namespace names', () => {
        expect(mapNamespaces({ items: [{ metadata: { name: 'shop' } }, { metadata: { name: 'default' } }, {}] })).toEqual(['default', 'shop']);
    });
});

describe('pod detail', () => {
    const pods = (fixture('pods.json') as { items: Array<{ metadata: { name: string } }> }).items;
    const web = pods.find((entry) => entry.metadata.name.startsWith('web-'))!;
    const api = pods.find((entry) => entry.metadata.name.startsWith('api-'))!;

    it('merges each container spec with its status', () => {
        const detail = mapPodDetail(web, fixture('events.json'));
        expect(detail.containers.map((container) => container.name)).toEqual(['nginx', 'sidecar']);
        const nginx = detail.containers[0];
        expect(nginx).toMatchObject({ image: 'nginx:1.27-alpine', ready: true, restarts: 0, ports: ['80/TCP'], init: false });
        expect(nginx.state.state).toBe('running');
        expect(nginx.env).toEqual([{ name: 'APP_MODE', value: 'production', from: null }, { name: 'DB_PASSWORD', value: 'hunter2-not-a-real-secret', from: null }]);
        expect(detail.qosClass).toBe('BestEffort');
        expect(detail.conditions.find((condition) => condition.type === 'Ready')?.status).toBe('True');
        expect(detail.volumes.some((volume) => volume.type === 'projected')).toBe(true);
    });

    it('keeps the last state of a crashed container', () => {
        const container = mapPodDetail(api, null).containers[0];
        expect(container.state).toMatchObject({ state: 'waiting', reason: 'CrashLoopBackOff' });
        expect(container.lastState).toMatchObject({ state: 'terminated', reason: 'Error', exitCode: 1 });
        expect(container.command).toContain('panic: dial tcp');
    });

    it('describes where a variable comes from without its value', () => {
        expect(mapEnv([
            { name: 'PASSWORD', valueFrom: { secretKeyRef: { name: 'db', key: 'password' } } },
            { name: 'MODE', valueFrom: { configMapKeyRef: { name: 'app', key: 'MODE' } } },
            { name: 'POD', valueFrom: { fieldRef: { fieldPath: 'metadata.name' } } },
            { name: 'MEM', valueFrom: { resourceFieldRef: { resource: 'limits.memory', containerName: 'app' } } },
            { name: 'EMPTY' }
        ])).toEqual([
            { name: 'PASSWORD', value: null, from: 'secret db/password' },
            { name: 'MODE', value: null, from: 'configmap app/MODE' },
            { name: 'POD', value: null, from: 'field metadata.name' },
            { name: 'MEM', value: null, from: 'resource limits.memory (app)' },
            { name: 'EMPTY', value: '', from: null }
        ]);
    });
});
