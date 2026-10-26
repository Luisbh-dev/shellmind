import type { RdpErrorCode, RdpGatewayError } from "../../shared/rdp";
import { GENERAL_ERROR_CODE, NEGOTIATION_ERROR_CODE, type RdCleanPathError } from "./rdcleanpath";

// Why a gateway connection failed: what the page's RDP client is told (an
// RDCleanPath error, codes only) and what the user is shown (over the
// socket that asked for the connection, see "rdp-status").
export class RdpGatewayFailure extends Error {
    constructor(
        readonly code: RdpErrorCode,
        message: string,
        readonly answer: RdCleanPathError = { errorCode: GENERAL_ERROR_CODE },
        readonly extra: Pick<RdpGatewayError, "details" | "mismatch"> & { x224?: Buffer } = {}
    ) {
        super(message);
        this.name = "RdpGatewayFailure";
    }

    get isNegotiation(): boolean {
        return this.answer.errorCode === NEGOTIATION_ERROR_CODE;
    }

    toEvent(): RdpGatewayError {
        return { code: this.code, message: this.message, ...(this.extra.details ? { details: this.extra.details } : {}), ...(this.extra.mismatch ? { mismatch: this.extra.mismatch } : {}) };
    }
}

// Winsock codes RDCleanPath reports socket failures with.
const WSA: Record<string, number> = {
    ECONNREFUSED: 10061,
    ETIMEDOUT: 10060,
    EHOSTUNREACH: 10065,
    ENETUNREACH: 10051,
    ECONNRESET: 10054,
    ECONNABORTED: 10053,
    EADDRNOTAVAIL: 10049,
    ENOTFOUND: 11001,
    EAI_AGAIN: 11002
};

const SOCKET_REASONS: Record<string, string> = {
    ECONNREFUSED: "the connection was refused (nothing listens on that port, or a firewall rejects it)",
    ETIMEDOUT: "the connection timed out",
    EHOSTUNREACH: "the host is unreachable",
    ENETUNREACH: "the network is unreachable",
    ECONNRESET: "the connection was reset",
    ENOTFOUND: "the host name could not be resolved",
    EAI_AGAIN: "the host name could not be resolved right now"
};

export function socketFailure(err: unknown, address: string): RdpGatewayFailure {
    const errno = (err as NodeJS.ErrnoException | null)?.code ?? "";
    const reason = SOCKET_REASONS[errno] ?? (err instanceof Error ? err.message : String(err));
    return new RdpGatewayFailure(
        errno === "ETIMEDOUT" ? "RDP_TIMEOUT" : "RDP_UNREACHABLE",
        `Could not connect to ${address}: ${reason}.`,
        { errorCode: GENERAL_ERROR_CODE, wsaLastError: WSA[errno] ?? 10060 },
        { details: { address, ...(errno ? { errno } : {}) } }
    );
}
