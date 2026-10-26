import { isIP } from "net";
import type { Duplex } from "stream";
import tls, { type ConnectionOptions, type TLSSocket } from "tls";
import { formatRdpAddress, type RdpTlsParameters } from "../../shared/rdp";
import { errorMessage } from "../errors";
import { createLogger } from "../logger";
import { RdpGatewayFailure } from "./failure";
import { certificateKeyUsage, type KeyUsage } from "./keyUsage";
import { GENERAL_ERROR_CODE, NEGOTIATION_ERROR_CODE } from "./rdcleanpath";
import type { RdpRoute } from "./route";
import { openRdpTransport, type RdpTransport, type TransportDeps } from "./transport";
import { FrameTimeoutError, NEGOTIATION_FAILURES, parseConnectionConfirm, PROTOCOL, readTpktFrame } from "./x224";

// The gateway's connection to the RDP server, up to a secured stream: the TCP
// connection (or the jump host's channel), the client's X.224 Connection
// Request and the server's Confirm, then the TLS handshake. The caller checks
// the server's certificate against its pin (certificates.ts).
//
// Windows' self-signed RDP certificates allow key encipherment and data
// encipherment, not digital signatures (key usage). TLS 1.3 and ECDHE key
// exchange need the server to sign the handshake with that key. OpenSSL, the
// TLS library of Node, lets it through. BoringSSL, the one of Electron's Node
// that runs the desktop app's backend, refuses the certificate
// (KEY_USAGE_BIT_INCORRECT). The gateway then connects again and offers only
// TLS 1.2 with RSA key exchange: the client encrypts the premaster secret
// with the server's key, which needs key encipherment only. Such a session
// has no forward secrecy (whoever later gets the server's private key can
// decrypt a recording of it), so it is the fallback and not the default.
//
// Nothing is authenticated when the first handshake is refused: a machine in
// the middle can get it refused with a certificate of its own, then pass the
// second connection through to the real server, whose pinned certificate
// would match. So the fallback is accepted only when the certificate of the
// second handshake does not allow digital signatures either (and allows key
// encipherment); one that does would have secured the first connection with
// forward secrecy, and the connection is refused as possibly intercepted. A
// certificate without Digital Signature takes the fallback on every
// connection from this runtime anyway, so forcing it gains a machine in the
// middle nothing.

const log = createLogger("rdp");

export type RdpConnectLimits = { connectTimeoutMs: number; negotiationTimeoutMs: number; tlsTimeoutMs: number };

export type RdpConnectOptions = {
    deps: TransportDeps;
    limits: RdpConnectLimits;
    // Aborting it ends whatever step is under way.
    signal: AbortSignal;
    // The server accepted the security settings; TLS comes next.
    onSecuring?: () => void;
};

export type RdpConnection = {
    transport: RdpTransport;
    // The server's X.224 Connection Confirm, as received.
    confirm: Buffer;
    secure: TLSSocket;
    // Secured with TLS 1.2 and RSA key exchange (the certificate does not
    // allow digital signatures and the runtime enforces that).
    rsaKeyExchange: boolean;
};

// TLS 1.2 suites with RSA key exchange, strongest first. Each must be known
// to OpenSSL and to BoringSSL, which has no AES-CBC with SHA-256 and drops
// suites it does not know from the list without a word
// (scripts/check-rdp-tls.mjs fails on any under the app's runtime).
export const RSA_KEY_EXCHANGE_CIPHERS = [
    "AES256-GCM-SHA384",
    "AES128-GCM-SHA256",
    "AES256-SHA",
    "AES128-SHA"
].join(":");

// BoringSSL's refusal of a certificate whose key usage does not allow the
// key exchange. Node reports it with the code ERR_SSL_KEY_USAGE_BIT_INCORRECT
// and the reason KEY_USAGE_BIT_INCORRECT; the message carries the reason too.
export function isKeyUsageRefusal(err: unknown): boolean {
    if (typeof err === "string") return /KEY_USAGE_BIT_INCORRECT/i.test(err);
    if (!err || typeof err !== "object") return false;
    const { code, reason, message } = err as { code?: unknown; reason?: unknown; message?: unknown };
    return code === "ERR_SSL_KEY_USAGE_BIT_INCORRECT"
        || (typeof reason === "string" && /^KEY_USAGE_BIT_INCORRECT$/i.test(reason))
        || (typeof message === "string" && /KEY_USAGE_BIT_INCORRECT/i.test(message));
}

// Why the certificate (DER) of the handshake with RSA key exchange did not
// need it, or null when it did: its key usage allows key encipherment and not
// digital signatures.
export function fallbackCertificateProblem(der: Buffer | undefined): string | null {
    if (!der || der.length === 0) return "it presented no certificate";
    let usage: KeyUsage | null;
    try {
        usage = certificateKeyUsage(der);
    } catch (err) {
        return `its key usage could not be read (${errorMessage(err)})`;
    }
    if (!usage) return "it has no key usage extension, so it allows digital signatures";
    if (usage.digitalSignature) return "it allows digital signatures";
    if (!usage.keyEncipherment) return "it does not allow key encipherment either";
    return null;
}

export function rdpTlsOptions(stream: Duplex, host: string, rsaKeyExchange: boolean): ConnectionOptions {
    return {
        socket: stream,
        // The certificate is checked against its pin (TOFU) instead of a CA:
        // RDP servers mostly present self-signed ones.
        rejectUnauthorized: false,
        servername: isIP(host) ? undefined : host,
        minVersion: "TLSv1.2",
        ...(rsaKeyExchange ? { maxVersion: "TLSv1.2" as const, ciphers: RSA_KEY_EXCHANGE_CIPHERS } : {})
    };
}

// What a connection is secured with, for the audit log and the page.
export function tlsParameters(connection: Pick<RdpConnection, "secure" | "rsaKeyExchange">): RdpTlsParameters {
    const protocol = connection.secure.getProtocol() ?? "unknown";
    // null once the socket has lost its handle.
    const suite: { name?: string; standardName?: string } | null = connection.secure.getCipher();
    const cipher = suite?.standardName || suite?.name || "unknown";
    return {
        protocol,
        cipher,
        forwardSecrecy: protocol === "TLSv1.3" || /^(?:TLS_)?(?:ECDHE|DHE)[_-]/.test(cipher),
        keyUsageFallback: connection.rsaKeyExchange
    };
}

// The first handshake was refused for the certificate's key usage.
class KeyUsageRefused extends Error {
    constructor(readonly original: unknown) {
        super(errorMessage(original));
        this.name = "KeyUsageRefused";
    }
}

const cancelled = () => new RdpGatewayFailure("RDP_INTERNAL", "The connection was cancelled.");

async function negotiate(stream: Duplex, connectionRequest: Buffer, address: string, timeoutMs: number): Promise<Buffer> {
    stream.write(connectionRequest);
    let frame: Buffer;
    try {
        frame = await readTpktFrame(stream, timeoutMs);
    } catch (err) {
        if (err instanceof FrameTimeoutError) {
            throw new RdpGatewayFailure("RDP_TIMEOUT", `${address} did not answer the Remote Desktop connection request in time. Is it an RDP server?`);
        }
        throw new RdpGatewayFailure("RDP_PROTOCOL", `${address} did not answer like an RDP server: ${errorMessage(err)}`);
    }
    let confirm;
    try {
        confirm = parseConnectionConfirm(frame);
    } catch (err) {
        throw new RdpGatewayFailure("RDP_PROTOCOL", `${address} sent an invalid connection confirm: ${errorMessage(err)}`);
    }
    if (confirm.kind === "failure") {
        const failure = NEGOTIATION_FAILURES[confirm.code] ?? `code ${confirm.code}`;
        throw new RdpGatewayFailure(
            "RDP_NEGOTIATION_FAILED",
            `${address} refused the security settings (${failure}).`,
            { errorCode: NEGOTIATION_ERROR_CODE },
            { details: { failure }, x224: frame }
        );
    }
    if (confirm.kind === "legacy" || confirm.selectedProtocol === PROTOCOL.rdp) {
        throw new RdpGatewayFailure("RDP_LEGACY_SECURITY", `${address} only offers standard RDP security, which is not encrypted with TLS. Enable TLS or NLA on the server.`);
    }
    return frame;
}

function startTls(stream: Duplex, host: string, address: string, timeoutMs: number, rsaKeyExchange: boolean): Promise<TLSSocket> {
    return new Promise((resolve, reject) => {
        const socket = tls.connect(rdpTlsOptions(stream, host, rsaKeyExchange));
        const fail = (err: unknown) => {
            clearTimeout(timer);
            socket.destroy();
            if (err instanceof RdpGatewayFailure) reject(err);
            else if (!rsaKeyExchange && isKeyUsageRefusal(err)) reject(new KeyUsageRefused(err));
            else if (rsaKeyExchange) {
                reject(new RdpGatewayFailure(
                    "RDP_TLS_FAILED",
                    `The TLS handshake with ${address} failed: its certificate does not allow digital signatures (key usage), which TLS 1.3 and ECDHE key exchange need, and TLS 1.2 with RSA key exchange failed too (${errorMessage(err)}). Give the server a certificate whose key usage includes Digital Signature.`,
                    { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 40 }
                ));
            } else {
                reject(new RdpGatewayFailure(
                    "RDP_TLS_FAILED",
                    `The TLS handshake with ${address} failed: ${errorMessage(err)}`,
                    { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 40 }
                ));
            }
        };
        const timer = setTimeout(() => fail(new RdpGatewayFailure("RDP_TIMEOUT", `The TLS handshake with ${address} timed out.`, { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 40 })), timeoutMs);
        socket.once("error", fail);
        socket.once("secureConnect", () => {
            clearTimeout(timer);
            socket.off("error", fail);
            socket.on("error", () => undefined);
            resolve(socket);
        });
    });
}

async function attempt(route: RdpRoute, connectionRequest: Buffer, options: RdpConnectOptions, rsaKeyExchange: boolean): Promise<RdpConnection> {
    const { deps, limits, signal } = options;
    const { host, port } = route.target;
    const address = formatRdpAddress(host, port);
    const transport = await openRdpTransport(route, deps, limits.connectTimeoutMs, signal);
    // A step under way ends with the transport.
    const onAbort = () => transport.close();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
        if (signal.aborted) throw cancelled();
        const confirm = await negotiate(transport.stream, connectionRequest, address, limits.negotiationTimeoutMs);
        if (!rsaKeyExchange) options.onSecuring?.();
        const secure = await startTls(transport.stream, host, address, limits.tlsTimeoutMs, rsaKeyExchange);
        const problem = rsaKeyExchange ? fallbackCertificateProblem(secure.getPeerCertificate().raw) : null;
        if (problem) {
            secure.destroy();
            throw new RdpGatewayFailure(
                "RDP_TLS_FAILED",
                `The TLS handshake with ${address} failed: the first certificate was refused for its key usage (no digital signatures), but the one presented when connecting again with TLS 1.2 and RSA key exchange did not need that: ${problem}. The connection may be intercepted to take away its forward secrecy.`,
                { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 42 }
            );
        }
        return { transport, confirm, secure, rsaKeyExchange };
    } catch (err) {
        transport.close();
        throw err;
    } finally {
        signal.removeEventListener("abort", onAbort);
    }
}

// Connects and secures; on BoringSSL's key usage refusal, once more from the
// start (a new connection and negotiation) with TLS 1.2 and RSA key exchange,
// kept only for a certificate that needs it.
export async function connectRdpServer(route: RdpRoute, connectionRequest: Buffer, options: RdpConnectOptions): Promise<RdpConnection> {
    try {
        return await attempt(route, connectionRequest, options, false);
    } catch (err) {
        if (!(err instanceof KeyUsageRefused)) throw err;
    }
    if (options.signal.aborted) throw cancelled();
    const address = formatRdpAddress(route.target.host, route.target.port);
    log.info(`The first TLS handshake with ${address}${route.via ? ` via ${route.via}` : ""} was refused for the certificate's key usage (no digital signatures, which this runtime's TLS library requires for TLS 1.3 and ECDHE): connecting again with TLS 1.2 and RSA key exchange`);
    return attempt(route, connectionRequest, options, true);
}
