import type { ConnectionError } from "../../shared/terminal";
import { errorMessage } from "../errors";
import type { Details } from "../ssh/connectionErrors";

// Failures of terminal and file sessions as coded errors, besides those of
// the SSH connection (server/ssh/connectionErrors.ts connectionError):
//   CHANNEL_TIMEOUT      the server did not open the terminal or file session (details.what, details.seconds)
//   CHANNEL_REFUSED      the server refused another session on every connection tried
//   CONNECTION_CLOSED    the connection closed
//   SFTP_FAILED          the SFTP subsystem could not start or failed (details.reason)
//   SFTP_ENDED           the SFTP subsystem ended on its own
//   FTP_FAILED / FTP_REJECTED  the FTP server failed / answered with an error (details.reason)
//   S3_CONFIG            the S3 client could not be set up (details.reason)
//   LOCAL_SPAWN_FAILED   the local shell or tool could not start (details.reason)

// A failure with the given code and the error's text as its reason.
export function failure(code: string, err: unknown, details: Details = {}): ConnectionError {
    const reason = errorMessage(err);
    return { code, message: reason, details: { ...details, reason } };
}

// FTP failures: network errors keep their system code, an FTP reply (a
// numeric code such as 530) is a rejection by the server.
export function ftpError(err: unknown): ConnectionError {
    const { code } = (err ?? {}) as { code?: unknown };
    if (typeof code === "string" && /^E[A-Z]+$/.test(code)) return { code, message: errorMessage(err) };
    if (typeof code === "number" && code === 530) return { code: "AUTH_FAILED", message: errorMessage(err) };
    return failure(typeof code === "number" ? "FTP_REJECTED" : "FTP_FAILED", err);
}
