import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MultiExecJob } from '../../shared/multiexec';
import type { PatchApplyResponse, PatchFleet, PatchPreview, PatchScan, PatchScanEvent } from '../../shared/patch';
import type { AuditEntry } from '../../shared/types';
import { createOpsHost, type OpsHost, type Reply } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The patch center over HTTP against the in-process SSH server: scans answer
// with output captured on a real Debian host, runs are multi-exec jobs whose
// servers run the patch script and reboot (the harness "boots" again when
// asked to), and everything that changes a server is in the audit log.

vi.setConfig({ testTimeout: 30_000 });

const fixture = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../fixtures/patch/${name}`, import.meta.url)), 'utf8');

let server: TestServer;
let harness: SshHarness;
let host: OpsHost;
let debianId: number;
let windowsId: number;
let wrongId: number;
let behindId: number;

// The fake host's state: what the scan reports and which boot it is in.
let pendingSecurity = true;
let bootId = 'boot-a';
let applyReply: Reply | null = null;

const windowsReport = JSON.stringify({
    updates: [{ title: '2026-09 Security Update (KB5122871)', kb: ['5122871'], severity: 'Critical', classes: [{ id: '0fa1201d-4330-4fa8-8ae9-b877473b6441', name: 'Security Updates' }], reboot: 2 }],
    error: null, reboot: true, admin: true, lastInstall: '2026-10-24T04:08:56Z', lastSearch: '2026-10-24T20:16:59Z'
});

function patchHost(script: string, kind: 'posix' | 'powershell'): Reply | undefined {
    if (kind === 'powershell') return script.includes('Microsoft.Update.Session') ? { stdout: windowsReport } : undefined;
    if (script.startsWith('LC_ALL=C') && script.includes('@@rc')) {
        // The scan: Debian with or without its security updates.
        const scan = fixture('scan-debian.txt');
        return { stdout: pendingSecurity ? scan : scan.replace(/Debian-Security:12\/oldstable-security/g, 'Debian:12.15/oldstable').replace(/@@SM:aptsecurity\n[\s\S]*?(?=@@SM:)/, '@@SM:aptsecurity\n') };
    }
    if (script.startsWith('# ShellMind patch center:')) {
        if (applyReply) return applyReply;
        pendingSecurity = false;
        return { stdout: '[shellmind] manager=apt\n+ sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade perl-base\n[shellmind] reboot-required=yes\n' };
    }
    // The boot check (server/patch/scripts.ts BOOT_CHECK_SCRIPT; server modules load after the backend boots).
    if (script.includes('m boot\n')) {
        return { stdout: `\n@@SM:boot\n${bootId}\n@@SM:pid1\n120\n@@SM:hz\n100\n@@SM:uptime\n${bootId === 'boot-a' ? '86400.0' : '12.5'}\n@@SM:state\nrunning\n@@SM:failed\n0\n@@SM:end\n` };
    }
    if (script.includes('systemctl reboot')) {
        bootId = 'boot-b';
        return { stdout: '' };
    }
    return undefined;
}

async function json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    return { status: res.status, body: await res.json() as T };
}

const post = <T>(path: string, body: unknown) => json<T>(path, { method: 'POST', body: JSON.stringify(body) });

async function saveServer(extra: Record<string, unknown>): Promise<number> {
    const { body } = await post<{ data: { id: number } }>('/api/servers', {
        name: `patch-${Math.random()}`, ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret', ...extra
    });
    return body.data.id;
}

async function scanEvents(serverIds: number[]): Promise<PatchScanEvent[]> {
    const res = await server.fetch('/api/patch/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverIds }) });
    expect(res.status).toBe(200);
    return (await res.text()).split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)) as PatchScanEvent);
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 20_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

const jobOf = async (id: string) => (await json<{ data: MultiExecJob }>(`/api/multiexec/jobs/${id}`)).body.data;
const finished = (id: string) => waitFor(async () => {
    const job = await jobOf(id);
    return ['done', 'stopped', 'cancelled', 'interrupted'].includes(job.status) ? job : null;
});

async function audit(): Promise<AuditEntry[]> {
    return (await json<{ data: AuditEntry[] }>('/api/audit?source=ops')).body.data;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    host = createOpsHost();
    host.respond(patchHost);
    harness = await startSshServer({ exec: host.exec, users: [{ username: 'tester', password: 'secret' }] });
    debianId = await saveServer({ name: 'debian-web' });
    // A Windows server's SSH port is ssh_port (port is Remote Desktop's).
    windowsId = await saveServer({ name: 'win-01', type: 'windows', port: 3389, ssh_port: harness.port });
    wrongId = await saveServer({ name: 'wrong-password', password: 'nope' });
    behindId = await saveServer({ name: 'behind-debian', jump_server_id: debianId });
    await post('/api/servers', { name: 'bucket', type: 's3', ip: '', s3_bucket: 'b', s3_access_key: 'k', s3_secret_key: 's' });
});

beforeEach(() => {
    applyReply = null;
});

afterAll(async () => {
    await server?.close();
    await harness?.close();
    vi.restoreAllMocks();
});

describe('patch center API', () => {
    it('needs the session token, like every route', async () => {
        const res = await fetch(`${server.baseUrl}/api/patch/fleet`);
        expect(res.status).toBe(401);
        const scan = await fetch(`${server.baseUrl}/api/patch/scan`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"serverIds":[1]}' });
        expect(scan.status).toBe(401);
    });

    it('lists the SSH servers, with the jump hosts they carry and no scan yet', async () => {
        const { body } = await json<{ data: PatchFleet }>('/api/patch/fleet');
        const rows = new Map(body.data.rows.map((row) => [row.serverId, row]));
        expect([...rows.keys()].sort((a, b) => a - b)).toEqual([debianId, windowsId, wrongId, behindId].sort((a, b) => a - b));
        expect(rows.get(debianId)).toMatchObject({ scan: null, scanError: null, jumpHostFor: [behindId], jobId: null });
    });

    it('scans several servers as a stream and keeps what it read, failures included', async () => {
        const events = await scanEvents([debianId, wrongId, windowsId]);
        expect(events.at(-1)).toEqual({ type: 'end' });
        const scans = new Map(events.flatMap((event) => (event.type === 'scan' ? [[event.serverId, event.scan] as const] : [])));
        expect(scans.get(debianId)).toMatchObject({ manager: 'apt', privilege: 'sudo', total: 45, security: 19 });
        expect(scans.get(windowsId)).toMatchObject({ platform: 'windows', manager: 'windows-update', total: 1, security: 1, rebootRequired: true });
        expect(events.find((event) => event.type === 'error')).toMatchObject({ serverId: wrongId, error: { code: 'AUTH_FAILED' } });
        expect(events.filter((event) => event.type === 'start')).toHaveLength(3);

        const { body } = await json<{ data: PatchFleet }>('/api/patch/fleet');
        const rows = new Map(body.data.rows.map((row) => [row.serverId, row]));
        expect(rows.get(debianId)?.scan).toMatchObject({ total: 45, security: 19, held: 0, patches: 0 });
        expect(rows.get(debianId)?.scan).not.toHaveProperty('updates');
        expect(rows.get(wrongId)).toMatchObject({ scan: null, scanError: { code: 'AUTH_FAILED' } });

        const one = await json<{ data: { scan: PatchScan } }>(`/api/servers/${debianId}/patch`);
        expect(one.body.data.scan.updates).toHaveLength(45);
    });

    it('checks what it is asked', async () => {
        expect((await post('/api/patch/scan', { serverIds: [] })).body).toMatchObject({ code: 'INVALID_PATCH' });
        expect((await post('/api/patch/preview', { serverIds: [debianId], mode: 'everything' })).body).toMatchObject({ code: 'INVALID_PATCH', details: { field: 'mode' } });
        expect((await post('/api/patch/preview', { serverIds: [debianId], mode: 'all', reboot: 'yes' })).body).toMatchObject({ code: 'INVALID_PATCH', details: { field: 'reboot' } });
        expect((await post('/api/patch/apply', { serverIds: [debianId], mode: 'all' })).body).toMatchObject({ code: 'INVALID_PATCH', details: { field: 'confirm' } });
        expect((await post('/api/patch/apply', { serverIds: [debianId], mode: 'all', confirm: 1, timeoutSec: 5 })).body).toMatchObject({ code: 'INVALID_PATCH', details: { field: 'timeoutSec' } });
        // A reboot's wait for SSH must fit in the time per server.
        expect((await post('/api/patch/apply', { serverIds: [debianId], mode: 'all', reboot: true, confirm: 1, timeoutSec: 900, rebootWaitSec: 1800 })).body).toMatchObject({ code: 'INVALID_PATCH', details: { field: 'timeoutSec', min: 2100 } });
        expect((await post(`/api/servers/999999/patch/scan`, {})).status).toBe(404);
        const s3 = (await json<{ data: Array<{ id: number; type: string }> }>('/api/servers')).body.data.find((entry) => entry.type === 's3')!;
        expect((await post(`/api/servers/${s3.id}/patch/scan`, {})).body).toMatchObject({ code: 'PATCH_UNSUPPORTED' });
    });

    it('previews a run: who runs, who does not and why, and the commands', async () => {
        const { body } = await post<{ data: PatchPreview }>('/api/patch/preview', { serverIds: [debianId, windowsId, wrongId, behindId, 424242], mode: 'security', reboot: true });
        const skips = Object.fromEntries(body.data.servers.map((entry) => [entry.serverId, entry.skip]));
        expect(skips).toEqual({ [debianId]: null, [windowsId]: 'windows', [wrongId]: 'scan-failed', [behindId]: 'not-scanned', 424242: 'not-found' });
        expect(body.data).toMatchObject({ eligible: 1, totals: { pending: 19, security: 19 }, rebootable: 0, commands: [{ manager: 'apt' }] });
        // It carries another server's connection: never rebooted by a run.
        expect(body.data.servers[0]).toMatchObject({ reboot: 'jump-host', jumpHostFor: [behindId], pending: 19 });
        expect(body.data.script.split('\n')[0]).toBe('# ShellMind patch center: install security updates, then reboot where a reboot is required');
    });

    it('runs as a multi-exec job: the script, the reboot and the wait for SSH, all in the audit log', async () => {
        // A server that is not a jump host, so the run reboots it.
        const soloId = await saveServer({ name: 'debian-solo' });
        await scanEvents([soloId]);
        pendingSecurity = true;
        bootId = 'boot-a';

        const mismatch = await post<{ code: string }>('/api/patch/apply', { serverIds: [soloId, windowsId], mode: 'security', reboot: true, confirm: 2 });
        expect(mismatch).toMatchObject({ status: 409, body: { code: 'PATCH_CONFIRM_MISMATCH', details: { expected: 1 } } });

        const { status, body } = await post<{ data: PatchApplyResponse }>('/api/patch/apply', { serverIds: [soloId, windowsId], mode: 'security', reboot: true, confirm: 1, rebootWaitSec: 60 });
        expect(status).toBe(201);
        expect(body.data.targets.map((target) => target.serverId)).toEqual([soloId]);
        expect(body.data.skipped.map((entry) => [entry.serverId, entry.skip])).toEqual([[windowsId, 'windows']]);
        expect(body.data.job).toMatchObject({ danger: 'power', total: 1, command: expect.stringMatching(/^# ShellMind patch center: install security updates/) });

        const job = await finished(body.data.job.id);
        expect(job.status).toBe('done');
        const run = job.servers[0];
        expect(run).toMatchObject({ status: 'ok', exitCode: 0 });
        expect(run.stdout).toContain('install --only-upgrade perl-base');
        expect(run.stdout).toMatch(/\[shellmind\] reboot=start\n\[shellmind\] reboot=waiting\n\[shellmind\] reboot=back after=\d+ up=\d+ state=running failed=0\n/);
        expect(bootId).toBe('boot-b');

        const entries = (await audit()).filter((entry) => entry.server_id === soloId);
        expect(entries.find((entry) => entry.command === 'patch center: install security updates, then reboot where a reboot is required')).toMatchObject({
            exit_code: 0,
            meta: { patch: true, mode: 'security', reboot: true, refresh: false, jobId: job.id, status: 'ok' }
        });
        expect(entries.find((entry) => entry.command === 'reboot (patch center)')).toMatchObject({ exit_code: 0, meta: { patch: true, action: 'reboot', jobId: job.id, state: 'running' } });
        // Not a "multi-exec" command, and no script text in the log.
        expect((await json<{ data: AuditEntry[] }>('/api/audit?source=multi-exec')).body.data.filter((entry) => entry.server_id === soloId)).toEqual([]);

        // The run's servers are read again once it ends.
        const reread = await waitFor(async () => {
            const state = (await json<{ data: { scan: PatchScan } }>(`/api/servers/${soloId}/patch`)).body.data;
            return state.scan.security === 0 ? state.scan : null;
        });
        expect(reread.total).toBe(45);
    });

    it('holds a server while a run is on it, and lets it go when the run is cancelled', async () => {
        const holdId = await saveServer({ name: 'debian-hold' });
        pendingSecurity = true;
        await scanEvents([holdId]);
        applyReply = { hang: true };
        // Two runs asked for at once: one starts, the other finds the server taken.
        const attempts = await Promise.all([1, 2].map(() => post<{ data?: PatchApplyResponse; code?: string }>('/api/patch/apply', { serverIds: [holdId], mode: 'all', confirm: 1 })));
        expect(attempts.map((attempt) => attempt.status).sort()).toEqual([201, 409]);
        expect(['PATCH_BUSY', 'PATCH_NOTHING_TO_RUN']).toContain(attempts.find((attempt) => attempt.status === 409)?.body.code);
        const jobId = attempts.find((attempt) => attempt.status === 201)!.body.data!.job.id;
        await waitFor(async () => (await jobOf(jobId)).servers[0].status === 'running');

        const fleet = (await json<{ data: PatchFleet }>('/api/patch/fleet')).body.data;
        expect(fleet.rows.find((row) => row.serverId === holdId)?.jobId).toBe(jobId);
        const second = await post<{ code: string; details: { skipped: Array<{ skip: string }> } }>('/api/patch/apply', { serverIds: [holdId], mode: 'all', confirm: 1 });
        expect(second.body).toMatchObject({ code: 'PATCH_NOTHING_TO_RUN', details: { skipped: [{ skip: 'busy' }] } });
        expect((await post<{ code: string }>(`/api/servers/${holdId}/patch/refresh`, {})).body.code).toBe('PATCH_BUSY');

        await post(`/api/multiexec/jobs/${jobId}/cancel`, {});
        expect((await finished(jobId)).status).toBe('cancelled');
        await waitFor(async () => (await json<{ data: PatchFleet }>('/api/patch/fleet')).body.data.rows.find((row) => row.serverId === holdId)?.jobId === null);
    });

    it('refreshes the package lists of one server on request, recorded, and reads it again', async () => {
        host.scripts.length = 0;
        const { status, body } = await post<{ data: { exitCode: number; scan: PatchScan } }>(`/api/servers/${debianId}/patch/refresh`, {});
        expect(status).toBe(200);
        expect(body.data).toMatchObject({ exitCode: 0, scan: { manager: 'apt' } });
        const refresh = host.scripts.find((entry) => entry.script.startsWith('# ShellMind patch center: refresh the package lists'));
        expect(refresh?.script).toContain('mode=refresh\nrefresh=1');
        expect((await audit()).find((entry) => entry.server_id === debianId && entry.meta?.action === 'refresh')).toMatchObject({ command: 'patch center: refresh the package lists', exit_code: 0 });

        // Windows: the online search is its refresh.
        const windows = await post<{ data: { scan: PatchScan } }>(`/api/servers/${windowsId}/patch/refresh`, {});
        expect(windows.body.data.scan.manager).toBe('windows-update');
        expect(host.scripts.some((entry) => entry.kind === 'powershell' && entry.script.includes('$searcher.Online = $true'))).toBe(true);
    });

    it('reports a refresh that needs a privilege the user does not have', async () => {
        applyReply = { stdout: '', stderr: '[shellmind] error=privilege\n', code: 77 };
        const { status, body } = await post<{ code: string }>(`/api/servers/${debianId}/patch/refresh`, {});
        expect(status).toBe(403);
        expect(body.code).toBe('PATCH_PRIVILEGE');
    });
});
