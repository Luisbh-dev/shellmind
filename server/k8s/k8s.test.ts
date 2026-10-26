import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { prepareCordon, prepareDeletePod, prepareRestart, prepareScale, prepareUseContext } from './actions';
import { buildStatus, parseConfigView, parseSshDetection, SSH_DETECT_SCRIPT } from './detect';
import { kubectlFailure, kubectlMessage } from './errors';
import { pickPodContainer } from '../../shared/k8s';
import { formatEvents, summarizePod } from './evidence';
import { podLogArgs } from './logs';
import { mapPodDetail } from './parse';
import { displayArg, sshKubectlCommand } from './runner';
import { localCommandLine, podExecArgs, podShellScript } from './shell';
import { namespaceArgs, parsePodAttach, parsePodLogSource, requireContext, requireName, requireNamespace, requireNamespaceScope } from './validate';

const fixture = (name: string): string => fs.readFileSync(fileURLToPath(new URL(`../../test/fixtures/k8s/${name}`, import.meta.url)), 'utf8');
const sections = (parts: Record<string, string>) => Object.entries(parts).map(([name, text]) => `\n@@SM:${name}\n${text}`).join('') + '\n@@SM:end\n';
const result = (stderr: string, code: number | null = 1) => ({ stdout: '', stderr, code });

describe('names', () => {
    it('accepts what kubeconfig tools write and refuses shell text', () => {
        for (const name of ['kind-dev', 'k3d-lab', 'gke_project_europe-west1_prod', 'admin@cluster', 'arn:aws:eks:eu-west-1:123456789012:cluster/prod', 'minikube']) {
            expect(requireContext(name)).toBe(name);
        }
        for (const name of ['', '-n', 'a b', "x';id;'", 'a$b', 'ctx`id`', 'a"b', 'a\nb']) {
            expect(() => requireContext(name), name).toThrow(/context/);
        }
    });

    it('validates namespaces, resource names and the all-namespaces scope', () => {
        expect(requireNamespace('kube-system')).toBe('kube-system');
        expect(() => requireNamespace('Kube')).toThrow();
        expect(() => requireNamespace('a'.repeat(64))).toThrow();
        expect(() => requireNamespace('*')).toThrow();
        expect(requireNamespaceScope('*')).toBe('*');
        expect(namespaceArgs('*')).toEqual(['--all-namespaces']);
        expect(namespaceArgs('shop')).toEqual(['-n', 'shop']);
        expect(requireName('ip-10-0-1-2.ec2.internal', 'node')).toBe('ip-10-0-1-2.ec2.internal');
        for (const name of ['web;id', '../x', '-rf', 'Web', 'a..b', 'a_b']) expect(() => requireName(name, 'pod'), name).toThrow();
    });

    it('parses a pod log source with safe defaults', () => {
        expect(parsePodLogSource({ context: 'k', namespace: 'ns', pod: 'p-1', container: 'c' }))
            .toEqual({ kind: 'pod', context: 'k', namespace: 'ns', pod: 'p-1', container: 'c', tail: 100, follow: true, timestamps: true });
        expect(parsePodLogSource({ context: 'k', namespace: 'ns', pod: 'p-1', container: 'c', previous: true, tail: 500, timestamps: false }))
            .toMatchObject({ previous: true, follow: false, tail: 500, timestamps: false });
        expect(() => parsePodLogSource({ context: 'k', namespace: 'ns', pod: 'p', container: 'c', tail: 999_999 })).toThrow(/between 0/);
        expect(() => parsePodLogSource({ context: 'k', namespace: 'ns', pod: 'p', container: "c'; id" })).toThrow(/container/);
    });

    it('parses a pod terminal attach (INVALID_ATTACH otherwise)', () => {
        expect(parsePodAttach({ kind: 'pod', context: 'k', namespace: 'ns', pod: 'p', container: 'c', extra: 'x' })).toEqual({ kind: 'pod', context: 'k', namespace: 'ns', pod: 'p', container: 'c' });
        expect(() => parsePodAttach({ kind: 'pod', context: 'k', namespace: 'ns', pod: 'p' })).toThrow(expect.objectContaining({ code: 'INVALID_ATTACH' }));
        expect(() => parsePodAttach({ kind: 'container' })).toThrow(expect.objectContaining({ code: 'INVALID_ATTACH' }));
    });
});

describe('command lines', () => {
    it('single-quotes every argument for the server and shows them plainly in the audit log', () => {
        expect(sshKubectlCommand('/usr/local/bin/kubectl', false, ['--context', 'a', 'get', 'pods'])).toBe("'/usr/local/bin/kubectl' '--context' 'a' 'get' 'pods'");
        expect(sshKubectlCommand('/usr/local/bin/kubectl', true, ['-n', 'x'])).toBe("sudo -n '/usr/local/bin/kubectl' '-n' 'x'");
        expect(sshKubectlCommand('/k', false, ["it's"])).toBe("'/k' 'it'\\''s'");
        expect(displayArg('deployment/web')).toBe('deployment/web');
        expect(displayArg('--replicas=3')).toBe('--replicas=3');
        expect(displayArg('a b')).toBe("'a b'");
    });

    it('builds the log arguments: follow, previous instance, backlog, timestamps', () => {
        const base = { kind: 'pod' as const, context: 'c', namespace: 'ns', pod: 'p', container: 'app' };
        expect(podLogArgs({ ...base, tail: 500 })).toEqual(['--context', 'c', '-n', 'ns', 'logs', 'p', '-c', 'app', '--tail=500', '-f', '--timestamps']);
        expect(podLogArgs({ ...base, previous: true, follow: true, timestamps: false })).toEqual(['--context', 'c', '--request-timeout=60s', '-n', 'ns', 'logs', 'p', '-c', 'app', '--tail=100', '--previous']);
        expect(podLogArgs({ ...base, follow: false })).toContain('--request-timeout=60s');
    });

    it('opens a tagged shell (bash, else sh) and passes the local argv through the command line parser intact', () => {
        const tag = 'a'.repeat(32);
        expect(podShellScript(tag)).toBe(`export SHELLMIND_TERMINAL=${tag}; command -v bash >/dev/null 2>&1 && exec bash; exec sh`);
        const attach = { kind: 'pod' as const, context: 'ctx', namespace: 'ns', pod: 'web-1', container: 'nginx' };
        expect(podExecArgs(attach, true, 'S')).toEqual(['--context', 'ctx', '-n', 'ns', 'exec', '-it', 'web-1', '-c', 'nginx', '--', 'sh', '-c', 'S']);
        expect(podExecArgs(attach, false, 'S')).not.toContain('-it');
        expect(localCommandLine(['C:\\Program Files\\kubectl.exe', 'sh', '-c', 'a && b'])).toBe("'C:\\Program Files\\kubectl.exe' 'sh' '-c' 'a && b'");
        expect(localCommandLine(["/home/o'brien/kubectl"])).toBe('"/home/o\'brien/kubectl"');
        expect(() => localCommandLine(["C:\\o'brien\\kubectl.exe"])).toThrow();
    });

    it('builds actions from validated input only', () => {
        expect(prepareRestart('c', 'ns', 'deployment', 'web').args).toEqual(['--context', 'c', '--request-timeout=20s', '-n', 'ns', 'rollout', 'restart', 'deployment/web']);
        expect(() => prepareRestart('c', 'ns', 'job', 'migrate')).toThrow('Only deployments, statefulsets and daemonsets can be restarted.');
        expect(prepareScale('c', 'ns', 'statefulset', 'db', 0).args).toContain('--replicas=0');
        expect(prepareScale('c', 'ns', 'deployment', 'web', 3).meta).toEqual({ kind: 'k8s', action: 'scale', target: 'web', context: 'c', namespace: 'ns', workload: 'deployment', replicas: 3 });
        for (const replicas of [-1, 1001, 1.5, '3', null]) expect(() => prepareScale('c', 'ns', 'deployment', 'web', replicas)).toThrow(/replicas/);
        expect(() => prepareScale('c', 'ns', 'daemonset', 'agent', 1)).toThrow('Only deployments and statefulsets can be scaled.');
        expect(prepareDeletePod('c', 'ns', 'p').args.slice(-4)).toEqual(['delete', 'pod', 'p', '--wait=false']);
        expect(prepareCordon('c', 'n1', 'uncordon').args.slice(-2)).toEqual(['uncordon', 'n1']);
        expect(() => prepareCordon('c', 'n1', 'drain')).toThrow();
        expect(prepareUseContext('c').args).toEqual(['config', 'use-context', 'c']);
    });
});

describe('kubectl failures', () => {
    it('reads as stable codes, kubectl noise left out', () => {
        expect(kubectlFailure(result('Error from server (Forbidden): pods is forbidden: User "dev" cannot list resource "pods"')).code).toBe('K8S_FORBIDDEN');
        // The cluster's sign-in, never HTTP 401: the frontend reads a 401 as
        // ShellMind's own access token refused (and drops it).
        expect(kubectlFailure(result('error: You must be logged in to the server (Unauthorized)'))).toMatchObject({ code: 'K8S_AUTH_REQUIRED', status: 502 });
        expect(kubectlFailure(result('getting credentials: exec: executable aws failed with exit code 255'))).toMatchObject({ code: 'K8S_AUTH_REQUIRED', status: 502 });
        expect(kubectlFailure(result('error: the server has asked for the client to provide credentials')).status).not.toBe(401);
        // Logs of a container that has not started yet.
        expect(kubectlFailure(result('Error from server (BadRequest): container "app" in pod "init-stuck" is waiting to start: PodInitializing'))).toMatchObject({ code: 'K8S_CONTAINER_NOT_RUNNING', status: 409 });
        expect(kubectlFailure(result('Error from server (BadRequest): previous terminated container "app" in pod "web-1" not found')).code).toBe('K8S_NOT_FOUND');
        expect(kubectlFailure(result('E1024 10:00:00.000000  1234 memcache.go:265] couldn\'t get current server API group list: dial tcp 10.0.0.1:6443: connect: connection refused\nThe connection to the server 10.0.0.1:6443 was refused - did you specify the right host or port?')).code).toBe('K8S_UNREACHABLE');
        expect(kubectlFailure(result('error: context "nope" does not exist')).code).toBe('K8S_CONTEXT_NOT_FOUND');
        expect(kubectlFailure(result('Error from server (NotFound): pods "x" not found')).code).toBe('K8S_NOT_FOUND');
        expect(kubectlFailure(result('spawn kubectl ENOENT', null)).code).toBe('KUBECTL_MISSING');
        expect(kubectlFailure(result('error: unknown command "frobnicate"')).code).toBe('K8S_COMMAND_FAILED');
        expect(kubectlMessage(result('E1024 10:00:00.000000  1 memcache.go:265] noise\nerror: the real message'))).toBe('error: the real message');
    });
});

describe('detection', () => {
    const config = fixture('config-view.json');

    it('lists the contexts of config view, with their API server and namespace', () => {
        const parsed = parseConfigView(JSON.parse(config));
        expect(parsed.currentContext).toBe('k3s-admin');
        expect(parsed.contexts).toEqual([
            { name: 'k3s-admin', cluster: 'k3s-lab', server: 'https://127.0.0.1:46443', namespace: null, user: 'k3s-lab-admin' },
            { name: 'k3s-lab', cluster: 'k3s-lab', server: 'https://127.0.0.1:46443', namespace: 'shop', user: 'k3s-lab-admin' }
        ]);
        const odd = parseConfigView({ contexts: [{ name: 'my cluster', context: {} }, { name: 'ok' }], 'current-context': 'my cluster' });
        expect(odd).toEqual({ contexts: [{ name: 'ok', cluster: null, server: null, namespace: null, user: null }], currentContext: null, unsupported: ['my cluster'] });
    });

    it('reads the SSH check: kubectl, its version and contexts', () => {
        const status = parseSshDetection(sections({ path: '/usr/local/bin/kubectl', version: '{"clientVersion":{"gitVersion":"v1.31.4"}}', config, 'config-exit': '0' }), 1);
        expect(status).toMatchObject({ runner: 'ssh', available: true, sudo: false, kubectl: { path: '/usr/local/bin/kubectl', version: 'v1.31.4' }, currentContext: 'k3s-admin', detectedAt: 1 });
        expect(status.contexts).toHaveLength(2);
    });

    it("falls back to root's kubeconfig through sudo when the user has none", () => {
        const empty = '{"kind":"Config","apiVersion":"v1","clusters":null,"contexts":null,"current-context":""}';
        const status = parseSshDetection(sections({ path: '/usr/local/bin/kubectl', config: empty, 'config-exit': '0', 'sudo-config': config, 'sudo-exit': '0' }));
        expect(status).toMatchObject({ available: true, sudo: true });
        const neither = parseSshDetection(sections({ path: '/usr/local/bin/kubectl', config: empty, 'config-exit': '0' }));
        expect(neither).toMatchObject({ available: false, problem: { code: 'NO_CONTEXTS' } });
    });

    it('says why kubectl is not usable', () => {
        expect(parseSshDetection(sections({ path: '' })).problem?.code).toBe('KUBECTL_MISSING');
        // A relative or odd path from PATH is not used.
        expect(parseSshDetection(sections({ path: 'kubectl' })).problem?.code).toBe('KUBECTL_MISSING');
        const unreadable = parseSshDetection(sections({ path: '/usr/bin/kubectl', config: 'error: error loading config file "/etc/rancher/k3s/k3s.yaml": open /etc/rancher/k3s/k3s.yaml: permission denied', 'config-exit': '1' }));
        expect(unreadable.problem).toEqual({ code: 'KUBECONFIG_ERROR', message: expect.stringContaining('permission denied') });
        expect(() => parseSshDetection('@@SM:path\n/usr/bin/kubectl\n')).toThrow(/cut off/);
        expect(buildStatus({ runner: 'local', path: null, version: null, sudo: false, config: null, detectedAt: 1 }).problem?.message).toMatch(/this computer/);
    });

    it('reads files only, and tries sudo only without contexts of its own', () => {
        expect(SSH_DETECT_SCRIPT).toContain('config view -o json');
        expect(SSH_DETECT_SCRIPT).not.toMatch(/\bget\b|use-context/);
        expect(SSH_DETECT_SCRIPT).toContain('sudo -n true');
    });
});

describe('pod evidence', () => {
    const pods = JSON.parse(fixture('pods.json')) as { items: Array<{ metadata: { name: string } }> };
    const web = pods.items.find((pod) => pod.metadata.name.startsWith('web-'))!;
    const api = pods.items.find((pod) => pod.metadata.name.startsWith('api-'))!;

    it('summarizes the pod without environment values', () => {
        const text = summarizePod(web);
        expect(text).toContain('Status: Running (phase Running), ready 2/2');
        expect(text).toContain('Container nginx (image nginx:1.27-alpine)');
        expect(text).toContain('Environment: 2 variables, values left out (they may hold secrets): APP_MODE, DB_PASSWORD');
        expect(text).not.toContain('hunter2');
        expect(text).not.toContain('production');
    });

    it('keeps what explains a crash loop', () => {
        const text = summarizePod(api);
        expect(text).toContain('State: waiting (CrashLoopBackOff)');
        expect(text).toMatch(/Last state: terminated \(Error\) exit code 1/);
        expect(text).toContain('Owner: Deployment api');
    });

    it('picks the container in trouble, or the one asked for', () => {
        const detail = mapPodDetail(api, null);
        expect(pickPodContainer(detail)?.name).toBe('api');
        const webDetail = mapPodDetail(web, null);
        expect(pickPodContainer(webDetail)?.name).toBe('nginx');
        expect(pickPodContainer(webDetail, 'sidecar')?.name).toBe('sidecar');
        expect(pickPodContainer(webDetail, 'nope')).toBeNull();
    });

    // A pod waiting for its init container: that one explains it, not the
    // app container that has not started (its logs cannot even be read).
    it('picks the init container a pod waits for', () => {
        const initPod = (initState: Record<string, unknown>, sidecar = false) => ({
            metadata: { name: 'init-stuck', namespace: 'shop' },
            spec: { initContainers: [{ name: 'proxy', image: 'envoy', restartPolicy: 'Always' }, { name: 'wait-db', image: 'alpine' }].filter((entry) => sidecar || entry.name !== 'proxy'), containers: [{ name: 'app', image: 'alpine' }] },
            status: {
                phase: 'Pending',
                initContainerStatuses: [
                    ...(sidecar ? [{ name: 'proxy', state: { running: { startedAt: '2026-10-24T10:00:00Z' } }, started: true, ready: true, restartCount: 0 }] : []),
                    { name: 'wait-db', state: initState, ready: false, restartCount: 0 }
                ],
                containerStatuses: [{ name: 'app', state: { waiting: { reason: 'PodInitializing' } }, ready: false, restartCount: 0 }]
            }
        });
        const running = mapPodDetail(initPod({ running: { startedAt: '2026-10-24T10:00:00Z' } }), null);
        expect(running.pod.status).toBe('Init:0/1');
        expect(running.pod.running).toEqual(['wait-db']);
        expect(pickPodContainer(running)?.name).toBe('wait-db');
        const crashing = mapPodDetail(initPod({ waiting: { reason: 'CrashLoopBackOff' } }), null);
        expect(crashing.pod.status).toBe('Init:CrashLoopBackOff');
        expect(pickPodContainer(crashing)?.name).toBe('wait-db');
        // A started sidecar does not hold the pod: the init container after it does.
        const withSidecar = mapPodDetail(initPod({ running: { startedAt: '2026-10-24T10:00:00Z' } }, true), null);
        expect(withSidecar.initContainers.map((container) => [container.name, container.sidecar])).toEqual([['proxy', true], ['wait-db', false]]);
        expect(pickPodContainer(withSidecar)?.name).toBe('wait-db');
        expect(withSidecar.pod.running).toEqual(['proxy', 'wait-db']);
        // Initialized: a completed init container is not "in trouble".
        const done = mapPodDetail({ ...initPod({ terminated: { exitCode: 0, reason: 'Completed' } }), status: { phase: 'Running', conditions: [{ type: 'Initialized', status: 'True' }], initContainerStatuses: [{ name: 'wait-db', state: { terminated: { exitCode: 0, reason: 'Completed' } }, ready: false, restartCount: 0 }], containerStatuses: [{ name: 'app', state: { running: { startedAt: '2026-10-24T10:00:00Z' } }, ready: true, restartCount: 0 }] } }, null);
        expect(done.pod.status).toBe('Running');
        expect(pickPodContainer(done)?.name).toBe('app');
    });

    it('lists events one per line', () => {
        expect(formatEvents([])).toMatch(/no events/);
        expect(formatEvents([{ type: 'Warning', reason: 'BackOff', message: 'Back-off\nrestarting', namespace: 'ns', object: { kind: 'Pod', name: 'p' }, count: 3, firstAt: null, lastAt: '2026-10-24T10:00:00Z', source: null }]))
            .toBe('2026-10-24T10:00:00Z Warning BackOff (x3) Pod/p: Back-off restarting');
    });
});
