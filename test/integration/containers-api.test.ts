import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ComposeOverview, ContainerInspectSummary, DiskUsage, ImageList, LogChunkPayload, PrunePreview, PruneResult } from '../../shared/ops';
import type { AuditEntry } from '../../shared/types';
import { createOpsHost, sections, type OpsHost, type Reply } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7-S3 over HTTP (and the log socket) against the in-process SSH server:
// Compose projects, images and prunes, container details. Requests name a
// project, a service, an image or a mode; the backend builds the commands.

vi.setConfig({ testTimeout: 20_000 });

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/ops/${name}`, import.meta.url)), 'utf8');

// Non-root user, passwordless sudo, Docker through sudo with the Compose plugin.
const LINUX_CAPS = sections({ uid: '1000', sudo: 'yes', systemd: 'yes', journal: 'yes', docker: 'sudo 26.1.4', podman: '', compose: 'yes' });

const shop = (service: string) => JSON.stringify({
    ID: `shop-${service}-id`, Names: `shop-${service}-1`, Image: 'nginx:1.25', State: 'running', Status: 'Up 2 hours', CreatedAt: '2026-10-24 15:18:17 +0000 UTC',
    Labels: `com.docker.compose.project=shop,com.docker.compose.service=${service},com.docker.compose.project.working_dir=/srv/shop,com.docker.compose.project.config_files=/srv/shop/compose.yaml,/srv/shop/compose.prod.yaml`,
});
// A container labelled with a project name ShellMind never passes to Compose.
const ODD = JSON.stringify({ ID: 'odd-id', Names: 'odd-1', Image: 'alpine:3', State: 'running', Status: 'Up 1 hour', Labels: 'com.docker.compose.project=bad;id,com.docker.compose.service=web' });
const COMPOSE_PS = [shop('web'), shop('db'), ODD].join('\n');

const ID = (n: number) => `sha256:${String(n).repeat(64)}`;
const IMAGES = [
    { ID: ID(1), Repository: 'nginx', Tag: '1.25', Size: '187MB', CreatedAt: '2026-09-01 10:00:00 +0000 UTC', CreatedSince: '7 weeks ago' },
    { ID: ID(2), Repository: '<none>', Tag: '<none>', Size: '187MB', CreatedAt: '2026-08-01 10:00:00 +0000 UTC', CreatedSince: '3 months ago' },
    { ID: ID(3), Repository: 'old/api', Tag: '0.9', Size: '50MB', CreatedAt: '2026-01-01 10:00:00 +0000 UTC', CreatedSince: '9 months ago' },
].map((item) => JSON.stringify(item)).join('\n');

let server: TestServer;
let harness: SshHarness;
let host: OpsHost;
let linuxId: number;
let windowsId: number;
// Paths the scripted host reports missing.
let missing: string[] = [];
const sockets: Socket[] = [];

type Json = Record<string, unknown> & { error?: string; code?: string };

async function call<T = Json>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as T };
}

async function saveServer(extra: Record<string, unknown> = {}): Promise<number> {
    const { body } = await call<{ data: { id: number } }>('POST', '/api/servers', { name: `c-${Math.random()}`, ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret', ...extra });
    return body.data.id;
}

async function auditEntries(): Promise<AuditEntry[]> {
    return (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops')).body.data;
}

const posixScripts = () => host.scripts.filter((entry) => entry.kind === 'posix').map((entry) => entry.script);

function linuxHost(script: string, kind: 'posix' | 'powershell'): Reply | undefined {
    if (kind === 'powershell') return script.includes('docker=$null;compose=$false') ? { stdout: '{"admin":true,"docker":"ok 26.1.4","compose":true}' } : undefined;
    if (script.includes('m uid')) return { stdout: LINUX_CAPS };
    if (script.includes("'label=com.docker.compose.project'")) return { stdout: sections({ ps: COMPOSE_PS, rc: '0' }) };
    if (script.includes('test -r') || script.includes('test -d')) return { stdout: missing.map((path) => `${path}\n`).join('') };
    // With the coloured banner `podman compose` prints even without a terminal.
    if (script.includes("'compose' '-p' 'shop'")) return { stdout: '\x1b[4m>>>> Executing external compose provider <<<<\x1b[0m\n Container shop-web-1  Restarting\n Container shop-web-1  Started\n' };
    if (script.includes("'image' 'ls' '-a'")) return { stdout: sections({ images: IMAGES, rc: '0', dangling: ID(2), used: ID(1) }) };
    if (script.includes("'system' 'df'")) {
        return {
            stdout: sections({
                summary: '{"Active":"1","Reclaimable":"237MB (63%)","Size":"424MB","TotalCount":"3","Type":"Images"}\n{"Active":"0","Reclaimable":"1.5GB","Size":"2GB","TotalCount":"40","Type":"Build Cache"}',
                rc: '0',
                ...(script.includes("'-v'") ? { verbose: JSON.stringify({ Images: [{ ID: ID(2), UniqueSize: '12MB' }, { ID: ID(3), UniqueSize: '50MB' }, { ID: ID(1), UniqueSize: '120MB' }] }) } : {}),
            }),
        };
    }
    if (script.includes("'image' 'prune'")) return { stdout: 'Deleted Images:\ndeleted: sha256:2222\n\nTotal reclaimed space: 12MB\n' };
    if (script.includes("'image' 'rm' 'nginx:1.25'")) return { stdout: 'Error response from daemon: conflict: unable to remove repository reference "nginx:1.25" (must force) - container shop-web-id is using its referenced image\n', code: 1 };
    if (script.includes("'image' 'rm'")) return { stdout: 'Untagged: old/api:0.9\n' };
    if (script.includes("'inspect' '--type' 'container' 'shop-web-1'")) return { stdout: fixture('docker-inspect.json') };
    if (script.includes("'stats' '--no-stream'")) return { stdout: '{"ID":"fde9ade5780c","Name":"shop-web-1","CPUPerc":"1.25%","MemPerc":"3.10%","MemUsage":"48MiB / 1.5GiB","NetIO":"1kB / 2kB","BlockIO":"0B / 0B","PIDs":"9"}\n' };
    return undefined;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    host = createOpsHost();
    host.respond(linuxHost);
    host.stream((script) => (script.includes("'logs' '-f'") ? { lines: ['web-1  | GET / 200'], intervalMs: 30 } : undefined));
    harness = await startSshServer({ exec: host.exec });
    linuxId = await saveServer();
    // A Windows server's SSH port is ssh_port (port is RDP's).
    windowsId = await saveServer({ type: 'windows', port: null, ssh_port: harness.port });
});

afterEach(() => {
    host.scripts.length = 0;
    missing = [];
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    vi.restoreAllMocks();
});

describe('compose projects', () => {
    it('lists the projects with their files and the ones the server lost', async () => {
        missing = ['/srv/shop/compose.prod.yaml'];
        const { status, body } = await call<ComposeOverview>('GET', `/api/servers/${linuxId}/ops/compose`);
        expect(status).toBe(200);
        expect(body).toMatchObject({ engine: 'docker', tool: 'docker compose', problem: null });
        expect(body.projects).toEqual([
            // Listed, but nothing runs for it (its actions would only fail validation).
            expect.objectContaining({ name: 'bad;id', running: 1, actionable: false }),
            expect.objectContaining({
                name: 'shop', workingDir: '/srv/shop', configFiles: ['/srv/shop/compose.yaml', '/srv/shop/compose.prod.yaml'], missingFiles: ['/srv/shop/compose.prod.yaml'], running: 2, actionable: true,
            }),
        ]);
        // The engine runs through sudo, so the files are checked the same way.
        expect(posixScripts().find((script) => script.includes('test -r'))).toContain("sudo -n test -r '/srv/shop/compose.yaml'");
    });

    it('restarts a service with the project files, audited', async () => {
        const { status, body } = await call<{ command: string; output: string }>('POST', `/api/servers/${linuxId}/ops/compose/shop/restart`, { service: 'web' });
        expect(status).toBe(200);
        expect(body.command).toBe("sudo -n docker 'compose' '-p' 'shop' '--project-directory' '/srv/shop' '-f' '/srv/shop/compose.yaml' '-f' '/srv/shop/compose.prod.yaml' 'restart' 'web'");
        expect(body.output).toBe('>>>> Executing external compose provider <<<<\n Container shop-web-1  Restarting\n Container shop-web-1  Started');
        const script = posixScripts().find((entry) => entry.includes("'restart' 'web'"));
        expect(script).toBe(`cd '/' || exit 1\n${body.command} 2>&1\n`);
        expect((await auditEntries())[0]).toMatchObject({ command: body.command, exit_code: 0, meta: { kind: 'compose', action: 'restart', target: 'shop', service: 'web' } });
    });

    it('pulls then recreates, and refuses up and update once a file is gone', async () => {
        const update = await call<{ command: string }>('POST', `/api/servers/${linuxId}/ops/compose/shop/update`);
        expect(update.body.command).toMatch(/'pull' && sudo -n docker 'compose' .* 'up' '-d'$/);
        missing = ['/srv/shop/compose.yaml'];
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/shop/up`)).toMatchObject({
            status: 409, body: { code: 'COMPOSE_FILES_MISSING', details: { project: 'shop', files: '/srv/shop/compose.yaml' } },
        });
        const down = await call<{ command: string }>('POST', `/api/servers/${linuxId}/ops/compose/shop/down`);
        expect(down.body.command).toBe("sudo -n docker 'compose' '-p' 'shop' 'down'");
    });

    it('validates names, actions and services before running anything', async () => {
        const before = host.scripts.length;
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/${encodeURIComponent('shop;id')}/up`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/shop/exec`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/shop/down`, { service: 'web' })).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/shop/restart`, { service: "web' && id" })).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/shop/restart`, { service: ['web'] })).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        // No Compose command or project lookup ran (at most the capability check).
        expect(host.scripts.slice(before).filter((entry) => /'compose' '-p'|label=com\.docker\.compose\.project/.test(entry.script))).toEqual([]);
        expect(await call('POST', `/api/servers/${linuxId}/ops/compose/ghost/restart`)).toMatchObject({ status: 404, body: { code: 'OPS_NOT_FOUND' } });
    });

    it('is a Linux feature', async () => {
        expect(await call('GET', `/api/servers/${windowsId}/ops/compose`)).toMatchObject({ status: 409, body: { code: 'OPS_UNSUPPORTED' } });
        expect(await call('GET', `/api/servers/${windowsId}/ops/images`)).toMatchObject({ status: 409, body: { code: 'OPS_UNSUPPORTED' } });
    });

    it('follows the logs of a project over the log socket', async () => {
        const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
        sockets.push(socket);
        let text = '';
        socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
            text += payload.data;
            ack();
        });
        socket.emit('logs-start', { id: 'c1', serverId: linuxId, source: { kind: 'compose', project: 'shop', service: 'web' } });
        await vi.waitFor(() => expect(text).toContain('web-1  | GET / 200'), { timeout: 10_000 });
        const stream = host.scripts.find((entry) => entry.kind === 'stream')?.script ?? '';
        expect(stream).toContain("cd '/' && exec sudo -n docker 'compose' '-p' 'shop' '--project-directory' '/srv/shop'");
        expect(stream).toContain("'logs' '-f' '--tail' '200' '--timestamps' 'web' </dev/null 2>&1 & p=$!");

        const error = new Promise<{ code: string }>((resolve) => socket.once('logs-error', resolve));
        socket.emit('logs-start', { id: 'c2', serverId: linuxId, source: { kind: 'compose', project: 'shop', service: 'web;id' } });
        expect(await error).toMatchObject({ code: 'OPS_INVALID_INPUT' });
    });
});

describe('images', () => {
    it('lists images, flags and the disk usage', async () => {
        const list = await call<ImageList>('GET', `/api/servers/${linuxId}/ops/images`);
        expect(list.body.images.map((image) => [image.reference, image.containers, image.dangling])).toEqual([
            [null, 0, true], ['nginx:1.25', 1, false], ['old/api:0.9', 0, false],
        ]);
        const usage = await call<DiskUsage>('GET', `/api/servers/${linuxId}/ops/disk-usage`);
        expect(usage.body.rows).toEqual([
            { kind: 'images', count: 3, active: 1, size: 424_000_000, reclaimable: 237_000_000 },
            { kind: 'build-cache', count: 40, active: 0, size: 2_000_000_000, reclaimable: 1_500_000_000 },
        ]);
        // The summary alone: the per-image sizes are read for a prune preview.
        expect(posixScripts().find((script) => script.includes("'system' 'df'"))).not.toContain("'-v'");
    });

    it('previews a prune with the space it frees, then prunes, audited', async () => {
        const preview = await call<PrunePreview>('GET', `/api/servers/${linuxId}/ops/images/prune-preview?mode=unused`);
        expect(preview.body).toMatchObject({ mode: 'unused', bytes: 62_000_000, estimate: 'at-least' });
        expect(preview.body.images.map((image) => image.id)).toEqual([ID(2), ID(3)]);
        const cache = await call<PrunePreview>('GET', `/api/servers/${linuxId}/ops/images/prune-preview?mode=build-cache`);
        expect(cache.body).toEqual({ mode: 'build-cache', images: [], bytes: 1_500_000_000, estimate: 'exact' });

        const prune = await call<PruneResult>('POST', `/api/servers/${linuxId}/ops/images/prune`, { mode: 'dangling' });
        expect(prune).toMatchObject({ status: 200, body: { command: "sudo -n docker 'image' 'prune' '-f'", reclaimedBytes: 12_000_000 } });
        expect((await auditEntries())[0]).toMatchObject({ command: "sudo -n docker 'image' 'prune' '-f'", exit_code: 0, meta: { kind: 'image', action: 'prune-dangling' } });
        expect(await call('GET', `/api/servers/${linuxId}/ops/images/prune-preview?mode=all`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/images/prune`, {})).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
    });

    it('removes an unused image; the engine refuses one a container uses', async () => {
        expect(await call('POST', `/api/servers/${linuxId}/ops/images/remove`, { ref: 'old/api:0.9' })).toMatchObject({ status: 200, body: { command: "sudo -n docker 'image' 'rm' 'old/api:0.9'" } });
        const busy = await call('POST', `/api/servers/${linuxId}/ops/images/remove`, { ref: 'nginx:1.25' });
        expect(busy).toMatchObject({ status: 502, body: { code: 'OPS_COMMAND_FAILED', error: expect.stringContaining('container shop-web-id is using its referenced image') } });
        // The engine's message (printed on stdout, 2>&1) is the audited error.
        expect((await auditEntries())[0]).toMatchObject({
            command: "sudo -n docker 'image' 'rm' 'nginx:1.25'",
            exit_code: 1,
            meta: { action: 'remove', error: expect.stringContaining('container shop-web-id is using its referenced image') },
        });
        expect(await call('POST', `/api/servers/${linuxId}/ops/images/remove`, { ref: "x' || reboot #" })).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
    });
});

describe('container details', () => {
    it('answers inspect with its summary and one container\'s usage', async () => {
        const detail = await call<{ inspect: { Id: string }; summary: ContainerInspectSummary }>('GET', `/api/servers/${linuxId}/ops/containers/shop-web-1`);
        expect(detail.body.inspect.Id).toMatch(/^fde9ade5780c/);
        expect(detail.body.summary).toMatchObject({ name: 'demo-web-1', health: { status: 'healthy' }, ports: [{ port: '80/tcp', hostPort: '8080' }, { port: '9000/tcp', hostPort: null }] });
        const usage = await call('GET', `/api/servers/${linuxId}/ops/containers/shop-web-1/stats`);
        expect(usage.body).toEqual({ stats: { id: 'fde9ade5780c', name: 'shop-web-1', cpuPercent: 1.25, memoryPercent: 3.1, memoryUsage: '48MiB / 1.5GiB', netIO: '1kB / 2kB', blockIO: '0B / 0B', pids: 9 } });
        expect(posixScripts().find((script) => script.includes("'stats'"))).toContain("sudo -n docker 'stats' '--no-stream' '--no-trunc' '--format' '{{json .}}' 'shop-web-1'");
        expect(await call('GET', `/api/servers/${linuxId}/ops/containers/${encodeURIComponent('a;b')}/stats`)).toMatchObject({ status: 400 });
    });
});
