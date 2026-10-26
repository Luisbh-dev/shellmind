import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "stream";
import type { TLSSocket } from "tls";
import { formatRdpAddress, RDP_GATEWAY_PATH, type PinnedRdpCertificate, type RdpCertificate, type RdpEndCause, type RdpStatusEvent } from "../../shared/rdp";
import type { AuditInput } from "../../shared/types";
import { tokensMatch } from "../auth";
import { recordAudit } from "../db/auditRepo";
import { AppError, errorMessage } from "../errors";
import { requestRejection } from "../http/network";
import { createLogger } from "../logger";
import { sshPool, type SshLease } from "../ssh/pool";
import { describeCertificate, rdpCertificates, type RdpCertificateStore } from "./certificates";
import { connectRdpServer, tlsParameters } from "./connect";
import { DerError } from "./der";
import { RdpGatewayFailure } from "./failure";
import { decodeRequest, encodeError, encodeResponse, GENERAL_ERROR_CODE, pduLength, type RdCleanPathRequest } from "./rdcleanpath";
import { loadRdpRoute, type RdpRoute } from "./route";
import { rdpTickets, type RdpTicket, type TicketBook } from "./tickets";
import type { RdpTransport } from "./transport";
import { acceptWebSocket, CLOSE, handshakeProblem, refuseUpgrade, type WebSocketConnection } from "./websocket";
import { parseConnectionRequest, PROTOCOL, X224Error } from "./x224";

// The RDCleanPath gateway of the embedded Remote Desktop client: a WebSocket
// at RDP_GATEWAY_PATH. For each connection it
//   1. accepts the upgrade only with an allowed Host/Origin and a ticket
//      issued over the authenticated socket (server/rdp/socket.ts),
//   2. reads the client's RDCleanPath request and checks its token and its
//      X.224 Connection Request,
//   3. connects to the saved server of the ticket (directly or through its
//      jump host), whatever destination the request names,
//   4. forwards the request, reads the X.224 Connection Confirm, upgrades to
//      TLS (connect.ts) and checks the server's certificate against the
//      pinned one,
//   5. answers with the confirm and the certificate chain, then relays the
//      RDP stream between the WebSocket and the TLS connection.
// The client does CredSSP (NLA) itself over that stream.

const log = createLogger("rdp");

export const GATEWAY_LIMITS = {
    // From the upgrade to the client's RDCleanPath request.
    requestTimeoutMs: 15_000,
    // TCP connection, or the jump host's channel.
    connectTimeoutMs: 15_000,
    // The server's X.224 Connection Confirm.
    negotiationTimeoutMs: 10_000,
    tlsTimeoutMs: 15_000,
    // Open relays at once (each one holds a TLS connection and a WebSocket).
    maxSessions: 16,
    // RDP PDUs are at most 64 KiB; a message is one write of the client.
    maxMessageBytes: 1024 * 1024,
    keepAliveMs: 30_000,
    // Certificates in the chain handed to the client.
    maxChain: 8,
    // After the user ends an established session, how long the client has
    // to close its WebSocket (its sign-off to the server is relayed meanwhile).
    userEndGraceMs: 5_000,
    // The page says the user ended a session ("rdp-disconnect") on its other
    // socket right before the client closes the WebSocket: how long a closed
    // WebSocket waits for that word.
    clientCloseGraceMs: 250
};

export type GatewayDeps = {
    tickets: TicketBook;
    certificates: RdpCertificateStore;
    acquire: (serverId: number) => Promise<SshLease>;
    loadRoute: (serverId: number) => Promise<RdpRoute>;
    audit: (input: AuditInput) => Promise<unknown>;
    limits: typeof GATEWAY_LIMITS;
};

export const defaultGatewayDeps: GatewayDeps = {
    tickets: rdpTickets,
    certificates: rdpCertificates,
    acquire: (serverId) => sshPool.acquire(serverId),
    loadRoute: (serverId) => loadRdpRoute(serverId, { password: false }),
    audit: recordAudit,
    limits: GATEWAY_LIMITS
};

// --- certificates the user may trust (see trustPresentedCertificate) ---

type Presented = { expected: PinnedRdpCertificate; actual: RdpCertificate; at: number };
const PRESENTED_TTL_MS = 15 * 60_000;
const MAX_PRESENTED = 64;
const presented = new Map<string, Presented>();
const endpointKey = (host: string, port: number, via: string) => `${host}\n${port}\n${via}`;

function rememberPresented(entry: Presented): void {
    const now = Date.now();
    for (const [key, value] of presented) if (now - value.at > PRESENTED_TTL_MS) presented.delete(key);
    while (presented.size >= MAX_PRESENTED) presented.delete(presented.keys().next().value as string);
    presented.set(endpointKey(entry.actual.host, entry.actual.port, entry.actual.via), entry);
}

// The changed certificate the gateway refused on this endpoint, while the
// user may still trust it: only exactly that certificate can replace the pin.
export function presentedCertificate(host: string, port: number, via: string, expected: string, actual: string): RdpCertificate | null {
    const entry = presented.get(endpointKey(host, port, via));
    if (!entry || Date.now() - entry.at > PRESENTED_TTL_MS) return null;
    if (entry.expected.fingerprint !== expected || entry.actual.fingerprint !== actual) return null;
    return entry.actual;
}

export function forgetPresented(host: string, port: number, via: string): void {
    presented.delete(endpointKey(host, port, via));
}

// --- sessions ---

const sessions = new Set<GatewaySession>();

// Why a session ended, as the audit log records it.
export const END_REASONS = {
    user: "The user disconnected.",
    cancelled: "The user cancelled the connection.",
    clientClosed: "The Remote Desktop client closed the connection.",
    pageGone: "The page that opened the session went away.",
    serverEnded: "The server ended the session.",
    serverClosed: "The connection to the server closed.",
    // As the page reports them (its client's words).
    remote: (detail: string) => `The remote desktop ended the session${detail ? ` (${detail})` : ""}.`,
    clientError: (detail: string) => `The Remote Desktop client stopped with an error${detail ? ` (${detail})` : ""}.`
} as const;

// Ends the connections a socket opened (it disconnected).
export function closeRdpSessionsOf(owner: string): void {
    for (const session of sessions) if (session.owner === owner) session.shutdown(END_REASONS.pageGone);
}

// Session `id` of socket `owner` ended in its page ("rdp-disconnect"): false
// when that socket has no such session (its ticket may not be used yet).
export function endRdpSessionFromPage(owner: string, id: string, cause: RdpEndCause, detail: string): boolean {
    for (const session of sessions) {
        if (session.owner !== owner || session.id !== id) continue;
        if (cause === "user") session.endByUser();
        else session.shutdown(cause === "remote" ? END_REASONS.remote(detail) : END_REASONS.clientError(detail));
        return true;
    }
    return false;
}

export function activeRdpSessions(): number {
    return sessions.size;
}

const accountName = (ticket: RdpTicket) => (ticket.domain ? `${ticket.domain}\\${ticket.username}` : ticket.username) || "(no user)";

class GatewaySession {
    readonly owner: string;
    readonly id: string;
    private readonly abort = new AbortController();
    private readonly queued: Buffer[] = [];
    private onMessage: ((data: Buffer) => void) | null = null;
    private transport: RdpTransport | null = null;
    private secure: TLSSocket | null = null;
    private route: RdpRoute | null = null;
    private startedAt = 0;
    private bytesToServer = 0;
    private bytesToClient = 0;
    private ended = false;
    // The user ended the session: whatever closes it next, that is the reason.
    private endedByUser = false;
    private userEndTimer: ReturnType<typeof setTimeout> | null = null;
    private clientClosed = false;

    constructor(private readonly ws: WebSocketConnection, private readonly ticket: RdpTicket, private readonly deps: GatewayDeps) {
        this.owner = ticket.owner;
        this.id = ticket.id;
        ws.on("message", (data) => {
            if (this.onMessage) this.onMessage(data);
            else this.queued.push(data);
        });
        ws.once("close", () => {
            if (this.startedAt === 0 || this.endedByUser) {
                this.end(END_REASONS.clientClosed);
                return;
            }
            this.clientClosed = true;
            this.userEndTimer = setTimeout(() => this.end(END_REASONS.clientClosed), this.deps.limits.clientCloseGraceMs);
        });
    }

    // A session still being set up stops now; an established one gets a
    // moment for the client's sign-off and its WebSocket close.
    endByUser(): void {
        if (this.ended || this.endedByUser) return;
        this.endedByUser = true;
        if (this.startedAt === 0 || this.clientClosed) {
            this.end(END_REASONS.user);
            return;
        }
        this.userEndTimer = setTimeout(() => this.end(END_REASONS.user), this.deps.limits.userEndGraceMs);
        this.userEndTimer.unref?.();
    }

    private report(event: Omit<RdpStatusEvent, "sessionId">): void {
        try {
            this.ticket.report({ sessionId: this.ticket.id, ...event });
        } catch (err) {
            log.debug(`Could not report RDP session ${this.ticket.id}: ${errorMessage(err)}`);
        }
    }

    private address(): string {
        return this.route ? formatRdpAddress(this.route.target.host, this.route.target.port) : `server #${this.ticket.serverId}`;
    }

    private audit(input: Omit<AuditInput, "serverId" | "source">): void {
        void this.deps.audit({ serverId: this.ticket.serverId, source: "rdp", ...input }).catch((err: unknown) => {
            log.warn(`Could not record RDP session ${this.ticket.id} in the audit log: ${errorMessage(err)}`);
        });
    }

    async run(): Promise<void> {
        sessions.add(this);
        try {
            const request = await this.readRequest();
            if (!tokensMatch(this.ticket.token, request.proxyAuth)) {
                throw new RdpGatewayFailure("RDP_TICKET", "The connection request does not carry its ticket.", { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 401 });
            }
            const connectionRequest = parseConnectionRequest(request.x224);
            const tlsProtocols = PROTOCOL.ssl | PROTOCOL.hybrid | PROTOCOL.hybridEx | PROTOCOL.rdstls;
            if (connectionRequest.requestedProtocols === null || (connectionRequest.requestedProtocols & tlsProtocols) === 0) {
                throw new RdpGatewayFailure("RDP_LEGACY_SECURITY", "The client asked for standard RDP security, which the gateway does not relay.");
            }

            // Fresh from the database: the ticket only names the server.
            this.route = await this.deps.loadRoute(this.ticket.serverId);
            this.checkOpen();
            this.report({ phase: "connecting" });
            const connection = await connectRdpServer(this.route, request.x224, {
                deps: { acquire: this.deps.acquire },
                limits: this.deps.limits,
                signal: this.abort.signal,
                onSecuring: () => this.report({ phase: "securing" })
            });
            this.transport = connection.transport;
            this.secure = connection.secure;
            // Read now, while the connection is surely open. A session
            // without forward secrecy must be told apart in the audit log.
            const tls = tlsParameters(connection);
            this.checkOpen();

            const chain = this.certificateChain(this.secure);
            const certificate = describeCertificate(chain[0], { host: this.route.target.host, port: this.route.target.port, via: this.route.via });
            const pinnedNow = await this.checkCertificate(certificate);
            this.checkOpen();

            this.ws.send(encodeResponse({ x224: connection.confirm, certChain: chain, serverAddr: this.transport.serverAddr }));
            this.startedAt = Date.now();
            log.info(`RDP session ${this.ticket.id} to server #${this.ticket.serverId} (${this.address()}${this.route.via ? ` via ${this.route.via}` : ""}) established with ${tls.protocol} ${tls.cipher}${tls.forwardSecrecy ? "" : ", without forward secrecy"}`);
            this.report({ phase: "established", certificate, pinnedNow, tls });
            this.audit({
                command: `rdp connect ${accountName(this.ticket)}@${this.address()}`,
                exitCode: 0,
                meta: { session: this.ticket.id, via: this.route.via || null, certificate: certificate.fingerprint, pinnedNow, tls }
            });
            this.relay(this.secure);
        } catch (err) {
            this.fail(err);
        }
    }

    private checkOpen(): void {
        if (this.ended) throw new RdpGatewayFailure("RDP_INTERNAL", "The connection was closed.");
    }

    // The client's RDCleanPath request: one DER PDU, possibly split across messages.
    private readRequest(): Promise<RdCleanPathRequest> {
        return new Promise((resolve, reject) => {
            let buffered: Buffer = Buffer.alloc(0);
            const settle = (outcome: () => void) => {
                clearTimeout(timer);
                this.abort.signal.removeEventListener("abort", onAbort);
                // Nothing may come before the answer.
                this.onMessage = () => this.fail(new RdpGatewayFailure(
                    "RDP_PROTOCOL",
                    "The Remote Desktop client sent data before the connection was ready.",
                    { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 400 }
                ));
                outcome();
            };
            const onAbort = () => settle(() => reject(new RdpGatewayFailure("RDP_INTERNAL", "The connection was closed.")));
            const timer = setTimeout(() => settle(() => reject(new RdpGatewayFailure(
                "RDP_PROTOCOL",
                "The Remote Desktop client sent no connection request.",
                { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 408 }
            ))), this.deps.limits.requestTimeoutMs);
            const take = (data: Buffer) => {
                buffered = buffered.length ? Buffer.concat([buffered, data]) : data;
                let request: RdCleanPathRequest;
                try {
                    const length = pduLength(buffered);
                    if (length === null || buffered.length < length) return;
                    if (buffered.length > length) throw new DerError("data after the request");
                    request = decodeRequest(buffered);
                } catch (err) {
                    settle(() => reject(new RdpGatewayFailure("RDP_PROTOCOL", `Invalid connection request: ${errorMessage(err)}`, { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 400 })));
                    return;
                }
                settle(() => resolve(request));
            };
            this.abort.signal.addEventListener("abort", onAbort, { once: true });
            this.onMessage = take;
            for (const data of this.queued.splice(0)) this.onMessage?.(data);
        });
    }

    private certificateChain(socket: TLSSocket): Buffer[] {
        const chain: Buffer[] = [];
        const seen = new Set<string>();
        let certificate = socket.getPeerCertificate(true);
        while (certificate?.raw && chain.length < this.deps.limits.maxChain && !seen.has(certificate.fingerprint256)) {
            seen.add(certificate.fingerprint256);
            chain.push(certificate.raw);
            certificate = certificate.issuerCertificate;
        }
        if (chain.length === 0) throw new RdpGatewayFailure("RDP_TLS_FAILED", `${this.address()} presented no certificate.`, { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 42 });
        return chain;
    }

    // Trust on first use; returns whether the certificate was pinned now.
    private async checkCertificate(certificate: RdpCertificate): Promise<boolean> {
        const { certificates } = this.deps;
        const known = await certificates.find(certificate.host, certificate.port, certificate.via);
        if (known && known.fingerprint === certificate.fingerprint) return false;
        if (!known) {
            const pinned = await certificates.pin(certificate);
            if (pinned.fingerprint === certificate.fingerprint) {
                log.info(`Pinned the RDP certificate of ${this.address()}${certificate.via ? ` via ${certificate.via}` : ""}: SHA-256 ${certificate.fingerprint}`);
                return true;
            }
            return this.mismatch(pinned, certificate);
        }
        return this.mismatch(known, certificate);
    }

    private mismatch(expected: PinnedRdpCertificate, actual: RdpCertificate): never {
        rememberPresented({ expected, actual, at: Date.now() });
        log.warn(`The RDP certificate of ${this.address()} changed (pinned ${expected.fingerprint}, presented ${actual.fingerprint}); connection refused`);
        throw new RdpGatewayFailure(
            "RDP_CERT_MISMATCH",
            `The certificate of ${this.address()} has changed since it was first trusted. This happens when Windows renews its self-signed certificate or the server was reinstalled, but it can also mean someone is intercepting the connection.`,
            { errorCode: GENERAL_ERROR_CODE, tlsAlertCode: 42 },
            { mismatch: { expected, actual } }
        );
    }

    private relay(secure: TLSSocket): void {
        let serverPaused = false;
        let clientPaused = false;
        this.onMessage = (data) => {
            this.bytesToServer += data.length;
            if (!secure.write(data) && !clientPaused) {
                clientPaused = true;
                this.ws.pause();
                secure.once("drain", () => {
                    clientPaused = false;
                    this.ws.resume();
                });
            }
        };
        for (const data of this.queued.splice(0)) this.onMessage(data);
        secure.on("data", (chunk: Buffer) => {
            this.bytesToClient += chunk.length;
            if (!this.ws.send(chunk) && !serverPaused) {
                serverPaused = true;
                secure.pause();
                this.ws.once("drain", () => {
                    serverPaused = false;
                    secure.resume();
                });
            }
        });
        secure.once("end", () => this.end(END_REASONS.serverEnded));
        secure.once("close", () => this.end(END_REASONS.serverClosed));
    }

    private fail(err: unknown): void {
        if (this.ended) {
            // Ended while a step was still under way: what that step opened goes too.
            this.secure?.destroy();
            this.transport?.close();
            return;
        }
        const failure = err instanceof RdpGatewayFailure
            ? err
            : err instanceof X224Error || err instanceof DerError
                ? new RdpGatewayFailure("RDP_PROTOCOL", errorMessage(err), { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 400 })
                : err instanceof AppError
                    ? new RdpGatewayFailure("RDP_INTERNAL", err.message, { errorCode: GENERAL_ERROR_CODE, httpStatusCode: err.status >= 500 ? 502 : 400 }, { details: { code: err.code } })
                    : new RdpGatewayFailure("RDP_INTERNAL", `The Remote Desktop gateway failed: ${errorMessage(err)}`, { errorCode: GENERAL_ERROR_CODE, httpStatusCode: 500 });
        const established = this.startedAt > 0;
        if (!established && this.ws.isOpen) {
            this.ws.send(encodeError(failure.answer, failure.isNegotiation ? failure.extra.x224 : undefined));
        }
        log.warn(`RDP session ${this.ticket.id} to server #${this.ticket.serverId} failed: ${failure.message}`);
        this.report({ phase: "failed", error: failure.toEvent() });
        if (!established) {
            this.audit({
                command: `rdp connect ${accountName(this.ticket)}@${this.address()}`,
                exitCode: 1,
                meta: { session: this.ticket.id, via: this.route?.via || null, error: failure.code, message: failure.message }
            });
        }
        this.end(failure.message, { reported: true });
    }

    // Closes everything; records the end of an established session.
    private end(cause: string, options: { reported?: boolean } = {}): void {
        if (this.ended) return;
        this.ended = true;
        if (this.userEndTimer) clearTimeout(this.userEndTimer);
        const reason = this.endedByUser ? (this.startedAt > 0 ? END_REASONS.user : END_REASONS.cancelled) : cause;
        sessions.delete(this);
        this.abort.abort();
        this.ws.close(CLOSE.normal, "");
        this.secure?.destroy();
        this.transport?.close();
        if (this.startedAt > 0) {
            const durationMs = Date.now() - this.startedAt;
            log.info(`RDP session ${this.ticket.id} to server #${this.ticket.serverId} ended after ${Math.round(durationMs / 1000)} s`);
            this.audit({
                command: `rdp disconnect ${accountName(this.ticket)}@${this.address()}`,
                meta: { session: this.ticket.id, durationMs, bytesToServer: this.bytesToServer, bytesToClient: this.bytesToClient, reason }
            });
        }
        if (!options.reported) this.report({ phase: "closed" });
    }

    shutdown(reason: string): void {
        this.end(reason);
    }
}

function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, deps: GatewayDeps): void {
    // A failing transport ends the session through "close".
    socket.on("error", () => undefined);
    const rejection = requestRejection(req.headers);
    if (rejection) {
        log.warn(`${rejection}: RDP gateway upgrade refused (host ${JSON.stringify(req.headers.host ?? "")}, origin ${JSON.stringify(req.headers.origin ?? "")})`);
        refuseUpgrade(socket, 403, rejection);
        return;
    }
    const problem = handshakeProblem(req);
    if (problem) {
        refuseUpgrade(socket, 400, problem);
        return;
    }
    const token = new URL(req.url ?? "", "http://gateway").searchParams.get("ticket");
    // An expired ticket's page hears why (its client only sees a refused WebSocket).
    const ticket = token ? deps.tickets.claim(token, (expired) => expired.report({
        sessionId: expired.id,
        phase: "failed",
        error: { code: "RDP_TICKET", message: "The Remote Desktop ticket expired before the client used it." }
    })) : null;
    if (!ticket) {
        log.warn("RDP gateway upgrade refused: missing, used or expired ticket");
        refuseUpgrade(socket, 401, "A valid Remote Desktop ticket is required.");
        return;
    }
    if (sessions.size >= deps.limits.maxSessions) {
        ticket.report({ sessionId: ticket.id, phase: "failed", error: { code: "RDP_BUSY", message: "Too many Remote Desktop sessions are open." } });
        refuseUpgrade(socket, 503, "Too many Remote Desktop sessions are open.");
        return;
    }
    const ws = acceptWebSocket(req, socket, head, { maxMessageBytes: deps.limits.maxMessageBytes, keepAliveMs: deps.limits.keepAliveMs });
    void new GatewaySession(ws, ticket, deps).run();
}

// Serves the gateway on the backend's HTTP server, next to socket.io.
export function attachRdpGateway(server: HttpServer, deps: GatewayDeps = defaultGatewayDeps): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
        let pathname: string;
        try {
            pathname = new URL(req.url ?? "", "http://gateway").pathname;
        } catch {
            return;
        }
        if (pathname !== RDP_GATEWAY_PATH) return;
        handleUpgrade(req, socket, head, deps);
    });
}
