import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type {
    ComposeOverview,
    ContainerInspectSummary,
    ContainerStats,
    DiskUsage,
    ImageList,
    LogChunkPayload,
    PrunePreview,
    PruneResult
} from '../../shared/ops';
import type { TerminalAttach } from '../../shared/protocol';
import type { ConnectionError, TerminalNotice } from '../../shared/terminal';
import type { AuditEntry } from '../../shared/types';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7-S3 end to end against a real Docker engine (opt-in: SHELLMIND_E2E=1):
// an sshd in front of its own engine (Docker in Docker, test/fixtures/ops/
// containers-e2e), so container shells, Compose projects and image prunes
// run for real and never touch the engine of the machine running the tests.
// The image `alpine:3` is copied in from the host; `update` pulls it again
// from Docker Hub (the inner engine needs network access for that test).

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-s3-dind';
const CONTAINER = `shellmind-test-containers-${process.pid}`;
const CONTEXT = fileURLToPath(new URL('../fixtures/ops/containers-e2e', import.meta.url));

vi.setConfig({ testTimeout: 90_000, hookTimeout: 300_000 });

let server: TestServer;
let opsId: number;
let devId: number;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

// A shell script run inside the test host (as root, next to its engine).
function inside(script: string): string {
    return execFileSync('docker', ['exec', '-i', CONTAINER, 'sh', '-s'], { input: script, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 20_000) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 150));
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

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    return { status: res.status, body: await res.json() as T };
}

async function saveServer(username: string, password: string, port: number): Promise<number> {
    const { body } = await call<{ data: { id: number } }>('POST', '/api/servers', { name: `dind-${username}`, ip: '127.0.0.1', port, type: 'linux', username, password });
    return body.data.id;
}

const COMPOSE_FILE = `services:
  web:
    image: alpine:3
    command: ["sh", "-c", "while :; do echo tick from web; sleep 0.5; done"]
    environment:
      API_TOKEN: s3cr3t-value
    ports:
      - "8080:80"
    volumes:
      - data:/data
  worker:
    image: alpine:3
    command: ["sleep", "infinity"]
volumes:
  data:
`;

type Terminal = {
    socket: Socket;
    output: () => string;
    notices: TerminalNotice[];
    errors: ConnectionError[];
    send: (text: string) => void;
    close: () => void;
};

// A terminal session over the real socket protocol, attached to a container.
async function openTerminal(serverId: number, attach: TerminalAttach, size = { cols: 100, rows: 30 }): Promise<Terminal> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
    let text = '';
    const notices: TerminalNotice[] = [];
    const errors: ConnectionError[] = [];
    socket.on('ssh-output', (data: ArrayBuffer | string) => {
        const chunk = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
        text += chunk;
        // BusyBox ash asks where the cursor is before its prompt and reads
        // the answer from the input, as a terminal (xterm.js) gives it.
        if (chunk.includes('\x1b[6n')) socket.emit('ssh-input', '\x1b[1;1R');
    });
    socket.on('terminal-notice', (notice: TerminalNotice) => notices.push(notice));
    socket.on('ssh-error', (_message: string, error: ConnectionError) => errors.push(error));
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    socket.emit('start-ssh', { serverId, purpose: 'terminal', ...size, attach });
    return {
        socket,
        output: () => text,
        notices,
        errors,
        send: (input) => socket.emit('ssh-input', input),
        close: () => socket.disconnect(),
    };
}

const auditOps = async () => (await call<{ data: AuditEntry[] }>('GET', '/api/audit?source=ops')).body.data;

describe.skipIf(!ENABLED)('containers v2 against a real Docker engine (docker in docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        docker('run', '-d', '--privileged', '--name', CONTAINER, '-p', '127.0.0.1::22', IMAGE);
        const port = Number(docker('port', CONTAINER, '22').split('\n')[0].split(':').pop());
        await waitFor(() => sshBanner(port), 30_000);
        await waitFor(() => spawnSync('docker', ['exec', CONTAINER, 'docker', 'info']).status === 0, 60_000);
        // The test image comes from the host: no registry needed to set up.
        const alpine = execFileSync('docker', ['save', 'alpine:3'], { maxBuffer: 512 * 1024 * 1024 });
        execFileSync('docker', ['exec', '-i', CONTAINER, 'docker', 'load'], { input: alpine, stdio: ['pipe', 'ignore', 'pipe'] });
        inside([
            'set -e',
            'mkdir -p /srv/web',
            `cat > /srv/web/compose.yaml <<'EOF'\n${COMPOSE_FILE}EOF`,
            'cd /srv/web && docker compose up -d >/dev/null 2>&1',
            'docker run -d --name lone alpine:3 sleep infinity >/dev/null',
            'docker create --name idle alpine:3 true >/dev/null',
            // A dangling image: the second commit takes the tag of the first.
            'docker run -d --name scratch alpine:3 sleep infinity >/dev/null',
            'docker commit scratch demo-app:latest >/dev/null',
            "docker exec scratch sh -c 'echo two > /two'",
            'docker commit scratch demo-app:latest >/dev/null',
            'docker rm -f scratch >/dev/null',
        ].join('\n'));
        server = await bootTestServer();
        opsId = await saveServer('ops', 'opspw', port);
        devId = await saveServer('dev', 'devpw', port);
    });

    afterAll(async () => {
        await server?.close();
        spawnSync('docker', ['rm', '-f', CONTAINER]);
        vi.restoreAllMocks();
    });

    it('detects the engine directly (docker group) and through sudo -n', async () => {
        expect((await call('GET', `/api/servers/${opsId}/ops/capabilities`)).body).toMatchObject({ containers: { engine: 'docker', sudo: false, compose: true } });
        expect((await call('GET', `/api/servers/${devId}/ops/capabilities`)).body).toMatchObject({ containers: { engine: 'docker', sudo: true, compose: true } });
    });

    describe('container shells', () => {
        it('opens a shell in a running container, follows resizes and ends with it', async () => {
            const term = await openTerminal(opsId, { kind: 'container', engine: 'docker', container: 'lone' });
            try {
                await waitFor(() => term.output().includes('# ') || term.output().includes('$ '));
                term.send('echo "answer=$((6*7))"; cat /etc/alpine-release\r');
                await waitFor(() => term.output().includes('answer=42'));
                expect(term.output()).toMatch(/\d+\.\d+\.\d+/);

                term.socket.emit('resize', { cols: 133, rows: 41 });
                await new Promise((resolve) => setTimeout(resolve, 300));
                term.send('stty size\r');
                await waitFor(() => term.output().includes('41 133'));

                const closed = new Promise<void>((resolve) => term.socket.once('ssh-closed', () => resolve()));
                term.send('exit\r');
                await closed;
                expect(term.notices.at(-1)).toEqual({ kind: 'session-ended' });
                expect(term.notices[0]).toMatchObject({ kind: 'connected' });
            } finally {
                term.close();
            }
            const entry = (await auditOps()).find((item) => item.meta?.action === 'shell' && item.meta?.target === 'lone');
            expect(entry).toMatchObject({ source: 'ops', command: expect.stringMatching(/^docker 'exec' '-it' '-e' 'SHELLMIND_TERMINAL=[a-f0-9]{32}' 'lone'/), meta: { kind: 'container', engine: 'docker', shell: 'auto' } });
            // It exited by itself: nothing was left to hang up.
            await new Promise((resolve) => setTimeout(resolve, 1500));
            expect((await auditOps()).some((item) => item.meta?.action === 'shell-end')).toBe(false);
        });

        it('goes through sudo -n docker for a user outside the docker group', async () => {
            const term = await openTerminal(devId, { kind: 'container', engine: 'docker', container: 'web-worker-1', shell: 'sh' });
            try {
                await waitFor(() => term.output().includes('# '));
                term.send('id -u; hostname\r');
                await waitFor(() => /\b0\r?\n/.test(term.output()));
                expect(term.errors).toEqual([]);
            } finally {
                term.close();
            }
        });

        it('refuses a stopped or unknown container before opening anything', async () => {
            for (const [container, code] of [['idle', 'CONTAINER_NOT_RUNNING'], ['nope', 'CONTAINER_NOT_FOUND']] as const) {
                const term = await openTerminal(opsId, { kind: 'container', engine: 'docker', container });
                try {
                    await waitFor(() => term.errors.length > 0);
                    expect(term.errors[0]).toMatchObject({ code, details: { container } });
                } finally {
                    term.close();
                }
            }
        });

        it('hangs up the shell left in the container when the tab goes away or reconnects, not what was nohup\'d', async () => {
            // What runs in `lone` besides its own sleep (and the ps asking).
            // Zombies ("[sleep]") are left out: `lone` has no init to reap
            // the nohup'd sleep this test kills once it was reparented to it.
            const leftovers = () => inside('docker exec lone ps -o args').split('\n').slice(1).map((line) => line.trim())
                .filter((line) => line && line !== 'sleep infinity' && line !== 'ps -o args' && !line.startsWith('['));
            expect(leftovers()).toEqual([]);

            const term = await openTerminal(opsId, { kind: 'container', engine: 'docker', container: 'lone' });
            try {
                await waitFor(() => term.output().includes('# '));
                term.send('top -b -d 5 >/dev/null & nohup sleep 3000 >/dev/null 2>&1 & sleep 1000\r');
                await waitFor(() => leftovers().includes('sleep 1000'));
                expect(leftovers()).toEqual(expect.arrayContaining(['sh', 'top -b -d 5', 'sleep 3000']));
            } finally {
                // The tab closes: docker exec ends with the channel, the engine keeps the shell.
                term.close();
            }
            await waitFor(() => leftovers().length === 1, 20_000);
            // nohup asked for the hang-up to be ignored.
            expect(leftovers()).toEqual(['sleep 3000']);
            inside("docker exec lone pkill -f 'sleep 3000'");
            await waitFor(async () => (await auditOps()).some((item) => item.meta?.action === 'shell-end' && item.meta?.target === 'lone'));
            const ended = (await auditOps()).find((item) => item.meta?.action === 'shell-end' && item.meta?.target === 'lone');
            expect(ended).toMatchObject({ exit_code: 0, command: expect.stringContaining("docker 'exec' 'lone' 'sh' '-c'"), meta: { kind: 'container', engine: 'docker', processes: 4 } });

            // Reconnecting the tab (start-ssh again) replaces its shell: the old one goes.
            const again = await openTerminal(devId, { kind: 'container', engine: 'docker', container: 'lone' });
            try {
                await waitFor(() => again.output().includes('# '));
                again.send('sleep 1001\r');
                await waitFor(() => leftovers().includes('sleep 1001'));
                again.socket.emit('start-ssh', { serverId: devId, purpose: 'terminal', cols: 100, rows: 30, attach: { kind: 'container', engine: 'docker', container: 'lone' } });
                await waitFor(() => !leftovers().includes('sleep 1001'), 20_000);
                await waitFor(() => leftovers().length === 1);
            } finally {
                again.close();
            }
            await waitFor(() => leftovers().length === 0, 20_000);
        });

        it('reports a shell the container does not have', async () => {
            const term = await openTerminal(opsId, { kind: 'container', engine: 'docker', container: 'lone', shell: 'bash' });
            try {
                await waitFor(() => term.notices.some((notice) => notice.kind === 'session-ended'));
                expect(term.output()).toMatch(/bash.*(not found|no such file)/i);
            } finally {
                term.close();
            }
        });
    });

    describe('compose projects', () => {
        it('lists a project from its labels with its files and containers', async () => {
            const { status, body } = await call<ComposeOverview>('GET', `/api/servers/${opsId}/ops/compose`);
            expect(status).toBe(200);
            expect(body).toMatchObject({ engine: 'docker', tool: 'docker compose', problem: null });
            expect(body.projects).toEqual([expect.objectContaining({
                name: 'web', workingDir: '/srv/web', configFiles: ['/srv/web/compose.yaml'], missingFiles: [], running: 2,
            })]);
            expect(body.projects[0].containers.map((container) => container.composeService)).toEqual(['web', 'worker']);
        });

        it('restarts one service and pulls and recreates the project, audited', async () => {
            const restart = await call<{ command: string; output: string }>('POST', `/api/servers/${devId}/ops/compose/web/restart`, { service: 'worker' });
            expect(restart.status).toBe(200);
            expect(restart.body.command).toBe("sudo -n docker 'compose' '-p' 'web' '--project-directory' '/srv/web' '-f' '/srv/web/compose.yaml' 'restart' 'worker'");
            expect(restart.body.output).toMatch(/worker-1.*(Restarting|Started)/);

            const update = await call<{ command: string; output: string }>('POST', `/api/servers/${opsId}/ops/compose/web/update`);
            expect(update.status, JSON.stringify(update.body)).toBe(200);
            expect(update.body.command).toContain("'pull' && docker 'compose'");
            expect(update.body.output).toMatch(/Pull/i);

            const entries = (await auditOps()).filter((item) => item.meta?.kind === 'compose');
            expect(entries.map((item) => item.meta?.action)).toEqual(expect.arrayContaining(['restart', 'update']));
            expect(entries.find((item) => item.meta?.action === 'restart')).toMatchObject({ exit_code: 0, meta: { target: 'web', service: 'worker' } });
        });

        it('follows the logs of the project live', async () => {
            const socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
            try {
                let text = '';
                socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
                    text += payload.data;
                    ack();
                });
                socket.emit('logs-start', { id: 'compose1', serverId: opsId, source: { kind: 'compose', project: 'web', service: 'web' } });
                await waitFor(() => (text.match(/tick from web/g) ?? []).length >= 3);
                const ended = new Promise((resolve) => socket.once('logs-end', resolve));
                socket.emit('logs-stop', { id: 'compose1' });
                expect(await ended).toEqual({ id: 'compose1', code: null });
                await waitFor(() => !inside('ps -o args').includes('compose -p web'), 15_000);
            } finally {
                socket.disconnect();
            }
        });

        it('keeps stop and down working by name when the files are gone, but not up', async () => {
            inside('mv /srv/web/compose.yaml /srv/web/compose.yaml.moved');
            try {
                const overview = await call<ComposeOverview>('GET', `/api/servers/${opsId}/ops/compose`);
                expect(overview.body.projects[0]).toMatchObject({ name: 'web', missingFiles: ['/srv/web/compose.yaml'] });
                const up = await call('POST', `/api/servers/${opsId}/ops/compose/web/up`);
                expect(up).toMatchObject({ status: 409, body: { code: 'COMPOSE_FILES_MISSING' } });
                const stop = await call<{ command: string }>('POST', `/api/servers/${opsId}/ops/compose/web/stop`);
                expect(stop.status).toBe(200);
                expect(stop.body.command).toBe("docker 'compose' '-p' 'web' 'stop'");
            } finally {
                inside('mv /srv/web/compose.yaml.moved /srv/web/compose.yaml');
            }
            const down = await call('POST', `/api/servers/${opsId}/ops/compose/web/down`);
            expect(down.status).toBe(200);
            expect((await call<ComposeOverview>('GET', `/api/servers/${opsId}/ops/compose`)).body.projects).toEqual([]);
            // The named volume survives `down`.
            expect(inside('docker volume ls -q')).toContain('web_data');
        });

        it('rejects names and actions that are not valid before running anything', async () => {
            expect((await call('POST', `/api/servers/${opsId}/ops/compose/${encodeURIComponent('web;id')}/up`)).body).toMatchObject({ code: 'OPS_INVALID_INPUT' });
            expect((await call('POST', `/api/servers/${opsId}/ops/compose/web/build`)).body).toMatchObject({ code: 'OPS_INVALID_INPUT' });
            expect((await call('POST', `/api/servers/${opsId}/ops/compose/web/down`, { service: 'worker' })).body).toMatchObject({ code: 'OPS_INVALID_INPUT' });
            expect((await call('POST', `/api/servers/${opsId}/ops/compose/ghost/restart`)).status).toBe(404);
        });
    });

    describe('container details', () => {
        it('summarizes inspect and reads a usage snapshot', async () => {
            inside('cd /srv/web && docker compose up -d >/dev/null 2>&1');
            const { body } = await call<{ summary: ContainerInspectSummary }>('GET', `/api/servers/${opsId}/ops/containers/web-web-1`);
            expect(body.summary).toMatchObject({
                name: 'web-web-1',
                state: { status: 'running', running: true },
                compose: { project: 'web', service: 'web', workingDir: '/srv/web', configFiles: ['/srv/web/compose.yaml'] },
                ports: [{ port: '80/tcp', hostIp: '0.0.0.0', hostPort: '8080' }],
            });
            expect(body.summary.env).toContainEqual({ name: 'API_TOKEN', value: 's3cr3t-value' });
            expect(body.summary.mounts).toContainEqual(expect.objectContaining({ type: 'volume', name: 'web_data', destination: '/data', readOnly: false }));
            expect(body.summary.networks.map((network) => network.name)).toEqual(['web_default']);

            const stats = await call<{ stats: ContainerStats }>('GET', `/api/servers/${opsId}/ops/containers/web-web-1/stats`);
            expect(stats.body.stats).toMatchObject({ name: 'web-web-1', pids: expect.any(Number) });
        });
    });

    describe('images', () => {
        it('lists images with what uses them and the dangling ones', async () => {
            const { body } = await call<ImageList>('GET', `/api/servers/${opsId}/ops/images`);
            // `update` may have pulled a newer alpine:3 for the project: the
            // other containers keep the old (now untagged, still used) image.
            const alpine = body.images.find((image) => image.reference === 'alpine:3');
            expect(alpine).toMatchObject({ dangling: false, containers: expect.any(Number) });
            expect(alpine?.containers).toBeGreaterThanOrEqual(2);
            expect(body.images.find((image) => image.reference === 'demo-app:latest')).toMatchObject({ dangling: false, containers: 0 });
            expect(body.images.filter((image) => image.dangling)).toHaveLength(1);
            // One row per image and name.
            expect(new Set(body.images.map((image) => `${image.id} ${image.reference}`)).size).toBe(body.images.length);

            const usage = await call<DiskUsage>('GET', `/api/servers/${opsId}/ops/disk-usage`);
            expect(usage.body.rows.map((row) => row.kind)).toEqual(['images', 'containers', 'volumes', 'build-cache']);
        });

        it('previews and prunes dangling images, then unused ones', async () => {
            const preview = await call<PrunePreview>('GET', `/api/servers/${opsId}/ops/images/prune-preview?mode=dangling`);
            expect(preview.body).toMatchObject({ mode: 'dangling', estimate: 'at-least' });
            expect(preview.body.images).toHaveLength(1);

            const prune = await call<PruneResult>('POST', `/api/servers/${devId}/ops/images/prune`, { mode: 'dangling' });
            expect(prune.status).toBe(200);
            expect(prune.body).toMatchObject({ command: "sudo -n docker 'image' 'prune' '-f'", reclaimedBytes: expect.any(Number) });
            expect((await call<ImageList>('GET', `/api/servers/${opsId}/ops/images`)).body.images.filter((image) => image.dangling)).toHaveLength(0);

            const unused = await call<PrunePreview>('GET', `/api/servers/${opsId}/ops/images/prune-preview?mode=unused`);
            expect(unused.body.images.map((image) => image.reference)).toEqual(['demo-app:latest']);
            expect((await call('POST', `/api/servers/${opsId}/ops/images/prune`, { mode: 'unused' })).status).toBe(200);
            const left = (await call<ImageList>('GET', `/api/servers/${opsId}/ops/images`)).body.images;
            expect(left.map((image) => image.reference).filter(Boolean)).toEqual(['alpine:3']);
            expect(left.every((image) => image.containers > 0)).toBe(true);
            expect((await auditOps()).map((item) => item.meta?.action)).toEqual(expect.arrayContaining(['prune-dangling', 'prune-unused']));
        });

        it('refuses to remove an image a container uses, removes one by reference', async () => {
            const busy = await call<{ code: string; error: string }>('POST', `/api/servers/${opsId}/ops/images/remove`, { ref: 'alpine:3' });
            expect(busy.status).toBe(502);
            expect(busy.body.error).toMatch(/conflict|being used|in use/i);
            // The audit log keeps why it failed (the engine printed it on stdout).
            const refused = (await auditOps()).find((item) => item.meta?.action === 'remove' && item.meta?.target === 'alpine:3');
            expect(refused).toMatchObject({ exit_code: 1, meta: { error: expect.stringMatching(/conflict|being used|in use/i) } });
            inside('docker tag alpine:3 spare:1');
            expect((await call('POST', `/api/servers/${opsId}/ops/images/remove`, { ref: 'spare:1' })).status).toBe(200);
            expect((await call('POST', `/api/servers/${opsId}/ops/images/remove`, { ref: "x'; id #" })).body).toMatchObject({ code: 'OPS_INVALID_INPUT' });
        });

        it('frees what the build cache preview announced, not the records images share', async () => {
            // A multi-stage build: the first stage's layers are cache only,
            // the copied layer is shared with the image it built.
            inside([
                'set -e',
                'mkdir -p /tmp/bc',
                "printf 'FROM alpine:3 AS build\\nRUN head -c 3000000 /dev/urandom > /blob\\nRUN head -c 2000000 /dev/urandom > /blob2\\nFROM alpine:3\\nCOPY --from=build /blob /blob\\n' > /tmp/bc/Dockerfile",
                'docker build -q -t cache-demo:1 /tmp/bc >/dev/null 2>&1',
            ].join('\n'));
            const preview = await call<PrunePreview>('GET', `/api/servers/${opsId}/ops/images/prune-preview?mode=build-cache`);
            expect(preview.body).toMatchObject({ mode: 'build-cache', estimate: 'exact' });
            expect(preview.body.bytes).toBeGreaterThan(4_000_000);

            const prune = await call<PruneResult>('POST', `/api/servers/${opsId}/ops/images/prune`, { mode: 'build-cache' });
            expect(prune.status).toBe(200);
            expect(prune.body.command).toBe("docker 'builder' 'prune' '-f'");
            expect(prune.body.reclaimedBytes).toBe(preview.body.bytes);
            expect((await call<PrunePreview>('GET', `/api/servers/${opsId}/ops/images/prune-preview?mode=build-cache`)).body.bytes).toBe(0);
            // The image built from the cache is untouched.
            expect((await call<ImageList>('GET', `/api/servers/${opsId}/ops/images`)).body.images.map((image) => image.reference)).toContain('cache-demo:1');
        });
    });
});
