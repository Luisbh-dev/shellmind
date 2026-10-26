import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { Server, type ServerChannel } from 'ssh2';
import type { ChatEvidenceResponse } from '../../shared/chat';
import type { K8sPodDetail, K8sPodList, K8sStatus, K8sWorkloadList } from '../../shared/k8s';
import type { LogChunkPayload, LogEndPayload } from '../../shared/ops';
import type { ConnectionError } from '../../shared/terminal';
import type { AuditEntry } from '../../shared/types';
import { POD_LIST_TEMPLATE } from '../../server/k8s/templates';
import { createOpsHost, sections, type OpsHost, type Reply } from '../helpers/opsHost';
import { generateKeyPair } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W8-T2 Kubernetes over SSH, against an in-process SSH server that plays a
// bastion with kubectl: the backend detects kubectl and its contexts, builds
// every kubectl command line from validated names, maps the JSON, audits
// actions, streams pod logs and opens pod shells. The fake kubectl answers
// from real `kubectl get -o json` output of a k3s cluster (test/fixtures/k8s).
// Users of the fake server: demo (a kubeconfig), ops (root's, through sudo),
// nokube (no contexts), nobin (no kubectl).

vi.setConfig({ testTimeout: 30_000 });

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/k8s/${name}`, import.meta.url)), 'utf8');
const PODS = JSON.parse(fixture('pods.json')) as { items: Array<{ metadata: { name: string } }> };
const podNamed = (prefix: string) => PODS.items.find((pod) => pod.metadata.name.startsWith(prefix))!;
const API_POD = podNamed('api-').metadata.name;
const WEB_POD = podNamed('web-').metadata.name;
const KUBECTL = "'/usr/local/bin/kubectl'";
const EMPTY_CONFIG = '{"kind":"Config","apiVersion":"v1","clusters":null,"contexts":null,"current-context":""}';

let server: TestServer;
let host: OpsHost;
let sshd: Server;
let port = 0;
const ids: Record<string, number> = {};
const execs: Array<{ user: string; command: string }> = [];
const sockets: Socket[] = [];

// A pod's shell on the exec channel: a prompt, each line answered, `exit` ends it.
function podShell(channel: ServerChannel) {
    channel.write('/ # ');
    let line = '';
    channel.on('data', (data: Buffer) => {
        for (const char of data.toString('utf8')) {
            if (char !== '\r') {
                line += char;
                continue;
            }
            if (line === 'exit') {
                channel.exit(0);
                channel.end();
                return;
            }
            channel.write(`\r\nran: ${line}\r\n/ # `);
            line = '';
        }
    });
}

// The fake bastion's kubectl, by login user.
function kubectl(user: string, script: string): Reply | undefined {
    if (script.includes('command -v kubectl')) {
        if (user === 'nobin') return { stdout: sections({ path: '' }) };
        const version = '{"clientVersion":{"gitVersion":"v1.31.4"}}';
        if (user === 'ops') return { stdout: sections({ path: '/usr/local/bin/kubectl', version, config: EMPTY_CONFIG, 'config-exit': '0', 'sudo-config': fixture('config-view.json'), 'sudo-exit': '0' }) };
        if (user === 'nokube') return { stdout: sections({ path: '/usr/local/bin/kubectl', version, config: EMPTY_CONFIG, 'config-exit': '0' }) };
        return { stdout: sections({ path: '/usr/local/bin/kubectl', version, config: fixture('config-view.json'), 'config-exit': '0' }) };
    }
    if (!script.includes(KUBECTL)) return undefined;
    // A context whose sign-in expired (EKS/GKE tokens, kubelogin).
    if (script.includes("'expired'") || script.includes("'expired-pod'")) {
        return { stderr: "E1026 10:00:00.000000  1 memcache.go:265] couldn't get current server API group list: the server has asked for the client to provide credentials\nerror: You must be logged in to the server (the server has asked for the client to provide credentials)\n", code: 1 };
    }
    if (script.includes("'--context' 'k3s-admin'") && script.includes("'get' 'pods'")) {
        return { stderr: 'Error from server (Forbidden): pods is forbidden: User "viewer" cannot list resource "pods" in API group "" in the namespace "shop"\n', code: 1 };
    }
    if (script.includes("'get' 'pods'")) return { stdout: fixture('pods.json') };
    if (script.includes("'get' 'deployments.apps,statefulsets.apps,daemonsets.apps,jobs.batch,cronjobs.batch'")) return { stdout: fixture('workloads.json') };
    if (script.includes("'get' 'events'") && script.includes("'--field-selector'")) {
        const name = /involvedObject\.name=([a-z0-9.-]+)'/.exec(script)?.[1];
        const all = JSON.parse(fixture('events.json')) as { items: Array<{ involvedObject: { name: string } }> };
        return { stdout: JSON.stringify({ items: all.items.filter((event) => event.involvedObject.name === name) }) };
    }
    if (script.includes("'get' 'events'")) return { stdout: fixture('events.json') };
    if (script.includes("'get' 'nodes'")) return { stdout: fixture('nodes.json') };
    if (script.includes("'get' 'namespaces'")) return { stdout: '{"items":[{"metadata":{"name":"default"}},{"metadata":{"name":"shop"}}]}' };
    const pod = /'get' 'pod' '([a-z0-9.-]+)'/.exec(script)?.[1];
    if (pod) {
        const found = PODS.items.find((entry) => entry.metadata.name === pod);
        return found ? { stdout: JSON.stringify(found) } : { stderr: `Error from server (NotFound): pods "${pod}" not found\n`, code: 1 };
    }
    if (script.includes("'logs'")) return { stdout: `2026-10-24T10:00:00Z panic: dial tcp 10.43.0.99:5432: connect: connection refused (token=ghp_${'a'.repeat(36)})\n` };
    if (script.includes("'rollout' 'restart'")) return { stdout: 'deployment.apps/web restarted\n' };
    if (script.includes("'scale'")) return { stdout: 'deployment.apps/web scaled\n' };
    if (script.includes("'delete' 'pod'")) return { stdout: `pod "${API_POD}" deleted\n` };
    if (script.includes("'cordon'") || script.includes("'uncordon'")) return { stdout: 'node/k3s cordoned\n' };
    if (script.includes('hung-up')) return { stdout: 'hung-up 2\n' };
    return undefined;
}

async function startServer(): Promise<void> {
    sshd = new Server({ hostKeys: [generateKeyPair().privateKey] }, (client) => {
        let user = '';
        client.on('error', () => undefined);
        client.on('authentication', (ctx) => {
            user = ctx.username;
            return ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password']);
        });
        client.on('ready', () => client.on('session', (accept) => {
            const session = accept();
            session.on('pty', (acceptPty) => acceptPty?.());
            session.on('window-change', (acceptChange) => acceptChange?.());
            session.on('exec', (acceptExec, _reject, info) => {
                const channel = acceptExec();
                execs.push({ user, command: info.command });
                if (info.command.includes("'exec' '-it'")) {
                    podShell(channel);
                    return;
                }
                host.respond((script) => kubectl(user, script));
                if (!host.exec(info.command, channel)) {
                    channel.exit(127);
                    channel.end();
                }
            });
        }));
    });
    await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve));
    port = (sshd.address() as net.AddressInfo).port;
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T & { code?: string; error?: string } }> {
    const res = await server.fetch(path, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as T & { code?: string; error?: string } };
}

async function save(body: Record<string, unknown>): Promise<number> {
    const { body: saved } = await call<{ data: { id: number } }>('POST', '/api/servers', body);
    return saved.data.id;
}

async function auditEntries(): Promise<AuditEntry[]> {
    return (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops')).body.data;
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

const shellExecs = () => execs.filter((entry) => entry.command.includes("'exec' '-it'"));
const k8s = (name: string, path: string) => `/api/servers/${ids[name]}/k8s/${path}`;

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    host = createOpsHost();
    host.stream((script) => {
        if (!script.includes("'logs'")) return undefined;
        // The app container of a pod still initializing: kubectl refuses, on stderr.
        if (script.includes("'init-stuck'")) return { lines: [], exitCode: 1, stderr: 'Error from server (BadRequest): container "app" in pod "init-stuck" is waiting to start: PodInitializing\n' };
        return { lines: ['2026-10-24T10:00:00Z GET / 200', '2026-10-24T10:00:01Z GET /health 200'], exitCode: 0 };
    });
    await startServer();
    server = await bootTestServer();
    for (const user of ['demo', 'ops', 'nokube', 'nobin']) ids[user] = await save({ name: `k8s-${user}`, ip: '127.0.0.1', port, type: 'linux', username: user, password: 'secret' });
    ids.windows = await save({ name: 'k8s-windows', ip: '127.0.0.1', port, type: 'windows', username: 'demo', password: 'secret' });
    ids.shell = await save({ name: 'k8s-local-shell', type: 'local', ip: 'local', cli_preset: 'shell' });
    ids.ftp = await save({ name: 'k8s-ftp', type: 'ftp', ip: '127.0.0.1', port: 21, username: 'u', password: 'p' });
});

afterEach(async () => {
    while (sockets.length) sockets.pop()?.disconnect();
    await new Promise((resolve) => setTimeout(resolve, 150));
    execs.length = 0;
    host.scripts.length = 0;
});

afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => sshd?.close(() => resolve()));
    vi.restoreAllMocks();
});

describe('kubectl detection', () => {
    it('finds kubectl and the kubeconfig contexts, reading files only', async () => {
        const { status, body } = await call<K8sStatus>('GET', k8s('demo', 'status'));
        expect(status).toBe(200);
        expect(body).toMatchObject({ runner: 'ssh', available: true, sudo: false, kubectl: { path: '/usr/local/bin/kubectl', version: 'v1.31.4' }, currentContext: 'k3s-admin' });
        expect(body.contexts.map((context) => context.name)).toEqual(['k3s-admin', 'k3s-lab']);
        // Nothing of the kubeconfig but names, clusters and URLs comes back.
        expect(JSON.stringify(body)).not.toMatch(/DATA\+OMITTED|client-key/);
    });

    it("uses root's kubeconfig through sudo when the login user has none", async () => {
        const { body } = await call<K8sStatus>('GET', k8s('ops', 'status'));
        expect(body).toMatchObject({ available: true, sudo: true });
        await call('GET', k8s('ops', 'pods?context=k3s-lab&namespace=shop'));
        expect(host.scripts.at(-1)?.script).toContain(`exec sudo -n ${KUBECTL} '--context' 'k3s-lab'`);
    });

    it('says what is missing instead of failing', async () => {
        expect((await call<K8sStatus>('GET', k8s('nokube', 'status'))).body).toMatchObject({ available: false, problem: { code: 'NO_CONTEXTS' }, installUrl: 'https://kubernetes.io/docs/tasks/tools/' });
        expect((await call<K8sStatus>('GET', k8s('nobin', 'status'))).body).toMatchObject({ available: false, problem: { code: 'KUBECTL_MISSING' }, kubectl: null });
        // Views need a working kubectl.
        const pods = await call('GET', k8s('nobin', 'pods?context=k3s-lab&namespace=shop'));
        expect(pods).toMatchObject({ status: 409, body: { code: 'KUBECTL_MISSING' } });
    });

    it('only runs kubectl for Linux SSH servers and local kubectl connections', async () => {
        for (const name of ['windows', 'shell', 'ftp']) {
            const res = await call('GET', k8s(name, 'status'));
            expect(res, name).toMatchObject({ status: 409, body: { code: 'K8S_UNSUPPORTED' } });
        }
        expect((await call('GET', '/api/servers/99999/k8s/status')).status).toBe(404);
    });

    it('detects again when asked, and caches otherwise', async () => {
        await call('GET', k8s('demo', 'status'));
        const before = host.scripts.filter((entry) => entry.script.includes('command -v kubectl')).length;
        await call('GET', k8s('demo', 'status'));
        expect(host.scripts.filter((entry) => entry.script.includes('command -v kubectl')).length).toBe(before);
        await call('GET', k8s('demo', 'status?refresh=1'));
        expect(host.scripts.filter((entry) => entry.script.includes('command -v kubectl')).length).toBe(before + 1);
    });
});

describe('views', () => {
    it('lists pods with their problems, built from validated names', async () => {
        const { status, body } = await call<K8sPodList>('GET', k8s('demo', 'pods?context=k3s-lab&namespace=shop'));
        expect(status).toBe(200);
        expect(body.pods.find((pod) => pod.name === API_POD)).toMatchObject({ status: 'CrashLoopBackOff', problem: 'crash-loop', owner: { kind: 'Deployment', name: 'api' } });
        // The compact template, not whole objects (server/k8s/templates.ts;
        // it has no single quote, so its quoting is plain).
        expect(POD_LIST_TEMPLATE).not.toContain("'");
        const template = `'go-template=${POD_LIST_TEMPLATE}'`;
        expect(host.scripts.at(-1)?.script).toBe(`LC_ALL=C\nexport LC_ALL\nexec ${KUBECTL} '--context' 'k3s-lab' '--request-timeout=20s' 'get' 'pods' '-n' 'shop' '-o' ${template}\n`);

        await call('GET', k8s('demo', 'pods?context=k3s-lab&namespace=*'));
        expect(host.scripts.at(-1)?.script).toContain(`'get' 'pods' '--all-namespaces' '-o' ${template}`);
    });

    it('lists workloads, events, nodes and namespaces', async () => {
        const workloads = (await call<K8sWorkloadList>('GET', k8s('demo', 'workloads?context=k3s-lab&namespace=shop'))).body;
        expect(workloads.workloads.map((workload) => `${workload.kind}/${workload.name}`)).toContain('deployment/web');
        const events = (await call<{ events: Array<{ type: string }> }>('GET', k8s('demo', 'events?context=k3s-lab&namespace=shop'))).body.events;
        expect(events[0].type).toBe('Warning');
        const nodes = (await call<{ nodes: Array<{ name: string }> }>('GET', k8s('demo', 'nodes?context=k3s-lab'))).body.nodes;
        expect(nodes.map((node) => node.name)).toEqual(['k3s']);
        const namespaces = (await call<{ namespaces: string[] }>('GET', k8s('demo', 'namespaces?context=k3s-lab'))).body.namespaces;
        expect(namespaces).toEqual(['default', 'shop']);
    });

    it("describes a pod with its own events (env values only on demand, in the spec's words)", async () => {
        const { body } = await call<K8sPodDetail>('GET', k8s('demo', `pods/${API_POD}?context=k3s-lab&namespace=shop`));
        expect(body.pod.name).toBe(API_POD);
        expect(body.containers[0].lastState).toMatchObject({ state: 'terminated', reason: 'Error', exitCode: 1 });
        expect(body.events.length).toBeGreaterThan(0);
        expect(body.events.every((event) => event.object.name === API_POD)).toBe(true);
        expect(host.scripts.some((entry) => entry.script.includes(`'--field-selector' 'involvedObject.kind=Pod,involvedObject.name=${API_POD}'`))).toBe(true);
    });

    it('refuses unknown contexts and malformed names before anything runs', async () => {
        const before = host.scripts.length;
        expect(await call('GET', k8s('demo', 'pods?context=nope&namespace=shop'))).toMatchObject({ status: 404, body: { code: 'K8S_CONTEXT_NOT_FOUND' } });
        expect(await call('GET', k8s('demo', `pods?context=${encodeURIComponent("x'; id")}&namespace=shop`))).toMatchObject({ status: 400, body: { code: 'K8S_INVALID_INPUT' } });
        expect(await call('GET', k8s('demo', `pods?context=k3s-lab&namespace=${encodeURIComponent('$(id)')}`))).toMatchObject({ status: 400, body: { code: 'K8S_INVALID_INPUT' } });
        expect(await call('GET', k8s('demo', `pods/${encodeURIComponent('a;b')}?context=k3s-lab&namespace=shop`))).toMatchObject({ status: 400, body: { code: 'K8S_INVALID_INPUT' } });
        expect(host.scripts.slice(before).filter((entry) => entry.script.includes(KUBECTL))).toEqual([]);
    });

    it('reads RBAC refusals and missing objects as such', async () => {
        expect(await call('GET', k8s('demo', 'pods?context=k3s-admin&namespace=shop'))).toMatchObject({ status: 403, body: { code: 'K8S_FORBIDDEN' } });
        expect(await call('GET', k8s('demo', 'pods/gone-pod?context=k3s-lab&namespace=shop'))).toMatchObject({ status: 404, body: { code: 'K8S_NOT_FOUND' } });
    });

    // A 401 tells the frontend that ShellMind's own access token was refused
    // (it drops it and asks for one): the cluster's sign-in is never one.
    it("answers an expired cluster sign-in with K8S_AUTH_REQUIRED, never HTTP 401", async () => {
        for (const path of ['pods?context=k3s-lab&namespace=expired', 'workloads?context=k3s-lab&namespace=expired', 'events?context=k3s-lab&namespace=expired', 'pods/expired-pod?context=k3s-lab&namespace=shop']) {
            const res = await call('GET', k8s('demo', path));
            expect(res, path).toMatchObject({ status: 502, body: { code: 'K8S_AUTH_REQUIRED', error: expect.stringContaining('You must be logged in') } });
        }
        const action = await call('POST', k8s('demo', 'workloads/deployment/web/restart'), { context: 'k3s-lab', namespace: 'expired' });
        expect(action).toMatchObject({ status: 502, body: { code: 'K8S_AUTH_REQUIRED' } });
        const evidence = await call('POST', '/api/chat/evidence', { serverId: ids.demo, attachment: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: 'expired-pod' } });
        expect(evidence).toMatchObject({ status: 502, body: { code: 'K8S_AUTH_REQUIRED' } });
        // ShellMind's own token is still good.
        expect((await call('GET', '/api/session')).status).toBe(200);
    });
});

describe('actions', () => {
    it('restarts, scales, deletes pods and cordons nodes, each audited', async () => {
        const ctx = { context: 'k3s-lab', namespace: 'shop' };
        expect((await call('POST', k8s('demo', 'workloads/deployment/web/restart'), ctx)).body).toMatchObject({ ok: true, command: 'kubectl --context k3s-lab -n shop rollout restart deployment/web' });
        expect((await call('POST', k8s('demo', 'workloads/deployment/web/scale'), { ...ctx, replicas: 3 })).body).toMatchObject({ ok: true, command: 'kubectl --context k3s-lab -n shop scale deployment/web --replicas=3' });
        expect((await call('POST', k8s('demo', `pods/${API_POD}/delete`), ctx)).body).toMatchObject({ ok: true });
        expect((await call('POST', k8s('demo', 'nodes/k3s/cordon'), { context: 'k3s-lab' })).body).toMatchObject({ ok: true, command: 'kubectl --context k3s-lab cordon k3s' });

        const audit = await auditEntries();
        expect(audit.slice(0, 4).map((entry) => entry.meta?.action)).toEqual(['cordon', 'delete-pod', 'scale', 'restart']);
        expect(audit[2]).toMatchObject({ server_id: ids.demo, exit_code: 0, meta: { kind: 'k8s', target: 'web', context: 'k3s-lab', namespace: 'shop', workload: 'deployment', replicas: 3 } });
        // The request timeout is ShellMind's, not part of what the user did.
        expect(audit.every((entry) => !entry.command.includes('request-timeout'))).toBe(true);
    });

    it('validates what an action may touch', async () => {
        const ctx = { context: 'k3s-lab', namespace: 'shop' };
        expect((await call('POST', k8s('demo', 'workloads/job/migrate/restart'), ctx)).body.code).toBe('K8S_INVALID_INPUT');
        expect((await call('POST', k8s('demo', 'workloads/deployment/web/scale'), { ...ctx, replicas: -1 })).body.code).toBe('K8S_INVALID_INPUT');
        expect((await call('POST', k8s('demo', 'workloads/deployment/web/scale'), { ...ctx, replicas: '2; id' })).body.code).toBe('K8S_INVALID_INPUT');
        expect((await call('POST', k8s('demo', 'nodes/k3s/drain'), { context: 'k3s-lab' })).body.code).toBe('K8S_INVALID_INPUT');
        expect((await call('POST', k8s('demo', 'pods/web-1/delete'), { context: 'k3s-lab' })).body.code).toBe('K8S_INVALID_INPUT');
        expect((await call('POST', k8s('demo', 'use-context'), { context: 'missing' })).body.code).toBe('K8S_CONTEXT_NOT_FOUND');
    });

    it("changes kubectl's current context only when asked, and detects it again", async () => {
        const res = await call('POST', k8s('demo', 'use-context'), { context: 'k3s-lab' });
        expect(res.status).toBe(502);
        // The fake has no answer for `config use-context`: it failed, audited all the same.
        expect((await auditEntries())[0]).toMatchObject({ command: 'kubectl config use-context k3s-lab', exit_code: 127, meta: { action: 'use-context' } });
    });
});

describe('pod logs', () => {
    it('streams `kubectl logs -f` through the log socket', async () => {
        const socket = await open();
        let text = '';
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            text += payload.data;
            ack();
        });
        const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
        socket.emit('logs-start', { id: 'pod1', serverId: ids.demo, source: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: WEB_POD, container: 'nginx', tail: 500 } });
        expect((await ended).code).toBe(0);
        expect(text).toContain('GET /health 200');
        const stream = host.scripts.find((entry) => entry.kind === 'stream');
        expect(stream?.script).toContain(`LC_ALL=C ${KUBECTL} '--context' 'k3s-lab' '-n' 'shop' 'logs' '${WEB_POD}' '-c' 'nginx' '--tail=500' '-f' '--timestamps'`);
    });

    it("reports kubectl's refusal as an error, not as a line of the container's logs", async () => {
        const socket = await open();
        let text = '';
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            text += payload.data;
            ack();
        });
        const ended = vi.fn();
        socket.on('logs-end', ended);
        const failed = new Promise<{ code: string; message: string }>((resolve) => socket.once('logs-error', resolve));
        socket.emit('logs-start', { id: 'pod3', serverId: ids.demo, source: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: 'init-stuck', container: 'app', tail: 100 } });
        expect(await failed).toMatchObject({ code: 'K8S_CONTAINER_NOT_RUNNING', message: expect.stringContaining('is waiting to start: PodInitializing') });
        expect(text).toBe('');
        expect(ended).not.toHaveBeenCalled();
    });

    it('refuses a malformed pod source', async () => {
        const socket = await open();
        const failed = new Promise<{ code: string; message: string }>((resolve) => socket.once('logs-error', resolve));
        socket.emit('logs-start', { id: 'pod2', serverId: ids.demo, source: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: WEB_POD, container: "nginx'; id" } });
        expect(await failed).toMatchObject({ code: 'OPS_INVALID_INPUT' });
    });
});

describe('pod shells', () => {
    async function openShell(attach: unknown): Promise<{ socket: Socket; output: () => string; errors: ConnectionError[] }> {
        const socket = await open();
        let text = '';
        const errors: ConnectionError[] = [];
        socket.on('ssh-output', (data: ArrayBuffer | string) => { text += typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); });
        socket.on('ssh-error', (_message: string, error: ConnectionError) => errors.push(error));
        socket.emit('start-ssh', { serverId: ids.demo, purpose: 'terminal', cols: 100, rows: 30, attach });
        return { socket, output: () => text, errors };
    }

    it('runs `kubectl exec -it` on a pty, audited, and hangs up the shell left behind', async () => {
        const term = await openShell({ kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: WEB_POD, container: 'nginx' });
        await vi.waitFor(() => expect(term.output()).toContain('/ # '));
        const [shell] = shellExecs();
        expect(shell.command).toMatch(new RegExp(`^${KUBECTL} '--context' 'k3s-lab' '-n' 'shop' 'exec' '-it' '${WEB_POD}' '-c' 'nginx' '--' 'sh' '-c' 'export SHELLMIND_TERMINAL=[a-f0-9]{32}; command -v bash >/dev/null 2>&1 && exec bash; exec sh'$`));
        term.socket.emit('ssh-input', 'hostname\r');
        await vi.waitFor(() => expect(term.output()).toContain('ran: hostname'));
        expect((await auditEntries())[0]).toMatchObject({ server_id: ids.demo, meta: { kind: 'k8s', action: 'shell', target: WEB_POD, container: 'nginx', context: 'k3s-lab', namespace: 'shop' } });
        expect((await auditEntries())[0].command).not.toMatch(/SHELLMIND_TERMINAL/);

        const tag = /SHELLMIND_TERMINAL=([a-f0-9]{32})/.exec(shell.command)?.[1];
        term.socket.disconnect();
        await vi.waitFor(() => expect(host.scripts.some((entry) => entry.script.includes('hung-up') && entry.script.includes(`SHELLMIND_TERMINAL=${tag}`))).toBe(true));
        await vi.waitFor(async () => expect((await auditEntries())[0]).toMatchObject({ exit_code: 0, meta: { action: 'shell-end', target: WEB_POD, processes: 2 } }));
    });

    it('refuses a container that is not running, and malformed names', async () => {
        const crashed = await openShell({ kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: API_POD, container: 'api' });
        await vi.waitFor(() => expect(crashed.errors).toHaveLength(1));
        expect(crashed.errors[0]).toMatchObject({ code: 'K8S_CONTAINER_NOT_RUNNING', details: { state: 'CrashLoopBackOff' } });

        const bad = await openShell({ kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: WEB_POD, container: 'nginx; id' });
        await vi.waitFor(() => expect(bad.errors).toHaveLength(1));
        expect(bad.errors[0].code).toBe('INVALID_ATTACH');
        expect(shellExecs()).toEqual([]);
    });
});

describe('pod diagnosis evidence', () => {
    it('collects the state, events and logs of the pod in trouble, redacted', async () => {
        const { status, body } = await call<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId: ids.demo, attachment: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: API_POD } });
        expect(status).toBe(200);
        const { evidence } = body;
        expect(evidence.sections.map((section) => section.id)).toEqual(['pod', 'pod-events', 'pod-logs']);
        expect(evidence.sections[0].text).toContain('CrashLoopBackOff');
        expect(evidence.sections[2].text).toContain('connection refused');
        // A token in the logs is masked before anything leaves the backend.
        expect(evidence.sections[2].text).not.toContain('ghp_aaaa');
        expect(evidence.access).toEqual({ platform: 'linux', user: 'demo', admin: null, sudo: false });
    });

    it('refuses an attachment with a malformed name', async () => {
        const res = await call('POST', '/api/chat/evidence', { serverId: ids.demo, attachment: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: 'a;b' } });
        expect(res.status).toBe(400);
    });
});
