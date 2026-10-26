import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import { vi } from 'vitest';
import { KEY_USAGE, keyUsageOf } from '../../scripts/check-rdp-tls.mjs';
import { encodeTlv, write } from '../../server/rdp/der';
import { parseConnectionRequest, readTpktFrame } from '../../server/rdp/x224';

// A fake RDP server for gateway tests: it answers the X.224 Connection
// Request, upgrades to TLS with a self-signed certificate of its own and then
// echoes what it receives (prefixed with "echo:"). And the X.224 / X.509
// builders the tests need, and BoringSSL's key usage rule for tls.connect.

// --- self-signed certificates ---

function oid(dotted: string): Buffer {
    const [first, second, ...rest] = dotted.split('.').map(Number);
    const bytes = [first * 40 + second];
    for (const part of rest) {
        const chunk: number[] = [];
        let value = part;
        do {
            chunk.unshift(value & 0x7f);
            value >>= 7;
        } while (value > 0);
        for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
        bytes.push(...chunk);
    }
    return encodeTlv(0x06, Buffer.from(bytes));
}

function time(date: Date): Buffer {
    const iso = date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    // UTCTime until 2049, GeneralizedTime after (RFC 5280).
    return date.getUTCFullYear() < 2050 ? encodeTlv(0x17, Buffer.from(`${iso.slice(2)}Z`)) : encodeTlv(0x18, Buffer.from(`${iso}Z`));
}

const name = (commonName: string) => write.sequence([encodeTlv(0x31, write.sequence([oid('2.5.4.3'), write.utf8(commonName)]))]);

export type TestCertificate = { key: string; cert: string; der: Buffer };

// An ECDSA P-256 certificate for `commonName`, signed by its own key.
export function selfSignedCertificate(commonName: string, validDays = 365): TestCertificate {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const algorithm = write.sequence([oid('1.2.840.10045.4.3.2')]);
    const now = Date.now();
    const tbs = write.sequence([
        write.explicit(0, write.unsigned(2)),
        encodeTlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
        algorithm,
        name(commonName),
        write.sequence([time(new Date(now - 3600_000)), time(new Date(now + validDays * 86_400_000))]),
        name(commonName),
        publicKey.export({ type: 'spki', format: 'der' }),
    ]);
    const signature = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
    const der = write.sequence([tbs, algorithm, encodeTlv(0x03, Buffer.concat([Buffer.from([0]), signature]))]);
    const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
    return { key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(), cert, der };
}

// --- X.224 ---

// The Connection Request an RDP client sends: mstshash cookie and RDP_NEG_REQ.
export function connectionRequest(options: { user?: string; protocols?: number | null } = {}): Buffer {
    const cookie = Buffer.from(`Cookie: mstshash=${options.user ?? 'tester'}\r\n`, 'latin1');
    const protocols = options.protocols === undefined ? 0x0b : options.protocols;
    const negotiation = protocols === null ? Buffer.alloc(0) : Buffer.from([0x01, 0x00, 0x08, 0x00, protocols & 0xff, (protocols >> 8) & 0xff, 0, 0]);
    const body = Buffer.concat([Buffer.from([0, 0xe0, 0, 0, 0x12, 0x34, 0]), cookie, negotiation]);
    body[0] = body.length - 1;
    const frame = Buffer.concat([Buffer.from([3, 0, 0, 0]), body]);
    frame.writeUInt16BE(frame.length, 2);
    return frame;
}

export function connectionConfirm(negotiation: { type: 'response' | 'failure'; value: number } | null): Buffer {
    const data = negotiation
        ? Buffer.from([negotiation.type === 'response' ? 0x02 : 0x03, 0x00, 0x08, 0x00, negotiation.value & 0xff, 0, 0, 0])
        : Buffer.alloc(0);
    const body = Buffer.concat([Buffer.from([0, 0xd0, 0, 0, 0x12, 0x34, 0]), data]);
    body[0] = body.length - 1;
    const frame = Buffer.concat([Buffer.from([3, 0, 0, 0]), body]);
    frame.writeUInt16BE(frame.length, 2);
    return frame;
}

// --- the server ---

export type FakeRdpBehaviour =
    // Negotiates HYBRID_EX, upgrades to TLS and echoes.
    | 'rdp'
    // RDP_NEG_FAILURE HYBRID_REQUIRED_BY_SERVER.
    | 'refuse'
    // A confirm without negotiation data (standard RDP security only).
    | 'legacy'
    // Never answers the request.
    | 'silent'
    // Answers something that is not TPKT.
    | 'garbage'
    // Confirms, then closes the connection instead of the TLS handshake.
    | 'drop-tls';

export type FakeRdpServer = {
    host: '127.0.0.1';
    port: number;
    // "request:<cookie>:<protocols>", "tls", "data:<text>", "closed".
    log: string[];
    // Each completed TLS handshake: its version and cipher (OpenSSL name).
    handshakes: Array<{ protocol: string | null; cipher: string }>;
    certificate: TestCertificate;
    behaviour: FakeRdpBehaviour;
    setCertificate: (certificate: TestCertificate) => void;
    openConnections: () => number;
    close: () => Promise<void>;
};

export type FakeRdpOptions = {
    certificate?: TestCertificate;
    behaviour?: FakeRdpBehaviour;
    // The server's TLS settings (cipher suites, versions).
    tls?: Pick<tls.TlsOptions, 'ciphers' | 'minVersion' | 'maxVersion'>;
};

export async function startFakeRdpServer(options: FakeRdpOptions = {}): Promise<FakeRdpServer> {
    const sockets = new Set<net.Socket>();
    const state: FakeRdpServer = {
        host: '127.0.0.1',
        port: 0,
        log: [],
        handshakes: [],
        certificate: options.certificate ?? selfSignedCertificate('fake-rdp'),
        behaviour: options.behaviour ?? 'rdp',
        setCertificate: (certificate) => { state.certificate = certificate; },
        openConnections: () => sockets.size,
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };

    const server = net.createServer(async (socket) => {
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => {
            sockets.delete(socket);
            state.log.push('closed');
        });
        let frame: Buffer;
        try {
            frame = await readTpktFrame(socket, 10_000);
        } catch {
            socket.destroy();
            return;
        }
        const request = parseConnectionRequest(frame);
        state.log.push(`request:${request.cookie}:${request.requestedProtocols}`);
        switch (state.behaviour) {
            case 'silent':
                return;
            case 'garbage':
                socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
                return;
            case 'legacy':
                socket.write(connectionConfirm(null));
                return;
            case 'refuse':
                socket.end(connectionConfirm({ type: 'failure', value: 5 }));
                return;
            default:
                break;
        }
        socket.write(connectionConfirm({ type: 'response', value: 0x08 }));
        if (state.behaviour === 'drop-tls') {
            socket.destroy();
            return;
        }
        const secure = new tls.TLSSocket(socket, { isServer: true, key: state.certificate.key, cert: state.certificate.cert, ...options.tls });
        secure.on('error', () => undefined);
        secure.once('secure', () => {
            state.log.push('tls');
            state.handshakes.push({ protocol: secure.getProtocol(), cipher: secure.getCipher().name });
        });
        secure.on('data', (data: Buffer) => {
            const text = data.toString('utf8');
            state.log.push(`data:${text}`);
            if (text === 'bye') secure.end();
            else secure.write(`echo:${text}`);
        });
        socket.resume();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    state.port = (server.address() as net.AddressInfo).port;
    return state;
}

// --- BoringSSL's key usage rule ---

// BoringSSL, the TLS library of Electron's Node (the desktop app's backend),
// refuses a server certificate whose key usage does not allow the key
// exchange: digitalSignature for TLS 1.3 and ECDHE, keyEncipherment for RSA
// key exchange. OpenSSL, under the tests, does not check it.

// The error BoringSSL's refusal reaches Node's TLS socket with (Electron 45).
export function boringSslKeyUsageError(): Error {
    return Object.assign(
        new Error(String.raw`106624:error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:..\..\third_party\boringssl\src\ssl\ssl_cert.cc:403:` + '\n'),
        { library: 'SSL routines', reason: 'KEY_USAGE_BIT_INCORRECT', code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT' },
    );
}

function refusedByBoringSsl(socket: tls.TLSSocket): boolean {
    // Not getPeerX509Certificate(): on Node 24 every later peer certificate
    // call of the socket (the gateway's) comes back empty after it.
    const der = socket.getPeerCertificate().raw as Buffer | undefined;
    const usage = der ? keyUsageOf(der) : null;
    if (usage === null) return false;
    const signed = socket.getProtocol() === 'TLSv1.3' || !socket.getCipher().standardName.startsWith('TLS_RSA_');
    return (usage & (signed ? KEY_USAGE.digitalSignature : KEY_USAGE.keyEncipherment)) === 0;
}

// Makes tls.connect refuse what BoringSSL refuses, with its error, instead of
// reporting the connection secured. Records the options of every call;
// onRefused runs at each refusal.
export function enforceKeyUsageLikeBoringSsl(options: { onRefused?: () => void } = {}): { calls: tls.ConnectionOptions[]; restore: () => void } {
    const connect = tls.connect;
    const calls: tls.ConnectionOptions[] = [];
    const spy = vi.spyOn(tls, 'connect').mockImplementation(((connectOptions: tls.ConnectionOptions) => {
        calls.push(connectOptions);
        const socket = connect(connectOptions);
        const emit = socket.emit.bind(socket);
        socket.emit = ((event: string | symbol, ...args: unknown[]) => {
            if (event === 'secureConnect' && refusedByBoringSsl(socket)) {
                socket.destroy(boringSslKeyUsageError());
                options.onRefused?.();
                return true;
            }
            return emit(event, ...args);
        }) as typeof socket.emit;
        return socket;
    }) as typeof tls.connect);
    return { calls, restore: () => spy.mockRestore() };
}
