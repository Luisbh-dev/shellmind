import { randomBytes } from 'node:crypto';
import net from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi, type MockInstance } from 'vitest';
import { io as connect, type Socket } from 'socket.io-client';
import type { PinnedRdpCertificate, RdpOpenResult, RdpStatusEvent, RdpTrustCertificateResult } from '../../shared/rdp';
import type { AuditEntry } from '../../shared/types';
import { decodePdu, encodeRequest, type RdCleanPathPdu } from '../../server/rdp/rdcleanpath';
import { digitalSignatureCertificate, keyEnciphermentCertificate, startInterceptingRelay } from '../../scripts/check-rdp-tls.mjs';
import { connectionConfirm, connectionRequest, enforceKeyUsageLikeBoringSsl, selfSignedCertificate, startFakeRdpServer, type FakeRdpServer } from '../helpers/rdpServer';
import { rawUpgrade } from '../helpers/rawHttp';
import { startSshServer, type SshHarness } from '../helpers/sshServer';
import { bootTestServer, type TestServer } from '../helpers/testServer';

// The embedded Remote Desktop gateway (server/rdp) end to end: tickets over
// the authenticated socket, the RDCleanPath exchange over the WebSocket, the
// relay to a fake RDP server over TLS, certificate pinning, jump hosts and
// the audit log.

vi.setConfig({ testTimeout: 30_000 });

let server: TestServer;
let rdp: FakeRdpServer;
let limits: typeof import('../../server/rdp/gateway').GATEWAY_LIMITS;
let consoleLog: MockInstance<typeof console.log>;
const sockets: Socket[] = [];
const PASSWORD = 'Rdp$ecret-123';

async function call<T = Record<string, unknown>>(method: string, path: string, body?: unknown): Promise<{ status: number; body: T }> {
    const res = await server.fetch(path, {
        method,
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: (await res.json()) as T };
}

async function saveWindows(fields: Record<string, unknown> = {}): Promise<number> {
    const created = await call<{ data: { id: number } }>('POST', '/api/servers', {
        name: `win-${Math.random().toString(36).slice(2, 7)}`, ip: '127.0.0.1', type: 'windows', port: rdp.port,
        username: 'alice', password: PASSWORD, domain: 'CORP', ...fields,
    });
    expect(created.status).toBe(200);
    return created.body.data.id;
}

async function openSocket(): Promise<{ socket: Socket; events: RdpStatusEvent[] }> {
    const socket = connect(server.baseUrl, { transports: ['websocket'], reconnection: false, forceNew: true, auth: { token: server.token } });
    sockets.push(socket);
    const events: RdpStatusEvent[] = [];
    socket.on('rdp-status', (event: RdpStatusEvent) => events.push(event));
    await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
    });
    return { socket, events };
}

function rdpOpen(socket: Socket, request: Record<string, unknown>): Promise<RdpOpenResult> {
    return new Promise((resolve) => socket.emit('rdp-open', request, resolve));
}

type Gateway = { ws: WebSocket; messages: Buffer[]; closed: Promise<CloseEvent>; next: () => Promise<Buffer> };

async function openGateway(ticket: string): Promise<Gateway> {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/rdp/gateway?ticket=${encodeURIComponent(ticket)}`);
    ws.binaryType = 'arraybuffer';
    const messages: Buffer[] = [];
    const waiters: Array<(data: Buffer) => void> = [];
    ws.onmessage = (event) => {
        const data = Buffer.from(event.data as ArrayBuffer);
        const waiter = waiters.shift();
        if (waiter) waiter(data);
        else messages.push(data);
    };
    const closed = new Promise<CloseEvent>((resolve) => { ws.onclose = resolve; });
    await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('the gateway refused the WebSocket'));
    });
    const next = () => new Promise<Buffer>((resolve, reject) => {
        const queued = messages.shift();
        if (queued) return resolve(queued);
        const timer = setTimeout(() => reject(new Error('no message from the gateway')), 15_000);
        waiters.push((data) => {
            clearTimeout(timer);
            resolve(data);
        });
    });
    return { ws, messages, closed, next };
}

// rdp-open + WebSocket + RDCleanPath request; resolves with the gateway's answer.
async function handshake(serverId: number, options: { credentials?: 'saved' | 'prompt'; destination?: string; proxyAuth?: string; x224?: Buffer } = {}) {
    const { socket, events } = await openSocket();
    const opened = await rdpOpen(socket, { serverId, credentials: options.credentials ?? 'saved' });
    if (!opened.ok) throw new Error(`rdp-open failed: ${opened.error}`);
    const gateway = await openGateway(opened.ticket);
    gateway.ws.send(encodeRequest({
        destination: options.destination ?? opened.destination,
        proxyAuth: options.proxyAuth ?? opened.ticket,
        x224: options.x224 ?? connectionRequest({ user: 'alice' }),
    }));
    const answer: RdCleanPathPdu = decodePdu(await gateway.next(), 1024 * 1024);
    return { socket, events, opened, gateway, answer };
}

async function waitFor(check: () => boolean, timeoutMs = 10_000): Promise<void> {
    const start = Date.now();
    while (!check()) {
        if (Date.now() - start > timeoutMs) throw new Error('timed out waiting');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const auditOf = async (serverId: number) =>
    (await call<{ data: AuditEntry[] }>('GET', `/api/audit?serverId=${serverId}&source=rdp`)).body.data;

// The newest audit entry of the server whose command starts with `prefix`,
// once it is written (the gateway records it without waiting).
async function waitForAudit(serverId: number, prefix: string): Promise<AuditEntry> {
    let found: AuditEntry | undefined;
    const start = Date.now();
    while (!found) {
        found = (await auditOf(serverId)).find((entry) => entry.command.startsWith(prefix));
        if (found) break;
        if (Date.now() - start > 10_000) throw new Error(`no "${prefix}" audit entry`);
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    return found;
}

beforeAll(async () => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    server = await bootTestServer();
    rdp = await startFakeRdpServer();
    limits = (await import('../../server/rdp/gateway')).GATEWAY_LIMITS;
});

afterEach(() => {
    for (const socket of sockets.splice(0)) socket.disconnect();
    rdp.behaviour = 'rdp';
});

afterAll(async () => {
    await server?.close();
    await rdp?.close();
    vi.restoreAllMocks();
});

describe('rdp-open', () => {
    it('hands out a ticket with the saved credentials, or without the password when the user types it', async () => {
        const id = await saveWindows();
        const { socket } = await openSocket();
        const saved = await rdpOpen(socket, { serverId: id, credentials: 'saved' });
        expect(saved).toMatchObject({
            ok: true, gatewayPath: '/api/rdp/gateway', destination: `127.0.0.1:${rdp.port}`,
            username: 'alice', domain: 'CORP', password: PASSWORD, via: null,
        });
        const prompted = await rdpOpen(socket, { serverId: id, credentials: 'prompt', username: 'bob', domain: '' });
        expect(prompted).toMatchObject({ ok: true, username: 'bob', domain: '' });
        expect(prompted).not.toHaveProperty('password');
        expect(saved.ok && prompted.ok && saved.ticket !== prompted.ticket).toBe(true);
    });

    it('refuses servers that are not Windows, unknown ones and bad requests', async () => {
        const { socket } = await openSocket();
        const linux = (await call<{ data: { id: number } }>('POST', '/api/servers', { name: 'lin', ip: '10.0.0.1', type: 'linux', username: 'root', password: 'x' })).body.data.id;
        expect(await rdpOpen(socket, { serverId: linux, credentials: 'saved' })).toMatchObject({ ok: false, code: 'UNSUPPORTED_PURPOSE' });
        expect(await rdpOpen(socket, { serverId: 999_999, credentials: 'saved' })).toMatchObject({ ok: false, code: 'SERVER_NOT_FOUND' });
        expect(await rdpOpen(socket, { serverId: 'x', credentials: 'saved' })).toMatchObject({ ok: false, code: 'INVALID_SERVER_ID' });
        const id = await saveWindows();
        expect(await rdpOpen(socket, { serverId: id })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
        expect(await rdpOpen(socket, { serverId: id, credentials: 'prompt', username: 'a\r\nb' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    });

    it('limits the tickets one socket may hold', async () => {
        const id = await saveWindows();
        const { socket } = await openSocket();
        const results = [];
        for (let i = 0; i < 5; i += 1) results.push(await rdpOpen(socket, { serverId: id, credentials: 'prompt' }));
        expect(results.filter((result) => result.ok)).toHaveLength(4);
        expect(results[4]).toMatchObject({ ok: false, code: 'RDP_BUSY' });
    });
});

describe('the gateway WebSocket', () => {
    it('requires an unused ticket and an allowed Host and Origin', async () => {
        const id = await saveWindows();
        const { socket } = await openSocket();
        const opened = await rdpOpen(socket, { serverId: id, credentials: 'prompt' });
        if (!opened.ok) throw new Error(opened.error);
        const path = `/api/rdp/gateway?ticket=${encodeURIComponent(opened.ticket)}`;
        expect(await rawUpgrade(server.port, { path, headers: { host: 'evil.example' } })).toMatchObject({ status: 403 });
        expect(await rawUpgrade(server.port, { path, headers: { origin: 'https://evil.example' } })).toMatchObject({ status: 403 });
        expect(await rawUpgrade(server.port, { path: '/api/rdp/gateway' })).toMatchObject({ status: 401 });
        expect(await rawUpgrade(server.port, { path: '/api/rdp/gateway?ticket=forged' })).toMatchObject({ status: 401 });
        expect(await rawUpgrade(server.port, { path })).toMatchObject({ status: 101 });
        // Used up by the upgrade above.
        expect(await rawUpgrade(server.port, { path })).toMatchObject({ status: 401 });
    });

    it('expires tickets that are not used in time', async () => {
        const id = await saveWindows();
        const { socket } = await openSocket();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now');
        const opened = await rdpOpen(socket, { serverId: id, credentials: 'prompt' });
        if (!opened.ok) throw new Error(opened.error);
        clock.mockReturnValue(now + 31_000);
        expect(await rawUpgrade(server.port, { path: `/api/rdp/gateway?ticket=${encodeURIComponent(opened.ticket)}` })).toMatchObject({ status: 401 });
        clock.mockRestore();
    });
});

describe('a Remote Desktop session', () => {
    it('connects to the saved server, pins its certificate and relays the stream', async () => {
        const id = await saveWindows();
        const before = rdp.log.length;
        // The destination the client names is ignored: the ticket's server is used.
        const { answer, gateway, events } = await handshake(id, { destination: '203.0.113.9:3389' });
        expect(answer.error).toBeUndefined();
        expect(answer.x224).toEqual(connectionConfirm({ type: 'response', value: 0x08 }));
        expect(answer.serverCertChain?.[0]).toEqual(rdp.certificate.der);
        expect(answer.serverAddr).toBe(`127.0.0.1:${rdp.port}`);
        expect(rdp.log.slice(before)).toEqual(expect.arrayContaining([`request:Cookie: mstshash=alice:${0x0b}`, 'tls']));

        gateway.ws.send(new TextEncoder().encode('hello'));
        expect((await gateway.next()).toString()).toBe('echo:hello');

        await waitFor(() => events.some((event) => event.phase === 'established'));
        expect(events.map((event) => event.phase)).toEqual(['connecting', 'securing', 'established']);
        const established = events[2];
        expect(established.pinnedNow).toBe(true);
        expect(established.certificate).toMatchObject({ host: '127.0.0.1', port: rdp.port, via: '', subject: 'CN=fake-rdp' });
        const tls = { protocol: 'TLSv1.3', cipher: expect.stringMatching(/^TLS_(AES|CHACHA20)_/), forwardSecrecy: true, keyUsageFallback: false };
        expect(established.tls).toEqual(tls);

        const state = await call<{ data: { pinned: { fingerprint: string } | null } }>('GET', `/api/rdp/certificate?serverId=${id}`);
        expect(state.body.data.pinned?.fingerprint).toBe(established.certificate?.fingerprint);

        gateway.ws.send(new TextEncoder().encode('bye'));
        await gateway.closed;
        await waitFor(() => events.some((event) => event.phase === 'closed'));
        // The gateway records the end without waiting: under load it lands after "closed".
        await waitForAudit(id, 'rdp disconnect');
        const audit = await auditOf(id);
        expect(audit.map((entry) => entry.command)).toEqual([
            `rdp disconnect CORP\\alice@127.0.0.1:${rdp.port}`,
            `rdp connect CORP\\alice@127.0.0.1:${rdp.port}`,
        ]);
        expect(audit[1]).toMatchObject({ exit_code: 0, meta: { pinnedNow: true, tls } });
        expect(audit[0].meta).toMatchObject({ bytesToServer: 8, durationMs: expect.any(Number) });
        expect(JSON.stringify(audit)).not.toContain(PASSWORD);
    });

    it('keeps the pinned certificate and refuses a changed one until the user trusts it', async () => {
        const id = await saveWindows();
        const first = await handshake(id);
        expect(first.answer.error).toBeUndefined();
        first.gateway.ws.close();
        const original = rdp.certificate;
        rdp.setCertificate(selfSignedCertificate('fake-rdp-renewed'));
        try {
            const changed = await handshake(id);
            expect(changed.answer.error).toEqual({ errorCode: 1, tlsAlertCode: 42 });
            await changed.gateway.closed;
            await waitFor(() => changed.events.some((event) => event.phase === 'failed'));
            const failure = changed.events.find((event) => event.phase === 'failed')!.error!;
            expect(failure.code).toBe('RDP_CERT_MISMATCH');
            expect(failure.mismatch?.expected.subject).toBe('CN=fake-rdp');
            expect(failure.mismatch?.actual.subject).toBe('CN=fake-rdp-renewed');
            const { expected, actual } = { expected: failure.mismatch!.expected.fingerprint, actual: failure.mismatch!.actual.fingerprint };

            const trust = (payload: Record<string, unknown>) => new Promise<RdpTrustCertificateResult>((resolve) => changed.socket.emit('rdp-trust-certificate', payload, resolve));
            // Only the certificate the gateway was shown can be trusted.
            expect(await trust({ serverId: id, expected, actual: expected.replace(/^../, '00') })).toMatchObject({ ok: false, code: 'RDP_CERT_CHANGED' });
            expect(await trust({ serverId: id, expected, actual: 'not a fingerprint' })).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
            expect(await trust({ serverId: id, expected, actual })).toEqual({ ok: true });

            const trusted = await handshake(id);
            expect(trusted.answer.error).toBeUndefined();
            await waitFor(() => trusted.events.some((event) => event.phase === 'established'));
            expect(trusted.events.find((event) => event.phase === 'established')?.pinnedNow).toBe(false);
            trusted.gateway.ws.close();
            expect((await auditOf(id)).some((entry) => entry.command === `rdp trust-certificate 127.0.0.1:${rdp.port}`)).toBe(true);
        } finally {
            rdp.setCertificate(original);
        }
    });

    it('forgets a pin on request', async () => {
        const id = await saveWindows();
        (await handshake(id)).gateway.ws.close();
        const state = await call<{ data: { pinned: { id: number } } }>('GET', `/api/rdp/certificate?serverId=${id}`);
        expect((await call('DELETE', `/api/rdp/certificates/${state.body.data.pinned.id}`)).status).toBe(200);
        expect((await call('DELETE', `/api/rdp/certificates/${state.body.data.pinned.id}`)).status).toBe(404);
        expect((await call<{ data: { pinned: unknown } }>('GET', `/api/rdp/certificate?serverId=${id}`)).body.data.pinned).toBeNull();
    });

    it('needs its own ticket in the RDCleanPath request', async () => {
        const id = await saveWindows();
        const { answer, events } = await handshake(id, { proxyAuth: 'someone-elses-ticket' });
        expect(answer.error).toEqual({ errorCode: 1, httpStatusCode: 401 });
        await waitFor(() => events.some((event) => event.phase === 'failed'));
        expect(events.at(-1)?.error?.code).toBe('RDP_TICKET');
    });

    it('refuses connection requests without TLS and malformed ones before connecting', async () => {
        const id = await saveWindows();
        const before = rdp.log.length;
        const legacy = await handshake(id, { x224: connectionRequest({ protocols: 0 }) });
        expect(legacy.answer.error?.errorCode).toBe(1);
        await waitFor(() => legacy.events.some((event) => event.phase === 'failed'));
        expect(legacy.events.at(-1)?.error?.code).toBe('RDP_LEGACY_SECURITY');
        const garbage = await handshake(id, { x224: Buffer.from('GET / HTTP/1.1\r\n\r\n') });
        expect(garbage.answer.error).toEqual({ errorCode: 1, httpStatusCode: 400 });
        expect(rdp.log.slice(before).filter((line) => line.startsWith('request:'))).toEqual([]);
    });

    it('refuses a request that is not RDCleanPath', async () => {
        const id = await saveWindows();
        const { socket, events } = await openSocket();
        const opened = await rdpOpen(socket, { serverId: id, credentials: 'saved' });
        if (!opened.ok) throw new Error(opened.error);
        const gateway = await openGateway(opened.ticket);
        gateway.ws.send(connectionRequest());
        expect(decodePdu(await gateway.next()).error).toEqual({ errorCode: 1, httpStatusCode: 400 });
        await waitFor(() => events.some((event) => event.phase === 'failed'));
        expect(events.at(-1)?.error?.code).toBe('RDP_PROTOCOL');
    });

    it('passes a negotiation failure of the server on', async () => {
        const id = await saveWindows();
        rdp.behaviour = 'refuse';
        const { answer, events } = await handshake(id);
        expect(answer.error).toEqual({ errorCode: 2 });
        expect(answer.x224).toEqual(connectionConfirm({ type: 'failure', value: 5 }));
        await waitFor(() => events.some((event) => event.phase === 'failed'));
        expect(events.at(-1)?.error).toMatchObject({ code: 'RDP_NEGOTIATION_FAILED', details: { failure: 'HYBRID_REQUIRED_BY_SERVER' } });
    });

    it.each([
        ['legacy', 'RDP_LEGACY_SECURITY'],
        ['garbage', 'RDP_PROTOCOL'],
        ['silent', 'RDP_TIMEOUT'],
    ] as const)('reports a %s server as %s', async (behaviour, code) => {
        const id = await saveWindows();
        rdp.behaviour = behaviour;
        const saved = limits.negotiationTimeoutMs;
        limits.negotiationTimeoutMs = 300;
        try {
            const { answer, events } = await handshake(id);
            expect(answer.error?.errorCode).toBe(1);
            await waitFor(() => events.some((event) => event.phase === 'failed'));
            expect(events.at(-1)?.error?.code).toBe(code);
        } finally {
            limits.negotiationTimeoutMs = saved;
        }
    });

    it('reports a port nobody listens on', async () => {
        const closed = net.createServer();
        await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
        const port = (closed.address() as net.AddressInfo).port;
        await new Promise((resolve) => closed.close(resolve));
        const id = await saveWindows({ port });
        const { answer, events } = await handshake(id);
        expect(answer.error).toEqual({ errorCode: 1, wsaLastError: 10061 });
        await waitFor(() => events.some((event) => event.phase === 'failed'));
        expect(events.at(-1)?.error).toMatchObject({ code: 'RDP_UNREACHABLE', details: { errno: 'ECONNREFUSED' } });
        await waitForAudit(id, 'rdp connect');
        const audit = await auditOf(id);
        expect(audit[0]).toMatchObject({ exit_code: 1, meta: { error: 'RDP_UNREACHABLE' } });
    });

    it('ends the session when the socket that opened it goes away', async () => {
        const id = await saveWindows();
        const { socket, gateway, answer } = await handshake(id);
        expect(answer.error).toBeUndefined();
        const open = rdp.openConnections();
        socket.disconnect();
        await gateway.closed;
        await waitFor(() => rdp.openConnections() < open);
        const ended = await waitForAudit(id, 'rdp disconnect');
        expect(ended.meta).toMatchObject({ reason: 'The page that opened the session went away.' });
    });

    it('records that the user ended the session, whatever closes it first', async () => {
        // The client closes its WebSocket right after the page said so on its socket.
        const first = await saveWindows();
        const closing = await handshake(first);
        await waitFor(() => closing.events.some((event) => event.phase === 'established'));
        closing.socket.emit('rdp-disconnect', { sessionId: closing.opened.sessionId });
        closing.gateway.ws.close();
        await closing.gateway.closed;
        expect((await waitForAudit(first, 'rdp disconnect')).meta).toMatchObject({ reason: 'The user disconnected.' });

        // The page goes away (its socket) before the WebSocket closes.
        const second = await saveWindows();
        const leaving = await handshake(second);
        await waitFor(() => leaving.events.some((event) => event.phase === 'established'));
        leaving.socket.emit('rdp-disconnect', { sessionId: leaving.opened.sessionId });
        await new Promise((resolve) => setTimeout(resolve, 100));
        leaving.socket.disconnect();
        await leaving.gateway.closed;
        expect((await waitForAudit(second, 'rdp disconnect')).meta).toMatchObject({ reason: 'The user disconnected.' });

        // Without that word, a closed WebSocket is the client's doing.
        const third = await saveWindows();
        const dropped = await handshake(third);
        await waitFor(() => dropped.events.some((event) => event.phase === 'established'));
        dropped.gateway.ws.close();
        expect((await waitForAudit(third, 'rdp disconnect')).meta).toMatchObject({ reason: 'The Remote Desktop client closed the connection.' });
    });

    it('records how the page says a session ended when its client keeps the WebSocket open', async () => {
        const remote = await saveWindows();
        const signedOut = await handshake(remote);
        await waitFor(() => signedOut.events.some((event) => event.phase === 'established'));
        signedOut.socket.emit('rdp-disconnect', {
            sessionId: signedOut.opened.sessionId,
            cause: 'remote',
            detail: 'The disconnection was initiated by the user logging off\u0007 his or her session on the server',
        });
        await signedOut.gateway.closed;
        expect((await waitForAudit(remote, 'rdp disconnect')).meta).toMatchObject({
            reason: 'The remote desktop ended the session (The disconnection was initiated by the user logging off his or her session on the server).',
        });

        const failing = await saveWindows();
        const failed = await handshake(failing);
        await waitFor(() => failed.events.some((event) => event.phase === 'established'));
        failed.socket.emit('rdp-disconnect', { sessionId: failed.opened.sessionId, cause: 'error', detail: 'RDP_LOGON_FAILURE'.padEnd(500, '!') });
        await failed.gateway.closed;
        const reason = String((await waitForAudit(failing, 'rdp disconnect')).meta?.reason);
        expect(reason.startsWith('The Remote Desktop client stopped with an error (RDP_LOGON_FAILURE!!!')).toBe(true);
        expect(reason.length).toBeLessThan(300);
    });

    it('gives the client a moment to close after the user ended the session, then closes it', async () => {
        const id = await saveWindows();
        const saved = limits.userEndGraceMs;
        limits.userEndGraceMs = 200;
        try {
            const { socket, gateway, opened, events } = await handshake(id);
            await waitFor(() => events.some((event) => event.phase === 'established'));
            socket.emit('rdp-disconnect', { sessionId: opened.sessionId });
            // Still relaying meanwhile (the client's sign-off reaches the server).
            gateway.ws.send(new TextEncoder().encode('signing off'));
            expect((await gateway.next()).toString()).toBe('echo:signing off');
            await gateway.closed;
            await waitFor(() => events.some((event) => event.phase === 'closed'));
            expect((await waitForAudit(id, 'rdp disconnect')).meta).toMatchObject({ reason: 'The user disconnected.' });
        } finally {
            limits.userEndGraceMs = saved;
        }
    });

    it('stops a connection the user cancels while it is set up, and drops an unused ticket', async () => {
        const id = await saveWindows();
        rdp.behaviour = 'silent';
        const { socket, events } = await openSocket();
        const opened = await rdpOpen(socket, { serverId: id, credentials: 'saved' });
        if (!opened.ok) throw new Error(opened.error);
        const gateway = await openGateway(opened.ticket);
        gateway.ws.send(encodeRequest({ destination: opened.destination, proxyAuth: opened.ticket, x224: connectionRequest({ user: 'alice' }) }));
        await waitFor(() => events.some((event) => event.phase === 'connecting'));
        socket.emit('rdp-disconnect', { sessionId: opened.sessionId });
        await gateway.closed;
        await waitFor(() => events.some((event) => event.phase === 'closed'));
        expect(events.some((event) => event.phase === 'failed')).toBe(false);
        // A cancelled attempt is no failed connection in the audit log.
        expect(await auditOf(id)).toEqual([]);

        // A ticket not used yet: another socket cannot cancel it, its own can.
        const pause = () => new Promise((resolve) => setTimeout(resolve, 50));
        const other = await openSocket();
        const kept = await rdpOpen(socket, { serverId: id, credentials: 'prompt' });
        if (!kept.ok) throw new Error(kept.error);
        other.socket.emit('rdp-disconnect', { sessionId: kept.sessionId });
        await pause();
        expect(await rawUpgrade(server.port, { path: `/api/rdp/gateway?ticket=${encodeURIComponent(kept.ticket)}` })).toMatchObject({ status: 101 });
        const unused = await rdpOpen(socket, { serverId: id, credentials: 'prompt' });
        if (!unused.ok) throw new Error(unused.error);
        socket.emit('rdp-disconnect', { sessionId: unused.sessionId });
        await pause();
        expect(await rawUpgrade(server.port, { path: `/api/rdp/gateway?ticket=${encodeURIComponent(unused.ticket)}` })).toMatchObject({ status: 401 });
    });
});

describe('a certificate that does not allow digital signatures', () => {
    // Windows' self-signed RDP certificate: RSA, key usage key encipherment
    // and data encipherment only. Electron's BoringSSL refuses it for TLS 1.3
    // and ECDHE; enforceKeyUsageLikeBoringSsl makes OpenSSL do the same here.
    const certificate = keyEnciphermentCertificate('WIN-RDP');
    let windows: FakeRdpServer;
    const requests = (log: string[]) => log.filter((line) => line.startsWith('request:'));

    beforeAll(async () => {
        windows = await startFakeRdpServer({ certificate });
    });

    afterAll(async () => {
        await windows?.close();
    });

    it('is secured with TLS 1.2 and RSA key exchange when the runtime refuses it, and pinned like any other', async () => {
        const { RSA_KEY_EXCHANGE_CIPHERS } = await import('../../server/rdp/connect');
        const id = await saveWindows({ port: windows.port });
        const boringSsl = enforceKeyUsageLikeBoringSsl();
        const logged = consoleLog.mock.calls.length;
        const start = windows.log.length;
        try {
            const { answer, gateway, events } = await handshake(id);
            expect(answer.error).toBeUndefined();
            expect(answer.x224).toEqual(connectionConfirm({ type: 'response', value: 0x08 }));
            expect(answer.serverCertChain?.[0]).toEqual(certificate.der);
            // Refused, then a new connection, negotiation and handshake offering RSA key exchange only.
            expect(requests(windows.log.slice(start))).toHaveLength(2);
            expect(boringSsl.calls.map(({ maxVersion, ciphers }) => ({ maxVersion, ciphers }))).toEqual([
                { maxVersion: undefined, ciphers: undefined },
                { maxVersion: 'TLSv1.2', ciphers: RSA_KEY_EXCHANGE_CIPHERS },
            ]);
            expect(windows.handshakes.at(-1)).toEqual({ protocol: 'TLSv1.2', cipher: 'AES256-GCM-SHA384' });

            gateway.ws.send(new TextEncoder().encode('hello'));
            expect((await gateway.next()).toString()).toBe('echo:hello');
            await waitFor(() => events.some((event) => event.phase === 'established'));
            expect(events.map((event) => event.phase)).toEqual(['connecting', 'securing', 'established']);
            expect(events[2]).toMatchObject({ pinnedNow: true, certificate: { fingerprint: certificate.fingerprint256, subject: 'CN=WIN-RDP' } });
            // Told apart from a session with forward secrecy, in the page and in the audit log.
            const tls = { protocol: 'TLSv1.2', cipher: 'TLS_RSA_WITH_AES_256_GCM_SHA384', forwardSecrecy: false, keyUsageFallback: true };
            expect(events[2].tls).toEqual(tls);

            const lines = consoleLog.mock.calls.slice(logged).map(([line]) => String(line)).filter((line) => line.includes('RSA key exchange'));
            expect(lines).toHaveLength(1);
            expect(lines[0]).toMatch(new RegExp(`INFO \\[rdp\\] The first TLS handshake with 127\\.0\\.0\\.1:${windows.port} was refused for the certificate's key usage \\(no digital signatures.*\\): connecting again with TLS 1\\.2 and RSA key exchange$`));

            gateway.ws.close();
            await waitForAudit(id, 'rdp disconnect');
            const audit = await auditOf(id);
            expect(audit.map((entry) => entry.command)).toEqual([
                `rdp disconnect CORP\\alice@127.0.0.1:${windows.port}`,
                `rdp connect CORP\\alice@127.0.0.1:${windows.port}`,
            ]);
            expect(audit[1]).toMatchObject({ exit_code: 0, meta: { pinnedNow: true, certificate: certificate.fingerprint256, tls } });
            expect(JSON.stringify([audit, consoleLog.mock.calls.slice(logged)])).not.toContain(PASSWORD);
        } finally {
            boringSsl.restore();
        }

        // Where the runtime accepts it (OpenSSL): TLS 1.3 at once, and the
        // same certificate, so the pin holds.
        const direct = await handshake(id);
        expect(direct.answer.error).toBeUndefined();
        await waitFor(() => direct.events.some((event) => event.phase === 'established'));
        expect(direct.events.find((event) => event.phase === 'established')).toMatchObject({
            pinnedNow: false, certificate: { fingerprint: certificate.fingerprint256 }, tls: { protocol: 'TLSv1.3', forwardSecrecy: true, keyUsageFallback: false },
        });
        expect(windows.handshakes.at(-1)?.protocol).toBe('TLSv1.3');
        direct.gateway.ws.close();
    });

    it('is not forced on a server whose certificate allows digital signatures: such a connection is refused and the pin stays', async () => {
        // The server's certificate allows digital signatures: TLS 1.3, no fallback.
        const genuine = digitalSignatureCertificate('GOOD-RDP');
        const signing = await startFakeRdpServer({ certificate: genuine });
        // An attacker in the middle answers the first connection with a
        // certificate without Digital Signature, which the runtime refuses,
        // and passes the next one, with RSA key exchange, to the server.
        const attacker = await startFakeRdpServer({ certificate: keyEnciphermentCertificate('MITM') });
        const relay = await startInterceptingRelay({ attacker: attacker.port, server: signing.port, intercept: 0 });
        const id = await saveWindows({ port: relay.port });
        const pinned = async () => (await call<{ data: { pinned: PinnedRdpCertificate | null } }>('GET', `/api/rdp/certificate?serverId=${id}`)).body.data.pinned;
        const intercepted = async () => {
            relay.intercept = 1;
            const from = relay.connections.length;
            const { answer, events } = await handshake(id);
            expect(answer.error).toEqual({ errorCode: 1, tlsAlertCode: 42 });
            await waitFor(() => events.some((event) => event.phase === 'failed'));
            expect(events.map((event) => event.phase)).toEqual(['connecting', 'securing', 'failed']);
            expect(events[2].error).toMatchObject({ code: 'RDP_TLS_FAILED' });
            expect(events[2].error?.message).toMatch(/^The TLS handshake with 127\.0\.0\.1:\d+ failed: the first certificate was refused for its key usage \(no digital signatures\), but the one presented when connecting again with TLS 1\.2 and RSA key exchange did not need that: it allows digital signatures\. The connection may be intercepted to take away its forward secrecy\.$/);
            expect(relay.connections.slice(from)).toEqual(['attacker', 'server']);
            expect(signing.handshakes.at(-1)).toEqual({ protocol: 'TLSv1.2', cipher: 'AES256-GCM-SHA384' });
            expect(await waitForAudit(id, 'rdp connect')).toMatchObject({ exit_code: 1, meta: { error: 'RDP_TLS_FAILED' } });
        };
        const boringSsl = enforceKeyUsageLikeBoringSsl();
        try {
            // At the first connection: refused, nothing pinned.
            await intercepted();
            expect(await pinned()).toBeNull();

            // Without the attacker: TLS 1.3, and pinned.
            const direct = await handshake(id);
            expect(direct.answer.error).toBeUndefined();
            await waitFor(() => direct.events.some((event) => event.phase === 'established'));
            expect(direct.events.find((event) => event.phase === 'established')).toMatchObject({
                pinnedNow: true, certificate: { fingerprint: genuine.fingerprint256 }, tls: { protocol: 'TLSv1.3', forwardSecrecy: true, keyUsageFallback: false },
            });
            direct.gateway.ws.close();
            const pin = await pinned();
            expect(pin?.fingerprint).toBe(genuine.fingerprint256);

            // Once pinned (and the pin would match): refused all the same, and the pin is unchanged.
            await intercepted();
            expect(await pinned()).toEqual(pin);
        } finally {
            boringSsl.restore();
            await relay.close();
            await Promise.all([signing.close(), attacker.close()]);
        }
    });

    it('reports a server that refuses RSA key exchange too, and what to change', async () => {
        const strict = await startFakeRdpServer({ certificate, tls: { ciphers: 'ECDHE-RSA-AES256-GCM-SHA384:ECDHE-RSA-AES128-GCM-SHA256' } });
        const id = await saveWindows({ port: strict.port });
        const boringSsl = enforceKeyUsageLikeBoringSsl();
        try {
            const { answer, events } = await handshake(id);
            expect(answer.error).toEqual({ errorCode: 1, tlsAlertCode: 40 });
            await waitFor(() => events.some((event) => event.phase === 'failed'));
            const failure = events.find((event) => event.phase === 'failed')!.error!;
            expect(failure.code).toBe('RDP_TLS_FAILED');
            expect(failure.message).toMatch(/^The TLS handshake with 127\.0\.0\.1:\d+ failed: its certificate does not allow digital signatures \(key usage\), which TLS 1\.3 and ECDHE key exchange need, and TLS 1\.2 with RSA key exchange failed too \(.+\)\. Give the server a certificate whose key usage includes Digital Signature\.$/s);
            expect(requests(strict.log)).toHaveLength(2);
            expect(boringSsl.calls).toHaveLength(2);
            expect((await call<{ data: { pinned: unknown } }>('GET', `/api/rdp/certificate?serverId=${id}`)).body.data.pinned).toBeNull();
            expect((await waitForAudit(id, 'rdp connect'))).toMatchObject({ exit_code: 1, meta: { error: 'RDP_TLS_FAILED' } });
        } finally {
            boringSsl.restore();
            await strict.close();
        }
    });

    it('is not tried again for a handshake that fails for another reason', async () => {
        const id = await saveWindows();
        rdp.behaviour = 'drop-tls';
        const boringSsl = enforceKeyUsageLikeBoringSsl();
        const start = rdp.log.length;
        try {
            const { answer, events } = await handshake(id);
            expect(answer.error).toEqual({ errorCode: 1, tlsAlertCode: 40 });
            await waitFor(() => events.some((event) => event.phase === 'failed'));
            const failure = events.find((event) => event.phase === 'failed')!.error!;
            expect(failure.code).toBe('RDP_TLS_FAILED');
            expect(failure.message).toMatch(/^The TLS handshake with 127\.0\.0\.1:\d+ failed: /);
            expect(failure.message).not.toContain('RSA');
            expect(requests(rdp.log.slice(start))).toHaveLength(1);
            expect(boringSsl.calls).toHaveLength(1);
        } finally {
            boringSsl.restore();
        }
    });
});

describe('ask for the password each time', () => {
    it('is kept by the backend, which then never hands out the saved password', async () => {
        const id = await saveWindows();
        expect((await call('GET', `/api/rdp/options?serverId=${id}`)).body).toMatchObject({ data: { askPassword: false } });
        expect((await call('PUT', '/api/rdp/options', { serverId: id, askPassword: true })).body).toMatchObject({ data: { askPassword: true } });
        expect((await call('GET', `/api/rdp/options?serverId=${id}`)).body).toMatchObject({ data: { askPassword: true } });

        const { socket } = await openSocket();
        const saved = await rdpOpen(socket, { serverId: id, credentials: 'saved' });
        expect(saved).toMatchObject({ ok: false, code: 'RDP_PASSWORD_REQUIRED' });
        expect(JSON.stringify(saved)).not.toContain(PASSWORD);
        const prompted = await rdpOpen(socket, { serverId: id, credentials: 'prompt' });
        expect(prompted).toMatchObject({ ok: true, username: 'alice' });
        expect(prompted).not.toHaveProperty('password');

        expect((await call('PUT', '/api/rdp/options', { serverId: id, askPassword: false })).status).toBe(200);
        expect(await rdpOpen(socket, { serverId: id, credentials: 'saved' })).toMatchObject({ ok: true, password: PASSWORD });
        expect((await auditOf(id)).map((entry) => entry.command)).toEqual(['rdp ask-password off', 'rdp ask-password on']);
    });

    it('is refused for anything but a saved Windows server and a yes or no', async () => {
        const id = await saveWindows();
        const linux = (await call<{ data: { id: number } }>('POST', '/api/servers', { name: 'lin-2', ip: '10.0.0.1', type: 'linux', username: 'root', password: 'x' })).body.data.id;
        expect(await call('PUT', '/api/rdp/options', { serverId: id, askPassword: 'yes' })).toMatchObject({ status: 400, body: { code: 'INVALID_REQUEST' } });
        expect(await call('PUT', '/api/rdp/options', { serverId: linux, askPassword: true })).toMatchObject({ status: 400, body: { code: 'UNSUPPORTED_PURPOSE' } });
        expect(await call('GET', '/api/rdp/options?serverId=999999')).toMatchObject({ status: 404, body: { code: 'SERVER_NOT_FOUND' } });
        expect(await call('GET', '/api/rdp/options?serverId=nope')).toMatchObject({ status: 400, body: { code: 'INVALID_SERVER_ID' } });
    });
});

describe('the pinned certificate', () => {
    it('can be read without usable credentials', async () => {
        const quoted = await saveWindows({ username: 'al"ice' });
        expect(await call('GET', `/api/rdp/certificate?serverId=${quoted}`)).toMatchObject({ status: 200, body: { data: { host: '127.0.0.1', port: rdp.port, via: '' } } });

        const unreadable = await saveWindows();
        const { dbRun } = await import('../../server/db/sqlite');
        const { encryptWithKey } = await import('../../server/security/secrets');
        await dbRun('UPDATE servers SET password = ? WHERE id = ?', [encryptWithKey(randomBytes(32), 'old'), unreadable]);
        expect((await call('GET', `/api/rdp/certificate?serverId=${unreadable}`)).status).toBe(200);
        const { socket } = await openSocket();
        expect(await rdpOpen(socket, { serverId: unreadable, credentials: 'saved' })).toMatchObject({ ok: false, code: 'SECRET_UNREADABLE' });
        // W7 integration: asked for the password, the saved one is not needed.
        const prompted = await rdpOpen(socket, { serverId: unreadable, credentials: 'prompt', username: 'alice' });
        expect(prompted).toMatchObject({ ok: true, username: 'alice' });
        expect(prompted).not.toHaveProperty('password');
    });

    it('goes with its server, like the server\'s "ask for the password" option', async () => {
        const id = await saveWindows();
        expect((await call('PUT', '/api/rdp/options', { serverId: id, askPassword: true })).status).toBe(200);
        const { dbAll } = await import('../../server/db/sqlite');
        expect(await dbAll('SELECT key FROM settings WHERE key = ?', [`rdp_ask_password:${id}`])).toHaveLength(1);
        expect((await call('DELETE', `/api/servers/${id}`)).status).toBe(200);
        expect(await dbAll('SELECT key FROM settings WHERE key = ?', [`rdp_ask_password:${id}`])).toEqual([]);
    });
});

describe('an expired ticket', () => {
    it('is reported to the page that asked for it', async () => {
        const id = await saveWindows();
        const { socket, events } = await openSocket();
        const now = Date.now();
        const clock = vi.spyOn(Date, 'now');
        const opened = await rdpOpen(socket, { serverId: id, credentials: 'prompt' });
        if (!opened.ok) throw new Error(opened.error);
        clock.mockReturnValue(now + 31_000);
        try {
            expect(await rawUpgrade(server.port, { path: `/api/rdp/gateway?ticket=${encodeURIComponent(opened.ticket)}` })).toMatchObject({ status: 401 });
        } finally {
            clock.mockRestore();
        }
        await waitFor(() => events.some((event) => event.phase === 'failed'));
        expect(events.at(-1)).toMatchObject({ sessionId: opened.sessionId, error: { code: 'RDP_TICKET' } });
    });
});

describe('through a jump host', () => {
    let jump: SshHarness;

    beforeAll(async () => {
        // The jump host reaches "rdp-internal" at the fake RDP server.
        jump = await startSshServer({ forward: (host, port) => (host === 'rdp-internal' ? { host: '127.0.0.1', port: rdp.port } : { host, port }) });
    });

    afterAll(async () => {
        await jump?.close();
    });

    it('goes through the jump host and pins the certificate for that route', async () => {
        const jumpId = (await call<{ data: { id: number } }>('POST', '/api/servers', {
            name: 'bastion', ip: '127.0.0.1', type: 'linux', port: jump.port, username: 'tester', password: 'secret',
        })).body.data.id;
        const id = await saveWindows({ ip: 'rdp-internal', port: 3389, jump_server_id: jumpId });
        const { answer, gateway, events, opened } = await handshake(id);
        expect(opened).toMatchObject({ ok: true, via: 'bastion', destination: 'rdp-internal:3389' });
        expect(answer.error).toBeUndefined();
        expect(answer.serverAddr).toBe('rdp-internal:3389');
        expect(jump.log).toContain('tcpip:rdp-internal:3389');
        gateway.ws.send(new TextEncoder().encode('via jump'));
        expect((await gateway.next()).toString()).toBe('echo:via jump');
        await waitFor(() => events.some((event) => event.phase === 'established'));
        expect(events.find((event) => event.phase === 'established')?.certificate).toMatchObject({ host: 'rdp-internal', port: 3389, via: `127.0.0.1:${jump.port}` });
        gateway.ws.close();
    });

    it('reports a jump host that cannot reach the server', async () => {
        const jumpId = (await call<{ data: { id: number } }>('POST', '/api/servers', {
            name: 'bastion-2', ip: '127.0.0.1', type: 'linux', port: jump.port, username: 'tester', password: 'wrong',
        })).body.data.id;
        const id = await saveWindows({ ip: 'rdp-internal', port: 3389, jump_server_id: jumpId });
        const { answer, events } = await handshake(id);
        expect(answer.error?.errorCode).toBe(1);
        await waitFor(() => events.some((event) => event.phase === 'failed'));
        expect(events.at(-1)?.error).toMatchObject({ code: 'RDP_JUMP_FAILED', details: { jump: 'bastion-2' } });
    });
});
