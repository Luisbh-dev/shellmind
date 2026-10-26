import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { POD_LIST_TEMPLATE } from '../../server/k8s/templates';
import type { K8sPodList, K8sStatus } from '../../shared/k8s';
import type { LogChunkPayload, LogEndPayload } from '../../shared/ops';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W8-T2 Kubernetes for a local connection with the kubectl preset: the
// backend runs this machine's kubectl (found on PATH, run without a shell)
// with the user's kubeconfig. A stand-in kubectl (test/fixtures/k8s/
// fake-kubectl.mjs) answers from real cluster output and records its argv.

vi.setConfig({ testTimeout: 30_000 });

const FAKE = fileURLToPath(new URL('../fixtures/k8s/fake-kubectl.mjs', import.meta.url));

let server: TestServer;
let binDir: string;
let logFile: string;
let localId: number;
let dockerId: number;
const savedPath = process.env.PATH;

// argv of every kubectl run so far.
const runs = (): string[][] => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as string[]) : []);

async function call<T = Record<string, unknown>>(method: string, url: string, body?: unknown): Promise<{ status: number; body: T & { code?: string } }> {
    const res = await server.fetch(url, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as T & { code?: string } };
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shellmind-fake-kubectl-'));
    logFile = path.join(binDir, 'runs.log');
    // A kubectl on PATH: a batch wrapper on Windows, an executable script elsewhere.
    if (process.platform === 'win32') {
        fs.writeFileSync(path.join(binDir, 'kubectl.cmd'), `@"${process.execPath}" "${FAKE}" %*\r\n`);
    } else {
        fs.writeFileSync(path.join(binDir, 'kubectl'), `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
        fs.chmodSync(path.join(binDir, 'kubectl'), 0o755);
    }
    process.env.PATH = `${binDir}${path.delimiter}${savedPath ?? ''}`;
    process.env.FAKE_KUBECTL_LOG = logFile;
    server = await bootTestServer({ env: { PATH: process.env.PATH, FAKE_KUBECTL_LOG: logFile } });
    const save = async (body: Record<string, unknown>) => (await call<{ data: { id: number } }>('POST', '/api/servers', body)).body.data.id;
    localId = await save({ name: 'kubectl here', type: 'local', ip: 'local', cli_preset: 'kubectl' });
    dockerId = await save({ name: 'docker here', type: 'local', ip: 'local', cli_preset: 'docker' });
});

afterAll(async () => {
    await server?.close();
    process.env.PATH = savedPath;
    delete process.env.FAKE_KUBECTL_LOG;
    fs.rmSync(binDir, { recursive: true, force: true });
    vi.restoreAllMocks();
});

describe('local kubectl', () => {
    it('finds kubectl on PATH and reads the contexts', async () => {
        const { body } = await call<K8sStatus>('GET', `/api/servers/${localId}/k8s/status`);
        expect(body).toMatchObject({ runner: 'local', available: true, sudo: false, kubectl: { version: 'v1.31.0-fake' }, currentContext: 'k3s-admin' });
        expect(body.kubectl?.path?.toLowerCase()).toContain(binDir.toLowerCase());
        expect(runs()).toEqual(expect.arrayContaining([['config', 'view', '-o', 'json'], ['version', '--client', '-o', 'json']]));
    });

    it('lists pods with the argv ShellMind built (no shell in between)', async () => {
        const { status, body } = await call<K8sPodList>('GET', `/api/servers/${localId}/k8s/pods?context=k3s-lab&namespace=shop`);
        expect(status).toBe(200);
        expect(body.pods.some((pod) => pod.problem === 'crash-loop')).toBe(true);
        // The compact template arrives whole, also through cmd.exe to the
        // Windows batch wrapper this test uses as kubectl.
        expect(runs().at(-1)).toEqual(['--context', 'k3s-lab', '--request-timeout=20s', 'get', 'pods', '-n', 'shop', '-o', `go-template=${POD_LIST_TEMPLATE}`]);
    });

    it("words kubectl's refusals", async () => {
        // The fake's "restricted" context does not exist in the kubeconfig: refused before kubectl runs.
        expect((await call('GET', `/api/servers/${localId}/k8s/pods?context=restricted&namespace=shop`)).body.code).toBe('K8S_CONTEXT_NOT_FOUND');
        expect((await call('GET', `/api/servers/${localId}/k8s/nodes?context=k3s-lab`)).body.code).toBe('K8S_COMMAND_FAILED');
    });

    it('scales, audited with the command as the user would type it', async () => {
        const res = await call('POST', `/api/servers/${localId}/k8s/workloads/deployment/web/scale`, { context: 'k3s-lab', namespace: 'shop', replicas: 2 });
        expect(res.body).toMatchObject({ ok: true, output: 'deployment.apps/web scaled' });
        const audit = (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops')).body.data;
        expect(audit[0]).toMatchObject({ server_id: localId, command: 'kubectl --context k3s-lab -n shop scale deployment/web --replicas=2', exit_code: 0 });
    });

    it('streams pod logs from a local kubectl process', async () => {
        const socket: Socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
        try {
            await new Promise<void>((resolve, reject) => {
                socket.once('connect', () => resolve());
                socket.once('connect_error', reject);
            });
            let text = '';
            socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
                text += payload.data;
                ack();
            });
            const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
            socket.emit('logs-start', { id: 'local1', serverId: localId, source: { kind: 'pod', context: 'k3s-lab', namespace: 'shop', pod: 'web-1', container: 'nginx', previous: true } });
            expect((await ended).code).toBe(0);
            expect(text).toContain('log of web-1/nginx (previous)');
            expect(runs().at(-1)).toEqual(['--context', 'k3s-lab', '--request-timeout=60s', '-n', 'shop', 'logs', 'web-1', '-c', 'nginx', '--tail=100', '--previous', '--timestamps']);
        } finally {
            socket.disconnect();
        }
    });

    it('is not offered for other local presets', async () => {
        expect((await call('GET', `/api/servers/${dockerId}/k8s/status`)).body.code).toBe('K8S_UNSUPPORTED');
    });
});
