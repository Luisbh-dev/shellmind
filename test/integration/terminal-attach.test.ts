import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import { Server, type ServerChannel } from 'ssh2';
import type { TerminalAttach } from '../../shared/protocol';
import type { ConnectionError, TerminalNotice } from '../../shared/terminal';
import type { AuditEntry } from '../../shared/types';
import { startFakeAgent, type FakeAgent } from '../helpers/fakeAgent';
import { createOpsHost, sections, type OpsHost } from '../helpers/opsHost';
import { generateKeyPair } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// W7-S3: a terminal session inside a container (start-ssh `attach`). The SSH
// server here records the pty and the window changes of the exec channel
// that runs `<engine> exec -it`, and plays a container shell on it.

vi.setConfig({ testTimeout: 30_000 });

const LINUX_CAPS = sections({ uid: '1000', sudo: 'yes', systemd: 'yes', journal: 'yes', docker: 'sudo 26.1.4', podman: '', compose: 'yes' });

type Pty = { cols: number; rows: number; term: string };

let server: TestServer;
let host: OpsHost;
let sshd: Server;
let port = 0;
let linuxId: number;
// What the fake `docker inspect --format {{.State.Status}}` prints per container.
const states: Record<string, string> = { 'web-1': 'running', idle: 'exited' };
// Exec channels opened, with the pty they asked for and their window changes.
const execs: Array<{ command: string; pty: Pty | null; windows: Array<{ cols: number; rows: number }> }> = [];
const sockets: Socket[] = [];
// Agent forwarding requests (W7-S2), by the kind of channel they came on.
const agentRequests: string[] = [];
let agent: FakeAgent;

// A container's shell: a prompt, each line answered, `exit` ends it.
function containerShell(channel: ServerChannel, record: (typeof execs)[number]) {
    channel.write('/ # ');
    let line = '';
    channel.on('data', (data: Buffer) => {
        for (const char of data.toString('utf8')) {
            if (char !== '\r') {
                line += char;
                continue;
            }
            if (line === 'exit') {
                channel.exit(0);
                channel.end();
                return;
            }
            const size = record.windows.at(-1) ?? record.pty;
            channel.write(line === 'size' ? `\r\n${size?.rows} ${size?.cols}\r\n/ # ` : `\r\nran: ${line}\r\n/ # `);
            line = '';
        }
    });
}

async function startServer(): Promise<void> {
    sshd = new Server({ hostKeys: [generateKeyPair().privateKey] }, (client) => {
        client.on('error', () => undefined);
        client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.password === 'secret' ? ctx.accept() : ctx.reject(['password'])));
        client.on('ready', () => client.on('session', (accept) => {
            const session = accept();
            let pty: Pty | null = null;
            let record: (typeof execs)[number] | null = null;
            session.on('pty', (acceptPty, _reject, info) => {
                // ssh2 passes the terminal type; its typings leave it out.
                pty = { cols: info.cols, rows: info.rows, term: (info as typeof info & { term: string }).term };
                acceptPty?.();
            });
            session.on('auth-agent', (acceptForward) => {
                agentRequests.push(record ? 'exec' : 'session');
                acceptForward?.();
            });
            // A login shell (the server's own, not a container's).
            session.on('shell', (acceptShell) => acceptShell().write('$ '));
            session.on('window-change', (acceptChange, _reject, info) => {
                record?.windows.push({ cols: info.cols, rows: info.rows });
                acceptChange?.();
            });
            session.on('exec', (acceptExec, _reject, info) => {
                const channel = acceptExec();
                record = { command: info.command, pty, windows: [] };
                execs.push(record);
                if (info.command.includes("'exec' '-it'")) {
                    containerShell(channel, record);
                    return;
                }
                if (!host.exec(info.command, channel)) {
                    channel.exit(127);
                    channel.end();
                }
            });
        }));
    });
    await new Promise<void>((resolve) => sshd.listen(0, '127.0.0.1', resolve));
    port = (sshd.address() as net.AddressInfo).port;
}

async function save(body: Record<string, unknown>): Promise<number> {
    const res = await server.fetch('/api/servers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

type Session = { socket: Socket; output: () => string; notices: TerminalNotice[]; errors: ConnectionError[] };

async function openTerminal(serverId: number, attach: unknown, size = { cols: 120, rows: 40 }): Promise<Session> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    let text = '';
    const notices: TerminalNotice[] = [];
    const errors: ConnectionError[] = [];
    socket.on('ssh-output', (data: ArrayBuffer | string) => { text += typeof data === 'string' ? data : Buffer.from(data).toString('utf8'); });
    socket.on('terminal-notice', (notice: TerminalNotice) => notices.push(notice));
    socket.on('ssh-error', (_message: string, error: ConnectionError) => errors.push(error));
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    socket.emit('start-ssh', { serverId, purpose: 'terminal', ...size, attach });
    return { socket, output: () => text, notices, errors };
}

async function auditEntries(): Promise<AuditEntry[]> {
    const res = await server.fetch('/api/audit?source=ops');
    return ((await res.json()) as { data: AuditEntry[] }).data;
}

const shellExecs = () => execs.filter((entry) => entry.command.includes("'exec' '-it'"));
const hangUps = () => host.scripts.filter((entry) => entry.script.includes('hung-up')).map((entry) => entry.script);
const tagOf = (command: string) => /'SHELLMIND_TERMINAL=([a-f0-9]{32})'/.exec(command)?.[1];

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    host = createOpsHost();
    host.respond((script) => {
        if (script.includes('m uid')) return { stdout: LINUX_CAPS };
        const inspect = /'inspect' '--type' 'container' '--format' '\{\{\.State\.Status\}\}' '([^']+)'/.exec(script);
        if (inspect) {
            const state = states[inspect[1]];
            return state ? { stdout: `${state}\n` } : { stdout: `Error response from daemon: No such container: ${inspect[1]}\n`, code: 1 };
        }
        // Hanging up a terminal's shell (and two of its jobs).
        if (script.includes('hung-up')) return { stdout: 'hung-up 3\n' };
        return undefined;
    });
    await startServer();
    agent = await startFakeAgent([generateKeyPair().privateKey]);
    server = await bootTestServer({ env: { SHELLMIND_SSH_AGENT: agent.path } });
    linuxId = await save({ name: 'docker-host', ip: '127.0.0.1', port, type: 'linux', username: 'tester', password: 'secret' });
});

afterEach(async () => {
    while (sockets.length) sockets.pop()?.disconnect();
    // The shells those sockets left are hung up in the background.
    await new Promise((resolve) => setTimeout(resolve, 200));
    execs.length = 0;
    host.scripts.length = 0;
});

afterAll(async () => {
    await server?.close();
    await new Promise<void>((resolve) => sshd?.close(() => resolve()));
    await agent?.close();
    vi.restoreAllMocks();
});

describe('terminal sessions inside a container', () => {
    // W7 integration (S2 + S3): the agent is forwarded to the server's own
    // shells that ask for it, never into a container.
    it('never asks for agent forwarding on a container shell, even on a server that forwards the agent', async () => {
        const res = await server.fetch('/api/identities', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'agent-attach', use_agent: true }) });
        const identityId = ((await res.json()) as { data: { id: number } }).data.id;
        const forwarding = await save({ name: 'docker-forwarding', ip: '127.0.0.1', port, type: 'linux', username: 'tester', password: 'secret', identity_id: identityId, agent_forward: true });
        agentRequests.length = 0;

        const inContainer = await openTerminal(forwarding, { kind: 'container', engine: 'docker', container: 'web-1' });
        await vi.waitFor(() => expect(inContainer.output()).toContain('/ # '));
        expect(shellExecs()).toHaveLength(1);
        expect(agentRequests).toEqual([]);

        // The same server's login shell does ask: the setup forwards at all.
        const login = await openTerminal(forwarding, undefined);
        await vi.waitFor(() => expect(login.output()).toContain('$ '));
        expect(agentRequests).toEqual(['session']);
    });

    it('runs `docker exec -it` on a pty of the pooled connection, follows resizes and ends with the shell', async () => {
        const attach: TerminalAttach = { kind: 'container', engine: 'docker', container: 'web-1' };
        const term = await openTerminal(linuxId, attach);
        await new Promise<void>((resolve) => term.socket.once('connection-ready', () => resolve()));
        await vi.waitFor(() => expect(term.output()).toContain('/ # '));

        const [shell] = shellExecs();
        expect(shell.command).toMatch(/^sudo -n docker 'exec' '-it' '-e' 'SHELLMIND_TERMINAL=[a-f0-9]{32}' 'web-1' 'sh' '-c' 'command -v bash >\/dev\/null 2>&1 && exec bash; exec sh'$/);
        expect(shell.pty).toEqual({ cols: 120, rows: 40, term: 'xterm-256color' });
        // The container was checked first; no OS probe runs for a container's shell.
        expect(execs.map((entry) => entry.command)).toEqual(['sh -s', 'sh -s', shell.command]);

        term.socket.emit('ssh-input', 'hello\r');
        await vi.waitFor(() => expect(term.output()).toContain('ran: hello'));
        term.socket.emit('resize', { cols: 100, rows: 30 });
        await vi.waitFor(() => expect(shell.windows).toEqual([{ cols: 100, rows: 30 }]));
        term.socket.emit('ssh-input', 'size\r');
        await vi.waitFor(() => expect(term.output()).toContain('30 100'));

        expect((await auditEntries())[0]).toMatchObject({
            server_id: linuxId,
            command: shell.command,
            meta: { kind: 'container', action: 'shell', target: 'web-1', engine: 'docker', shell: 'auto' },
        });

        const closed = new Promise<void>((resolve) => term.socket.once('ssh-closed', () => resolve()));
        term.socket.emit('ssh-input', 'exit\r');
        await closed;
        expect(term.notices.map((notice) => notice.kind)).toEqual(['connected', 'session-ended']);
        // The shell exited by itself: there is nothing to hang up.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(hangUps()).toEqual([]);
    });

    it('opens the shell asked for', async () => {
        const term = await openTerminal(linuxId, { kind: 'container', engine: 'docker', container: 'web-1', shell: '/bin/ash' });
        await vi.waitFor(() => expect(term.output()).toContain('/ # '));
        expect(shellExecs()[0].command).toMatch(/^sudo -n docker 'exec' '-it' '-e' 'SHELLMIND_TERMINAL=[a-f0-9]{32}' 'web-1' '\/bin\/ash'$/);
    });

    it('hangs up the shell in the container when the tab goes away or reconnects, audited', async () => {
        const attach: TerminalAttach = { kind: 'container', engine: 'docker', container: 'web-1' };
        const closedTab = await openTerminal(linuxId, attach);
        await vi.waitFor(() => expect(closedTab.output()).toContain('/ # '));
        const reconnected = await openTerminal(linuxId, attach);
        await vi.waitFor(() => expect(reconnected.output()).toContain('/ # '));
        const [first, second] = shellExecs().map((entry) => tagOf(entry.command));
        expect(first).toBeDefined();
        expect(second).not.toBe(first);

        // Closing the tab: the socket goes, the engine would keep the shell.
        closedTab.socket.disconnect();
        await vi.waitFor(() => expect(hangUps()).toHaveLength(1));
        expect(hangUps()[0]).toContain(`sudo -n docker 'exec' 'web-1' 'sh' '-c'`);
        expect(hangUps()[0]).toContain(`SHELLMIND_TERMINAL=${first}`);

        // Reconnecting a tab replaces its session: the old shell is hung up too.
        reconnected.socket.emit('start-ssh', { serverId: linuxId, purpose: 'terminal', cols: 120, rows: 40, attach });
        await vi.waitFor(() => expect(hangUps()).toHaveLength(2));
        expect(hangUps()[1]).toContain(`SHELLMIND_TERMINAL=${second}`);
        await vi.waitFor(() => expect(shellExecs()).toHaveLength(3));

        await vi.waitFor(async () => {
            const ends = (await auditEntries()).filter((entry) => entry.meta?.action === 'shell-end' && [first, second].some((tag) => entry.command.includes(`${tag}`)));
            expect(ends).toHaveLength(2);
            expect(ends[0]).toMatchObject({
                server_id: linuxId,
                exit_code: 0,
                command: expect.stringContaining("sudo -n docker 'exec' 'web-1' 'sh' '-c'"),
                meta: { kind: 'container', target: 'web-1', engine: 'docker', processes: 3 },
            });
        });
    });

    it('refuses a stopped or unknown container before opening a terminal', async () => {
        for (const [container, code, details] of [
            ['idle', 'CONTAINER_NOT_RUNNING', { container: 'idle', state: 'exited' }],
            ['ghost', 'CONTAINER_NOT_FOUND', { container: 'ghost' }],
        ] as const) {
            const term = await openTerminal(linuxId, { kind: 'container', engine: 'docker', container });
            await vi.waitFor(() => expect(term.errors).toHaveLength(1));
            expect(term.errors[0]).toMatchObject({ code, details });
        }
        expect(shellExecs()).toEqual([]);
    });

    it('refuses an invalid attachment, another engine and servers without a Linux SSH shell', async () => {
        const invalid = await openTerminal(linuxId, { kind: 'container', engine: 'docker', container: "web-1'; reboot; '" });
        await vi.waitFor(() => expect(invalid.errors).toHaveLength(1));
        expect(invalid.errors[0]).toMatchObject({ code: 'INVALID_ATTACH' });

        const podman = await openTerminal(linuxId, { kind: 'container', engine: 'podman', container: 'web-1' });
        await vi.waitFor(() => expect(podman.errors).toHaveLength(1));
        expect(podman.errors[0]).toMatchObject({ code: 'CONTAINER_ENGINE_MISMATCH', details: { engine: 'docker', requested: 'podman' } });

        const localId = await save({ name: 'local', type: 'local' });
        const local = await openTerminal(localId, { kind: 'container', engine: 'docker', container: 'web-1' });
        await vi.waitFor(() => expect(local.errors).toHaveLength(1));
        expect(local.errors[0]).toMatchObject({ code: 'CONTAINER_SHELL_UNSUPPORTED' });

        const windowsId = await save({ name: 'win', ip: '127.0.0.1', port: null, ssh_port: port, type: 'windows', username: 'tester', password: 'secret' });
        const windows = await openTerminal(windowsId, { kind: 'container', engine: 'docker', container: 'web-1' });
        await vi.waitFor(() => expect(windows.errors).toHaveLength(1));
        expect(windows.errors[0]).toMatchObject({ code: 'CONTAINER_SHELL_UNSUPPORTED' });
        expect(shellExecs()).toEqual([]);
    });
});
