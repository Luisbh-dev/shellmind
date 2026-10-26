import { formatRdpAddress, RDP_GATEWAY_PATH, type RdpDisconnectRequest, type RdpEndCause, type RdpOpenRequest, type RdpOpenResult, type RdpTrustCertificateResult } from "../../shared/rdp";
import { recordAudit } from "../db/auditRepo";
import { AppError, errorMessage } from "../errors";
import { createLogger } from "../logger";
import type { SocketSession } from "../sockets/session";
import { FINGERPRINT_PATTERN, rdpCertificates } from "./certificates";
import { closeRdpSessionsOf, endRdpSessionFromPage, forgetPresented, presentedCertificate } from "./gateway";
import { rdpOptions } from "./options";
import { loadRdpEndpoint, loadRdpRoute } from "./route";
import { rdpTickets, TicketLimitError } from "./tickets";

const log = createLogger("rdp");

// Socket events of the embedded Remote Desktop client:
//   "rdp-open"  a ticket for the gateway, with the saved credentials when the
//               user connects with them. CredSSP (NLA) runs in the page's
//               RDP client, so the stored password is handed to the page,
//               once per connection and only over this authenticated socket;
//               the page keeps it in memory for that connection only. Never
//               for a server set to ask for the password each time.
//   "rdp-trust-certificate"  replaces a pinned certificate the gateway saw change.
//   "rdp-disconnect"  one of this socket's sessions ended in the page: the user
//               ended or cancelled it, the remote desktop ended it, or the
//               client stopped on an error (the audit log says which).
// The sessions a socket opened end when it disconnects.

// Logon names and domains: printable, no quotes or line breaks.
const isAccountText = (value: string) =>
    value.length <= 256 && [...value].every((ch) => ch !== "\"" && ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f);

function parseOpenRequest(payload: unknown): RdpOpenRequest {
    const input = (payload ?? {}) as Partial<Record<keyof RdpOpenRequest, unknown>>;
    const credentials = input.credentials === "prompt" ? "prompt" : input.credentials === "saved" ? "saved" : null;
    if (!credentials) throw new AppError("INVALID_REQUEST", "Say whether to use the saved credentials or ask for them.", 400);
    const text = (value: unknown, what: string) => {
        if (value === undefined || value === null) return undefined;
        if (typeof value !== "string" || !isAccountText(value)) throw new AppError("INVALID_REQUEST", `The ${what} contains characters Remote Desktop cannot use.`, 400);
        return value.trim();
    };
    return {
        serverId: input.serverId as number,
        credentials,
        username: text(input.username, "user name"),
        domain: text(input.domain, "domain")
    };
}

// The page's words for how a session ended, as the audit log keeps them:
// one line of printable text, bounded.
function endDetail(value: unknown): string {
    if (typeof value !== "string") return "";
    return [...value].filter((ch) => ch.charCodeAt(0) >= 0x20 && ch.charCodeAt(0) !== 0x7f).join("").trim().slice(0, 200);
}

function refusal(err: unknown): { ok: false; code: string; error: string } {
    if (err instanceof AppError) return { ok: false, code: err.code, error: err.message };
    if (err instanceof TicketLimitError) return { ok: false, code: err.code, error: err.message };
    log.error(`Remote Desktop request failed: ${errorMessage(err)}`);
    return { ok: false, code: "RDP_INTERNAL", error: "The Remote Desktop connection could not be prepared." };
}

export function registerRdpHandlers(session: SocketSession): void {
    const { socket } = session;

    socket.on("rdp-open", async (payload, ack) => {
        if (typeof ack !== "function") return;
        let result: RdpOpenResult;
        try {
            const request = parseOpenRequest(payload);
            const prompted = request.credentials === "prompt";
            const route = await loadRdpRoute(request.serverId, { password: !prompted });
            const { target } = route;
            if (!prompted && (await rdpOptions.get(target.serverId)).askPassword) {
                throw new AppError("RDP_PASSWORD_REQUIRED", `"${target.name}" asks for the password each time: the saved one is not handed out.`, 409);
            }
            const username = prompted && request.username !== undefined ? request.username : target.username;
            const domain = prompted && request.domain !== undefined ? request.domain : target.domain ?? "";
            const ticket = rdpTickets.issue({
                serverId: target.serverId,
                owner: socket.id,
                username,
                domain,
                report: (event) => {
                    if (socket.connected) socket.emit("rdp-status", event);
                }
            });
            result = {
                ok: true,
                sessionId: ticket.id,
                ticket: ticket.token,
                gatewayPath: RDP_GATEWAY_PATH,
                destination: formatRdpAddress(target.host, target.port),
                username,
                domain,
                ...(!prompted && target.password ? { password: target.password } : {}),
                via: route.jump?.name ?? null
            };
        } catch (err) {
            result = refusal(err);
        }
        ack(result);
    });

    socket.on("rdp-trust-certificate", async (payload, ack) => {
        if (typeof ack !== "function") return;
        let result: RdpTrustCertificateResult;
        try {
            const { serverId, expected, actual } = (payload ?? {}) as Record<string, unknown>;
            if (typeof expected !== "string" || typeof actual !== "string" || !FINGERPRINT_PATTERN.test(expected) || !FINGERPRINT_PATTERN.test(actual) || expected === actual) {
                throw new AppError("INVALID_REQUEST", "The certificate to trust is not valid.", 400);
            }
            const { serverId: id, host, port, via } = await loadRdpEndpoint(serverId);
            const certificate = presentedCertificate(host, port, via, expected, actual);
            if (!certificate) {
                throw new AppError("RDP_CERT_CHANGED", "This certificate is no longer the one the server presented; connect again to compare the current one.", 409);
            }
            const pinned = await rdpCertificates.replace(certificate, expected);
            if (pinned.fingerprint !== actual) {
                throw new AppError("RDP_CERT_CHANGED", "The pinned certificate changed in the meantime; connect again to compare the current one.", 409);
            }
            forgetPresented(host, port, via);
            log.warn(`RDP certificate of ${formatRdpAddress(host, port)}${via ? ` via ${via}` : ""} replaced at the user's request: ${expected} -> ${actual}`);
            void recordAudit({
                serverId: id,
                source: "rdp",
                command: `rdp trust-certificate ${formatRdpAddress(host, port)}`,
                meta: { expected, actual, via: via || null }
            }).catch((err: unknown) => log.warn(`Could not record the certificate change in the audit log: ${errorMessage(err)}`));
            result = { ok: true };
        } catch (err) {
            result = refusal(err);
        }
        ack(result);
    });

    socket.on("rdp-disconnect", (payload) => {
        const { sessionId, cause, detail } = (payload ?? {}) as Partial<Record<keyof RdpDisconnectRequest, unknown>>;
        if (typeof sessionId !== "string" || sessionId.length > 64) return;
        const how: RdpEndCause = cause === "remote" || cause === "error" ? cause : "user";
        // Not connected yet: its ticket is dropped, so it never connects.
        if (!endRdpSessionFromPage(socket.id, sessionId, how, endDetail(detail))) rdpTickets.revoke(socket.id, sessionId);
    });

    socket.on("disconnect", () => {
        rdpTickets.revoke(socket.id);
        closeRdpSessionsOf(socket.id);
    });
}
