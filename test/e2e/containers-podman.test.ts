import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect } from 'socket.io-client';
import type { ComposeOverview, DiskUsage, ImageList, PrunePreview } from '../../shared/ops';
import type { TerminalNotice } from '../../shared/terminal';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7-S3 end to end against Podman (opt-in: SHELLMIND_E2E=1): sshd in front of
// Podman and podman-compose in a privileged container (test/fixtures/ops/
// podman-e2e), isolated from the engine of the machine running the tests.
// The image `alpine:3` is copied in from the host Docker.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-s3-podman';
const CONTAINER = `shellmind-test-podman-${process.pid}`;
const CONTEXT = fileURLToPath(new URL('../fixtures/ops/podman-e2e', import.meta.url));

vi.setConfig({ testTimeout: 90_000, hookTimeout: 600_000 });

let server: TestServer;
let rootId: number;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

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

const COMPOSE_FILE = `services:
  web:
    image: docker.io/library/alpine:3
    command: ["sh", "-c", "while :; do echo tick from web; sleep 1; done"]
  worker:
    image: docker.io/library/alpine:3
    command: ["sleep", "infinity"]
`;

describe.skipIf(!ENABLED)('containers v2 against Podman and podman-compose', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        docker('run', '-d', '--privileged', '--name', CONTAINER, '-p', '127.0.0.1::22', IMAGE);
        const port = Number(docker('port', CONTAINER, '22').split('\n')[0].split(':').pop());
        await waitFor(() => sshBanner(port), 30_000);
        const alpine = execFileSync('docker', ['save', 'alpine:3'], { maxBuffer: 512 * 1024 * 1024 });
        execFileSync('docker', ['exec', '-i', CONTAINER, 'podman', 'load'], { input: alpine, stdio: ['pipe', 'ignore', 'pipe'] });
        inside([
            'set -e',
            'podman tag alpine:3 docker.io/library/alpine:3 2>/dev/null || true',
            // A second name: Podman 5 then lists the image once per name.
            'podman tag docker.io/library/alpine:3 docker.io/library/alpine:latest',
            'mkdir -p /srv/pc',
            `cat > /srv/pc/compose.yaml <<'EOF'\n${COMPOSE_FILE}EOF`,
            // podman-compose labels the file as given: relative to its directory.
            'cd /srv/pc && podman-compose up -d >/dev/null 2>&1',
            'podman run -d --name lone docker.io/library/alpine:3 sleep infinity >/dev/null',
            'podman run -d --name scratch docker.io/library/alpine:3 sleep infinity >/dev/null',
            'podman commit scratch localhost/demo-app:latest >/dev/null',
            "podman exec scratch sh -c 'echo two > /two'",
            'podman commit scratch localhost/demo-app:latest >/dev/null',
            'podman rm -f -t 0 scratch >/dev/null',
        ].join('\n'));
        server = await bootTestServer();
        const { body } = await call<{ data: { id: number } }>('POST', '/api/servers', { name: 'podman', ip: '127.0.0.1', port, type: 'linux', username: 'root', password: 'rootpw' });
        rootId = body.data.id;
    });

    afterAll(async () => {
        await server?.close();
        spawnSync('docker', ['rm', '-f', CONTAINER]);
        vi.restoreAllMocks();
    });

    it('finds the project of podman-compose with its relative file, and restarts it', async () => {
        expect((await call('GET', `/api/servers/${rootId}/ops/capabilities`)).body).toMatchObject({ containers: { engine: 'podman', compose: false } });
        const { body } = await call<ComposeOverview>('GET', `/api/servers/${rootId}/ops/compose`);
        expect(body.tool).toMatch(/^podman( |-)compose$/);
        expect(body.projects).toEqual([expect.objectContaining({ name: 'pc', workingDir: '/srv/pc', configFiles: ['/srv/pc/compose.yaml'], missingFiles: [], running: 2 })]);

        const restart = await call<{ command: string; output: string }>('POST', `/api/servers/${rootId}/ops/compose/pc/restart`, { service: 'worker' });
        expect(restart.status, JSON.stringify(restart.body)).toBe(200);
        expect(restart.body.command).toMatch(/compose' '-p' 'pc' '-f' '\/srv\/pc\/compose\.yaml' 'restart' 'worker'$/);
        // The provider's coloured banner reads as plain text.
        expect(restart.body.output).not.toContain('\x1b');
    });

    it('lists images with Podman\'s names and previews the dangling one', async () => {
        const { body } = await call<ImageList>('GET', `/api/servers/${rootId}/ops/images`);
        const references = body.images.map((image) => image.reference);
        expect(new Set(references).size).toBe(references.length);
        expect(references.filter((reference) => reference?.startsWith('docker.io/library/alpine:'))).toEqual(['docker.io/library/alpine:3', 'docker.io/library/alpine:latest']);
        expect(body.images.find((image) => image.reference === 'docker.io/library/alpine:3')?.containers).toBeGreaterThanOrEqual(3);
        expect(body.images.find((image) => image.reference === 'localhost/demo-app:latest')).toMatchObject({ containers: 0, dangling: false });
        expect(body.images.filter((image) => image.dangling)).toHaveLength(1);
        const preview = await call<PrunePreview>('GET', `/api/servers/${rootId}/ops/images/prune-preview?mode=dangling`);
        expect(preview.body).toMatchObject({ mode: 'dangling', estimate: 'up-to' });
        expect(preview.body.images).toHaveLength(1);
        const usage = await call<DiskUsage>('GET', `/api/servers/${rootId}/ops/disk-usage`);
        expect(usage.body.rows.map((row) => row.kind)).toEqual(['images', 'containers', 'volumes']);
        expect((await call('POST', `/api/servers/${rootId}/ops/images/prune`, { mode: 'dangling' })).status).toBe(200);
        expect((await call<ImageList>('GET', `/api/servers/${rootId}/ops/images`)).body.images.filter((image) => image.dangling)).toHaveLength(0);
    });

    it('opens a shell in a Podman container that follows resizes', async () => {
        const socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
        let text = '';
        const notices: TerminalNotice[] = [];
        socket.on('ssh-output', (data: ArrayBuffer | string) => {
            const chunk = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
            text += chunk;
            if (chunk.includes('\x1b[6n')) socket.emit('ssh-input', '\x1b[1;1R');
        });
        socket.on('terminal-notice', (notice: TerminalNotice) => notices.push(notice));
        try {
            await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
            socket.emit('start-ssh', { serverId: rootId, purpose: 'terminal', cols: 100, rows: 30, attach: { kind: 'container', engine: 'podman', container: 'lone' } });
            await waitFor(() => text.includes('# '));
            socket.emit('ssh-input', 'stty size\r');
            await waitFor(() => text.includes('30 100'));
            socket.emit('resize', { cols: 120, rows: 40 });
            await new Promise((resolve) => setTimeout(resolve, 300));
            socket.emit('ssh-input', 'stty size; exit\r');
            await waitFor(() => notices.some((notice) => notice.kind === 'session-ended'));
            expect(text).toContain('40 120');
        } finally {
            socket.disconnect();
        }
    });

    it('hangs up the shell left in a Podman container when the tab goes away', async () => {
        const leftovers = () => inside('podman exec lone ps -o args').split('\n').slice(1).map((line) => line.trim())
            .filter((line) => line && line !== 'sleep infinity' && line !== 'ps -o args');
        const socket = connect(server.baseUrl, { transports: ['websocket'], forceNew: true, reconnection: false, auth: { token: server.token } });
        let text = '';
        socket.on('ssh-output', (data: ArrayBuffer | string) => {
            const chunk = typeof data === 'string' ? data : Buffer.from(data).toString('utf8');
            text += chunk;
            if (chunk.includes('\x1b[6n')) socket.emit('ssh-input', '\x1b[1;1R');
        });
        try {
            await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
            socket.emit('start-ssh', { serverId: rootId, purpose: 'terminal', cols: 100, rows: 30, attach: { kind: 'container', engine: 'podman', container: 'lone' } });
            await waitFor(() => text.includes('# '));
            socket.emit('ssh-input', 'top -b -d 5 >/dev/null & sleep 1000\r');
            await waitFor(() => leftovers().includes('sleep 1000'));
        } finally {
            socket.disconnect();
        }
        await waitFor(() => leftovers().length === 0, 20_000);
        const ended = async () => (await call<{ data: Array<{ meta?: Record<string, unknown> }> }>('GET', '/api/audit?source=ops')).body.data
            .find((item) => item.meta?.action === 'shell-end');
        await waitFor(async () => Boolean(await ended()));
        expect(await ended()).toMatchObject({ meta: { engine: 'podman', target: 'lone', processes: 3 } });
    });
});
