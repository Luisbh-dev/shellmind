import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatEvidenceResponse } from '../../shared/chat';
import type { CleanupOverview, CleanupPreview, DeletedOpenResult, DirectoryListing, DiskActionResult, DiskOverview, LargeFilesResult } from '../../shared/disk';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W8-T4 end to end: the disk toolkit against real OpenSSH servers in Docker
// (opt-in: SHELLMIND_E2E=1) whose disks test/fixtures/disk/e2e/seed.sh fills
// the way an incident looks: big files, a log deleted while a process holds
// it, old rotated logs, core dumps, a package cache, archived journals.
// Debian (GNU tools, lsof, sudo, journald), Alpine (busybox, no lsof: /proc)
// and Fedora (dnf). Every command runs for real; the space freed is
// measured on the server.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const FIXTURES = fileURLToPath(new URL('../fixtures/disk/e2e', import.meta.url));
const SEED = fs.readFileSync(`${FIXTURES}/seed.sh`, 'utf8');
const MiB = 1024 * 1024;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 600_000 });

type Host = { image: string; container: string; port: number };

let server: TestServer;
const hosts: Record<'debian' | 'alpine' | 'fedora', Host> = {
    debian: { image: 'shellmind-test-disk-debian', container: `shellmind-test-disk-debian-${process.pid}`, port: 0 },
    alpine: { image: 'shellmind-test-disk-alpine', container: `shellmind-test-disk-alpine-${process.pid}`, port: 0 },
    fedora: { image: 'shellmind-test-disk-fedora', container: `shellmind-test-disk-fedora-${process.pid}`, port: 0 },
};
const ids: Record<string, number> = {};

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A script run as root inside the container (setup and inspection).
function inside(host: Host, script: string): string {
    return execFileSync('docker', ['exec', '-i', host.container, 'sh', '-s'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// The space an action freed is the change in free space (df) of / around it.
// Every container writes to the one Docker disk while the other suites run
// (package installs), which moved it by 5 MiB and more: how much says little
// here. The result must be that measured change; what the action did is
// checked on the server.
function expectMeasured(result: DiskActionResult): void {
    expect(result.mounts).toEqual([{ mount: '/', freeBefore: expect.any(Number), freeAfter: expect.any(Number) }]);
    expect(result.freedBytes).toBe(result.mounts[0].freeAfter - result.mounts[0].freeBefore);
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

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as T };
}

async function saveServer(name: string, port: number, username: string, password: string): Promise<number> {
    const { body } = await call<{ data: { id: number } }>('POST', '/api/servers', { name, ip: '127.0.0.1', port, type: 'linux', username, password });
    return body.data.id;
}

async function start(host: Host) {
    docker('run', '-d', '--name', host.container, '-p', '127.0.0.1::22', host.image);
    host.port = Number(docker('port', host.container, '22').split('\n')[0].split(':').pop());
    await waitFor(() => sshBanner(host.port));
    inside(host, SEED);
}

const preview = (overview: CleanupOverview, id: string) => overview.cleanups.find((entry) => entry.id === id) as CleanupPreview;

describe.skipIf(!ENABLED)('the disk toolkit against real servers (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        for (const [name, host] of Object.entries(hosts)) {
            docker('build', '-q', '-t', host.image, `${FIXTURES}/${name}`);
        }
        await Promise.all(Object.values(hosts).map(start));
        server = await bootTestServer();
        ids.debianSudo = await saveServer('debian-sudo', hosts.debian.port, 'ops', 'opspw');
        ids.debianRoot = await saveServer('debian-root', hosts.debian.port, 'root', 'rootpw');
        ids.debianPlain = await saveServer('debian-plain', hosts.debian.port, 'plain', 'plainpw');
        ids.alpine = await saveServer('alpine', hosts.alpine.port, 'ops', 'opspw');
        ids.fedora = await saveServer('fedora', hosts.fedora.port, 'root', 'rootpw');
    });

    afterAll(async () => {
        await server?.close();
        for (const host of Object.values(hosts)) spawnSync('docker', ['rm', '-f', host.container]);
        vi.restoreAllMocks();
    });

    it('reports the filesystems and who the commands run as', async () => {
        const sudo = await call<DiskOverview>('GET', `/api/servers/${ids.debianSudo}/disk`);
        expect(sudo.status).toBe(200);
        expect(sudo.body.access).toMatchObject({ platform: 'linux', user: 'ops', root: false, sudo: true, elevated: true });
        const root = sudo.body.mounts.find((mount) => mount.mount === '/');
        expect(root).toBeDefined();
        expect(root!.totalBytes).toBeGreaterThan(root!.freeBytes);
        expect(root!.inodes?.total).toBeGreaterThan(0);
        const plain = await call<DiskOverview>('GET', `/api/servers/${ids.debianPlain}/disk`);
        expect(plain.body.access).toMatchObject({ root: false, sudo: false, elevated: false });
    });

    it('explores the directories, largest first, and drills down', async () => {
        const top = await call<DirectoryListing>('GET', `/api/servers/${ids.debianSudo}/disk/usage?path=/&budget=60`);
        expect(top.status).toBe(200);
        expect(top.body).toMatchObject({ path: '/', mount: '/', timedOut: false, denied: 0, elevated: true, cached: false });
        const srv = top.body.entries.find((entry) => entry.name === 'srv');
        expect(srv).toMatchObject({ kind: 'dir', path: '/srv' });
        expect(srv!.bytes).toBeGreaterThanOrEqual(190 * MiB);
        expect(top.body.entries.find((entry) => entry.name === 'proc')).toBeUndefined();
        // Cached the second time; a rescan asks the server again.
        expect((await call<DirectoryListing>('GET', `/api/servers/${ids.debianSudo}/disk/usage?path=/`)).body.cached).toBe(true);
        const data = await call<DirectoryListing>('GET', `/api/servers/${ids.debianSudo}/disk/usage?path=/srv/data&rescan=1`);
        expect(data.body.entries.map((entry) => entry.name)).toEqual(['archive', 'uploads', 'notes.txt']);
        expect(data.body.entries[0].bytes).toBeGreaterThanOrEqual(120 * MiB);
        expect(data.body.entries[2]).toMatchObject({ kind: 'file' });
    });

    it('leaves out names with a newline, and stays off other filesystems (GNU and busybox)', async () => {
        for (const id of [ids.debianSudo, ids.alpine]) {
            const weird = await call<DirectoryListing>('GET', `/api/servers/${id}/disk/usage?path=/srv/weird`);
            expect(weird.status).toBe(200);
            expect(weird.body.entries.map((entry) => entry.name)).toEqual(['plain.bin']);
            expect(weird.body.totalBytes).toBeGreaterThanOrEqual(63 * MiB);
            const proc = await call<{ code: string; error: string }>('GET', `/api/servers/${id}/disk/usage?path=/proc`);
            expect(proc).toMatchObject({ status: 404, body: { code: 'DISK_UNKNOWN_MOUNT' } });
            expect(proc.body.error).toMatch(/^\/proc is not on \//);
        }
    });

    it('counts what the login user may not read, without elevation', async () => {
        const top = await call<DirectoryListing>('GET', `/api/servers/${ids.debianPlain}/disk/usage?path=/`);
        expect(top.status).toBe(200);
        expect(top.body.elevated).toBe(false);
        expect(top.body.denied).toBeGreaterThan(0);
        const root = await call<{ code: string }>('GET', `/api/servers/${ids.debianPlain}/disk/usage?path=/root`);
        expect(root).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });
    });

    it('finds the largest files of a filesystem', async () => {
        const { status, body } = await call<LargeFilesResult>('GET', `/api/servers/${ids.debianSudo}/disk/large-files?mount=/&minMB=50`);
        expect(status).toBe(200);
        expect(body.files.map((file) => file.path).slice(0, 2)).toEqual(['/srv/data/archive/backup-2026-09.tar', '/srv/data/uploads/video.mp4']);
        expect(body.files[0]).toMatchObject({ bytes: 125829120, owner: 'root' });
        expect(body.files[0].modifiedAt).toBeGreaterThan(Date.now() - 3600_000);
        const busybox = await call<LargeFilesResult>('GET', `/api/servers/${ids.alpine}/disk/large-files?mount=/&minMB=50`);
        expect(busybox.body.files.map((file) => file.path)).toEqual(['/srv/data/archive/backup-2026-09.tar', '/srv/data/uploads/video.mp4']);
    });

    it('finds the deleted log still held open, with lsof and in /proc, and truncates it', async () => {
        for (const id of [ids.debianSudo, ids.alpine]) {
            const { status, body } = await call<DeletedOpenResult>('GET', `/api/servers/${id}/disk/deleted?mount=/`);
            expect(status).toBe(200);
            expect(body.source).toBe(id === ids.alpine ? 'proc' : 'lsof');
            const held = body.files.find((file) => file.path === '/var/log/app/held.log');
            expect(held).toMatchObject({ process: 'sleep', bytes: 52428800, user: 'root', unit: null });

            expect(held!.inode).toMatch(/^\d+$/);
            expect(held!.started).toMatch(/^\d+$/);

            // A reused pid is refused: the name must still match, and so must
            // the start time; the descriptor must still hold the file listed.
            const wrong = await call<{ code: string; error: string }>('POST', `/api/servers/${id}/disk/deleted/release`, { action: 'truncate', mount: '/', pid: held!.pid, fd: held!.fd, process: 'nginx' });
            expect(wrong.status).toBe(502);
            expect(wrong.body.error).toMatch(/not the one listed/);
            const restarted = await call<{ error: string }>('POST', `/api/servers/${id}/disk/deleted/release`, { action: 'truncate', mount: '/', pid: held!.pid, fd: held!.fd, process: held!.process, started: String(Number(held!.started) + 1), inode: held!.inode });
            expect(restarted.body.error).toMatch(/started after the scan/);
            const other = await call<{ error: string }>('POST', `/api/servers/${id}/disk/deleted/release`, { action: 'truncate', mount: '/', pid: held!.pid, fd: held!.fd, process: held!.process, started: held!.started, inode: String(Number(held!.inode) + 1) });
            expect(other.body.error).toMatch(/another file than the one listed/);
            expect(Number(inside(id === ids.alpine ? hosts.alpine : hosts.debian, `stat -L -c %s /proc/${held!.pid}/fd/${held!.fd}`))).toBe(52428800);

            const release = await call<DiskActionResult>('POST', `/api/servers/${id}/disk/deleted/release`, { action: 'truncate', mount: '/', pid: held!.pid, fd: held!.fd, process: held!.process, started: held!.started!, inode: held!.inode! });
            expect(release.status).toBe(200);
            expectMeasured(release.body);
            expect(Number(inside(id === ids.alpine ? hosts.alpine : hosts.debian, `stat -L -c %s /proc/${held!.pid}/fd/${held!.fd}`))).toBe(0);
            // Emptied, it holds nothing: no longer listed.
            const after = await call<DeletedOpenResult>('GET', `/api/servers/${id}/disk/deleted?mount=/`);
            expect(after.body.files.find((file) => file.path === '/var/log/app/held.log')).toBeUndefined();
        }
        const audit = await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops');
        expect(audit.body.data.map((entry) => entry.command)).toEqual(expect.arrayContaining([expect.stringMatching(/^sudo -n sh -c 'exec 3< \/proc\/\d+\/fd\/\d+ && : > \/proc\/\$\$\/fd\/3'$/)]));
    });

    it('previews the cleanups, refuses them without elevation, and runs them as root', async () => {
        const plain = await call<CleanupOverview>('GET', `/api/servers/${ids.debianPlain}/disk/cleanups`);
        expect(preview(plain.body, 'rotated-logs')).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_ELEVATED' } });
        const refused = await call<{ code: string }>('POST', `/api/servers/${ids.debianPlain}/disk/cleanups/rotated-logs`, { days: 7 });
        expect(refused).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });

        const overview = await call<CleanupOverview>('GET', `/api/servers/${ids.debianSudo}/disk/cleanups`);
        expect(overview.status).toBe(200);
        // Sizes are the space allocated, which can differ a little right after writing.
        const near = (mib: number) => expect.toSatisfy((bytes: number) => Math.abs(bytes - mib * MiB) <= MiB);
        expect(preview(overview.body, 'rotated-logs')).toMatchObject({ status: 'ready', count: 3, bytes: near(16), mounts: ['/'] });
        expect(preview(overview.body, 'core-dumps')).toMatchObject({ status: 'ready', count: 1, bytes: near(30) });
        expect(preview(overview.body, 'package-cache')).toMatchObject({ status: 'ready', facts: { manager: 'apt' }, command: 'sudo -n apt-get clean' });
        expect(preview(overview.body, 'tmp')).toMatchObject({ status: 'nothing' });
        expect(preview(overview.body, 'journal').facts?.archived).toBeGreaterThan(0);
        // GNU find removes each file relative to the folder it walks.
        expect(preview(overview.body, 'rotated-logs')).toMatchObject({ facts: { removal: 'delete' }, command: expect.stringMatching(/ -delete$/) });

        const logs = await call<DiskActionResult>('POST', `/api/servers/${ids.debianSudo}/disk/cleanups/rotated-logs`, { days: 7 });
        expect(logs.status).toBe(200);
        expect(logs.body.output).toContain('3 files removed');
        expectMeasured(logs.body);
        expect(inside(hosts.debian, 'ls /var/log/app')).toBe('app.log\nrecent.log.1');

        const cores = await call<DiskActionResult>('POST', `/api/servers/${ids.debianRoot}/disk/cleanups/core-dumps`, {});
        expect(cores.status).toBe(200);
        expectMeasured(cores.body);
        expect(inside(hosts.debian, 'ls -A /var/lib/systemd/coredump')).toBe('');
        const apt = await call<DiskActionResult>('POST', `/api/servers/${ids.debianSudo}/disk/cleanups/package-cache`, {});
        expect(apt.status).toBe(200);
        expect(inside(hosts.debian, 'ls /var/cache/apt/archives | grep -c deb || true')).toBe('0');

        // The journal down to 50 MB: the oldest archived files go.
        const before = Number(inside(hosts.debian, 'du -sk /var/log/journal | cut -f 1'));
        const journal = await call<DiskActionResult>('POST', `/api/servers/${ids.debianSudo}/disk/cleanups/journal`, { keepMB: 50 });
        expect(journal.status).toBe(200);
        expect(journal.body.command).toBe('sudo -n journalctl --vacuum-size=50M');
        expect(Number(inside(hosts.debian, 'du -sk /var/log/journal | cut -f 1'))).toBeLessThan(before);
        expect(journal.body.reportedBytes).toBeGreaterThan(0);

        // Nothing left to clean is refused.
        const again = await call<{ code: string }>('POST', `/api/servers/${ids.debianSudo}/disk/cleanups/rotated-logs`, { days: 7 });
        expect(again).toMatchObject({ status: 409, body: { code: 'DISK_NOTHING_TO_CLEAN' } });

        const audit = await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops');
        const commands = audit.body.data.map((entry) => entry.command);
        expect(commands).toEqual(expect.arrayContaining(['sudo -n apt-get clean', 'sudo -n journalctl --vacuum-size=50M', expect.stringMatching(/^sudo -n find \/var\/log -xdev/)]));
        expect(audit.body.data.find((entry) => entry.command === 'sudo -n apt-get clean')?.meta).toMatchObject({ kind: 'disk', action: 'cleanup-package-cache' });
    });

    it('cleans the apk and dnf caches', async () => {
        const alpine = await call<CleanupOverview>('GET', `/api/servers/${ids.alpine}/disk/cleanups`);
        expect(preview(alpine.body, 'package-cache')).toMatchObject({ facts: { manager: 'apk' }, command: 'sudo -n apk cache clean' });
        expect(preview(alpine.body, 'journal')).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_FOUND' } });
        const apk = await call<DiskActionResult>('POST', `/api/servers/${ids.alpine}/disk/cleanups/package-cache`, {});
        expect(apk.status).toBe(200);
        expect(inside(hosts.alpine, 'ls /var/cache/apk | grep -c oldpkg || true')).toBe('0');

        const fedora = await call<CleanupOverview>('GET', `/api/servers/${ids.fedora}/disk/cleanups`);
        const dnf = preview(fedora.body, 'package-cache');
        expect(dnf).toMatchObject({ facts: { manager: 'dnf' }, command: 'dnf clean all' });
        if (dnf.status === 'ready') {
            const run = await call<DiskActionResult>('POST', `/api/servers/${ids.fedora}/disk/cleanups/package-cache`, {});
            expect(run.status).toBe(200);
            expect(run.body.output).toMatch(/removed|Removed|files/i);
        }
    });

    it('collects the evidence of "why is this disk full?" for the AI', async () => {
        const { status, body } = await call<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId: ids.debianSudo, attachment: { kind: 'disk', mount: '/' } });
        expect(status).toBe(200);
        const parts = Object.fromEntries(body.evidence.sections.map((section) => [section.id, section]));
        expect(Object.keys(parts)).toEqual(['disk', 'disk-dirs', 'disk-files', 'disk-deleted', 'disk-consumers']);
        expect(parts.disk.text).toContain('<- the filesystem asked about');
        expect(parts['disk-dirs'].text).toMatch(/\/srv\/data/);
        expect(parts['disk-files'].text).toContain('/srv/data/archive/backup-2026-09.tar');
        expect(parts['disk-consumers'].text).toMatch(/^journal \(on \/\): /m);
        const unknown = await call<{ code: string }>('POST', '/api/chat/evidence', { serverId: ids.debianSudo, attachment: { kind: 'disk', mount: '/nope' } });
        expect(unknown.status).toBe(404);
    });
});
