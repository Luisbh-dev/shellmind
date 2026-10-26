import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import net from 'node:net';
import { connectionRequest, digitalSignatureCertificate, FALLBACK_LOG, KEY_USAGE, keyEnciphermentCertificate, keyUsageOf, rdpTlsProblem, rsaCertificate, startInterceptingRelay } from '../../scripts/check-rdp-tls.mjs';
import { SMOKE_SCRIPTS } from '../../scripts/smoke-linux-distros.mjs';
import { parseConnectionRequest } from '../../server/rdp/x224';
import { selfSignedCertificate } from '../helpers/rdpServer';

// scripts/check-rdp-tls.mjs, which smoke:packaged runs on every package: the
// RDP gateway under the app's own runtime (BoringSSL) against a server whose
// certificate does not allow digital signatures, like Windows' own, and
// against an attacker in the middle who tries to force its fallback.

describe('the certificate of the check', () => {
    it("is what Windows makes for RDP: self-signed RSA, key encipherment and data encipherment only, server authentication", () => {
        const certificate = keyEnciphermentCertificate('WIN-RDP');
        const parsed = new X509Certificate(certificate.der);
        expect(parsed.subject).toBe('CN=WIN-RDP');
        expect(parsed.issuer).toBe('CN=WIN-RDP');
        expect(parsed.publicKey.asymmetricKeyType).toBe('rsa');
        expect(parsed.verify(parsed.publicKey)).toBe(true);
        expect(parsed.fingerprint256).toBe(certificate.fingerprint256);
        expect(new X509Certificate(certificate.cert).fingerprint256).toBe(certificate.fingerprint256);
        // Node calls the extended key usage "keyUsage".
        expect(parsed.keyUsage).toEqual(['1.3.6.1.5.5.7.3.1']);
        expect(keyUsageOf(certificate.der)).toBe(KEY_USAGE.keyEncipherment | KEY_USAGE.dataEncipherment);
        expect(keyUsageOf(certificate.der)! & KEY_USAGE.digitalSignature).toBe(0);
        expect(Date.parse(parsed.validTo)).toBeGreaterThan(Date.now());
    });

    it('is new each time, and a certificate without key usage has none', () => {
        expect(keyEnciphermentCertificate().fingerprint256).not.toBe(keyEnciphermentCertificate().fingerprint256);
        expect(keyUsageOf(selfSignedCertificate('ecdsa').der)).toBeNull();
        expect(keyUsageOf(rsaCertificate('any-use', null).der)).toBeNull();
    });

    it("has a counterpart whose key usage allows digital signatures, the attacker's target", () => {
        const certificate = digitalSignatureCertificate('GOOD-RDP');
        const parsed = new X509Certificate(certificate.der);
        expect(parsed.subject).toBe('CN=GOOD-RDP');
        expect(parsed.verify(parsed.publicKey)).toBe(true);
        expect(keyUsageOf(certificate.der)).toBe(KEY_USAGE.digitalSignature | KEY_USAGE.keyEncipherment);
        expect(keyUsageOf(rsaCertificate('data', KEY_USAGE.dataEncipherment).der)).toBe(KEY_USAGE.dataEncipherment);
    });

    it('comes with the Connection Request of an RDP client', () => {
        expect(parseConnectionRequest(connectionRequest())).toEqual({ cookie: 'Cookie: mstshash=check', requestedProtocols: 0x0b });
    });
});

describe('the outcome of the check', () => {
    const fingerprint256 = 'AA:BB';
    const electron = { electron: '45.0.0', node: '24.22.0', openssl: '0.0.0' };
    const refused = {
        ok: false as const, stage: 'connect', code: 'RDP_TLS_FAILED',
        message: 'The TLS handshake with 127.0.0.1:2 failed: the first certificate was refused for its key usage (no digital signatures), but the one presented when connecting again with TLS 1.2 and RSA key exchange did not need that: it allows digital signatures. The connection may be intercepted to take away its forward secrecy.',
    };
    const fallback = { ok: true as const, runtime: electron, rsaKeyExchange: true, protocol: 'TLSv1.2', cipher: 'AES256-GCM-SHA384', fingerprint256, missingCiphers: [], intercepted: refused };
    const seen = { fingerprint256, connections: 2, handshakes: [{ protocol: 'TLSv1.2', cipher: 'AES256-GCM-SHA384' }], fallbackLogLines: 1, relayed: ['attacker', 'server'] };
    // A runtime that accepts certificates without Digital Signature (OpenSSL)
    // secures the attacker's connection directly: the pin is what catches it.
    const direct = {
        ...fallback, runtime: { electron: null, node: '24.20.0', openssl: '3.5.7' }, rsaKeyExchange: false, protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384',
        intercepted: { ok: true as const, rsaKeyExchange: false, protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384', fingerprint256: 'EE:FF' },
    };
    const directSeen = { ...seen, connections: 1, handshakes: [{ protocol: 'TLSv1.3', cipher: 'TLS_AES_256_GCM_SHA384' }], fallbackLogLines: 0, relayed: ['attacker'] };

    it('passes the fallback to RSA key exchange, and a runtime that needs none', () => {
        expect(rdpTlsProblem(fallback, seen)).toBeNull();
        expect(rdpTlsProblem(direct, directSeen)).toBeNull();
    });

    it("fails a fallback list with suites the runtime does not know (BoringSSL leaves them out)", () => {
        expect(rdpTlsProblem({ ...fallback, missingCiphers: ['AES256-SHA256', 'AES128-SHA256'] }, seen))
            .toBe("the runtime does not know AES256-SHA256, AES128-SHA256 of the fallback's suites (RSA_KEY_EXCHANGE_CIPHERS in server/rdp/connect.ts), and leaves them out");
        expect(rdpTlsProblem({ ...refused, runtime: electron, missingCiphers: ['AES256-GCM-SHA384'] }, seen)).toMatch(/^the runtime does not know AES256-GCM-SHA384 /);
    });

    it('fails a fallback an attacker in the middle forced on a server whose certificate allows digital signatures', () => {
        const forced = { ok: true as const, rsaKeyExchange: true, protocol: 'TLSv1.2', cipher: 'AES256-GCM-SHA384', fingerprint256: 'CC:DD' };
        expect(rdpTlsProblem({ ...fallback, intercepted: forced }, seen))
            .toBe('an attacker in the middle forced TLS 1.2 with RSA key exchange, without forward secrecy, on a server whose certificate allows digital signatures (TLSv1.2 AES256-GCM-SHA384)');
        expect(rdpTlsProblem({ ...direct, intercepted: forced }, directSeen)).toMatch(/^an attacker in the middle forced TLS 1\.2/);
        expect(rdpTlsProblem({ ...fallback, intercepted: undefined }, seen)).toBe('the runtime reported nothing of the connection through the attacker in the middle');
        expect(rdpTlsProblem({ ...fallback, intercepted: { ...refused, code: 'RDP_TIMEOUT', message: 'The TLS handshake with 127.0.0.1:2 timed out.' } }, seen))
            .toBe('the gateway should refuse the connection through the attacker in the middle as possibly intercepted, it failed otherwise (RDP_TIMEOUT): The TLS handshake with 127.0.0.1:2 timed out.');
        expect(rdpTlsProblem({ ...fallback, intercepted: direct.intercepted }, seen)).toMatch(/^the connection through the attacker in the middle was secured directly \(TLSv1\.3 TLS_AES_256_GCM_SHA384\)/);
        expect(rdpTlsProblem(fallback, { ...seen, relayed: ['attacker'] })).toBe("the refused fallback should have taken the attacker's connection, then the server's; the relay saw attacker");
        expect(rdpTlsProblem(direct, { ...directSeen, relayed: [] })).toBeNull();
        expect(rdpTlsProblem({ ...direct, intercepted: refused }, directSeen)).toMatch(/^the connection through the attacker in the middle should be secured directly, as the server's was: /);
    });

    it('fails a connection that was not secured, with what the gateway said', () => {
        expect(rdpTlsProblem(null, seen)).toBe('the runtime reported no result');
        expect(rdpTlsProblem({ ok: false, runtime: electron, stage: 'connect', code: 'RDP_TLS_FAILED', message: 'The TLS handshake with 127.0.0.1:1 failed: ...KEY_USAGE_BIT_INCORRECT...' }, seen))
            .toBe('the gateway could not secure the connection (connect): The TLS handshake with 127.0.0.1:1 failed: ...KEY_USAGE_BIT_INCORRECT...');
        expect(rdpTlsProblem({ ok: false, stage: 'load', message: "Cannot find module 'connect.js'" }, seen)).toMatch(/^the gateway could not secure the connection \(load\)/);
    });

    it('fails another certificate, and a fallback that is not one', () => {
        expect(rdpTlsProblem({ ...fallback, fingerprint256: 'CC:DD' }, seen)).toBe("the gateway got another certificate (CC:DD) than the server's (AA:BB)");
        expect(rdpTlsProblem(fallback, { ...seen, connections: 1 })).toBe('the fallback should take a second connection, the server saw 1');
        expect(rdpTlsProblem({ ...fallback, cipher: 'ECDHE-RSA-AES256-GCM-SHA384' }, seen)).toMatch(/^the fallback should be TLS 1\.2 with RSA key exchange, it was TLSv1\.2 ECDHE-RSA-AES256-GCM-SHA384/);
        expect(rdpTlsProblem({ ...fallback, protocol: 'TLSv1.3' }, seen)).toMatch(/^the fallback should be TLS 1\.2/);
        expect(rdpTlsProblem(fallback, { ...seen, handshakes: [] })).toMatch(/\(the server saw no handshake\)$/);
        expect(rdpTlsProblem(fallback, { ...seen, fallbackLogLines: 0 })).toBe('the gateway should log the fallback once at info level, it logged it 0 times');
        expect(rdpTlsProblem(fallback, { ...seen, fallbackLogLines: 2 })).toMatch(/logged it 2 times$/);
    });

    it("looks for the gateway's own log line", () => {
        const source = fs.readFileSync(fileURLToPath(new URL('../../server/rdp/connect.ts', import.meta.url)), 'utf8');
        expect(source).toContain(FALLBACK_LOG);
    });
});

describe('the attacker in the middle', () => {
    // A server that answers each connection with its name and closes it.
    const named = async (name: string) => {
        const server = net.createServer((socket) => socket.end(name));
        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        return { port: (server.address() as net.AddressInfo).port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
    };
    const read = (port: number) => new Promise<string>((resolve, reject) => {
        let text = '';
        net.connect(port, '127.0.0.1').on('data', (chunk) => { text += chunk; }).on('end', () => resolve(text)).on('error', reject);
    });

    it('answers the next connections it is told to itself, and passes the others on untouched', async () => {
        const attacker = await named('attacker');
        const server = await named('server');
        const relay = await startInterceptingRelay({ attacker: attacker.port, server: server.port });
        try {
            expect([await read(relay.port), await read(relay.port), await read(relay.port)]).toEqual(['attacker', 'server', 'server']);
            relay.intercept = 1;
            expect([await read(relay.port), await read(relay.port)]).toEqual(['attacker', 'server']);
            expect(relay.connections).toEqual(['attacker', 'server', 'server', 'attacker', 'server']);
        } finally {
            await relay.close();
            await Promise.all([attacker.close(), server.close()]);
        }
    });
});

describe('smoke:packaged', () => {
    const script = (name: string) => fs.readFileSync(fileURLToPath(new URL(`../../scripts/${name}`, import.meta.url)), 'utf8');

    it('runs the check on the package it checks', () => {
        const smoke = script('smoke-packaged.mjs');
        expect(smoke).toContain("import { checkRdpTls } from './check-rdp-tls.mjs';");
        expect(smoke).toMatch(/await checkBackend\(app\.exe, asar\);\s+await checkRdpGatewayTls\(app\.exe, asar\);/);
    });

    it("has every module it imports mounted into the distributions' containers", () => {
        const local = [...script('smoke-packaged.mjs').matchAll(/from '\.\/([^']+)'/g)].map(([, name]) => name);
        expect(local).toContain('check-rdp-tls.mjs');
        expect(SMOKE_SCRIPTS).toEqual(['smoke-packaged.mjs', ...local]);
    });
});
