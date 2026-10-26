import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MultiExecJob } from '../../shared/multiexec';
import type { PatchApplyResponse, PatchPreview, PatchScan, PatchScanEvent } from '../../shared/patch';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The patch center end to end against real distributions in Docker (opt-in:
// SHELLMIND_E2E=1): Debian 12.1, Ubuntu 24.04 as released, Rocky Linux 9.0 and
// Alpine 3.20.0, each with openssh and sudo and its package lists cached in
// the image, so real updates (and real security updates) are pending. Scans
// run the real scripts; runs are real multi-exec jobs that install packages
// with apt-get, dnf and apk, and the Alpine host "reboots" (its PID 1 ends and
// Docker starts it again) while the run waits for SSH to come back.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const CONTEXT = fileURLToPath(new URL('../fixtures/patch/e2e', import.meta.url));
const DISTROS = ['debian', 'ubuntu', 'rocky', 'alpine'] as const;
type Distro = typeof DISTROS[number];

vi.setConfig({ testTimeout: 600_000, hookTimeout: 900_000 });

let server: TestServer;
const ports = {} as Record<Distro, number>;
const ids = {} as Record<Distro, number>;
let askerId = 0;

const container = (distro: Distro) => `shellmind-test-patch-${distro}-${process.pid}`;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }).trim();
}

async function waitFor<T>(read: () => Promise<T | null | undefined | false>, timeoutMs = 30_000, everyMs = 250): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await read();
        if (value) return value;
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, everyMs));
    }
}

// A free local port: the hosts keep theirs across a restart (Docker picks a
// new random one for an unspecified host port each time a container starts).
function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.listen(0, '127.0.0.1', () => {
            const { port } = probe.address() as net.AddressInfo;
            probe.close(() => resolve(port));
        });
    });
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

async function json<T>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
    return { status: res.status, body: await res.json() as T };
}

async function saveServer(name: string, port: number, username: string, password: string): Promise<number> {
    const { body } = await json<{ data: { id: number } }>('/api/servers', {
        method: 'POST',
        body: JSON.stringify({ name, ip: '127.0.0.1', port, type: 'linux', username, password })
    });
    return body.data.id;
}

async function scan(serverIds: number[]): Promise<Map<number, PatchScan | { error: string }>> {
    const res = await server.fetch('/api/patch/scan', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverIds }) });
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);
    const events = (await res.text()).split('\n\n').filter((chunk) => chunk.startsWith('data: ')).map((chunk) => JSON.parse(chunk.slice(6)) as PatchScanEvent);
    expect(events.at(-1)).toEqual({ type: 'end' });
    const results = new Map<number, PatchScan | { error: string }>();
    for (const event of events) {
        if (event.type === 'scan') results.set(event.serverId, event.scan);
        if (event.type === 'error') results.set(event.serverId, { error: `${event.error.code}: ${event.error.message}` });
    }
    return results;
}

const scanOf = (results: Map<number, PatchScan | { error: string }>, id: number): PatchScan => {
    const result = results.get(id);
    if (!result || 'error' in result) throw new Error(`no scan of #${id}: ${JSON.stringify(result)}`);
    return result;
};

async function finished(jobId: string, timeoutMs = 540_000): Promise<MultiExecJob> {
    return waitFor(async () => {
        const { body } = await json<{ data: MultiExecJob }>(`/api/multiexec/jobs/${jobId}`);
        return ['done', 'stopped', 'cancelled', 'interrupted'].includes(body.data.status) ? body.data : null;
    }, timeoutMs, 1000);
}

describe.skipIf(!ENABLED)('patch center against real distributions (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        for (const distro of DISTROS) {
            docker('build', '-q', '-t', `shellmind-test-patch-${distro}`, '-f', `${CONTEXT}/${distro}/Dockerfile`, CONTEXT);
            ports[distro] = await freePort();
            docker('run', '-d', '--name', container(distro), '--restart=always', '--tmpfs', '/run', '-p', `127.0.0.1:${ports[distro]}:22`, `shellmind-test-patch-${distro}`);
        }
        for (const distro of DISTROS) await waitFor(() => sshBanner(ports[distro]), 60_000);
        server = await bootTestServer();
        for (const distro of DISTROS) ids[distro] = await saveServer(`e2e-patch-${distro}`, ports[distro], 'ops', 'opspw');
        askerId = await saveServer('e2e-patch-asker', ports.debian, 'asker', 'askerpw');
    });

    afterAll(async () => {
        await server?.close();
        for (const distro of DISTROS) spawnSync('docker', ['rm', '-f', container(distro)]);
        vi.restoreAllMocks();
    });

    it('reads pending and security updates on every distribution without changing anything', async () => {
        const results = await scan([...DISTROS.map((distro) => ids[distro]), askerId]);
        const debian = scanOf(results, ids.debian);
        expect(debian).toMatchObject({ platform: 'linux', manager: 'apt', privilege: 'sudo', notices: [] });
        expect(debian.total).toBeGreaterThan(10);
        expect(debian.security).toBeGreaterThan(0);
        expect(debian.updates.find((update) => update.security)).toMatchObject({ current: expect.any(String), available: expect.any(String), repository: expect.stringMatching(/security/) });
        // A security fix a point release ships again (the candidate) is still a security update:
        // Debian 12.1's glibc has 2.36-9+deb12u7 in bookworm-security and a newer point release.
        expect(debian.updates.find((update) => update.name === 'libc6')).toMatchObject({ current: '2.36-9+deb12u1', security: true, repository: expect.stringMatching(/oldstable.*bookworm-security/) });
        expect(debian.updates.filter((update) => update.security && !update.repository?.includes('oldstable-security')).length).toBeGreaterThan(5);
        expect(debian.metadataAt).toBeGreaterThan(0);

        const ubuntu = scanOf(results, ids.ubuntu);
        expect(ubuntu).toMatchObject({ manager: 'apt', privilege: 'sudo' });
        expect(ubuntu.security).toBeGreaterThan(5);
        expect(ubuntu.updates.some((update) => update.repository?.includes('noble-security'))).toBe(true);

        const rocky = scanOf(results, ids.rocky);
        expect(rocky).toMatchObject({ manager: 'dnf', privilege: 'sudo' });
        expect(rocky.total).toBeGreaterThan(20);
        expect(rocky.security).toBeGreaterThan(0);
        const fix = rocky.updates.find((update) => update.security)!;
        expect(fix).toMatchObject({ arch: expect.any(String), current: expect.stringMatching(/el9/), severity: expect.stringMatching(/Critical|Important|Moderate|Low/) });
        expect(rocky.lastUpdateAt).toBeGreaterThan(0);

        const alpine = scanOf(results, ids.alpine);
        expect(alpine).toMatchObject({ manager: 'apk', privilege: 'sudo', security: null });
        expect(alpine.total).toBeGreaterThan(0);

        // sudo that asks for a password is reported, not tried.
        expect(scanOf(results, askerId)).toMatchObject({ manager: 'apt', privilege: 'sudo-password' });

        // Read-only: a second scan finds the same.
        const again = await scan([ids.debian, ids.rocky]);
        expect(scanOf(again, ids.debian).total).toBe(debian.total);
        expect(scanOf(again, ids.rocky).total).toBe(rocky.total);
    });

    it('previews a run and refuses a confirmation that no longer matches it', async () => {
        const serverIds = [ids.debian, ids.alpine, askerId];
        const { body } = await json<{ data: PatchPreview }>('/api/patch/preview', { method: 'POST', body: JSON.stringify({ serverIds, mode: 'security', refresh: false, reboot: false }) });
        const preview = body.data;
        expect(preview.eligible).toBe(1);
        expect(Object.fromEntries(preview.servers.map((entry) => [entry.serverId, entry.skip]))).toEqual({ [ids.debian]: null, [ids.alpine]: 'no-security', [askerId]: 'sudo-password' });
        expect(preview.commands.map((plan) => plan.manager)).toEqual(['apt']);
        expect(preview.script).toMatch(/^# ShellMind patch center: install security updates/);

        const refused = await json<{ code: string; details: { expected: number } }>('/api/patch/apply', { method: 'POST', body: JSON.stringify({ serverIds, mode: 'security', confirm: 3 }) });
        expect(refused).toMatchObject({ status: 409, body: { code: 'PATCH_CONFIRM_MISMATCH', details: { expected: 1 } } });
    });

    it('installs security updates with a canary that waits for approval', async () => {
        const serverIds = [ids.debian, ids.ubuntu];
        // What apt marks as installed automatically (as a dependency) before the run.
        const autoBefore = docker('exec', container('debian'), 'apt-mark', 'showauto');
        const { status, body } = await json<{ data: PatchApplyResponse }>('/api/patch/apply', {
            method: 'POST',
            body: JSON.stringify({ serverIds, mode: 'security', refresh: false, reboot: false, confirm: 2, strategy: { concurrency: 2, canary: { count: 1, onSuccess: 'pause' } } })
        });
        expect(status).toBe(201);
        const jobId = body.data.job.id;
        expect(body.data.job.command).toMatch(/^# ShellMind patch center:/);

        const paused = await waitFor(async () => {
            const job = (await json<{ data: MultiExecJob }>(`/api/multiexec/jobs/${jobId}`)).body.data;
            return job.status === 'paused' ? job : null;
        }, 300_000, 1000);
        expect(paused.pause?.reason).toBe('canary');
        expect(paused.servers[0]).toMatchObject({ serverId: ids.debian, status: 'ok', exitCode: 0 });
        expect(paused.servers[0].stdout).toMatch(/install --only-upgrade/);
        expect(paused.servers[1].status).toBe('queued');

        // A second run cannot start on servers this one holds.
        const busy = await json<{ code: string; details: { skipped: Array<{ skip: string }> } }>('/api/patch/apply', { method: 'POST', body: JSON.stringify({ serverIds: [ids.debian], mode: 'all', confirm: 1 }) });
        expect(busy).toMatchObject({ status: 409, body: { code: 'PATCH_NOTHING_TO_RUN', details: { skipped: [{ skip: 'busy' }] } } });

        await json(`/api/multiexec/jobs/${jobId}/resume`, { method: 'POST' });
        const job = await finished(jobId);
        expect(job.status).toBe('done');
        expect(job.servers.map((entry) => [entry.serverId, entry.status])).toEqual([[ids.debian, 'ok'], [ids.ubuntu, 'ok']]);

        // Naming the packages to `install` did not turn them into packages installed by hand.
        expect(docker('exec', container('debian'), 'apt-mark', 'showauto')).toBe(autoBefore);
        expect(job.servers[0].stdout).toMatch(/\+ sudo -n apt-mark auto .*libc6/);
        const results = await scan(serverIds);
        expect(scanOf(results, ids.debian).security).toBe(0);
        expect(scanOf(results, ids.ubuntu).security).toBe(0);
        expect(scanOf(results, ids.debian).lastUpdateAt).toBeGreaterThan(Date.now() - 15 * 60_000);

        // The job's own entry, not the `hostname` its output grouping asked
        // (recorded after it, with the job's details and `probe`).
        const audit = (await json<{ data: AuditEntry[] }>(`/api/audit?serverId=${ids.debian}&source=ops`)).body.data;
        expect(audit.find((entry) => entry.meta?.patch === true && entry.meta?.jobId === jobId && !entry.meta?.probe)).toMatchObject({
            command: 'patch center: install security updates',
            exit_code: 0,
            meta: { mode: 'security', reboot: false }
        });
    });

    it('installs security updates on Rocky Linux with dnf, from the metadata it has', async () => {
        const before = scanOf(await scan([ids.rocky]), ids.rocky);
        const { body } = await json<{ data: PatchApplyResponse }>('/api/patch/apply', {
            method: 'POST',
            body: JSON.stringify({ serverIds: [ids.rocky], mode: 'security', confirm: 1 })
        });
        const job = await finished(body.data.job.id);
        expect(job.servers[0]).toMatchObject({ status: 'ok', exitCode: 0 });
        expect(job.servers[0].stdout).toMatch(/dnf -y --setopt=\*\.metadata_expire=never upgrade --security/);
        // No refresh was asked for: no repository metadata was downloaded (only packages, "(n/N): ...").
        expect(job.servers[0].stdout).not.toMatch(/^Rocky Linux .* [kM]B\/s \|/m);
        const after = scanOf(await scan([ids.rocky]), ids.rocky);
        expect(after.security).toBe(0);
        expect(after.metadataAt).toBe(before.metadataAt);
    });

    it('installs every update on Alpine, reboots it because it asks for it and waits for SSH', async () => {
        docker('exec', container('alpine'), 'touch', '/run/reboot-required');
        const before = await scan([ids.alpine]);
        expect(scanOf(before, ids.alpine).rebootRequired).toBe(true);
        const listsAt = scanOf(before, ids.alpine).metadataAt;
        const startedAt = docker('inspect', '-f', '{{.State.StartedAt}}', container('alpine'));

        const { body } = await json<{ data: PatchApplyResponse }>('/api/patch/apply', {
            method: 'POST',
            body: JSON.stringify({ serverIds: [ids.alpine], mode: 'all', reboot: true, rebootWaitSec: 120, confirm: 1 })
        });
        expect(body.data.job.danger).toBe('power');
        const job = await finished(body.data.job.id);
        const run = job.servers[0];
        expect(run.stdout).toMatch(/apk --cache-max-age \d+ upgrade/);
        // The indexes were not fetched again behind the user's back.
        expect(run.stdout).not.toMatch(/fetch .*APKINDEX/);
        expect(run.stdout).toMatch(/\[shellmind\] reboot=start\n/);
        expect(run.stdout).toMatch(/\[shellmind\] reboot=back after=\d+ up=\d+/);
        expect(run).toMatchObject({ status: 'ok', exitCode: 0 });
        expect(docker('inspect', '-f', '{{.State.StartedAt}}', container('alpine'))).not.toBe(startedAt);

        const after = scanOf(await scan([ids.alpine]), ids.alpine);
        expect(after.total).toBe(0);
        expect(after.rebootRequired).not.toBe(true);
        expect(after.metadataAt).toBe(listsAt);

        const audit = (await json<{ data: AuditEntry[] }>(`/api/audit?serverId=${ids.alpine}&source=ops`)).body.data;
        expect(audit.find((entry) => entry.command === 'reboot (patch center)')).toMatchObject({ exit_code: 0, meta: { patch: true, action: 'reboot', jobId: body.data.job.id } });
    });
});
