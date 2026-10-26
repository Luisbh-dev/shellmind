import type { ConnectionCause, ConnectionError } from "../../shared/terminal";
import { AppError } from "../errors";
import { HostKeyMismatchError } from "./hostKeys";
import { describeSshError } from "./pool";

// SSH connection failures as coded errors (the client translates the code;
// `message` stays the English text). Codes made here, besides AppError codes
// and system error codes (ECONNREFUSED...):
//   AUTH_FAILED          the saved credentials were rejected (details.methods
//                        when the server named the methods it accepts)
//   HANDSHAKE_TIMEOUT    no SSH handshake within the time
//   KEEPALIVE_TIMEOUT    the connection stopped answering
//   HANDSHAKE_FAILED     no common algorithms, a broken handshake
//   DNS_FAILED           the host name does not resolve
//   PRIVATE_KEY_INVALID  the saved private key cannot be read
//   JUMP_UNREACHABLE     the jump host could not reach the target (details.target, details.reason)
//   JUMP_TIMEOUT         ...not within the time (details.target or details.jump, details.seconds)
//   SSH_FAILED           anything else (only `message`)
// The terminal and file sessions add their own (server/sockets/terminalErrors.ts).

export type Details = Record<string, string | number>;

// Only flat string/number details travel to the client.
function flatDetails(details: Record<string, unknown> | undefined): Details | undefined {
    if (!details) return undefined;
    const flat: Details = {};
    for (const [key, value] of Object.entries(details)) {
        if (typeof value === "string" || typeof value === "number") flat[key] = value;
        else if (Array.isArray(value) && value.every((item) => typeof item === "string")) flat[key] = value.join(", ");
    }
    return Object.keys(flat).length ? flat : undefined;
}

function coded(code: string, message: string, details?: Details): ConnectionError {
    return details ? { code, message, details } : { code, message };
}

export function connectionError(err: unknown, fallbackCode = "SSH_FAILED"): ConnectionError {
    const message = describeSshError(err);
    if (err instanceof HostKeyMismatchError) {
        return coded("HOST_KEY_MISMATCH", message, flatDetails({ host: err.host, port: err.port, via: err.via || undefined }));
    }
    if (err instanceof AppError) return coded(err.code, message, flatDetails(err.details));

    const { level, code, methods, details } = (err ?? {}) as { level?: unknown; code?: unknown; methods?: unknown; details?: unknown };
    if (level === "client-authentication") {
        return Array.isArray(methods) && methods.length
            ? coded("AUTH_FAILED", message, flatDetails({ methods }))
            : coded("AUTH_FAILED", message);
    }
    if (level === "client-timeout") return coded(/keepalive/i.test(message) ? "KEEPALIVE_TIMEOUT" : "HANDSHAKE_TIMEOUT", message);
    if (level === "client-dns") return coded("DNS_FAILED", message);
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]{2,40}$/.test(code)) {
        return coded(code, message, details && typeof details === "object" ? flatDetails(details as Record<string, unknown>) : undefined);
    }
    if (/Cannot parse privateKey|Encrypted private OpenSSH key detected|bad passphrase/i.test(message)) return coded("PRIVATE_KEY_INVALID", message);
    if (level === "handshake" || level === "protocol") return coded("HANDSHAKE_FAILED", message);
    return coded(fallbackCode, message);
}

// A connection failure of the status, operations and log endpoints, which
// answer it as SSH_FAILED: its English text and, when it has a more precise
// code than that, the cause the client words like a terminal's.
export function sshFailure(err: unknown): { message: string; connection?: ConnectionCause } {
    const { code, message, details } = connectionError(err);
    if (code === "SSH_FAILED") return { message };
    return { message, connection: details ? { code, details } : { code } };
}
