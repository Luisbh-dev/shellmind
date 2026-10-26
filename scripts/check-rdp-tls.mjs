// `node scripts/check-rdp-tls.mjs [--runtime <exe>] [--server <dir>]`: checks
// that the RDP gateway secures a connection to a server whose certificate
// allows key encipherment but not digital signatures, as Windows' self-signed
// RDP certificates do, under the app's own runtime.
//
// BoringSSL, the TLS library of Electron's Node (the desktop app's backend),
// refuses such a certificate for TLS 1.3 and ECDHE key exchange
// (KEY_USAGE_BIT_INCORRECT); the gateway then connects again with TLS 1.2 and
// RSA key exchange (server/rdp/connect.ts). OpenSSL, under plain Node, accepts
// the certificate, so the test suite never sees that refusal: this check runs
// the gateway's connection code with ELECTRON_RUN_AS_NODE against a fake RDP
// server (X.224 Connection Confirm, then TLS) with such a certificate, made
// here with a new key. It also fails when
//   - the runtime does not know a suite of the fallback's list (BoringSSL
//     leaves it out without a word), and
//   - an attacker in the middle can force the fallback on a server whose
//     certificate allows digital signatures: a relay answers the first
//     connection with a certificate without Digital Signature and passes the
//     next one to such a server; the gateway must refuse that connection.
// `smoke:packaged` runs it on every package.
//   --runtime <exe>  the Electron executable (default: the project's electron)
//   --server <dir>   the compiled backend (default: dist-server, from
//                    `npm run build:server`)
import { spawn } from 'node:child_process';
import { generateKeyPairSync, randomBytes, sign, X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROBE_TIMEOUT_MS = 60_000;

// --- A self-signed RSA certificate (DER built by hand: Node cannot issue one) ---

function tlv(tag, value) {
    const length = value.length < 0x80
        ? Buffer.from([value.length])
        : (() => {
            const bytes = [];
            for (let rest = value.length; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
            return Buffer.from([0x80 | bytes.length, ...bytes]);
        })();
    return Buffer.concat([Buffer.from([tag]), length, value]);
}

const sequence = (...items) => tlv(0x30, Buffer.concat(items));
const explicit = (n, inner) => tlv(0xa0 | n, inner);
const DER_NULL = Buffer.from([0x05, 0x00]);
const DER_TRUE = Buffer.from([0x01, 0x01, 0xff]);

function oid(dotted) {
    const [first, second, ...rest] = dotted.split('.').map(Number);
    const bytes = [first * 40 + second];
    for (const part of rest) {
        const chunk = [];
        let value = part;
        do {
            chunk.unshift(value & 0x7f);
            value = Math.floor(value / 128);
        } while (value > 0);
        for (let i = 0; i < chunk.length - 1; i += 1) chunk[i] |= 0x80;
        bytes.push(...chunk);
    }
    return tlv(0x06, Buffer.from(bytes));
}

const utcTime = (date) => tlv(0x17, Buffer.from(`${date.toISOString().replace(/[-:T]/g, '').slice(2, 14)}Z`));
const commonNameOf = (name) => sequence(tlv(0x31, sequence(oid('2.5.4.3'), tlv(0x0c, Buffer.from(name, 'utf8')))));

// KeyUsage bits (RFC 5280 4.2.1.3) in the first byte of the BIT STRING.
export const KEY_USAGE = { digitalSignature: 0x80, keyEncipherment: 0x20, dataEncipherment: 0x10 };

// The KeyUsage BIT STRING of `bits` (one byte): DER leaves out the trailing zero bits.
function keyUsageBitString(bits) {
    if (bits === 0) return tlv(0x03, Buffer.from([0x00]));
    let unused = 0;
    while (!(bits & (1 << unused))) unused += 1;
    return tlv(0x03, Buffer.from([unused, bits]));
}

/**
 * A self-signed RSA certificate for `commonName` whose extended key usage is
 * server authentication and whose key usage is `keyUsage` (KEY_USAGE bits;
 * null: no key usage extension, the key may be used for anything).
 * @param {string} commonName
 * @param {number | null} keyUsage
 * @returns {{ key: string, cert: string, der: Buffer, fingerprint256: string }}
 */
export function rsaCertificate(commonName, keyUsage) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const algorithm = sequence(oid('1.2.840.113549.1.1.11'), DER_NULL);
    const now = Date.now();
    const extensions = sequence(
        ...(keyUsage === null ? [] : [sequence(oid('2.5.29.15'), DER_TRUE, tlv(0x04, keyUsageBitString(keyUsage)))]),
        sequence(oid('2.5.29.37'), tlv(0x04, sequence(oid('1.3.6.1.5.5.7.3.1')))),
    );
    const tbs = sequence(
        explicit(0, tlv(0x02, Buffer.from([0x02]))),
        tlv(0x02, Buffer.concat([Buffer.from([0x01]), randomBytes(15)])),
        algorithm,
        commonNameOf(commonName),
        sequence(utcTime(new Date(now - 3600_000)), utcTime(new Date(now + 30 * 86_400_000))),
        commonNameOf(commonName),
        publicKey.export({ type: 'spki', format: 'der' }),
        explicit(3, extensions),
    );
    const signature = sign('sha256', tbs, privateKey);
    const der = sequence(tbs, algorithm, tlv(0x03, Buffer.concat([Buffer.from([0x00]), signature])));
    const cert = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').replace(/.{1,64}/g, '$&\n')}-----END CERTIFICATE-----\n`;
    return {
        key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
        cert,
        der,
        fingerprint256: new X509Certificate(der).fingerprint256,
    };
}

/**
 * What Windows makes for RDP: a self-signed RSA certificate whose key usage is
 * key encipherment and data encipherment only (no digital signature).
 * @param {string} [commonName]
 */
export function keyEnciphermentCertificate(commonName = 'shellmind-rdp-check') {
    return rsaCertificate(commonName, KEY_USAGE.keyEncipherment | KEY_USAGE.dataEncipherment);
}

/**
 * An RSA certificate whose key usage allows digital signatures and key
 * encipherment, like one a CA issues for TLS servers.
 * @param {string} [commonName]
 */
export function digitalSignatureCertificate(commonName = 'shellmind-rdp-check-signing') {
    return rsaCertificate(commonName, KEY_USAGE.digitalSignature | KEY_USAGE.keyEncipherment);
}

/**
 * The key usage bits of a DER certificate (first byte of the BIT STRING), or
 * null when it has no key usage extension.
 * @param {Buffer} der
 * @returns {number | null}
 */
export function keyUsageOf(der) {
    const at = der.indexOf(oid('2.5.29.15'));
    if (at < 0) return null;
    let offset = at + 5;
    // critical BOOLEAN (DEFAULT FALSE: only present when true)
    if (der[offset] === 0x01) offset += 3;
    // OCTET STRING { BIT STRING { unused bits, bits... } }
    if (der[offset] !== 0x04 || der[offset + 2] !== 0x03) return null;
    return der[offset + 5] ?? 0;
}

// --- A fake RDP server: X.224 Connection Confirm, then TLS ---

/**
 * The X.224 Connection Request an RDP client sends (mstshash cookie,
 * RDP_NEG_REQ for TLS, CredSSP and CredSSP with Early User Authorization).
 * @returns {Buffer}
 */
export function connectionRequest() {
    const cookie = Buffer.from('Cookie: mstshash=check\r\n', 'latin1');
    const negotiation = Buffer.from([0x01, 0x00, 0x08, 0x00, 0x0b, 0x00, 0x00, 0x00]);
    const body = Buffer.concat([Buffer.from([0, 0xe0, 0, 0, 0x12, 0x34, 0]), cookie, negotiation]);
    body[0] = body.length - 1;
    const frame = Buffer.concat([Buffer.from([3, 0, 0, 0]), body]);
    frame.writeUInt16BE(frame.length, 2);
    return frame;
}

// RDP_NEG_RSP selecting CredSSP with Early User Authorization, like Windows.
function connectionConfirm() {
    const body = Buffer.from([6, 0xd0, 0, 0, 0x12, 0x34, 0, 0x02, 0x00, 0x08, 0x00, 0x08, 0, 0, 0]);
    body[0] = body.length - 1;
    const frame = Buffer.concat([Buffer.from([3, 0, 0, 0]), body]);
    frame.writeUInt16BE(frame.length, 2);
    return frame;
}

/**
 * Serves RDP's start on a loopback port: reads a TPKT frame, answers with a
 * Connection Confirm, then does TLS with `certificate`. Records each
 * connection and each completed handshake.
 * @param {{ key: string, cert: string }} certificate
 */
export async function startRdpTlsServer(certificate) {
    const sockets = new Set();
    const state = {
        port: 0,
        connections: 0,
        /** @type {{ protocol: string | null, cipher: string }[]} */
        handshakes: [],
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => server.close(() => resolve(undefined)));
        },
    };
    const server = net.createServer((socket) => {
        state.connections += 1;
        sockets.add(socket);
        socket.on('error', () => undefined);
        socket.on('close', () => sockets.delete(socket));
        let buffered = Buffer.alloc(0);
        const onData = (chunk) => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length < 4 || buffered.length < buffered.readUInt16BE(2)) return;
            socket.off('data', onData);
            socket.pause();
            socket.write(connectionConfirm());
            const secure = new tls.TLSSocket(socket, { isServer: true, key: certificate.key, cert: certificate.cert });
            secure.on('error', () => undefined);
            secure.once('secure', () => state.handshakes.push({ protocol: secure.getProtocol(), cipher: secure.getCipher().name }));
            socket.resume();
        };
        socket.on('data', onData);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
    state.port = /** @type {net.AddressInfo} */ (server.address()).port;
    return state;
}

/**
 * An attacker in the middle on a loopback port: it passes every connection,
 * untouched, to the `server` port, except the next `intercept` ones, which go
 * to the `attacker` port (a server with a certificate of its own).
 * @param {{ attacker: number, server: number, intercept?: number }} ports
 */
export async function startInterceptingRelay({ attacker, server: upstreamPort, intercept = 1 }) {
    const sockets = new Set();
    const state = {
        port: 0,
        // How many of the next connections go to the attacker.
        intercept,
        /** @type {('attacker' | 'server')[]} */
        connections: [],
        close: async () => {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => relay.close(() => resolve(undefined)));
        },
    };
    const relay = net.createServer((client) => {
        const toAttacker = state.intercept > 0;
        if (toAttacker) state.intercept -= 1;
        state.connections.push(toAttacker ? 'attacker' : 'server');
        const upstream = net.connect(toAttacker ? attacker : upstreamPort, '127.0.0.1');
        for (const [socket, other] of [[client, upstream], [upstream, client]]) {
            sockets.add(socket);
            socket.on('error', () => undefined);
            socket.on('close', () => {
                sockets.delete(socket);
                other.destroy();
            });
        }
        client.pipe(upstream).pipe(client);
    });
    await new Promise((resolve) => relay.listen(0, '127.0.0.1', () => resolve(undefined)));
    state.port = /** @type {net.AddressInfo} */ (relay.address()).port;
    return state;
}

// --- The check ---

// What the runtime runs: the gateway's connection code (connectRdpServer of
// server/rdp/connect.ts) against the fake server, then through the attacker
// in the middle; the last output line is its result as JSON. Inputs come in
// the environment.
const PROBE = `
const out = (value) => process.stdout.write('\\n' + JSON.stringify(value) + '\\n');
const runtime = { electron: process.versions.electron || null, node: process.versions.node, openssl: process.versions.openssl || null };
let gateway;
try {
    gateway = require(process.env.CHECK_RDP_CONNECT_MODULE);
} catch (error) {
    out({ ok: false, runtime, stage: 'load', message: String((error && error.message) || error) });
    process.exit(0);
}
const known = require('tls').getCiphers();
const missingCiphers = String(gateway.RSA_KEY_EXCHANGE_CIPHERS || '').split(':').filter((suite) => !known.includes(suite.toLowerCase()));
const connect = (port) => gateway.connectRdpServer(
    { target: { kind: 'rdp', serverId: 0, name: 'check', host: '127.0.0.1', port, username: 'check' }, jump: null, via: '' },
    Buffer.from(process.env.CHECK_RDP_X224, 'hex'),
    {
        deps: { acquire: () => Promise.reject(new Error('no jump host')) },
        limits: { connectTimeoutMs: 15000, negotiationTimeoutMs: 10000, tlsTimeoutMs: 15000 },
        signal: new AbortController().signal,
    },
).then((connection) => {
    const certificate = connection.secure.getPeerCertificate();
    const secured = { ok: true, rsaKeyExchange: connection.rsaKeyExchange, protocol: connection.secure.getProtocol(), cipher: connection.secure.getCipher().name, fingerprint256: certificate.fingerprint256 };
    connection.secure.destroy();
    connection.transport.close();
    return secured;
}, (error) => ({ ok: false, stage: 'connect', code: error && error.code, message: String((error && error.message) || error) }));
(async () => {
    const windows = await connect(Number(process.env.CHECK_RDP_PORT));
    if (!windows.ok) return out({ ...windows, runtime, missingCiphers });
    out({ ...windows, runtime, missingCiphers, intercepted: await connect(Number(process.env.CHECK_RDP_RELAY_PORT)) });
})();
`;

// The gateway's line when it falls back (server/rdp/connect.ts).
export const FALLBACK_LOG = 'connecting again with TLS 1.2 and RSA key exchange';

/**
 * @typedef {{ electron: string | null, node: string, openssl: string | null }} ProbeRuntime
 * @typedef {{ ok: true, rsaKeyExchange: boolean, protocol: string | null, cipher: string, fingerprint256: string }
 *   | { ok: false, stage: string, code?: string, message: string }} ProbeConnection
 * @typedef {(Extract<ProbeConnection, { ok: true }> & { runtime: ProbeRuntime, missingCiphers?: string[], intercepted?: ProbeConnection })
 *   | (Extract<ProbeConnection, { ok: false }> & { runtime?: ProbeRuntime, missingCiphers?: string[] })} ProbeResult
 */

/**
 * What is wrong with the outcome of the check, or null.
 * @param {ProbeResult | null} result what the runtime reported
 * @param {{ fingerprint256: string, connections: number, handshakes: { protocol: string | null, cipher: string }[], fallbackLogLines: number, relayed: string[] }} seen
 *   the fake server's certificate and what it saw; how often the gateway
 *   logged the fallback to it; where the attacker's relay sent each connection
 * @returns {string | null}
 */
export function rdpTlsProblem(result, seen) {
    if (!result) return 'the runtime reported no result';
    if (result.missingCiphers?.length) {
        return `the runtime does not know ${result.missingCiphers.join(', ')} of the fallback's suites (RSA_KEY_EXCHANGE_CIPHERS in server/rdp/connect.ts), and leaves them out`;
    }
    if (!result.ok) return `the gateway could not secure the connection (${result.stage}): ${result.message}`;
    if (result.fingerprint256 !== seen.fingerprint256) return `the gateway got another certificate (${result.fingerprint256}) than the server's (${seen.fingerprint256})`;
    if (result.rsaKeyExchange) {
        const last = seen.handshakes.at(-1);
        if (seen.connections !== 2) return `the fallback should take a second connection, the server saw ${seen.connections}`;
        if (result.protocol !== 'TLSv1.2' || /^(ECDHE|DHE)-/.test(result.cipher) || last?.protocol !== 'TLSv1.2' || last.cipher !== result.cipher) {
            return `the fallback should be TLS 1.2 with RSA key exchange, it was ${result.protocol} ${result.cipher} (the server saw ${last ? `${last.protocol} ${last.cipher}` : 'no handshake'})`;
        }
        if (seen.fallbackLogLines !== 1) return `the gateway should log the fallback once at info level, it logged it ${seen.fallbackLogLines} times`;
    }
    return interceptionProblem(result, seen.relayed);
}

// The relay answers the first connection with a certificate without Digital
// Signature and passes the next one to a server whose certificate has it.
function interceptionProblem(/** @type {Extract<ProbeResult, { ok: true }>} */ result, /** @type {string[]} */ relayed) {
    const intercepted = result.intercepted;
    if (!intercepted) return 'the runtime reported nothing of the connection through the attacker in the middle';
    if (intercepted.ok && intercepted.rsaKeyExchange) {
        return `an attacker in the middle forced TLS 1.2 with RSA key exchange, without forward secrecy, on a server whose certificate allows digital signatures (${intercepted.protocol} ${intercepted.cipher})`;
    }
    if (!result.rsaKeyExchange) {
        // A runtime that accepts certificates without Digital Signature
        // secures the attacker's connection directly (the pin catches that).
        return intercepted.ok ? null : `the connection through the attacker in the middle should be secured directly, as the server's was: ${intercepted.message}`;
    }
    if (intercepted.ok) return `the connection through the attacker in the middle was secured directly (${intercepted.protocol} ${intercepted.cipher}), with a certificate this runtime refuses`;
    if (intercepted.code !== 'RDP_TLS_FAILED' || !intercepted.message.includes('allows digital signatures')) {
        return `the gateway should refuse the connection through the attacker in the middle as possibly intercepted, it failed otherwise (${intercepted.code}): ${intercepted.message}`;
    }
    if (relayed.join(',') !== 'attacker,server') return `the refused fallback should have taken the attacker's connection, then the server's; the relay saw ${relayed.join(', ') || 'none'}`;
    return null;
}

/** @param {ProbeRuntime | undefined} runtime */
const runtimeName = (runtime) => (!runtime ? 'the runtime'
    : runtime.electron ? `Electron ${runtime.electron} (Node ${runtime.node}, BoringSSL)` : `Node ${runtime.node} (OpenSSL ${runtime.openssl})`);

/**
 * Runs the check: `runtime` (with ELECTRON_RUN_AS_NODE) loads
 * `serverDir`/server/rdp/connect.js and secures a connection to a fake RDP
 * server whose certificate does not allow digital signatures, then one
 * through an attacker in the middle who tries to force the fallback on a
 * server whose certificate allows them. Resolves with a one-line summary;
 * rejects with what went wrong.
 * @param {{ runtime: string, serverDir: string, env?: NodeJS.ProcessEnv, timeoutMs?: number }} options
 * @returns {Promise<string>}
 */
export async function checkRdpTls({ runtime, serverDir, env = process.env, timeoutMs = PROBE_TIMEOUT_MS }) {
    const certificate = keyEnciphermentCertificate();
    const server = await startRdpTlsServer(certificate);
    const attacker = await startRdpTlsServer(keyEnciphermentCertificate('shellmind-rdp-check-attacker'));
    const signing = await startRdpTlsServer(digitalSignatureCertificate());
    const relay = await startInterceptingRelay({ attacker: attacker.port, server: signing.port });
    try {
        const child = spawn(runtime, ['-e', PROBE], {
            cwd: os.tmpdir(),
            env: {
                ...env,
                ELECTRON_RUN_AS_NODE: '1',
                LOG_LEVEL: 'info',
                SHELLMIND_DEBUG: '',
                DOTENV_CONFIG_PATH: path.join(os.tmpdir(), `shellmind-check-${randomBytes(6).toString('hex')}.env`),
                CHECK_RDP_CONNECT_MODULE: path.join(serverDir, 'server', 'rdp', 'connect.js'),
                CHECK_RDP_PORT: String(server.port),
                CHECK_RDP_RELAY_PORT: String(relay.port),
                CHECK_RDP_X224: connectionRequest().toString('hex'),
            },
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        const exit = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                child.kill();
                reject(new Error(`the runtime did not finish within ${timeoutMs / 1000} s:\n${stdout}${stderr}`));
            }, timeoutMs);
            child.once('error', (error) => {
                clearTimeout(timer);
                reject(new Error(`could not start ${runtime}: ${error.message}`));
            });
            child.once('exit', (code, signal) => {
                clearTimeout(timer);
                resolve(signal ?? code);
            });
        });
        const lines = stdout.trim().split(/\r?\n/);
        const last = lines.at(-1) ?? '';
        /** @type {ProbeResult | null} */
        let result = null;
        try {
            result = last.startsWith('{') ? JSON.parse(last) : null;
        } catch {
            result = null;
        }
        if (!result && exit !== 0) throw new Error(`the runtime exited with ${exit}:\n${stdout}${stderr}`);
        const problem = rdpTlsProblem(result, {
            fingerprint256: certificate.fingerprint256,
            connections: server.connections,
            handshakes: server.handshakes,
            fallbackLogLines: lines.filter((line) => line.includes(FALLBACK_LOG) && line.includes(`127.0.0.1:${server.port} `)).length,
            relayed: relay.connections,
        });
        if (problem) throw new Error(`${runtimeName(result?.runtime)}: ${problem}`);
        const done = /** @type {Extract<ProbeResult, { ok: true }>} */ (result);
        return done.rsaKeyExchange
            ? `${runtimeName(done.runtime)} refused the RDP certificate without Digital Signature for TLS 1.3/ECDHE; the gateway fell back to ${done.protocol} ${done.cipher} (RSA key exchange) and got the same certificate, and refused the fallback an attacker in the middle forced on a server whose certificate allows digital signatures`
            : `${runtimeName(done.runtime)} secured the RDP connection to a certificate without Digital Signature directly (${done.protocol} ${done.cipher}), no fallback needed`;
    } finally {
        await relay.close();
        await Promise.all([server.close(), attacker.close(), signing.close()]);
    }
}

function defaultRuntime() {
    try {
        // From Node, the electron package exports the path of its executable.
        const exe = createRequire(path.join(root, 'package.json'))('electron');
        if (typeof exe === 'string') return exe;
    } catch {
        // Not installed.
    }
    throw new Error('no Electron runtime found: pass --runtime <executable>');
}

async function main() {
    const args = process.argv.slice(2);
    const option = (name) => {
        const index = args.indexOf(name);
        if (index < 0) return undefined;
        const value = args[index + 1];
        if (!value || value.startsWith('--')) throw new Error(`${name} needs a value`);
        return value;
    };
    const runtime = option('--runtime') ?? defaultRuntime();
    const serverDir = path.resolve(option('--server') ?? path.join(root, 'dist-server'));
    console.log(`check-rdp-tls: ${runtime}, backend in ${serverDir}`);
    console.log(`check-rdp-tls: ok - ${await checkRdpTls({ runtime, serverDir })}`);
}

const entry = process.argv[1] && fs.existsSync(process.argv[1]) ? fs.realpathSync(process.argv[1]) : '';
if (entry === fileURLToPath(import.meta.url)) {
    main().catch((error) => {
        console.error(`check-rdp-tls: FAILED: ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    });
}
