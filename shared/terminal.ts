// Terminal session messages that are not program output. The backend sends
// them as data ("terminal-notice") and the client writes them into the
// terminal in the user's language.

// Why a scoped CLI console refused a line.
//   operator            an unquoted pipe, redirection or chaining (`detail`)
//   line-break          several lines at once
//   unterminated-quote  `detail` is "single" or "double"
//   batch-unsafe        % or ! in the arguments of a Windows batch tool
//   not-found           the tool is not on PATH
export type CliRefusal = "operator" | "line-break" | "unterminated-quote" | "batch-unsafe" | "not-found";

// A connection failure the client shows in the user's language. `code` picks
// the text and `details` fill it in; `message` is the backend's own (English)
// text, shown for codes the client does not know and as the technical detail.
// Codes: those of AppError/ConnectionTargetError (SERVER_NOT_FOUND,
// SECRET_UNREADABLE...), the system error codes of the network (ECONNREFUSED,
// ENOTFOUND, EHOSTUNREACH, ETIMEDOUT...) and the ones listed in
// server/ssh/connectionErrors.ts and server/sockets/terminalErrors.ts.
export type ConnectionError = {
    code: string;
    message: string;
    details?: Record<string, string | number>;
};

// Why an SSH_FAILED answer of the status, operations or log endpoints failed
// (`details.connection` of the API error, `connection` of a log stream's
// error): a ConnectionError without the message the answer already carries.
export type ConnectionCause = Omit<ConnectionError, "message">;

export type TerminalNotice =
    // The session is up: `target` is host:port, `via` the jump hosts
    // (nearest first); `protocol` "ftp" for the FTP shell (SSH otherwise).
    | { kind: "connected"; target: string; via: string[]; protocol?: "ssh" | "ftp" }
    // The SSH channel or connection closed (`reason`/`error` when it failed).
    | { kind: "connection-closed"; reason?: string; error?: ConnectionError }
    // A local console's process ended.
    | { kind: "session-ended" }
    // A scoped CLI console opened; `installUrl` when its tool is missing.
    | { kind: "cli-console"; name: string; bin: string; installUrl?: string }
    | { kind: "cli-refused"; bin: string; reason: CliRefusal; detail?: string }
    // Ctrl+C during a flood: output the backend still held (`bytes`) was
    // dropped instead of being drawn before the prompt comes back.
    | { kind: "output-discarded"; bytes: number };

// "trust-host-key": the user checked a changed host key (see
// HostKeyMismatchPayload) and trusts the new one. The pinned key is replaced
// only while it is still `expected`, and only by `actual`.
export type TrustHostKeyPayload = {
    serverId: number;
    host: string;
    port: number;
    keyType: string;
    expected: string;
    actual: string;
};

// HOST_KEY_CHANGED: the pinned key is neither of the two any more.
export type TrustHostKeyResult = { ok: true } | { ok: false; code: string; error: string };
