import fs from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Client } from 'ssh2';
import { io as connect, type Socket } from 'socket.io-client';
import type { ChatEvidence } from '../../shared/chat';
import type { DiskOverview, DirectoryListing, CleanupOverview } from '../../shared/disk';
import type { FleetBoard } from '../../shared/fleet';
import type { MultiExecJob } from '../../shared/multiexec';
import type { LogChunkPayload, LogEndPayload, OpsCapabilities, ServiceDetail, ServicesList } from '../../shared/ops';
import type { PatchScan } from '../../shared/patch';
import type { StatusSnapshot } from '../../shared/status';
import { encodePowerShellBlock } from '../../shared/powershell';
import { ok, openFileSession } from '../helpers/fileClient';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Every Windows feature end to end against a real Windows OpenSSH server
// (opt-in; `npm run test:e2e -- test/e2e/windows-ssh.test.ts`):
//   SHELLMIND_E2E_WINDOWS=user@host:port
//   SHELLMIND_E2E_WINDOWS_PASSWORD=<password>  or  SHELLMIND_E2E_WINDOWS_KEY=<private key file>
//   SHELLMIND_E2E_WINDOWS_SERVICE=<service>    (optional: a stopped service the
//       account may start and stop, left stopped; an administrator starts and
//       stops it, any other account must be refused)
//   SHELLMIND_E2E_WINDOWS_CONTAINER=<running container>  (optional, Docker on that host)
// Use a throwaway account, never your own: the test writes in its profile.
// It covers the status, the capabilities, services, live logs, the fleet
// probe, the Windows Update listing, the disk toolkit (read-only: previews,
// never a cleanup), multi-exec, the evidence of an AI diagnosis (no model is
// called), the file manager (SFTP) and the terminal (cmd.exe, then
// PowerShell with a block of lines). PowerShell scripts must reach the
// server on stdin: no PowerShell process of the account ever has a script
// on its command line (endpoint protection flags encoded command lines).

const TARGET = /^([^@]+)@(.+):(\d+)$/.exec(process.env.SHELLMIND_E2E_WINDOWS ?? '');
const KEY_FILE = process.env.SHELLMIND_E2E_WINDOWS_KEY ?? '';
const PASSWORD = process.env.SHELLMIND_E2E_WINDOWS_PASSWORD ?? '';
const SERVICE = process.env.SHELLMIND_E2E_WINDOWS_SERVICE ?? '';
const CONTAINER = process.env.SHELLMIND_E2E_WINDOWS_CONTAINER ?? '';
const ENABLED = Boolean(TARGET && (KEY_FILE || PASSWORD));
// The one command line a PowerShell script of ShellMind runs behind (cmd.exe
// may double the space after "powershell").
const STDIN_COMMAND_LINE = /^powershell\s+-NoProfile -NonInteractive -Command -$/;

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let server: TestServer;
let serverId: number;
let workDir = '';
let admin = false;
let delivery: typeof import('../../server/ops/remote');
const sockets: Socket[] = [];

const credentials = () => (KEY_FILE ? { privateKey: fs.readFileSync(KEY_FILE, 'utf8') } : { password: PASSWORD });

// Runs a PowerShell script on the host directly (setup and inspection), the
// way the backend delivers one.
function remote(script: string): Promise<string> {
    const [, username, host, port] = TARGET!;
    const { command, stdin } = delivery.powershellInvocation(script, 'stdin');
    return new Promise((resolve, reject) => {
        const client = new Client();
        let done = false;
        client.on('error', (err) => { if (!done) reject(err); });
        client.on('ready', () => {
            client.exec(command, (err, channel) => {
                if (err) return reject(err);
                let stdout = '';
                channel.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
                channel.stderr.on('data', () => {});
                channel.on('close', () => {
                    done = true;
                    client.end();
                    resolve(stdout.trim());
                });
                channel.end(stdin);
            });
        });
        client.connect({ host, port: Number(port), username, ...credentials(), readyTimeout: 20_000 });
    });
}

// Command lines of the account's PowerShell (but the one asking) and docker
// processes. An account that is not an administrator may not use WMI over
// SSH: it sees its own processes (those whose start time it may read), and
// no command lines ("?").
async function remoteCommandLines(): Promise<string[]> {
    const listing = admin
        ? await remote("Get-CimInstance Win32_Process -Filter \"Name='powershell.exe' OR Name='docker.exe'\"|?{$_.ProcessId -ne $PID -and (Invoke-CimMethod -InputObject $_ -MethodName GetOwner).User -eq [Environment]::UserName}|%{[Console]::Out.WriteLine($_.CommandLine)}")
        : await remote("Get-Process -Name powershell,docker -ErrorAction SilentlyContinue|?{$_.Id -ne $PID -and $_.StartTime}|%{[Console]::Out.WriteLine('?')}");
    return listing.split(/\r?\n/).filter(Boolean);
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
}

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as T };
}

function openSocket(): Socket {
    const socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
    sockets.push(socket);
    return socket;
}

function collectLogs(socket: Socket, id: string): () => string {
    let text = '';
    socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
        if (payload.id === id) text += payload.data;
        ack();
    });
    return () => text;
}

const psLiteral = (text: string) => `'${text.replace(/'/g, "''")}'`;

describe.skipIf(!ENABLED)('Windows features against a real Windows OpenSSH server', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        const [, username, host, port] = TARGET!;
        server = await bootTestServer();
        delivery = await import('../../server/ops/remote');
        const res = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            // Windows servers keep the SSH port in ssh_port (port is RDP's).
            body: JSON.stringify({ name: 'e2e-windows', ip: host, ssh_port: Number(port), type: 'windows', username, ...credentials() }),
        });
        serverId = ((await res.json()) as { data: { id: number } }).data.id;
        workDir = await remote("$d=Join-Path $env:USERPROFILE ('shellmind-e2e-'+[guid]::NewGuid().ToString('N').Substring(0,8));New-Item -ItemType Directory $d|Out-Null;Set-Content -LiteralPath (Join-Path $d 'app.log') -Value 'first line';[Console]::Out.Write($d)");
        expect(workDir).toMatch(/^[A-Za-z]:\\.*shellmind-e2e-[0-9a-f]{8}$/);
    });

    afterAll(async () => {
        for (const socket of sockets) socket.disconnect();
        if (workDir) await remote(`Remove-Item -Recurse -Force -LiteralPath ${psLiteral(workDir)}`).catch(() => {});
        await server?.close();
        vi.restoreAllMocks();
    });

    it('detects the platform and the privileges', async () => {
        const { body } = await call<OpsCapabilities>('GET', `/api/servers/${serverId}/ops/capabilities?refresh=1`);
        expect(body).toMatchObject({ platform: 'windows', systemd: false, journal: false, sudo: false });
        expect(typeof body.root).toBe('boolean');
        admin = body.root === true;
    });

    // Without WMI (not an administrator): no processor load and no processes.
    it('collects the status with one PowerShell script', async () => {
        const { status, body } = await call<StatusSnapshot>('GET', `/api/servers/${serverId}/status`);
        expect(status, JSON.stringify(body)).toBe(200);
        expect(body.platform).toBe('windows');
        expect(body.os).toMatch(/^Microsoft Windows/);
        expect(body.uptimeSeconds).toBeGreaterThan(0);
        expect(body.memory?.totalMB).toBeGreaterThan(0);
        expect(body.disks.length).toBeGreaterThan(0);
        expect(body.network).not.toBeNull();
        if (admin) {
            expect(body.limited).toBeUndefined();
            expect(body.cpu?.usagePercent).toBeGreaterThanOrEqual(0);
            expect(body.processes.length).toBeGreaterThan(0);
        } else {
            expect(body).toMatchObject({ limited: true, cpu: null, processes: [] });
        }
    });

    it('lists services, names running dependents and reports a failed action readably', async () => {
        // Not an administrator: only the services it may query, said so.
        const list = await call<ServicesList>('GET', `/api/servers/${serverId}/ops/services`);
        expect(list.body.services.map((service) => service.name)).toContain('EventLog');
        expect(list.body.limited).toBe(admin ? undefined : true);

        // LanmanWorkstation has running dependents; a user who is not an
        // administrator may query EventLog, not LanmanWorkstation.
        const detail = await call<ServiceDetail>('GET', `/api/servers/${serverId}/ops/services/${admin ? 'LanmanWorkstation' : 'EventLog'}`);
        expect(detail.status).toBe(200);
        expect(detail.body.properties).toMatchObject({ State: 'Running', StartMode: 'Auto' });
        expect(Array.isArray(detail.body.dependents)).toBe(true);
        if (!admin) expect(await call('GET', `/api/servers/${serverId}/ops/services/LanmanWorkstation`)).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });

        const failed = await call('POST', `/api/servers/${serverId}/ops/services/ShellMindNoSuchSvc/start`);
        expect(failed).toMatchObject({ status: 502, body: { code: 'OPS_COMMAND_FAILED', error: "Cannot find any service with service name 'ShellMindNoSuchSvc'." } });
    });

    it.skipIf(!SERVICE)('starts and stops a service as an administrator, and is refused otherwise', async () => {
        const state = async () => (await call<ServicesList>('GET', `/api/servers/${serverId}/ops/services`)).body.services.find((service) => service.name === SERVICE)?.sub;
        const started = await call<{ ok?: boolean; code?: string }>('POST', `/api/servers/${serverId}/ops/services/${SERVICE}/start`);
        if (!admin) {
            // Refused, not reported missing (the user may not even query it).
            expect(started).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });
            expect(await call('GET', `/api/servers/${serverId}/ops/services/${SERVICE}`)).toMatchObject({ status: 403, body: { code: 'OPS_PERMISSION_DENIED' } });
            return;
        }
        try {
            expect(started).toMatchObject({ status: 200, body: { ok: true } });
            expect(await state()).toBe('Running');
            const detail = await call<ServiceDetail>('GET', `/api/servers/${serverId}/ops/services/${SERVICE}`);
            expect(detail.body.properties).toMatchObject({ State: 'Running', StartMode: 'Manual' });
        } finally {
            const stopped = await call('POST', `/api/servers/${serverId}/ops/services/${SERVICE}/stop`);
            expect(stopped.status).toBe(200);
        }
        expect(await state()).toBe('Stopped');
        const audit = await call<{ data: Array<{ source: string; command: string }> }>('GET', '/api/audit?source=ops&limit=20');
        expect(audit.body.data.map((entry) => entry.command)).toEqual(expect.arrayContaining([`Start-Service -Name '${SERVICE}'`, `Stop-Service -Force -Name '${SERVICE}'`]));
    });

    it('follows a growing file and leaves no PowerShell behind once stopped', async () => {
        const path = `${workDir}\\app.log`;
        // Nothing of an earlier test still runs.
        await waitFor(async () => (await remoteCommandLines()).length === 0);
        const socket = openSocket();
        const text = collectLogs(socket, 'w1');
        socket.emit('logs-start', { id: 'w1', serverId, source: { kind: 'file', path } });
        await waitFor(() => text().includes('first line'));
        await remote(`Add-Content -LiteralPath ${psLiteral(path)} -Value 'second line'`);
        await waitFor(() => text().includes('second line'));
        // The stream's PowerShell got its script on stdin (only an
        // administrator may read the command lines).
        const running = await remoteCommandLines();
        expect(running.length).toBeGreaterThan(0);
        if (admin) for (const line of running) expect(line).toMatch(STDIN_COMMAND_LINE);

        const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
        socket.emit('logs-stop', { id: 'w1' });
        expect(await ended).toEqual({ id: 'w1', code: null });
        await waitFor(async () => (await remoteCommandLines()).length === 0);
        expect(text()).not.toMatch(/CLIXML|<Objs/);
    });

    it('reports a missing file as text, not CLIXML', async () => {
        const socket = openSocket();
        const text = collectLogs(socket, 'w2');
        const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
        socket.emit('logs-start', { id: 'w2', serverId, source: { kind: 'file', path: `${workDir}\\missing.log` } });
        expect(await ended).toEqual({ id: 'w2', code: 1 });
        expect(text()).toMatch(/Cannot find path .*missing\.log/);
        expect(text()).not.toMatch(/CLIXML|<Objs/);
    });

    it.skipIf(!CONTAINER)('follows container logs and kills docker when the socket drops', async () => {
        const running = async () => (await remoteCommandLines()).filter((line) => /docker(\.exe)?"?\s+logs -f/i.test(line) && line.includes(CONTAINER)).length;
        const socket = openSocket();
        const text = collectLogs(socket, 'w3');
        socket.emit('logs-start', { id: 'w3', serverId, source: { kind: 'container', container: CONTAINER } });
        await waitFor(() => text().split('\n').length > 3);
        expect(await running()).toBe(1);
        socket.disconnect();
        await waitFor(async () => (await running()) === 0);
        expect(text()).not.toMatch(/CLIXML|<Objs/);
    });

    it('reads the server on the fleet board', async () => {
        const refresh = await call('POST', '/api/fleet/refresh', { ids: [serverId] });
        expect(refresh.status).toBe(202);
        let snapshot: FleetBoard['snapshots'][number] | undefined;
        await waitFor(async () => {
            snapshot = (await call<{ data: FleetBoard }>('GET', '/api/fleet')).body.data.snapshots.find((entry) => entry.serverId === serverId);
            return Boolean(snapshot && !snapshot.checking && snapshot.readAt);
        }, 90_000);
        expect(snapshot!.error).toBeNull();
        expect(snapshot!.reachedVia).toBe('ssh');
        expect(snapshot!.metrics).not.toBeNull();
    });

    it('lists pending Windows updates without installing anything', async () => {
        const { status, body } = await call<{ data: PatchScan }>('POST', `/api/servers/${serverId}/patch/scan`);
        expect(status, JSON.stringify(body)).toBe(200);
        expect(body.data).toMatchObject({ platform: 'windows', manager: 'windows-update', privilege: admin ? 'admin' : 'user' });
        expect(Array.isArray(body.data.updates)).toBe(true);
        // Over SSH Windows Update lets only administrators search it.
        expect(body.data.notices.map((notice) => notice.code)).toEqual(admin ? [] : ['search-denied']);
    });

    it('reads the drives, a folder, the largest files and the cleanup previews', async () => {
        const overview = await call<DiskOverview>('GET', `/api/servers/${serverId}/disk`);
        expect(overview.status, JSON.stringify(overview.body)).toBe(200);
        const drive = overview.body.mounts.find((mount) => workDir.toUpperCase().startsWith(mount.mount.toUpperCase()));
        expect(drive).toBeDefined();

        await remote(`$f=[IO.File]::Create((Join-Path ${psLiteral(workDir)} 'big.bin'));$f.SetLength(3MB);$f.Close()`);
        const usage = await call<DirectoryListing>('GET', `/api/servers/${serverId}/disk/usage?path=${encodeURIComponent(workDir)}&budget=30&rescan=1`);
        expect(usage.status, JSON.stringify(usage.body)).toBe(200);
        expect(usage.body.entries.map((entry) => entry.name)).toEqual(expect.arrayContaining(['big.bin', 'app.log']));

        const cleanups = await call<CleanupOverview>('GET', `/api/servers/${serverId}/disk/cleanups`);
        expect(cleanups.status, JSON.stringify(cleanups.body)).toBe(200);
        expect(cleanups.body.cleanups.map((cleanup) => cleanup.id)).toEqual(expect.arrayContaining(['win-temp', 'win-recycle-bin']));
    });

    it('finds the largest files of a drive', async () => {
        const drive = (await call<DiskOverview>('GET', `/api/servers/${serverId}/disk`)).body.mounts[0];
        const large = await call<{ files: unknown[]; timedOut: boolean }>('GET', `/api/servers/${serverId}/disk/large-files?mount=${encodeURIComponent(drive.mount)}&minMB=500&rescan=1`);
        expect(large.status, JSON.stringify(large.body)).toBe(200);
        expect(Array.isArray(large.body.files)).toBe(true);
    });

    it('runs a command with multi-exec through the default shell', async () => {
        const started = await call<{ data: { job: { id: string } } }>('POST', '/api/multiexec', { command: 'echo multi-exec %USERNAME% & ver', serverIds: [serverId], timeoutSec: 60 });
        expect(started.status, JSON.stringify(started.body)).toBe(201);
        let job: MultiExecJob | undefined;
        await waitFor(async () => {
            job = (await call<{ data: MultiExecJob }>('GET', `/api/multiexec/jobs/${started.body.data.job.id}`)).body.data;
            return job.status === 'done';
        }, 60_000);
        const [run] = job!.servers;
        expect(run).toMatchObject({ status: 'ok', exitCode: 0 });
        expect(run.stdout).toContain(`multi-exec ${TARGET![1]}`);
        expect(run.stdout).toMatch(/Microsoft Windows \[Version/);
    });

    it('collects the evidence of an AI diagnosis', async () => {
        const evidence = async (attachment: Record<string, unknown>) => {
            const { status, body } = await call<{ evidence: ChatEvidence }>('POST', '/api/chat/evidence', { serverId, attachment });
            expect(status, JSON.stringify(body)).toBe(200);
            const sections = body.evidence.sections;
            for (const section of sections) expect(section.text, section.id).not.toMatch(/CLIXML|<Objs|FromBase64String/);
            return sections;
        };
        // What a user who is not an administrator may not read is named as
        // such (the event logs, the services), never reported as empty.
        const denied = (section: ChatEvidence['sections'][number] | undefined) => Boolean(section?.failed && /OPS_PERMISSION_DENIED/.test(section.text));
        const triage = await evidence({ kind: 'triage' });
        expect(triage.filter((section) => !section.failed).map((section) => section.id)).toEqual(expect.arrayContaining(['system', 'disk', 'memory', 'processes', 'ports', ...(admin ? ['errors', 'stopped-services'] : [])]));
        if (!admin) expect(triage.filter(denied).map((section) => section.id)).toEqual(['errors', 'stopped-services']);
        expect(triage.find((section) => section.id === 'memory')?.text).toMatch(/MB available of [\d,.]+ MB/);
        const service = await evidence({ kind: 'service', name: 'EventLog' });
        expect(service.find((section) => section.id === 'service')?.text).toMatch(/State: Running/);
        const events = service.find((section) => section.id === 'events');
        expect(admin ? !events?.failed : denied(events)).toBe(true);
        const logs = await evidence({ kind: 'logs', source: { kind: 'file', path: `${workDir}\\app.log` } });
        expect(logs.find((section) => section.id === 'logs')?.text).toContain('second line');
        expect((await evidence({ kind: 'status' })).some((section) => section.id === 'snapshot' && !section.failed)).toBe(true);
        const drive = (await call<DiskOverview>('GET', `/api/servers/${serverId}/disk`)).body.mounts[0];
        expect((await evidence({ kind: 'disk', mount: drive.mount })).some((section) => section.id === 'disk' && !section.failed)).toBe(true);
    });

    it('browses, writes, reads, renames and deletes files over SFTP', async () => {
        const socket = await openFileSession(server, serverId);
        sockets.push(socket);
        const session = await ok(socket, 'files-session');
        // OpenSSH for Windows names a drive /C:/.
        const dir = `/${workDir.replace(/\\/g, '/')}`;
        const listing = await ok(socket, 'files-list', { path: dir });
        expect(listing.entries.map((entry) => entry.name)).toContain('app.log');
        expect(session.home).toMatch(/^\/[A-Za-z]:\//);

        const name = 'notas-señal ’e2e’.txt';
        const content = Buffer.from('línea uno\r\nlínea dos\r\n', 'utf8');
        await ok(socket, 'files-write', { path: `${dir}/${name}`, data: content, expected: null });
        const read = await ok(socket, 'files-read', { path: `${dir}/${name}` });
        expect(Buffer.from(read.data as ArrayBuffer).toString('utf8')).toBe(content.toString('utf8'));
        await ok(socket, 'files-rename', { from: `${dir}/${name}`, to: `${dir}/renamed.txt`, isDir: false });
        expect(await remote(`Get-Content -Raw -LiteralPath (Join-Path ${psLiteral(workDir)} 'renamed.txt') -Encoding UTF8`)).toBe('línea uno\r\nlínea dos');
        const removed = await ok(socket, 'files-delete', { items: [{ path: `${dir}/renamed.txt`, isDir: false }] });
        expect(removed.deleted).toBe(1);
        const root = await ok(socket, 'files-list', { path: dir.slice(0, 3) });
        expect(root.entries.map((entry) => entry.name.toLowerCase())).toContain('windows');
    });

    it('opens a terminal in cmd.exe, then runs a block of lines in PowerShell', async () => {
        const socket = openSocket();
        let output = '';
        socket.on('ssh-output', (data: ArrayBuffer | string) => {
            const text = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
            output += text;
            socket.emit('ssh-ack', Buffer.byteLength(text));
        });
        const ready = new Promise<void>((resolve, reject) => {
            socket.once('connection-ready', () => resolve());
            socket.once('ssh-error', (message: string) => reject(new Error(message)));
        });
        socket.on('connect', () => socket.emit('start-ssh', { serverId, purpose: 'terminal', cols: 120, rows: 30 }));
        await ready;
        await waitFor(() => /[A-Za-z]:\\[^\r\n]*>/.test(output));
        socket.emit('ssh-input', 'echo cmd-says-%USERNAME%\r');
        await waitFor(() => output.includes(`cmd-says-${TARGET![1]}`));

        socket.emit('ssh-input', 'powershell -NoLogo -NoProfile\r');
        // eslint-disable-next-line no-control-regex -- terminal escape sequences
        const plain = () => output.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '');
        await waitFor(() => /PS [A-Za-z]:\\[^\r\n]*>\s*$/.test(plain()), 60_000);
        const mark = output.length;
        socket.emit('ssh-input', `${encodePowerShellBlock("$n = 6 * 7\nGet-Item $env:SystemRoot |\n  Select-Object -ExpandProperty Name\n\"answer=$n\"")}\r`);
        await waitFor(() => output.slice(mark).includes('answer=42'), 60_000);
        expect(output.slice(mark)).toMatch(/Windows/i);
        socket.emit('ssh-input', 'exit\r');
        socket.emit('ssh-input', 'exit\r');
    });
});
