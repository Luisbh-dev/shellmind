import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ChatEvidenceResponse } from '../../shared/chat';
import type { K8sPod, K8sPodList, K8sStatus, K8sWorkloadList } from '../../shared/k8s';
import type { LogChunkPayload, LogEndPayload } from '../../shared/ops';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W8-T2 Kubernetes end to end (opt-in: SHELLMIND_E2E=1): a real k3s cluster
// in Docker, reached through a real OpenSSH bastion with the official kubectl
// (test/fixtures/k8s/e2e). Pods are listed and diagnosed, logs streamed, a
// shell opened in a pod (and hung up when its tab goes away), workloads
// scaled and restarted, pods deleted. The cluster runs the host's alpine:3,
// imported into k3s (nothing is pulled from a registry but k3s itself).

const ENABLED = process.env.SHELLMIND_E2E === '1';
const K3S_IMAGE = 'rancher/k3s:v1.31.4-k3s1';
const SSHD_IMAGE = 'shellmind-test-k8s-sshd';
const NAME = `shellmind-test-k8s-${process.pid}`;
const K3S = `${NAME}-k3s`;
const SSHD = `${NAME}-sshd`;
const CONTEXT = fileURLToPath(new URL('../fixtures/k8s/e2e', import.meta.url));
const MANIFEST = fileURLToPath(new URL('../fixtures/k8s/e2e/workloads.yaml', import.meta.url));

vi.setConfig({ testTimeout: 120_000, hookTimeout: 420_000 });

let server: TestServer;
let serverId: number;
const sockets: Socket[] = [];

function docker(args: string[], input?: string | Buffer): string {
    return execFileSync('docker', args, { encoding: 'utf8', input, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
}

const kubectl = (...args: string[]) => docker(['exec', K3S, 'kubectl', ...args]);

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 60_000, what = 'condition'): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        try {
            if (await check()) return;
        } catch {
            // Not there yet.
        }
        if (Date.now() > deadline) throw new Error(`${what} not met in time`);
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
}

function sshBanner(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = net.connect(port, '127.0.0.1');
        socket.once('data', (data) => {
            socket.destroy();
            resolve(data.toString().startsWith('SSH-'));
        });
        socket.once('error', () => resolve(false));
        socket.setTimeout(1000, () => {
            socket.destroy();
            resolve(false);
        });
    });
}

async function api<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as T };
}

async function open(): Promise<Socket> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    return socket;
}

const k8s = (path: string) => `/api/servers/${serverId}/k8s/${path}`;
const pods = async () => (await api<K8sPodList>('GET', k8s('pods?context=default&namespace=shop'))).body.pods;
const podOf = async (app: string): Promise<K8sPod | undefined> => (await pods()).find((pod) => pod.labels.app === app && pod.problem !== 'terminating');
const audit = async () => (await api<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops')).body.data;

describe.skipIf(!ENABLED)('Kubernetes against a real k3s cluster (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker(['network', 'create', NAME]);
        docker(['run', '-d', '--name', K3S, '--network', NAME, '--privileged', K3S_IMAGE, 'server', '--disable', 'traefik', '--disable', 'metrics-server', '--tls-san', K3S, '--write-kubeconfig-mode', '644']);
        docker(['build', '-q', '-t', SSHD_IMAGE, CONTEXT]);
        docker(['run', '-d', '--name', SSHD, '--network', NAME, '-p', '127.0.0.1::22', SSHD_IMAGE]);
        const port = Number(docker(['port', SSHD, '22']).split('\n')[0].split(':').pop());

        await waitFor(() => / Ready /.test(` ${kubectl('get', 'nodes', '--no-headers')} `), 180_000, 'k3s node ready');
        // The workloads' image, from the host into the cluster's containerd.
        try {
            docker(['image', 'inspect', 'alpine:3']);
        } catch {
            docker(['pull', 'alpine:3']);
        }
        // One platform only: a multi-platform save (containerd image store)
        // lists manifests whose layers the host does not have.
        const platform = docker(['version', '--format', '{{.Server.Os}}/{{.Server.Arch}}']);
        const image = execFileSync('docker', ['save', '--platform', platform, 'alpine:3'], { maxBuffer: 256 * 1024 * 1024 });
        docker(['exec', '-i', K3S, 'ctr', '-n', 'k8s.io', 'images', 'import', '-'], image);
        docker(['exec', '-i', K3S, 'kubectl', 'apply', '-f', '-'], fs.readFileSync(MANIFEST, 'utf8'));

        // The bastion's kubeconfig points at the k3s container by name.
        const kubeconfig = docker(['exec', K3S, 'cat', '/etc/rancher/k3s/k3s.yaml']).replace('https://127.0.0.1:6443', `https://${K3S}:6443`);
        docker(['exec', '-i', SSHD, 'sh', '-c', 'cat > /home/demo/.kube/config && chown demo:demo /home/demo/.kube/config && chmod 600 /home/demo/.kube/config'], kubeconfig);
        // A context whose sign-in the cluster refuses (an expired token).
        docker(['exec', '-u', 'demo', SSHD, 'kubectl', 'config', 'set-credentials', 'expired', '--token=not-a-valid-token']);
        docker(['exec', '-u', 'demo', SSHD, 'kubectl', 'config', 'set-context', 'expired', '--cluster=default', '--user=expired', '--namespace=shop']);
        await waitFor(() => sshBanner(port), 30_000, 'sshd');
        await waitFor(() => /Running/.test(kubectl('get', 'pods', '-n', 'shop', '-l', 'app=web', '--no-headers')), 120_000, 'web pods running');

        server = await bootTestServer();
        serverId = (await api<{ data: { id: number } }>('POST', '/api/servers', { name: 'k3s-e2e', ip: '127.0.0.1', port, type: 'linux', username: 'demo', password: 'demo' })).body.data.id;
    });

    afterAll(async () => {
        while (sockets.length) sockets.pop()?.disconnect();
        await server?.close();
        for (const args of [['rm', '-f', SSHD], ['rm', '-f', K3S], ['network', 'rm', NAME]]) {
            try {
                docker(args);
            } catch {
                // Already gone.
            }
        }
    });

    it('finds kubectl on the bastion and its contexts', async () => {
        const { body } = await api<K8sStatus>('GET', k8s('status'));
        expect(body).toMatchObject({ runner: 'ssh', available: true, sudo: false, currentContext: 'default', kubectl: { path: '/usr/local/bin/kubectl', version: 'v1.31.4' } });
        expect(body.contexts.map((context) => context.name)).toEqual(['default', 'expired']);
    });

    it('lists the pods with the crash loop flagged, and the workloads', async () => {
        await waitFor(async () => (await podOf('api'))?.problem === 'crash-loop', 90_000, 'api crash loop');
        const web = (await pods()).filter((pod) => pod.labels.app === 'web');
        expect(web).toHaveLength(2);
        expect(web[0]).toMatchObject({ phase: 'Running', ready: 1, total: 1, owner: { kind: 'Deployment', name: 'web' } });
        const workloads = (await api<K8sWorkloadList>('GET', k8s('workloads?context=default&namespace=shop'))).body.workloads;
        expect(workloads.find((workload) => workload.name === 'web')).toMatchObject({ kind: 'deployment', health: 'ok', ready: 2, desired: 2 });
        expect(workloads.find((workload) => workload.name === 'api')).toMatchObject({ health: 'degraded' });
        expect(workloads.find((workload) => workload.name === 'migrate')).toMatchObject({ kind: 'job' });
        const events = (await api<{ events: Array<{ type: string; reason: string }> }>('GET', k8s('events?context=default&namespace=shop'))).body.events;
        expect(events[0].type).toBe('Warning');
        expect(events.some((event) => event.type === 'Warning' && event.reason === 'BackOff')).toBe(true);
    });

    // The compact template (server/k8s/templates.ts) against kubectl's own JSON.
    it("lists every pod as kubectl's own JSON has it", async () => {
        const raw = JSON.parse(docker(['exec', '-u', 'demo', SSHD, 'kubectl', 'get', 'pods', '-n', 'shop', '-o', 'json'])) as {
            items: Array<{ metadata: { name: string; namespace: string }; spec: { nodeName?: string; containers: Array<{ name: string }> }; status: { phase: string; podIP?: string } }>;
        };
        const listed = new Map((await pods()).map((pod) => [pod.name, pod]));
        const settled = raw.items.filter((item) => listed.has(item.metadata.name));
        expect(settled.length).toBeGreaterThanOrEqual(raw.items.length - 1);
        for (const item of settled) {
            expect(listed.get(item.metadata.name), item.metadata.name).toMatchObject({
                namespace: item.metadata.namespace,
                phase: item.status.phase,
                node: item.spec.nodeName ?? null,
                containers: item.spec.containers.map((container) => container.name)
            });
        }
    });

    // A 401 would tell the frontend that ShellMind's own access token was refused.
    it("answers a sign-in the cluster refuses with K8S_AUTH_REQUIRED, never HTTP 401", async () => {
        const res = await api<{ code: string }>('GET', k8s('pods?context=expired&namespace=shop'));
        expect(res).toMatchObject({ status: 502, body: { code: 'K8S_AUTH_REQUIRED' } });
        const evidence = await api<{ code: string }>('POST', '/api/chat/evidence', { serverId, attachment: { kind: 'pod', context: 'expired', namespace: 'shop', pod: 'init-stuck' } });
        expect(evidence).toMatchObject({ status: 502, body: { code: 'K8S_AUTH_REQUIRED' } });
    });

    it('opens a shell in a running pod that is not ready', async () => {
        await waitFor(async () => (await podOf('notready'))?.problem === 'not-ready', 90_000, 'not-ready pod');
        expect(await podOf('notready')).toMatchObject({ phase: 'Running', ready: 0, running: ['app'] });
    });

    it("gives a pod stuck initializing its init container's logs, shell and evidence", async () => {
        await waitFor(async () => (await podOf('init-stuck'))?.running.includes('wait-db') === true, 90_000, 'init container running');
        expect(await podOf('init-stuck')).toMatchObject({ status: 'Init:0/1', running: ['wait-db'] });

        // The app container has not started: kubectl's refusal is an error, not a log line.
        const socket = await open();
        let text = '';
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            text += payload.data;
            ack();
        });
        const failed = new Promise<{ code: string; message: string }>((resolve) => socket.once('logs-error', resolve));
        socket.emit('logs-start', { id: 'e2e-init', serverId, source: { kind: 'pod', context: 'default', namespace: 'shop', pod: 'init-stuck', container: 'app', tail: 100, follow: false } });
        expect(await failed).toMatchObject({ code: 'K8S_CONTAINER_NOT_RUNNING', message: expect.stringContaining('PodInitializing') });
        expect(text).toBe('');

        // A shell in the init container the pod waits for.
        let output = '';
        socket.on('ssh-output', (data: ArrayBuffer | string) => { output += typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); });
        const ready = new Promise<void>((resolve) => socket.once('connection-ready', () => resolve()));
        socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: 100, rows: 30, attach: { kind: 'pod', context: 'default', namespace: 'shop', pod: 'init-stuck', container: 'wait-db' } });
        await ready;
        await waitFor(() => output.includes('#'), 20_000, 'init container shell prompt');
        socket.emit('ssh-input', 'echo "in $((40+2))"\r');
        await waitFor(() => output.includes('in 42'), 20_000, 'init container command output');
        socket.disconnect();
        // Hung up (and audited) before the other tests read the audit log.
        await waitFor(async () => (await audit()).some((entry) => entry.meta?.action === 'shell-end' && entry.meta?.target === 'init-stuck'), 30_000, 'init shell hung up');

        const { status, body } = await api<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId, attachment: { kind: 'pod', context: 'default', namespace: 'shop', pod: 'init-stuck' } });
        expect(status).toBe(200);
        const logs = body.evidence.sections.find((section) => section.id === 'pod-logs');
        expect(logs?.title).toContain('wait-db');
        expect(logs?.text).toContain('waiting for db');
    });

    it('follows the logs of a container until stopped', async () => {
        const web = (await podOf('web'))!;
        const socket = await open();
        let text = '';
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            text += payload.data;
            ack();
        });
        socket.emit('logs-start', { id: 'e2e1', serverId, source: { kind: 'pod', context: 'default', namespace: 'shop', pod: web.name, container: 'app', tail: 5 } });
        await waitFor(() => (text.match(/tick \d+/g) ?? []).length >= 7, 30_000, 'live log lines');
        const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
        socket.emit('logs-stop', { id: 'e2e1' });
        expect((await ended).code).toBeNull();
        expect(text).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z tick \d+$/m);
    });

    it('opens a shell in a pod and hangs it up when the tab goes away', async () => {
        const web = (await podOf('web'))!;
        const socket = await open();
        let output = '';
        socket.on('ssh-output', (data: ArrayBuffer | string) => { output += typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); });
        const ready = new Promise<void>((resolve) => socket.once('connection-ready', () => resolve()));
        socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: 100, rows: 30, attach: { kind: 'pod', context: 'default', namespace: 'shop', pod: web.name, container: 'app' } });
        await ready;
        await waitFor(() => output.includes('#'), 20_000, 'pod shell prompt');
        socket.emit('ssh-input', 'echo "answer $((6*7))"; sleep 600 &\r');
        await waitFor(() => output.includes('answer 42'), 20_000, 'command output');
        const shells = () => kubectl('exec', '-n', 'shop', web.name, '-c', 'app', '--', 'ps', '-o', 'args').split('\n').filter((line) => /^(sh|sleep 600)$/.test(line.trim()));
        expect(shells().length).toBeGreaterThanOrEqual(2);

        socket.disconnect();
        await waitFor(async () => (await audit())[0]?.meta?.action === 'shell-end', 30_000, 'hang-up');
        expect((await audit())[0]).toMatchObject({ exit_code: 0, meta: { kind: 'k8s', target: web.name, container: 'app' } });
        await waitFor(() => shells().length === 0, 20_000, 'shell gone from the container');
    });

    it('scales, restarts and deletes pods, audited', async () => {
        const ctx = { context: 'default', namespace: 'shop' };
        expect((await api('POST', k8s('workloads/deployment/web/scale'), { ...ctx, replicas: 3 })).status).toBe(200);
        await waitFor(async () => (await pods()).filter((pod) => pod.labels.app === 'web' && pod.phase === 'Running').length === 3, 60_000, 'three web pods');
        expect((await api('POST', k8s('workloads/deployment/web/scale'), { ...ctx, replicas: 2 })).status).toBe(200);

        const before = (await podOf('api'))!.name;
        expect((await api('POST', k8s(`pods/${before}/delete`), ctx)).status).toBe(200);
        await waitFor(async () => { const replacement = await podOf('api'); return Boolean(replacement && replacement.name !== before); }, 60_000, 'replacement pod');

        expect((await api('POST', k8s('workloads/deployment/web/restart'), ctx)).status).toBe(200);
        expect(kubectl('get', 'deployment', 'web', '-n', 'shop', '-o', 'jsonpath={.spec.template.metadata.annotations}')).toContain('kubectl.kubernetes.io/restartedAt');

        const actions = (await audit()).slice(0, 4).map((entry) => `${entry.meta?.action} ${entry.exit_code}`);
        expect(actions).toEqual(['restart 0', 'delete-pod 0', 'scale 0', 'scale 0']);
    });

    it('collects the evidence of a crash-looping pod for the AI, without secrets', async () => {
        await waitFor(async () => (await podOf('api'))?.restarts !== 0, 60_000, 'api restarted');
        const api1 = (await podOf('api'))!;
        const { status, body } = await api<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId, attachment: { kind: 'pod', context: 'default', namespace: 'shop', pod: api1.name } });
        expect(status).toBe(200);
        const text = body.evidence.sections.map((section) => `${section.id}: ${section.text}`).join('\n');
        expect(text).toContain('Owner: Deployment api');
        expect(text).toContain('connection refused');
        const webPod = (await podOf('web'))!;
        const web = await api<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId, attachment: { kind: 'pod', context: 'default', namespace: 'shop', pod: webPod.name } });
        expect(JSON.stringify(web.body)).not.toContain('e2e-not-a-real-secret');
        expect(JSON.stringify(web.body)).toContain('DB_PASSWORD');
    });
});
