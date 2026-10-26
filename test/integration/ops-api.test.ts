import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuditEntry } from '../../shared/types';
import { createOpsHost, sections, type OpsHost, type Reply } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Operations panels over HTTP against the in-process SSH server: requests
// name a unit or a container, the backend builds and runs the command.

vi.setConfig({ testTimeout: 20_000 });

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/ops/${name}`, import.meta.url)), 'utf8');

const LINUX_CAPS = sections({ uid: '1000', sudo: 'yes', systemd: 'yes', journal: 'yes', docker: 'sudo 26.1.4', podman: '', compose: 'yes' });

let server: TestServer;
let harness: SshHarness;
let host: OpsHost;
let linuxId: number;

type Json = Record<string, unknown> & { error?: string; code?: string };

async function call(method: string, path: string): Promise<{ status: number; body: Json }> {
    const res = await server.fetch(path, { method });
    return { status: res.status, body: await res.json() as Json };
}

async function saveServer(extra: Record<string, unknown> = {}, target: SshHarness = harness): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `ops-${Math.random()}`, ip: target.host, port: target.port, type: 'linux', username: 'tester', password: 'secret', ...extra }),
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

async function auditEntries(): Promise<AuditEntry[]> {
    const res = await server.fetch('/api/audit?source=ops');
    return ((await res.json()) as { data: AuditEntry[] }).data;
}

// The default fake Linux host: non-root user with passwordless sudo, systemd and Docker.
function linuxHost(script: string): Reply | undefined {
    if (script.includes('m uid')) return { stdout: LINUX_CAPS };
    if (script.includes('list-units --type=service')) return { stdout: fixture('systemctl.txt') };
    if (script.includes('systemctl show')) return { stdout: sections({ show: 'Id=nginx.service\nActiveState=failed\nMainPID=0', status: '× nginx.service - web server' }), code: 3 };
    if (script.includes("restart -- 'ssh.service'")) return { stderr: 'Failed to restart ssh.service: Access denied\n', code: 4 };
    if (script.includes('systemctl --no-ask-password')) return { stdout: '' };
    if (script.includes('journalctl -u')) return { stdout: '2024-05-06T10:00:00+0000 web-01 nginx[1]: started\n' };
    if (script.includes("'ps' '-a'")) return { stdout: sections({ ps: fixture('docker-ps.jsonl'), rc: '0', compose: '[{"Name":"web","Status":"running(2)","ConfigFiles":"/srv/web/compose.yaml"}]' }) };
    if (script.includes("'stats' '--no-stream'")) return { stdout: '{"ID":"3f4e5d6c7b8a","Name":"web-proxy-1","CPUPerc":"0.12%","MemPerc":"0.35%","MemUsage":"27.5MiB / 7.66GiB","NetIO":"1kB / 2kB","BlockIO":"0B / 0B","PIDs":"5"}\n' };
    if (script.includes("'inspect'")) return { stdout: '[{"Id":"3f4e","Name":"/web-proxy-1","State":{"Status":"running"}}]\n' };
    if (script.includes("'logs' '--tail'")) return { stdout: '2024-05-06T10:00:00Z GET / 200\n' };
    if (script.includes("'rm' '-f' 'gone'")) return { stdout: 'Error response from daemon: No such container: gone\n', code: 1 };
    if (script.includes("sudo -n docker '")) return { stdout: 'web-proxy-1\n' };
    return undefined;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    host = createOpsHost();
    host.respond(linuxHost);
    harness = await startSshServer({ exec: host.exec });
    linuxId = await saveServer();
});

afterEach(() => {
    host.scripts.length = 0;
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    vi.restoreAllMocks();
});

describe('capabilities', () => {
    it('detects once and caches until a refresh is asked for', async () => {
        const first = await call('GET', `/api/servers/${linuxId}/ops/capabilities`);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ platform: 'linux', root: false, sudo: true, systemd: true, containers: { engine: 'docker', compose: true } });
        await call('GET', `/api/servers/${linuxId}/ops/capabilities`);
        expect(host.scripts.filter((entry) => entry.script.includes('m uid'))).toHaveLength(1);
        await call('GET', `/api/servers/${linuxId}/ops/capabilities?refresh=1`);
        expect(host.scripts.filter((entry) => entry.script.includes('m uid'))).toHaveLength(2);
    });

    it('refuses servers without SSH', async () => {
        const ftp = await saveServer({ type: 'ftp' });
        expect(await call('GET', `/api/servers/${ftp}/ops/services`)).toEqual({
            status: 400, body: { error: 'Operations panels are only available for SSH-capable servers.', code: 'UNSUPPORTED_PURPOSE' },
        });
        expect((await call('GET', '/api/servers/999999/ops/services')).status).toBe(404);
    });

    it('answers a connection failure with its cause', async () => {
        const id = await saveServer({ password: 'wrong' });
        expect(await call('GET', `/api/servers/${id}/ops/services`)).toMatchObject({
            status: 502, body: { code: 'SSH_FAILED', error: expect.stringMatching(/^Auth failed/), details: { connection: { code: 'AUTH_FAILED' } } },
        });
    });
});

describe('services', () => {
    it('lists units with their unit file state', async () => {
        const res = await call('GET', `/api/servers/${linuxId}/ops/services`);
        expect(res.status).toBe(200);
        const services = res.body.services as Array<{ name: string; active: string; startup: string }>;
        expect(services.find((service) => service.name === 'nginx.service')).toMatchObject({ active: 'failed', startup: 'enabled' });
    });

    it('shows a unit and its journal', async () => {
        const detail = await call('GET', `/api/servers/${linuxId}/ops/services/nginx.service`);
        expect(detail.body).toMatchObject({ name: 'nginx.service', properties: { ActiveState: 'failed' }, statusText: '× nginx.service - web server' });
        const journal = await call('GET', `/api/servers/${linuxId}/ops/services/nginx.service/journal?lines=50`);
        expect(journal.body.text).toContain('nginx[1]: started');
        expect(host.scripts.at(-1)?.script).toContain("sudo -n journalctl -u 'nginx.service' -n 50");
    });

    it('runs an action through sudo and records it in the audit log', async () => {
        const res = await call('POST', `/api/servers/${linuxId}/ops/services/nginx.service/restart`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ ok: true, command: "sudo -n systemctl --no-ask-password restart -- 'nginx.service'" });
        expect((await auditEntries())[0]).toMatchObject({
            server_id: linuxId, source: 'ops', command: "sudo -n systemctl --no-ask-password restart -- 'nginx.service'", exit_code: 0,
            meta: { kind: 'service', action: 'restart', target: 'nginx.service' },
        });
    });

    it('answers 403 when the server refuses, and audits the failed attempt', async () => {
        const res = await call('POST', `/api/servers/${linuxId}/ops/services/ssh.service/restart`);
        expect(res).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED', error: 'Failed to restart ssh.service: Access denied' } });
        expect((await auditEntries())[0]).toMatchObject({ command: expect.stringContaining("'ssh.service'"), exit_code: 4 });
    });

    it('never runs a command for an invalid unit name or action', async () => {
        const injected = encodeURIComponent("nginx.service'; reboot; '");
        expect(await call('POST', `/api/servers/${linuxId}/ops/services/${injected}/restart`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/services/nginx.service/mask`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(host.scripts.some((entry) => entry.script.includes('reboot') || entry.script.includes('mask'))).toBe(false);
    });

    it('reports a server without systemd', async () => {
        const plain = createOpsHost();
        plain.respond((script) => (script.includes('m uid') ? { stdout: sections({ uid: '0', systemd: '', journal: '' }) } : undefined));
        const other = await startSshServer({ exec: plain.exec });
        try {
            const id = await saveServer({}, other);
            expect(await call('GET', `/api/servers/${id}/ops/services`)).toMatchObject({ status: 409, body: { code: 'OPS_UNSUPPORTED' } });
        } finally {
            await other.close();
        }
    });
});

describe('Windows services', () => {
    let windows: OpsHost;
    let windowsHarness: SshHarness;
    let windowsId: number;

    beforeAll(async () => {
        windows = createOpsHost();
        windows.respond((script, kind) => {
            if (kind !== 'powershell') return undefined;
            if (script.includes('docker=$null;compose=$false')) return { stdout: '{"admin":true,"docker":null,"compose":false}' };
            // As a user who is not an administrator sees them (see the scripts).
            if (script.includes('Get-Service -ErrorVariable e')) return { stdout: '{"limited":true,"services":[{"n":"BFE","d":"Base Filtering Engine","s":"Running","t":"Automatic"}]}' };
            if (script.includes("Get-Service -Name 'ShellMindHidden'") && script.includes('exit 5')) return { code: 5 };
            if (script.includes("Start-Service -Name 'ShellMindHidden'")) return { stderr: 'Access is denied: over SSH Windows lets only administrators query or manage most services.\r\n', code: 1 };
            if (script.includes('Win32_Service -Filter')) return { stdout: fixture('windows-service-detail.json') };
            if (script.includes("Stop-Service -Force -Name 'LanmanWorkstation'")) return { stdout: '' };
            // Captured from Windows Server 2025: the message, then CLIXML progress.
            if (script.includes("Start-Service -Name 'ShellMindNoSuchSvc'")) return { stderr: fixture('powershell-stderr-action.txt'), code: 1 };
            return undefined;
        });
        windowsHarness = await startSshServer({ exec: windows.exec });
        windowsId = await saveServer({ type: 'windows', port: null, ssh_port: windowsHarness.port }, windowsHarness);
    });

    afterAll(async () => {
        await windowsHarness?.close();
    });

    it('names the running dependents in the detail', async () => {
        const detail = await call('GET', `/api/servers/${windowsId}/ops/services/LanmanWorkstation`);
        expect(detail).toMatchObject({ status: 200, body: { name: 'LanmanWorkstation', dependents: ['SessionEnv'], properties: { State: 'Running' } } });
    });

    it('stops a service that has dependents (-Force) and audits it', async () => {
        const res = await call('POST', `/api/servers/${windowsId}/ops/services/LanmanWorkstation/stop`);
        expect(res).toMatchObject({ status: 200, body: { ok: true, command: "Stop-Service -Force -Name 'LanmanWorkstation'" } });
        expect((await auditEntries())[0]).toMatchObject({ server_id: windowsId, command: "Stop-Service -Force -Name 'LanmanWorkstation'", exit_code: 0 });
    });

    it('reports the cmdlet\'s own message when an action fails', async () => {
        const res = await call('POST', `/api/servers/${windowsId}/ops/services/ShellMindNoSuchSvc/start`);
        expect(res).toMatchObject({ status: 502, body: { code: 'OPS_COMMAND_FAILED', error: "Cannot find any service with service name 'ShellMindNoSuchSvc'." } });
        expect((await auditEntries())[0]).toMatchObject({ command: "Start-Service -Name 'ShellMindNoSuchSvc'", exit_code: 1 });
    });

    it('tells a user who may not list the services, query or manage one that it is refused', async () => {
        expect(await call('GET', `/api/servers/${windowsId}/ops/services`)).toMatchObject({ status: 200, body: { limited: true, services: [{ name: 'BFE', active: 'active' }] } });
        expect(await call('GET', `/api/servers/${windowsId}/ops/services/ShellMindHidden`)).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED', error: expect.stringMatching(/only administrators/) } });
        expect(await call('POST', `/api/servers/${windowsId}/ops/services/ShellMindHidden/start`)).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });
    });
});

describe('containers', () => {
    it('lists containers and compose projects', async () => {
        const res = await call('GET', `/api/servers/${linuxId}/ops/containers`);
        expect(res.status).toBe(200);
        expect(res.body).toMatchObject({ engine: 'docker', projects: [{ name: 'web' }] });
        expect((res.body.containers as Array<{ name: string }>).map((container) => container.name)).toEqual(['web-db-1', 'web-proxy-1', 'old-job']);
        expect(host.scripts.at(-1)?.script).toContain("sudo -n docker 'ps' '-a' '--no-trunc' '--format' '{{json .}}'");
    });

    it('reads stats, inspect output and logs', async () => {
        expect((await call('GET', `/api/servers/${linuxId}/ops/container-stats`)).body.stats).toEqual([
            expect.objectContaining({ name: 'web-proxy-1', cpuPercent: 0.12, pids: 5 }),
        ]);
        expect((await call('GET', `/api/servers/${linuxId}/ops/containers/web-proxy-1`)).body.inspect).toMatchObject({ Name: '/web-proxy-1' });
        expect((await call('GET', `/api/servers/${linuxId}/ops/containers/web-proxy-1/logs?lines=20`)).body.text).toContain('GET / 200');
        expect(host.scripts.at(-1)?.script).toContain("'logs' '--tail' '20' '--timestamps' 'web-proxy-1'");
    });

    it('runs and audits actions; engine errors come back as 502 with their message', async () => {
        expect(await call('POST', `/api/servers/${linuxId}/ops/containers/web-proxy-1/restart`)).toMatchObject({ status: 200, body: { ok: true } });
        const missing = await call('POST', `/api/servers/${linuxId}/ops/containers/gone/remove`);
        expect(missing).toMatchObject({ status: 502, body: { code: 'OPS_COMMAND_FAILED', error: 'Error response from daemon: No such container: gone' } });
        const [latest, previous] = await auditEntries();
        expect(latest).toMatchObject({ command: "sudo -n docker 'rm' '-f' 'gone'", exit_code: 1, meta: { kind: 'container', action: 'remove' } });
        expect(previous).toMatchObject({ command: "sudo -n docker 'restart' 'web-proxy-1'", exit_code: 0 });
    });

    it('rejects invalid references before running anything', async () => {
        expect(await call('POST', `/api/servers/${linuxId}/ops/containers/${encodeURIComponent('web;id')}/stop`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${linuxId}/ops/containers/web/exec`)).toMatchObject({ status: 400 });
        expect(host.scripts.some((entry) => entry.script.includes('web;id'))).toBe(false);
    });
});
