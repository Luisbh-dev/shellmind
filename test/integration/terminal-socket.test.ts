import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { ServerChannel } from 'ssh2';
import type { HostKeyMismatchPayload } from '../../shared/protocol';
import type { TrustHostKeyResult } from '../../shared/terminal';
import { HARNESS_PROMPT, startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// Terminal sessions end to end: several tabs per server, spare connections
// past sshd's MaxSessions, UTF-8 safe and batched output, flow control, and
// trusting a changed host key.

vi.setConfig({ testTimeout: 30_000 });

const FLOOD_BYTES = 4 * 1024 * 1024;
const UTF8_SAMPLE = 'ñ á 漢字 ✓ — €';

// A shell with a few test commands: `utf8` (multibyte characters split in
// single bytes), `many` (2000 tiny writes), `flood` (4 MiB, then DONE).
function scriptedShell(channel: ServerChannel): boolean {
    channel.write('scripted$ ');
    let line = '';
    channel.on('data', (data: Buffer) => {
        for (const char of data.toString('utf8')) {
            if (char !== '\r') {
                line += char;
                continue;
            }
            const command = line.trim();
            line = '';
            if (command === 'utf8') {
                const bytes = Buffer.from(`${UTF8_SAMPLE}\r\n`, 'utf8');
                for (let i = 0; i < bytes.length; i++) channel.write(bytes.subarray(i, i + 1));
            } else if (command === 'many') {
                for (let i = 0; i < 2000; i++) channel.write(`${i}\r\n`);
                channel.write('MANY-END\r\n');
            } else if (command === 'flood') {
                const chunk = Buffer.alloc(16 * 1024, 'x');
                let sent = 0;
                const pump = () => {
                    while (sent < FLOOD_BYTES) {
                        sent += chunk.length;
                        if (!channel.write(chunk)) {
                            channel.once('drain', pump);
                            return;
                        }
                    }
                    channel.write('\r\nDONE\r\n');
                };
                pump();
            } else if (command === 'endless') {
                // `yes` until Ctrl+C, then how much it printed.
                endless(channel);
                return;
            }
            channel.write('scripted$ ');
        }
    });
    return true;
}

function endless(channel: ServerChannel): void {
    const chunk = Buffer.alloc(16 * 1024, 'x');
    let sent = 0;
    let interrupted = false;
    const onInput = (data: Buffer) => {
        if (!data.includes(0x03) || interrupted) return;
        interrupted = true;
        channel.off('data', onInput);
        channel.write(`^C\r\nINTERRUPTED after ${sent} bytes\r\nscripted$ `);
    };
    channel.on('data', onInput);
    const pump = () => {
        while (!interrupted) {
            sent += chunk.length;
            if (!channel.write(chunk)) {
                channel.once('drain', pump);
                return;
            }
        }
    };
    pump();
}

let server: TestServer;
let limited: SshHarness;
let scripted: SshHarness;
const sockets: Socket[] = [];

function open(): Socket {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    return socket;
}

type Session = { socket: Socket; events: string[]; text: () => string; bytes: () => number; binary: () => boolean; os: () => string | null };

async function startSession(serverId: number, purpose: 'terminal' | 'files'): Promise<Session> {
    const socket = open();
    const events: string[] = [];
    let bytes = 0;
    let binary = true;
    let os: string | null = null;
    // Binary messages, each ending on a character boundary.
    socket.on('ssh-output', (chunk: Buffer | string) => {
        if (typeof chunk === 'string') binary = false;
        bytes += typeof chunk === 'string' ? chunk.length : chunk.length;
        events.push(chunk.toString());
    });
    socket.on('os-detected', (name: string) => {
        os = name;
    });
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    const ready = new Promise<void>((resolve, reject) => {
        socket.once('connection-ready', () => resolve());
        socket.once('ssh-error', (message: string) => reject(new Error(message)));
    });
    socket.emit('start-ssh', { serverId, purpose, cols: 100, rows: 30 });
    await ready;
    return { socket, events, text: () => events.join(''), bytes: () => bytes, binary: () => binary, os: () => os };
}

const startTerminal = (serverId: number) => startSession(serverId, 'terminal');

async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

async function saveServer(target: SshHarness): Promise<number> {
    const res = await server.fetch('/api/servers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: `t-${target.port}`, ip: target.host, port: target.port, type: 'linux', username: 'tester', password: 'secret' }),
    });
    return ((await res.json()) as { data: { id: number } }).data.id;
}

beforeAll(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    limited = await startSshServer({ maxSessions: 2 });
    scripted = await startSshServer({ shell: scriptedShell });
});

afterEach(() => {
    while (sockets.length) sockets.pop()?.disconnect();
});

afterAll(async () => {
    await server?.close();
    await limited?.close();
    await scripted?.close();
    vi.restoreAllMocks();
});

describe('terminal tabs', () => {
    it('opens more tabs than the server allows sessions per connection on spare pooled connections', async () => {
        const id = await saveServer(limited);
        const { sshPool } = await import('../../server/ssh/pool');
        const before = limited.connections();

        // One at a time, so the order of refusals is deterministic.
        const tabs = [];
        for (let i = 0; i < 4; i++) tabs.push(await startTerminal(id));

        // 2 sessions per connection (the OS probe exec also needs one now and then).
        expect(limited.connections() - before).toBeGreaterThanOrEqual(2);
        // A tab's OS probe runs after the tab is ready and, when the tab's
        // connection has no session left, borrows a spare connection until it
        // ends (a fifth lease, seen under load). With every probe answered,
        // only the four tabs hold a lease.
        for (const [index, tab] of tabs.entries()) await until(() => tab.os() !== null, `the OS probe of tab ${index}`);
        expect(sshPool.inspect(id).refs).toBe(4);

        for (const [index, tab] of tabs.entries()) {
            tab.socket.emit('ssh-input', `tab ${index}\r`);
            await until(() => tab.text().includes(`you typed: tab ${index}`), `tab ${index} to echo`);
        }

        for (const tab of tabs) tab.socket.disconnect();
        await until(() => sshPool.inspect(id).refs === 0, 'every lease to be released');
    });

    it('leaves the exec, stream and SFTP slots of a connection free however many tabs are open', async () => {
        // OpenSSH's default MaxSessions; `hold` commands run until released.
        const held: ServerChannel[] = [];
        const busy = await startSshServer({
            maxSessions: 10,
            exec: (command, channel) => {
                if (command !== 'hold') return false;
                held.push(channel);
                return true;
            },
        });
        try {
            const id = await saveServer(busy);
            const { sshPool } = await import('../../server/ssh/pool');
            const { exec, execStream, MAX_EXEC_CHANNELS, MAX_STREAM_CHANNELS } = await import('../../server/ssh/exec');
            const { MAX_SHELLS_PER_CONNECTION, MAX_SHELLS_PER_SPARE } = await import('../../server/sockets/terminal');
            expect(MAX_SHELLS_PER_CONNECTION).toBe(2);
            expect(MAX_SHELLS_PER_SPARE).toBe(9);

            const tabs = [];
            for (let i = 0; i < 5; i++) tabs.push(await startTerminal(id));
            await startSession(id, 'files');
            expect(busy.log).toContain('sftp');
            // Two shells on the server's connection, the other three share one
            // spare (which carries no exec, stream or SFTP channels).
            expect(busy.connections()).toBe(2);

            // Status, ops and log streams on the server's connection still get
            // every channel they count on.
            const lease = await sshPool.acquire(id);
            const failures: unknown[] = [];
            const running = [
                ...Array.from({ length: MAX_EXEC_CHANNELS }, () => exec(lease, 'hold', { timeoutMs: 20_000 })),
                ...Array.from({ length: MAX_STREAM_CHANNELS }, () => execStream(lease, 'hold', { onData: () => undefined, timeoutMs: 20_000 })),
            ].map((promise) => promise.catch((err: unknown) => { failures.push(err); }));
            try {
                await until(() => held.length === MAX_EXEC_CHANNELS + MAX_STREAM_CHANNELS || failures.length > 0, 'every exec and stream channel');
                expect(failures).toEqual([]);
            } finally {
                for (const channel of held) {
                    channel.exit(0);
                    channel.end();
                }
                await Promise.all(running);
                lease.release();
            }

            for (const [index, tab] of tabs.entries()) {
                tab.socket.emit('ssh-input', `tab ${index}\r`);
                await until(() => tab.text().includes(`you typed: tab ${index}`), `tab ${index} to echo`);
            }
        } finally {
            while (sockets.length) sockets.pop()?.disconnect();
            await busy.close();
        }
    });

    it('opens the file session on a spare connection when the server refuses another channel', async () => {
        // A server of its own: idle connections the other tests left in the
        // pool would take the file session. With MaxSessions 1 the shell alone
        // fills the connection, whenever the OS probe exec (refused there too)
        // happens to run.
        const single = await startSshServer({ maxSessions: 1 });
        try {
            const id = await saveServer(single);
            const { sshPool } = await import('../../server/ssh/pool');
            await startTerminal(id);
            expect(single.connections()).toBe(1);

            await startSession(id, 'files');
            expect(single.log).toContain('sftp');
            // The OS probe, refused on the shell's connection too, runs on a
            // spare of its own (exec moves to one like the file session), so
            // a third connection may come and stay idle: count the leases.
            await until(() => sshPool.inspect(id)?.refs === 2, 'the OS probe to give its leases back');
            expect(single.connections()).toBeGreaterThanOrEqual(2);
            expect(sshPool.inspect(id)?.connections).toBeGreaterThanOrEqual(2);
        } finally {
            while (sockets.length) sockets.pop()?.disconnect();
            await single.close();
        }
    });
});

describe('trusting a changed host key', () => {
    const OLD = `SHA256:${'A'.repeat(43)}`;

    async function mismatch(id: number) {
        const socket = open();
        await new Promise<void>((resolve) => socket.once('connect', () => resolve()));
        const changed = new Promise<HostKeyMismatchPayload>((resolve) => socket.once('host-key-mismatch', resolve));
        socket.emit('start-ssh', { serverId: id, purpose: 'terminal' });
        return { socket, changed: await changed };
    }

    function trust(socket: Socket, payload: object): Promise<TrustHostKeyResult> {
        return new Promise((resolve) => socket.emit('trust-host-key', payload, resolve));
    }

    it('replaces the pinned key by exactly the confirmed one, without trusting on first use again', async () => {
        const target = await startSshServer();
        try {
            const id = await saveServer(target);
            const { knownHostsRepo } = await import('../../server/db/knownHostsRepo');
            await knownHostsRepo.pin({ host: target.host, port: target.port, key_type: 'ssh-ed25519', fingerprint: OLD });

            const { socket, changed } = await mismatch(id);
            expect(changed).toMatchObject({ expected: OLD, actual: target.fingerprint });
            const request = { serverId: id, host: target.host, port: target.port, keyType: changed.keyType, expected: OLD, actual: target.fingerprint };

            // Refused: not on the route, another key than the one presented, nonsense.
            expect(await trust(socket, { ...request, host: '10.9.9.9' })).toMatchObject({ ok: false, code: 'NOT_ON_ROUTE' });
            expect(await trust(socket, { ...request, expected: `SHA256:${'B'.repeat(43)}` })).toMatchObject({ ok: false, code: 'HOST_KEY_CHANGED' });
            expect(await trust(socket, { ...request, actual: 'whatever' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
            expect((await knownHostsRepo.find(target.host, target.port))?.fingerprint).toBe(OLD);

            expect(await trust(socket, request)).toEqual({ ok: true });
            expect((await knownHostsRepo.find(target.host, target.port))?.fingerprint).toBe(target.fingerprint);
            // A second tab trusting the same change is fine.
            expect(await trust(socket, request)).toEqual({ ok: true });

            const trusted: unknown[] = [];
            const tab = open();
            tab.on('host-key-trusted', (info: unknown) => trusted.push(info));
            await new Promise<void>((resolve) => tab.once('connect', () => resolve()));
            const ready = new Promise<void>((resolve) => tab.once('connection-ready', () => resolve()));
            tab.emit('start-ssh', { serverId: id, purpose: 'terminal' });
            await ready;
            expect(trusted).toEqual([]);
        } finally {
            await target.close();
        }
    });
});

describe('terminal output', () => {
    it('keeps multibyte characters that arrive split across packets intact', async () => {
        const id = await saveServer(scripted);
        const tab = await startTerminal(id);
        await until(() => tab.text().includes('scripted$ '), 'the prompt');
        tab.socket.emit('ssh-input', 'utf8\r');
        await until(() => tab.text().includes(UTF8_SAMPLE), 'the UTF-8 sample');
        expect(tab.text()).not.toContain('�');
    });

    it('batches many small writes into few messages', async () => {
        const id = await saveServer(scripted);
        const tab = await startTerminal(id);
        await until(() => tab.text().includes('scripted$ '), 'the prompt');
        const before = tab.events.length;
        tab.socket.emit('ssh-input', 'many\r');
        await until(() => tab.text().includes('MANY-END'), 'the end marker');
        expect(tab.text()).toContain('1999\r\n');
        expect(tab.events.length - before).toBeLessThan(40);
    });

    it('sends the output as binary messages', async () => {
        const id = await saveServer(scripted);
        const tab = await startTerminal(id);
        await until(() => tab.text().includes('scripted$ '), 'the prompt');
        expect(tab.binary()).toBe(true);
        expect(tab.bytes()).toBe(Buffer.byteLength(tab.text()));
    });

    it('pauses the shell while the client does not acknowledge and loses nothing', async () => {
        const id = await saveServer(scripted);
        const tab = await startTerminal(id);
        await until(() => tab.text().includes('scripted$ '), 'the prompt');
        // Everything so far is written; this also turns flow control on.
        tab.socket.emit('ssh-ack', tab.bytes());
        const start = tab.bytes();

        tab.socket.emit('ssh-input', 'flood\r');
        await until(() => tab.bytes() - start > 100_000, 'the first part of the flood');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const stalled = tab.bytes() - start;
        // 128 KiB unacknowledged, plus what was already in flight.
        expect(stalled).toBeLessThan(500_000);
        expect(tab.text()).not.toContain('DONE');

        let acked = start;
        const ackAll = () => {
            const total = tab.bytes();
            if (total > acked) tab.socket.emit('ssh-ack', total - acked);
            acked = total;
        };
        const timer = setInterval(ackAll, 10);
        try {
            ackAll();
            await until(() => tab.text().includes('DONE'), 'the end of the flood', 25_000);
        } finally {
            clearInterval(timer);
        }
        expect(tab.text().split('x').length - 1).toBe(FLOOD_BYTES);
    });

    it('echoes a keystroke without waiting for the batch timer (perf-terminal-echo)', async () => {
        const plain = await startSshServer();
        // A batch timer long enough to tell the two apart whatever the load
        // (the echo used to wait for it: 16-31 ms on Windows).
        const { TERMINAL_OUTPUT_DEFAULTS } = await import('../../server/sockets/terminalOutput');
        const flushMs = TERMINAL_OUTPUT_DEFAULTS.flushMs;
        TERMINAL_OUTPUT_DEFAULTS.flushMs = 400;
        try {
            const id = await saveServer(plain);
            const tab = await startTerminal(id);
            await until(() => tab.text().includes(HARNESS_PROMPT), 'the prompt');
            const samples: number[] = [];
            for (const key of 'abc') {
                // A pause between keystrokes, as when typing.
                await new Promise((resolve) => setTimeout(resolve, 500));
                const before = tab.text().length;
                const sentAt = performance.now();
                tab.socket.emit('ssh-input', key);
                await until(() => tab.text().length > before, `the echo of ${key}`);
                samples.push(performance.now() - sentAt);
            }
            expect(Math.max(...samples)).toBeLessThan(200);
        } finally {
            TERMINAL_OUTPUT_DEFAULTS.flushMs = flushMs;
            await plain.close();
        }
    });

    it('drops the output held back during a flood on Ctrl+C, and only that (perf-ctrlc-backlog)', async () => {
        const id = await saveServer(scripted);
        const tab = await startTerminal(id);
        const notices: Array<{ kind: string; bytes?: number }> = [];
        tab.socket.on('terminal-notice', (notice: { kind: string; bytes?: number }) => notices.push(notice));
        await until(() => tab.text().includes('scripted$ '), 'the prompt');
        tab.socket.emit('ssh-ack', tab.bytes());
        const start = tab.bytes();

        tab.socket.emit('ssh-input', 'endless\r');
        // The client lags: the output stalls once the backend paused the shell.
        await until(() => tab.bytes() - start > 100_000, 'the flood');
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const beforeInterrupt = tab.bytes();

        tab.socket.emit('ssh-input', '\x03');
        let acked = start;
        const timer = setInterval(() => {
            const total = tab.bytes();
            if (total > acked) tab.socket.emit('ssh-ack', total - acked);
            acked = total;
        }, 10);
        try {
            await until(() => /INTERRUPTED after \d+ bytes/.test(tab.text()), 'the prompt after Ctrl+C');
        } finally {
            clearInterval(timer);
        }

        const dropped = notices.find((notice) => notice.kind === 'output-discarded');
        expect(dropped?.bytes).toBeGreaterThan(256 * 1024);
        // Nothing else is lost: what arrived plus what was dropped is what the shell printed.
        const printed = Number(/INTERRUPTED after (\d+) bytes/.exec(tab.text())![1]);
        const received = tab.text().split('x').length - 1;
        expect(received + dropped!.bytes!).toBe(printed);
        // What still arrived after the interrupt was only what was in flight.
        expect(tab.bytes() - beforeInterrupt).toBeLessThan(printed - (beforeInterrupt - start));
    });

    it('still serves clients that never acknowledge', async () => {
        const id = await saveServer(scripted);
        const tab = await startTerminal(id);
        await until(() => tab.text().includes('scripted$ '), 'the prompt');
        tab.socket.emit('ssh-input', 'flood\r');
        await until(() => tab.text().includes('DONE'), 'the end of the flood', 25_000);
    });

    it('answers ordinary typing in the default harness shell', async () => {
        const plain = await startSshServer();
        try {
            const id = await saveServer(plain);
            const tab = await startTerminal(id);
            await until(() => tab.text().includes(HARNESS_PROMPT), 'the prompt');
            tab.socket.emit('ssh-input', 'héllo wörld\r');
            await until(() => tab.text().includes('you typed: héllo wörld'), 'the echo');
        } finally {
            await plain.close();
        }
    });
});
