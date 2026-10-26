import type { ServerChannel } from 'ssh2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatEvidenceResponse } from '../../shared/chat';
import type { CleanupOverview, DeletedOpenResult, DirectoryListing, DiskActionResult, DiskOverview, LargeFilesResult } from '../../shared/disk';
import type { AuditEntry } from '../../shared/types';
import { createOpsHost, sections, type OpsHost, type Reply } from '../helpers/opsHost';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W8-T4 over HTTP against in-process SSH servers that answer the disk
// toolkit's scripts: who the commands run as (root, sudo -n, neither),
// validation of what a request names, the scan cache, the audited cleanups
// and releases with the free space measured around them, Windows, and the
// AI evidence. The scripts themselves run for real in test/e2e/disk-docker.

vi.setConfig({ testTimeout: 20_000 });

type Kind = 'root' | 'sudo' | 'plain' | 'windows';

const CAPS: Record<Exclude<Kind, 'windows'>, string> = {
    root: sections({ uid: '0', sudo: '', systemd: 'yes', journal: 'yes', docker: 'ok 26.1.4', podman: '', compose: 'yes' }),
    sudo: sections({ uid: '1000', sudo: 'yes', systemd: 'yes', journal: 'yes', docker: 'sudo 26.1.4', podman: '', compose: 'yes' }),
    plain: sections({ uid: '1001', sudo: '', systemd: 'yes', journal: 'yes', docker: '', podman: '', compose: '' }),
};

const KB = 1024;
const MiB = 1024 * KB;

// The free KiB of "/", raised by what each run "frees".
let freeKb = 1_000_000;

const mounts = () => sections({
    mounts: '/dev/sda1 / ext4 rw,relatime\n/dev/sdb1 /data xfs rw',
    df: `Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 20000000 ${19_000_000 - freeKb + 1_000_000} ${freeKb} 95% /\n/dev/sdb1 1000000 500000 500000 50% /data`,
    inodes: 'Filesystem Inodes IUsed IFree IUse% Mounted on\n/dev/sda1 1000 500 500 50% /',
});

const CLEANUP_CHECK = sections({
    journal: `tool\n${300 * MiB} 1700000000 /var/log/journal/x/system@a-1.journal\n${50 * MiB} 1792800000 /var/log/journal/x/system.journal`,
    packages: 'apt\napt 24592 /var/cache/apt',
    rotated: `10485760 1700000000 /var/log/app.log.1\n@@TOTAL 1 10485760`,
    tmp: '@@TOTAL 0 0',
    core: '@@TOTAL 0 0',
    remove: 'delete',
    where: '/var/log/journal\t/\n/var/cache/apt\t/\n/var/log\t/\n/tmp\t/\n/var/tmp\t/',
});

const DANGLING = `sha256:${'2'.repeat(64)}`;

function linux(script: string): Reply | undefined {
    if (script.includes('df -P -i "$@"')) return { stdout: mounts() };
    if (script.includes('du -x -k -a -d 1')) {
        return { stdout: sections({ check: 'ok', du: `300000\t/srv\n100\t/srv/a\n200000\t/srv/data`, rc: '0', errors: 'denied 0', dirs: '/srv/a\n/srv/data', links: '', mounts: '/\n/data' }) };
    }
    if (script.includes('du -x -k -d 2')) return { stdout: '900000\t/\n300000\t/srv\n200000\t/srv/data\n' };
    if (script.includes('-size +')) return { stdout: sections({ files: '125829120 1792886545.5 root /srv/data/backup.tar', rc: '0', errors: 'denied 0' }) };
    if (script.includes('lsof -nP -w +L1')) {
        return { stdout: sections({ source: 'lsof', files: `F\t812\t5\t${20 * MiB}\t1311\t/var/log/nginx/access.log (deleted)`, procs: 'P\t812\twww-data\t0::/system.slice/nginx.service \t4242\tnginx' }) };
    }
    if (script.includes('m journal') && script.includes('m packages')) return { stdout: CLEANUP_CHECK };
    if (script.includes('exec 3< /proc/812/fd/5') && script.includes(': > /proc/$$/fd/3')) {
        freeKb += 20 * KB;
        return { stdout: '' };
    }
    if (script.includes('-print -delete')) {
        freeKb += 10 * KB;
        return { stdout: '/var/log/app.log.1\n1 files removed\n' };
    }
    if (script.includes("'image' 'ls' '-a'")) return { stdout: sections({ images: JSON.stringify({ ID: DANGLING, Repository: '<none>', Tag: '<none>', Size: '12MB' }), rc: '0', dangling: DANGLING, used: '' }) };
    if (script.includes("'system' 'df'")) return { stdout: sections({ summary: '{"Active":"0","Reclaimable":"12MB","Size":"12MB","TotalCount":"1","Type":"Images"}\n{"Active":"0","Reclaimable":"0B","Size":"0B","TotalCount":"0","Type":"Build Cache"}', rc: '0' }) };
    if (script.includes("'info' '--format'")) return { stdout: '/var/lib/docker\t/\n' };
    if (script.includes("'ps' '-a'")) return { stdout: sections({ ps: '', rc: '0' }) };
    if (script.includes("'image' 'prune' '-f'")) {
        freeKb += 12 * KB;
        return { stdout: 'Deleted Images:\ndeleted: sha256:2222\n\nTotal reclaimed space: 12MB\n' };
    }
    return undefined;
}

function windows(script: string): Reply | undefined {
    if (script.includes('WindowsIdentity') && script.includes('docker')) return { stdout: '{"admin":true,"docker":null,"compose":false}' };
    if (script.includes('GetDrives()') && script.includes('@{disks=$d}')) return { stdout: '{"disks":[{"n":"C:","fs":"NTFS","s":107374182400,"f":10737418240}]}' };
    if (script.includes('function Get-FolderSize')) {
        return { stdout: JSON.stringify({ entries: [{ n: 'Windows', b: 32212254720, k: 'd', p: false }, { n: 'pagefile.sys', b: 4294967296, k: 'f' }], total: 36507222016, restCount: 0, restBytes: 0, denied: 2, timedOut: false }) };
    }
    if (script.includes('Measure-Files $t')) {
        return { stdout: JSON.stringify({ system: 'C:', tempPaths: ['C:\\Users\\ops\\AppData\\Local\\Temp'], recyclePaths: ['C:\\$Recycle.Bin'], temp: { b: MiB, c: 2, stopped: false, top: [] }, update: { b: 0, c: 0, stopped: false, top: [] }, recycle: { b: 0, c: 0, stopped: false, top: [] } }) };
    }
    if (script.includes('"system=$env:SystemDrive"')) return { stdout: 'system=C:\r\n' };
    if (script.includes('/AnalyzeComponentStore')) {
        return { stdout: 'exit=0\r\nBackups and Disabled Features : 2.00 GB\r\nCache and Temporary Data : 512.00 MB\r\nNumber of Reclaimable Packages : 3\r\nComponent Store Cleanup Recommended : Yes\r\n' };
    }
    if (script.includes('/StartComponentCleanup')) return { stdout: 'The operation completed successfully.\r\n', delayMs: dismRunMs };
    return undefined;
}

// How long DISM's cleanup "takes" on the Windows host.
let dismRunMs = 0;

let server: TestServer;
const harnesses: SshHarness[] = [];
const hosts: Partial<Record<Kind, OpsHost>> = {};
const ids: Partial<Record<Kind, number>> = {};
// Scripts that went through `sudo -n sh -s`, per server kind.
const elevatedRuns: Record<string, number> = {};

type Json = Record<string, unknown> & { error?: string; code?: string };

async function call<T = Json>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json() as T };
}

async function startHost(kind: Kind): Promise<void> {
    const host = createOpsHost();
    host.respond((script, shell) => {
        if (kind === 'windows') return shell === 'powershell' ? windows(script) : undefined;
        if (script.includes('m uid')) return { stdout: CAPS[kind] };
        return linux(script);
    });
    const harness = await startSshServer({
        exec: (command: string, channel: ServerChannel) => {
            if (command === 'sudo -n sh -s') {
                elevatedRuns[kind] = (elevatedRuns[kind] ?? 0) + 1;
                return host.exec('sh -s', channel);
            }
            return host.exec(command, channel);
        },
    });
    harnesses.push(harness);
    hosts[kind] = host;
    const body = kind === 'windows'
        ? { name: `disk-${kind}`, ip: harness.host, port: null, ssh_port: harness.port, type: 'windows', username: 'tester', password: 'secret' }
        : { name: `disk-${kind}`, ip: harness.host, port: harness.port, type: 'linux', username: 'tester', password: 'secret' };
    ids[kind] = (await call<{ data: { id: number } }>('POST', '/api/servers', body)).body.data.id;
}

const scripts = (kind: Kind, pattern: string) => (hosts[kind]?.scripts ?? []).filter((entry) => entry.script.includes(pattern));

async function auditEntries(): Promise<AuditEntry[]> {
    return (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops')).body.data;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    server = await bootTestServer();
    for (const kind of ['root', 'sudo', 'plain', 'windows'] as const) await startHost(kind);
});

afterEach(() => {
    for (const host of Object.values(hosts)) host.scripts.length = 0;
});

afterAll(async () => {
    await server?.close();
    await Promise.all(harnesses.map((harness) => harness.close()));
    vi.restoreAllMocks();
});

describe('access', () => {
    it('needs the session token', async () => {
        const res = await fetch(`${server.baseUrl}/api/servers/${ids.sudo}/disk`);
        expect(res.status).toBe(401);
    });

    it('reports the filesystems and runs the reads through sudo -n when that is the way to root', async () => {
        const before = elevatedRuns.sudo ?? 0;
        const { status, body } = await call<DiskOverview>('GET', `/api/servers/${ids.sudo}/disk`);
        expect(status).toBe(200);
        expect(body.access).toEqual({ platform: 'linux', user: 'tester', root: false, sudo: true, elevated: true });
        expect(body.mounts.map((mount) => mount.mount)).toEqual(['/', '/data']);
        expect(elevatedRuns.sudo).toBe(before + 1);

        const plain = await call<DiskOverview>('GET', `/api/servers/${ids.plain}/disk`);
        expect(plain.body.access).toMatchObject({ root: false, sudo: false, elevated: false });
        expect(elevatedRuns.plain ?? 0).toBe(0);
    });

    it('answers 404 for a server that does not exist', async () => {
        expect((await call('GET', '/api/servers/9999/disk')).body.code).toBe('SERVER_NOT_FOUND');
    });
});

describe('validation', () => {
    it('refuses what a request may not name', async () => {
        const id = ids.root;
        expect(await call('GET', `/api/servers/${id}/disk/usage?path=etc`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('GET', `/api/servers/${id}/disk/usage?path=/var/../etc`)).toMatchObject({ status: 400 });
        expect(await call('GET', `/api/servers/${id}/disk/usage?path=/var&budget=5`)).toMatchObject({ status: 400 });
        expect(await call('GET', `/api/servers/${id}/disk/large-files?mount=/&minMB=7`)).toMatchObject({ status: 400 });
        expect(await call('GET', `/api/servers/${id}/disk/large-files?mount=/nope`)).toMatchObject({ status: 404, body: { code: 'DISK_UNKNOWN_MOUNT' } });
        expect(await call('GET', `/api/servers/${id}/disk/deleted?mount=/etc`)).toMatchObject({ status: 404, body: { code: 'DISK_UNKNOWN_MOUNT' } });
        expect(await call('GET', `/api/servers/${id}/disk/cleanups/rm-rf`)).toMatchObject({ status: 400, body: { code: 'OPS_INVALID_INPUT' } });
        expect(await call('POST', `/api/servers/${id}/disk/cleanups/rotated-logs`, { days: '7; reboot' })).toMatchObject({ status: 400 });
        expect(await call('POST', `/api/servers/${id}/disk/cleanups/package-cache`, { days: 7 })).toMatchObject({ status: 400 });
        expect(await call('POST', `/api/servers/${id}/disk/deleted/release`, { action: 'rm', mount: '/', pid: 812, process: 'nginx' })).toMatchObject({ status: 400 });
        expect(await call('POST', `/api/servers/${id}/disk/deleted/release`, { action: 'restart-service', mount: '/', pid: 812, process: 'nginx', unit: 'x; reboot' })).toMatchObject({ status: 400 });
        expect(await call('GET', `/api/servers/${id}/disk/cleanups/win-temp`)).toMatchObject({ status: 409, body: { code: 'OPS_UNSUPPORTED' } });
        // Nothing reached the server.
        expect(scripts('root', ': >')).toHaveLength(0);
    });
});

describe('scans', () => {
    it('lists a directory once, then from the cache until a rescan', async () => {
        const first = await call<DirectoryListing>('GET', `/api/servers/${ids.root}/disk/usage?path=/srv`);
        expect(first.status).toBe(200);
        expect(first.body).toMatchObject({ path: '/srv', mount: '/', totalBytes: 300000 * KB, cached: false, elevated: true });
        expect(first.body.entries.map((entry) => [entry.name, entry.kind])).toEqual([['data', 'dir'], ['a', 'dir']]);
        expect((await call<DirectoryListing>('GET', `/api/servers/${ids.root}/disk/usage?path=/srv`)).body.cached).toBe(true);
        expect((await call<DirectoryListing>('GET', `/api/servers/${ids.root}/disk/usage?path=/srv&rescan=1`)).body.cached).toBe(false);
        expect(scripts('root', 'du -x -k -a -d 1')).toHaveLength(2);
        expect(scripts('root', "p='/srv'")).toHaveLength(2);
    });

    it('finds the largest files of a filesystem', async () => {
        const { body } = await call<LargeFilesResult>('GET', `/api/servers/${ids.root}/disk/large-files?mount=/&minMB=100`);
        expect(body.files).toEqual([{ path: '/srv/data/backup.tar', bytes: 125829120, modifiedAt: 1792886545500, owner: 'root' }]);
        expect(scripts('root', '-size +102400k')).toHaveLength(1);
    });
});

describe('deleted files still open', () => {
    it('lists them with what runs their process, and empties one through /proc, audited and measured', async () => {
        const list = await call<DeletedOpenResult>('GET', `/api/servers/${ids.sudo}/disk/deleted?mount=/`);
        expect(list.body).toMatchObject({ source: 'lsof', totalBytes: 20 * MiB, partial: false });
        expect(list.body.files[0]).toMatchObject({ pid: 812, fd: 5, process: 'nginx', unit: 'nginx.service', user: 'www-data', path: '/var/log/nginx/access.log', inode: '1311', started: '4242' });

        const release = await call<DiskActionResult>('POST', `/api/servers/${ids.sudo}/disk/deleted/release`, { action: 'truncate', mount: '/', pid: 812, fd: 5, process: 'nginx', inode: '1311', started: '4242' });
        expect(release.status).toBe(200);
        expect(release.body).toMatchObject({ command: "sudo -n sh -c 'exec 3< /proc/812/fd/5 && : > /proc/$$/fd/3'", freedBytes: 20 * MiB, mounts: [{ mount: '/' }] });
        const script = scripts('sudo', 'exec 3< /proc/812/fd/5')[0].script;
        expect(script).toContain("[ \"$c\" = 'nginx' ]");
        expect(script).toContain('[ "$st" = 4242 ]');
        expect(script).toContain("*' (deleted)'");
        expect(script).toContain('[ "$(stat -L -c %i /proc/$$/fd/3 2>/dev/null)" = 1311 ]');
        const entry = (await auditEntries()).find((item) => item.command === "sudo -n sh -c 'exec 3< /proc/812/fd/5 && : > /proc/$$/fd/3'");
        expect(entry).toMatchObject({ exit_code: 0, meta: { kind: 'disk', action: 'truncate', target: 'nginx (pid 812), fd 5' } });
    });

    it('needs root to empty a file, and is a Linux matter', async () => {
        expect(await call('POST', `/api/servers/${ids.plain}/disk/deleted/release`, { action: 'truncate', mount: '/', pid: 812, fd: 5, process: 'nginx' }))
            .toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });
        expect(await call('GET', `/api/servers/${ids.windows}/disk/deleted?mount=C:\\`)).toMatchObject({ status: 409, body: { code: 'OPS_UNSUPPORTED' } });
    });
});

describe('cleanups', () => {
    it('previews them, refuses them without elevation, and runs them with the space measured', async () => {
        const plain = await call<CleanupOverview>('GET', `/api/servers/${ids.plain}/disk/cleanups`);
        expect(plain.body.cleanups.find((preview) => preview.id === 'rotated-logs')).toMatchObject({ status: 'unavailable', reason: { code: 'NOT_ELEVATED' } });
        expect(await call('POST', `/api/servers/${ids.plain}/disk/cleanups/rotated-logs`, { days: 7 })).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });

        const overview = await call<CleanupOverview>('GET', `/api/servers/${ids.sudo}/disk/cleanups`);
        const byId = Object.fromEntries(overview.body.cleanups.map((preview) => [preview.id, preview]));
        expect(byId.journal).toMatchObject({ status: 'ready', bytes: 300 * MiB, command: 'sudo -n journalctl --vacuum-size=200M' });
        expect(byId['rotated-logs']).toMatchObject({ status: 'ready', count: 1, mounts: ['/'] });
        expect(byId['docker-dangling']).toMatchObject({ status: 'ready', count: 1, command: "sudo -n docker 'image' 'prune' '-f'" });
        expect(byId['docker-build-cache']).toMatchObject({ status: 'nothing' });

        const run = await call<DiskActionResult>('POST', `/api/servers/${ids.sudo}/disk/cleanups/rotated-logs`, { days: 7 });
        expect(run.status).toBe(200);
        expect(run.body).toMatchObject({ freedBytes: 10 * MiB, output: expect.stringContaining('1 files removed'), mounts: [{ mount: '/' }] });
        // GNU find here: each file is removed relative to the folder it walks.
        expect(byId['rotated-logs'].command).toMatch(/^sudo -n find \/var\/log .* -delete$/);
        expect(scripts('sudo', '-print -delete')[0].script).toContain('-mtime +6');
        const entry = (await auditEntries()).find((item) => item.command.startsWith('sudo -n find /var/log'));
        expect(entry).toMatchObject({ exit_code: 0, meta: { kind: 'disk', action: 'cleanup-rotated-logs', target: '/' } });

        const prune = await call<DiskActionResult>('POST', `/api/servers/${ids.sudo}/disk/cleanups/docker-dangling`, {});
        expect(prune.body).toMatchObject({ reportedBytes: 12_000_000, freedBytes: 12 * MiB });
    });

    it('refuses a cleanup with nothing to remove', async () => {
        expect(await call('POST', `/api/servers/${ids.root}/disk/cleanups/tmp`, {})).toMatchObject({ status: 409, body: { code: 'DISK_NOTHING_TO_CLEAN' } });
    });
});

describe('Windows', () => {
    it('reads the drives, the folder sizes and the Windows cleanups with PowerShell', async () => {
        const overview = await call<DiskOverview>('GET', `/api/servers/${ids.windows}/disk`);
        expect(overview.body).toMatchObject({ access: { platform: 'windows', elevated: true }, mounts: [{ mount: 'C:\\', fsType: 'NTFS' }] });
        const usage = await call<DirectoryListing>('GET', `/api/servers/${ids.windows}/disk/usage?path=${encodeURIComponent('C:\\')}`);
        expect(usage.body.entries.map((entry) => entry.path)).toEqual(['C:\\Windows', 'C:\\pagefile.sys']);
        expect(usage.body.denied).toBe(2);
        const cleanups = await call<CleanupOverview>('GET', `/api/servers/${ids.windows}/disk/cleanups`);
        expect(cleanups.body.cleanups.map((preview) => [preview.id, preview.status])).toEqual([
            ['win-temp', 'ready'], ['win-update-cache', 'nothing'], ['win-recycle-bin', 'nothing'], ['win-component-store', 'analyze'],
        ]);
        expect(hosts.windows?.scripts.every((entry) => entry.kind === 'powershell')).toBe(true);
    });

    it('analyzes the component store for its preview only, once in a while, never before the run', async () => {
        const preview = await call<CleanupOverview['cleanups'][number]>('GET', `/api/servers/${ids.windows}/disk/cleanups/win-component-store`);
        expect(preview.body).toMatchObject({ status: 'ready', bytes: 2.5 * 1024 * MiB, facts: { recommended: 'yes', packages: 3 }, mounts: ['C:\\'] });
        // Reopened: the analysis of a moment ago, also in the list.
        expect((await call<CleanupOverview['cleanups'][number]>('GET', `/api/servers/${ids.windows}/disk/cleanups/win-component-store`)).body.bytes).toBe(2.5 * 1024 * MiB);
        const list = await call<CleanupOverview>('GET', `/api/servers/${ids.windows}/disk/cleanups`);
        expect(list.body.cleanups.find((entry) => entry.id === 'win-component-store')).toMatchObject({ status: 'ready', facts: { recommended: 'yes' } });
        expect(scripts('windows', '/AnalyzeComponentStore')).toHaveLength(1);

        const run = await call<DiskActionResult>('POST', `/api/servers/${ids.windows}/disk/cleanups/win-component-store`, {});
        expect(run.status).toBe(200);
        expect(run.body).toMatchObject({ command: 'Dism.exe /Online /Cleanup-Image /StartComponentCleanup', mounts: [{ mount: 'C:\\' }] });
        expect(scripts('windows', '/AnalyzeComponentStore')).toHaveLength(1);
        expect(scripts('windows', '/StartComponentCleanup')).toHaveLength(1);
        // The store changed: the next preview analyzes it again.
        await call('GET', `/api/servers/${ids.windows}/disk/cleanups/win-component-store`);
        expect(scripts('windows', '/AnalyzeComponentStore')).toHaveLength(2);
    });

    it('finishes a cleanup whose window closed while it ran, and audits it', async () => {
        dismRunMs = 1500;
        const dism = async () => (await auditEntries()).filter((entry) => entry.command === 'Dism.exe /Online /Cleanup-Image /StartComponentCleanup');
        const before = (await dism()).length;
        try {
            const controller = new AbortController();
            const request = server.fetch(`/api/servers/${ids.windows}/disk/cleanups/win-component-store`, {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: controller.signal,
            }).catch((error: unknown) => error);
            await vi.waitFor(() => expect(scripts('windows', '/StartComponentCleanup')).toHaveLength(1));
            controller.abort();
            expect(await request).toMatchObject({ name: 'AbortError' });
            // The run went on to its end (an aborted one is audited without an exit code).
            await vi.waitFor(async () => {
                const entries = await dism();
                expect(entries).toHaveLength(before + 1);
                expect(entries[0]).toMatchObject({ exit_code: 0 });
            }, { timeout: 5000, interval: 100 });
        } finally {
            dismRunMs = 0;
        }
    });
});

describe('the AI evidence', () => {
    it('gathers why a filesystem is full', async () => {
        const { status, body } = await call<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId: ids.root, attachment: { kind: 'disk', mount: '/' } });
        expect(status).toBe(200);
        expect(body.evidence.attachment).toEqual({ kind: 'disk', mount: '/' });
        expect(body.evidence.sections.map((section) => section.id)).toEqual(['disk', 'disk-dirs', 'disk-files', 'disk-deleted', 'disk-consumers']);
        expect(body.evidence.sections.find((section) => section.id === 'disk-deleted')?.text).toContain('/var/log/nginx/access.log (deleted), held by nginx pid 812 fd 5');
        expect(body.evidence.sections.find((section) => section.id === 'disk-dirs')?.text).toContain('/srv/data');
        expect(await call('POST', '/api/chat/evidence', { serverId: ids.root, attachment: { kind: 'disk', mount: 'relative' } })).toMatchObject({ status: 400 });
    });

    it('names where the Windows drives were read', async () => {
        const { status, body } = await call<ChatEvidenceResponse>('POST', '/api/chat/evidence', { serverId: ids.windows, attachment: { kind: 'disk', mount: 'C:\\' } });
        expect(status).toBe(200);
        expect(body.evidence.sections[0]).toMatchObject({ id: 'disk', source: '[IO.DriveInfo]::GetDrives()' });
        expect(body.evidence.sections[0].text).toContain('C:\\ (C:, NTFS): 90% used');
    });
});
