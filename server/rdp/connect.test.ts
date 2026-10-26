import { PassThrough } from 'node:stream';
import tls from 'node:tls';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { digitalSignatureCertificate, KEY_USAGE, keyEnciphermentCertificate, rsaCertificate, startInterceptingRelay, startRdpTlsServer } from '../../scripts/check-rdp-tls.mjs';
import { boringSslKeyUsageError, connectionRequest, enforceKeyUsageLikeBoringSsl, selfSignedCertificate } from '../../test/helpers/rdpServer';
import { connectRdpServer, fallbackCertificateProblem, isKeyUsageRefusal, rdpTlsOptions, RSA_KEY_EXCHANGE_CIPHERS, tlsParameters, type RdpConnection } from './connect';
import { RdpGatewayFailure } from './failure';
import type { RdpRoute } from './route';

describe('isKeyUsageRefusal', () => {
    it("recognises BoringSSL's refusal by its code, its reason or its message", () => {
        expect(isKeyUsageRefusal(boringSslKeyUsageError())).toBe(true);
        expect(isKeyUsageRefusal(Object.assign(new Error('handshake failed'), { code: 'ERR_SSL_KEY_USAGE_BIT_INCORRECT' }))).toBe(true);
        expect(isKeyUsageRefusal(Object.assign(new Error('handshake failed'), { reason: 'KEY_USAGE_BIT_INCORRECT' }))).toBe(true);
        expect(isKeyUsageRefusal(new Error('error:1000012e:SSL routines:OPENSSL_internal:KEY_USAGE_BIT_INCORRECT:ssl_cert.cc:403:'))).toBe(true);
        expect(isKeyUsageRefusal('error:1000012e:SSL routines:OPENSSL_internal:key_usage_bit_incorrect')).toBe(true);
    });

    it('leaves every other failure alone', () => {
        for (const err of [
            new Error('socket hang up'),
            Object.assign(new Error('Client network socket disconnected before secure TLS connection was established'), { code: 'ECONNRESET' }),
            Object.assign(new Error('ssl3_read_bytes:sslv3 alert handshake failure'), { code: 'ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE', reason: 'sslv3 alert handshake failure' }),
            Object.assign(new Error('wrong version number'), { reason: 'KEY_USAGE_BIT_INCORRECT_SOMETHING' }),
            new RdpGatewayFailure('RDP_TIMEOUT', 'The TLS handshake with 10.0.0.5:3389 timed out.'),
            null,
            undefined,
            42,
        ]) {
            expect(isKeyUsageRefusal(err)).toBe(false);
        }
    });
});

describe('rdpTlsOptions', () => {
    const stream = new PassThrough();

    it('offers TLS 1.2 and later with the default suites first, without checking the CA (the certificate is pinned)', () => {
        expect(rdpTlsOptions(stream, 'rdp.example', false)).toEqual({ socket: stream, rejectUnauthorized: false, servername: 'rdp.example', minVersion: 'TLSv1.2' });
        expect(rdpTlsOptions(stream, '10.0.0.5', false).servername).toBeUndefined();
        expect(rdpTlsOptions(stream, 'fe80::1', false).servername).toBeUndefined();
    });

    it('falls back to TLS 1.2 with suites of RSA key exchange only, which OpenSSL knows and BoringSSL has', () => {
        expect(rdpTlsOptions(stream, 'rdp.example', true)).toEqual({
            socket: stream, rejectUnauthorized: false, servername: 'rdp.example', minVersion: 'TLSv1.2', maxVersion: 'TLSv1.2', ciphers: RSA_KEY_EXCHANGE_CIPHERS,
        });
        const suites = RSA_KEY_EXCHANGE_CIPHERS.split(':');
        // No ephemeral (EC)DH: nothing the server has to sign.
        expect(suites.filter((suite) => /DH/.test(suite))).toEqual([]);
        // This runtime's OpenSSL; scripts/check-rdp-tls.mjs checks Electron's BoringSSL.
        expect(suites.filter((suite) => !tls.getCiphers().includes(suite.toLowerCase()))).toEqual([]);
        // BoringSSL has no AES-CBC with SHA-256 or SHA-384 (it would drop them without a word).
        expect(suites.filter((suite) => /^AES\d+-SHA(256|384)$/.test(suite))).toEqual([]);
    });
});

describe('fallbackCertificateProblem', () => {
    it('accepts the fallback for a certificate that allows key encipherment and not digital signatures', () => {
        expect(fallbackCertificateProblem(keyEnciphermentCertificate('WIN-RDP').der)).toBeNull();
        expect(fallbackCertificateProblem(rsaCertificate('ke-only', KEY_USAGE.keyEncipherment).der)).toBeNull();
    });

    it('says why a certificate did not need the fallback', () => {
        expect(fallbackCertificateProblem(digitalSignatureCertificate('signing').der)).toBe('it allows digital signatures');
        expect(fallbackCertificateProblem(rsaCertificate('any-use', null).der)).toBe('it has no key usage extension, so it allows digital signatures');
        expect(fallbackCertificateProblem(rsaCertificate('data-only', KEY_USAGE.dataEncipherment).der)).toBe('it does not allow key encipherment either');
        expect(fallbackCertificateProblem(selfSignedCertificate('ecdsa').der)).toBe('it has no key usage extension, so it allows digital signatures');
        expect(fallbackCertificateProblem(undefined)).toBe('it presented no certificate');
        expect(fallbackCertificateProblem(Buffer.alloc(0))).toBe('it presented no certificate');
        expect(fallbackCertificateProblem(Buffer.from('not a certificate'))).toMatch(/^its key usage could not be read \(.+\)$/);
    });
});

describe('tlsParameters', () => {
    const secure = (protocol: string, name: string, standardName: string) =>
        ({ getProtocol: () => protocol, getCipher: () => ({ name, standardName, version: protocol }) }) as unknown as RdpConnection['secure'];

    it('tells a session with forward secrecy from one without', () => {
        expect(tlsParameters({ secure: secure('TLSv1.3', 'TLS_AES_256_GCM_SHA384', 'TLS_AES_256_GCM_SHA384'), rsaKeyExchange: false }))
            .toEqual({ protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', forwardSecrecy: true, keyUsageFallback: false });
        expect(tlsParameters({ secure: secure('TLSv1.2', 'ECDHE-RSA-AES256-GCM-SHA384', 'TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384'), rsaKeyExchange: false }))
            .toMatchObject({ forwardSecrecy: true });
        expect(tlsParameters({ secure: secure('TLSv1.2', 'DHE-RSA-AES256-GCM-SHA384', 'TLS_DHE_RSA_WITH_AES_256_GCM_SHA384'), rsaKeyExchange: false }))
            .toMatchObject({ forwardSecrecy: true });
        expect(tlsParameters({ secure: secure('TLSv1.2', 'AES256-GCM-SHA384', 'TLS_RSA_WITH_AES_256_GCM_SHA384'), rsaKeyExchange: true }))
            .toEqual({ protocol: 'TLSv1.2', cipher: 'TLS_RSA_WITH_AES_256_GCM_SHA384', forwardSecrecy: false, keyUsageFallback: true });
        // Without a standard name, the OpenSSL one.
        expect(tlsParameters({ secure: secure('TLSv1.2', 'ECDHE-RSA-AES128-SHA', ''), rsaKeyExchange: false })).toMatchObject({ cipher: 'ECDHE-RSA-AES128-SHA', forwardSecrecy: true });
        expect(tlsParameters({ secure: secure('TLSv1.2', 'AES128-SHA', ''), rsaKeyExchange: false })).toMatchObject({ cipher: 'AES128-SHA', forwardSecrecy: false });
    });

    it('does not throw for a socket that has lost its handle', () => {
        const closed = { getProtocol: () => null, getCipher: () => null } as unknown as RdpConnection['secure'];
        expect(tlsParameters({ secure: closed, rsaKeyExchange: true })).toEqual({ protocol: 'unknown', cipher: 'unknown', forwardSecrecy: false, keyUsageFallback: true });
    });
});

describe('connectRdpServer', () => {
    // Windows' self-signed RDP certificate: key encipherment, no digital signature.
    const certificate = keyEnciphermentCertificate('WIN-RDP');
    const limits = { connectTimeoutMs: 5_000, negotiationTimeoutMs: 5_000, tlsTimeoutMs: 5_000 };
    const deps = { acquire: () => Promise.reject(new Error('no jump host')) };
    let server: Awaited<ReturnType<typeof startRdpTlsServer>>;
    let log: MockInstance<typeof console.log>;
    const opened: RdpConnection[] = [];

    const route = (): RdpRoute => ({
        target: { kind: 'rdp', serverId: 1, name: 'win', host: '127.0.0.1', port: server.port, username: 'alice' },
        jump: null,
        via: '',
    });
    const connect = async (signal = new AbortController().signal, onSecuring?: () => void) => {
        const connection = await connectRdpServer(route(), connectionRequest(), { deps, limits, signal, onSecuring });
        opened.push(connection);
        return connection;
    };
    const fallbackLines = () => log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes('RSA key exchange'));

    beforeEach(async () => {
        server = await startRdpTlsServer(certificate);
        log = vi.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(async () => {
        for (const connection of opened.splice(0)) {
            connection.secure.destroy();
            connection.transport.close();
        }
        vi.restoreAllMocks();
        await server.close();
    });

    it('secures the connection at once where the runtime accepts the certificate (OpenSSL)', async () => {
        const securing = vi.fn();
        const connection = await connect(undefined, securing);
        expect(connection.rsaKeyExchange).toBe(false);
        expect(connection.secure.getProtocol()).toBe('TLSv1.3');
        expect(connection.secure.getPeerCertificate().fingerprint256).toBe(certificate.fingerprint256);
        expect(connection.confirm.subarray(-8, -4)).toEqual(Buffer.from([0x02, 0x00, 0x08, 0x00]));
        expect(securing).toHaveBeenCalledTimes(1);
        expect(server.connections).toBe(1);
        expect(fallbackLines()).toEqual([]);
        expect(tlsParameters(connection)).toEqual({ protocol: 'TLSv1.3', cipher: expect.stringMatching(/^TLS_/), forwardSecrecy: true, keyUsageFallback: false });
    });

    it("connects again with TLS 1.2 and RSA key exchange after BoringSSL's refusal, to the same certificate", async () => {
        const boringSsl = enforceKeyUsageLikeBoringSsl();
        const securing = vi.fn();
        const connection = await connect(undefined, securing);
        expect(connection.rsaKeyExchange).toBe(true);
        expect(connection.secure.getProtocol()).toBe('TLSv1.2');
        expect(connection.secure.getCipher().standardName).toMatch(/^TLS_RSA_WITH_/);
        expect(connection.secure.getPeerCertificate().fingerprint256).toBe(certificate.fingerprint256);
        expect(server.connections).toBe(2);
        expect(boringSsl.calls.map((options) => options.ciphers)).toEqual([undefined, RSA_KEY_EXCHANGE_CIPHERS]);
        // The page hears "securing" once.
        expect(securing).toHaveBeenCalledTimes(1);
        expect(fallbackLines()).toEqual([
            expect.stringMatching(new RegExp(`INFO \\[rdp\\] The first TLS handshake with 127\\.0\\.0\\.1:${server.port} was refused for the certificate's key usage`)),
        ]);
        expect(tlsParameters(connection)).toEqual({ protocol: 'TLSv1.2', cipher: 'TLS_RSA_WITH_AES_256_GCM_SHA384', forwardSecrecy: false, keyUsageFallback: true });
    });

    // An attacker in the middle answers the first connection with a
    // certificate without Digital Signature (the Windows-like server here),
    // which the runtime refuses, then passes the second one, with RSA key
    // exchange, to the real server untouched: its pinned certificate would match.
    it.each([
        ['allows digital signatures', () => digitalSignatureCertificate('GOOD-RDP'), 'it allows digital signatures'],
        ['has no key usage extension', () => rsaCertificate('ANY-USE', null), 'it has no key usage extension, so it allows digital signatures'],
    ])('refuses the fallback an attacker in the middle forces on a server whose certificate %s', async (_, make, problem) => {
        const boringSsl = enforceKeyUsageLikeBoringSsl();
        const genuine = await startRdpTlsServer(make());
        const relay = await startInterceptingRelay({ attacker: server.port, server: genuine.port });
        try {
            const intercepted = { ...route(), target: { ...route().target, port: relay.port } };
            const failure = await connectRdpServer(intercepted, connectionRequest(), { deps, limits, signal: new AbortController().signal }).then(
                (connection) => {
                    opened.push(connection);
                    throw new Error('the connection was secured');
                },
                (err: unknown) => err,
            );
            expect(failure).toBeInstanceOf(RdpGatewayFailure);
            expect(failure).toMatchObject({ code: 'RDP_TLS_FAILED', answer: { errorCode: 1, tlsAlertCode: 42 } });
            expect((failure as RdpGatewayFailure).message).toBe(
                `The TLS handshake with 127.0.0.1:${relay.port} failed: the first certificate was refused for its key usage (no digital signatures), but the one presented when connecting again with TLS 1.2 and RSA key exchange did not need that: ${problem}. The connection may be intercepted to take away its forward secrecy.`,
            );
            expect(relay.connections).toEqual(['attacker', 'server']);
            expect(genuine.handshakes).toEqual([{ protocol: 'TLSv1.2', cipher: 'AES256-GCM-SHA384' }]);
            expect(boringSsl.calls.map((options) => options.ciphers)).toEqual([undefined, RSA_KEY_EXCHANGE_CIPHERS]);
            // What it logs claims nothing of the server's certificate.
            expect(fallbackLines()).toEqual([expect.stringContaining(`The first TLS handshake with 127.0.0.1:${relay.port} was refused`)]);
        } finally {
            await relay.close();
            await genuine.close();
        }
    });

    it('stops when it is cancelled after the refusal, without connecting again', async () => {
        const controller = new AbortController();
        enforceKeyUsageLikeBoringSsl({ onRefused: () => controller.abort() });
        await expect(connect(controller.signal)).rejects.toMatchObject({ code: 'RDP_INTERNAL', message: 'The connection was cancelled.' });
        expect(server.connections).toBe(1);
        expect(fallbackLines()).toEqual([]);
    });
});
