import { execFileSync, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ChatEvidence, ChatEvidenceResponse } from '../../shared/chat';
import { jsonReply, startAnthropicMock, type AnthropicMock } from '../helpers/anthropicMock';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// AI diagnosis evidence end to end against a real sshd and busybox userland
// in Docker (opt-in: SHELLMIND_E2E=1), with the stand-in systemctl,
// journalctl and docker of the operations image (test/fixtures/ops/e2e):
// every evidence script, its quoting and sudo -n run for real. The model is
// the in-process Anthropic mock.

const ENABLED = process.env.SHELLMIND_E2E === '1';
const IMAGE = 'shellmind-test-ai-sshd';
const CONTAINER = `shellmind-test-ai-${process.pid}`;
const CONTEXT = fileURLToPath(new URL('../fixtures/ops/e2e', import.meta.url));

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let server: TestServer;
let mock: AnthropicMock;
let opsId: number;

function docker(...args: string[]): string {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

async function waitFor(check: () => Promise<boolean>, timeoutMs: number) {
    const deadline = Date.now() + timeoutMs;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error('condition not met in time');
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

async function evidenceFor(attachment: unknown): Promise<ChatEvidence> {
    const res = await server.fetch('/api/chat/evidence', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ serverId: opsId, attachment }) });
    const body = await res.json() as ChatEvidenceResponse & { error?: string };
    expect(res.status, body.error).toBe(200);
    return body.evidence;
}

const section = (evidence: ChatEvidence, id: string) => evidence.sections.find((part) => part.id === id);

describe.skipIf(!ENABLED)('diagnosis evidence against a real sshd (docker)', () => {
    beforeAll(async () => {
        vi.spyOn(console, 'log').mockImplementation(() => {});
        docker('build', '-q', '-t', IMAGE, CONTEXT);
        docker('run', '-d', '--name', CONTAINER, '-p', '127.0.0.1::22', IMAGE);
        const port = Number(docker('port', CONTAINER, '22').split('\n')[0].split(':').pop());
        await waitFor(() => sshBanner(port), 30_000);
        mock = await startAnthropicMock();
        server = await bootTestServer({ env: { MINIMAX_PROXY_URL: mock.url } });
        const res = await server.fetch('/api/servers', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'e2e-ai', ip: '127.0.0.1', port, type: 'linux', username: 'ops', password: 'opspw' })
        });
        opsId = ((await res.json()) as { data: { id: number } }).data.id;
    });

    afterAll(async () => {
        await server?.close();
        await mock?.close();
        spawnSync('docker', ['rm', '-f', CONTAINER]);
        vi.restoreAllMocks();
    });

    it('reads a failed service and its journal through sudo -n', async () => {
        const evidence = await evidenceFor({ kind: 'service', name: 'nginx' });
        expect(section(evidence, 'service')?.text).toContain('Active: failed (Result: exit-code)');
        expect(section(evidence, 'journal')?.text).toContain('start request repeated too quickly');
        const calls = docker('exec', CONTAINER, 'cat', '/tmp/ops-calls.log');
        expect(calls).toContain('journalctl -u nginx.service -n 200 --no-pager -o short-iso');
    });

    it('summarizes a container reached through sudo docker, with its logs', async () => {
        const evidence = await evidenceFor({ kind: 'container', container: 'web-proxy-1' });
        expect(section(evidence, 'container')?.text).toContain('State: running');
        expect(section(evidence, 'container')?.text).toContain('Engine: docker 26.1.4 (run through sudo');
        expect(section(evidence, 'container-logs')?.text).toContain('"GET / HTTP/1.1" 200 615');
    });

    it('tails a log file once, and reports one that does not exist', async () => {
        const evidence = await evidenceFor({ kind: 'logs', source: { kind: 'file', path: '/var/log/ticker.log' } });
        expect(section(evidence, 'logs')?.text).toMatch(/app\[42\]: tick/);
        // The ticker repeats one message: the run is folded.
        expect(section(evidence, 'logs')?.text).toMatch(/\[\.\.\. \d+ similar lines\]/);

        const missing = await server.fetch('/api/chat/evidence', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ serverId: opsId, attachment: { kind: 'logs', source: { kind: 'file', path: '/var/log/no such dir/app.log' } } })
        });
        expect(missing.status).toBe(502);
        expect(await missing.json()).toMatchObject({ code: 'EVIDENCE_UNAVAILABLE', error: expect.stringContaining('/var/log/no such dir/app.log') });
    });

    it('collects the status snapshot and the triage pack with busybox tools', async () => {
        const status = await evidenceFor({ kind: 'status' });
        expect(section(status, 'snapshot')?.text).toMatch(/^Host: .*Alpine Linux/);
        expect(section(status, 'failed-units')?.text).toContain('nginx.service');

        const triage = await evidenceFor({ kind: 'triage' });
        expect(triage.sections.map((part) => part.id)).toEqual(['system', 'failed-units', 'errors', 'kernel', 'disk', 'memory', 'processes', 'ports']);
        // A container has no CAP_SYSLOG, even through sudo: the kernel part
        // says it could not be read (it used to pass for "nothing found").
        expect(triage.sections.filter((part) => part.failed).map((part) => part.id)).toEqual(['kernel']);
        expect(section(triage, 'kernel')?.text).toContain('The kernel log (dmesg) cannot be read');
        expect(section(triage, 'kernel')?.text).toContain('klogctl: Operation not permitted');
        expect(section(triage, 'system')?.text).toContain('Alpine Linux');
        expect(section(triage, 'disk')?.text).toMatch(/ \/$/m);
        // Only directories: not the files Docker bind-mounts.
        expect(section(triage, 'disk')?.text).not.toContain('/etc/hosts');
        expect(section(triage, 'memory')?.text).toMatch(/Mem:/);
        expect(section(triage, 'ports')?.text).toMatch(/:22\b/);
        // The script's own processes are left out of the busiest ones.
        expect(section(triage, 'processes')?.text).not.toMatch(/\bsh -s\b/);
    });

    it('hands the collected evidence to the model', async () => {
        const evidence = await evidenceFor({ kind: 'triage' });
        mock.queue(jsonReply('### Findings\n- nginx failed'));
        const res = await server.fetch('/api/chat', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ purpose: 'diagnose', serverId: opsId, attachment: { kind: 'triage' }, evidence, language: 'en' })
        });
        expect(await res.json()).toMatchObject({ response: '### Findings\n- nginx failed' });
        const turn = mock.requests.at(-1)?.body.messages?.at(-1)?.content[0].text ?? '';
        expect(turn).toContain('Failed systemd units (systemctl list-units --state=failed)');
        expect(turn).toContain('nginx.service loaded failed failed');
    });
});
