import type { ServerChannel } from 'ssh2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { LogChunkPayload, LogEndPayload } from '../../shared/ops';
import { createOpsHost } from './opsHost';
import { startSshServer, type SshHarness } from './sshServer';
import { bootTestServer, type TestServer } from './testServer';

// How a PowerShell script reaches a Windows server, over the SSH harness: by
// default on the stdin of a fixed `powershell ... -Command -` (closed after
// a one-off script, left open under a log stream, which watches it), with
// SHELLMIND_POWERSHELL_DELIVERY=encoded as -EncodedCommand. Each mode is a
// test file of its own (test/integration/powershell-delivery*.test.ts): the
// backend reads the setting once.

const STDIN_COMMAND = 'powershell -NoProfile -NonInteractive -Command -';
const WINDOWS_REPORT = JSON.stringify({
    host: 'WIN-SRV01', os: 'Microsoft Windows Server 2025 Standard', ver: '10.0.26100', up: 3600, cores: 2,
    mem: { t: 4194304, f: 2097152, st: 0, sf: 0 }, cpu: { i: 5000000, s: 10000000 }, el: 10000000,
    disks: [{ n: 'C:', fs: 'NTFS', s: 107374182400, f: 53687091200 }], net: [], procs: [], users: 0,
});
// A log path outside ASCII: it reaches the script as [char] codes.
const LOG_PATH = 'C:\\Registros\\aplicaci\u00f3n.log';

type Channel = { command: string; stdin: string; ended: boolean; closed: boolean };

async function until(check: () => boolean, timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs;
    while (!check()) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

export function describePowerShellDelivery(mode: 'stdin' | 'encoded'): void {
    vi.setConfig({ testTimeout: 20_000 });

    let server: TestServer;
    let harness: SshHarness;
    let windowsId: number;
    const host = createOpsHost();
    const channels: Channel[] = [];
    const sockets: Socket[] = [];

    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        server = await bootTestServer({ env: mode === 'encoded' ? { SHELLMIND_POWERSHELL_DELIVERY: 'encoded' } : {} });
        host.respond((script) => {
            if (script.includes('Win32_PerfRawData_PerfOS_Processor')) return { stdout: `${WINDOWS_REPORT}\r\n` };
            if (script.includes('docker=$null;compose=$false')) return { stdout: '{"admin":true,"docker":null,"compose":false}' };
            return undefined;
        });
        host.stream((script) => (script.includes("Get-Content -LiteralPath ('C:\\Registros\\aplicaci'+[char]0x00f3+'n.log') -Wait") ? { lines: ['started'], intervalMs: 30 } : undefined));
        harness = await startSshServer({
            exec: (command: string, channel: ServerChannel) => {
                if (command.startsWith('powershell ')) {
                    const entry: Channel = { command, stdin: '', ended: false, closed: false };
                    channels.push(entry);
                    channel.on('data', (chunk: Buffer) => { entry.stdin += chunk.toString('utf8'); });
                    channel.on('end', () => { entry.ended = true; });
                    channel.on('close', () => { entry.closed = true; });
                }
                return host.exec(command, channel);
            },
        });
        const res = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'delivery-win', ip: harness.host, ssh_port: harness.port, type: 'windows', username: 'tester', password: 'secret' }),
        });
        windowsId = ((await res.json()) as { data: { id: number } }).data.id;
    });

    afterAll(async () => {
        for (const socket of sockets) socket.disconnect();
        await server?.close();
        await harness?.close();
        vi.restoreAllMocks();
    });

    describe(`PowerShell delivery (${mode})`, () => {
        it('sends a one-off script and closes its stdin', async () => {
            const res = await server.fetch(`/api/servers/${windowsId}/status`);
            expect(res.status).toBe(200);
            expect(channels).toHaveLength(1);
            const [status] = channels;
            if (mode === 'encoded') {
                expect(status.command).toMatch(/^powershell -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/);
                expect(status.stdin).toBe('');
            } else {
                expect(status.command).toBe(STDIN_COMMAND);
                expect(status.stdin).toMatch(/^& \{\n[\s\S]*Win32_PerfRawData_PerfOS_Processor[\s\S]*\nif\(-not \$\?\)\{exit 1\}\n\}\n\n$/);
            }
            expect(status.ended).toBe(true);
        });

        it('keeps the stdin of a log stream open until the stream is stopped', async () => {
            const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
            sockets.push(socket);
            let text = '';
            socket.on('logs-chunk', (payload: LogChunkPayload, ack: () => void) => {
                text += payload.data;
                ack();
            });
            socket.emit('logs-start', { id: 'd1', serverId: windowsId, source: { kind: 'file', path: LOG_PATH } });
            await until(() => text.includes('started'));
            const stream = channels.find((entry) => !entry.closed);
            expect(stream).toBeDefined();
            expect(stream!.ended).toBe(false);
            if (mode === 'encoded') {
                expect(stream!.command).toMatch(/ -EncodedCommand /);
                expect(stream!.stdin).toBe('');
            } else {
                expect(stream!.command).toBe(STDIN_COMMAND);
                expect(stream!.stdin).toContain('[Console]::OpenStandardInput()');
            }
            const ended = new Promise<LogEndPayload>((resolve) => socket.once('logs-end', resolve));
            socket.emit('logs-stop', { id: 'd1' });
            expect(await ended).toEqual({ id: 'd1', code: null });
            await until(() => stream!.closed);
        });
    });
}
