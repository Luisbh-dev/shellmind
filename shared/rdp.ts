// Remote Desktop: the native client launch (GET /api/rdp/native, POST
// /api/rdp/launch) and the embedded client's gateway (below).

// The client the backend opens: mstsc (Windows), FreeRDP or Remmina (Linux),
// or a .rdp file handed to the system's default handler (macOS, other Linux).
export type RdpClientKind = "mstsc" | "xfreerdp3" | "xfreerdp" | "remmina" | "rdp-file";

export type RdpSupport = {
    supported: boolean;
    client: RdpClientKind | null;
    // process.platform of the backend ("win32", "darwin", "linux", ...).
    platform: string;
};

// Body of POST /api/rdp/launch.
export type RdpLaunchInput = { serverId: number };

export type RdpLaunchResult = { client: RdpClientKind };

export type RdpFileTarget = { host: string; port: number; username?: string | null; domain?: string | null };

// A .rdp connection file that asks for the password (it never holds one).
// Line breaks in the values would start new settings, so they are dropped.
export function buildRdpFileContent(target: RdpFileTarget): string {
    const clean = (value: string) => value.replace(/[\r\n]+/g, " ").trim();
    const host = clean(target.host);
    const address = `${host.includes(":") ? `[${host}]` : host}:${target.port}`;
    const user = clean(target.username ?? "");
    const domain = clean(target.domain ?? "");
    const lines = [
        `full address:s:${address}`,
        user ? `username:s:${domain ? `${domain}\\${user}` : user}` : "",
        "prompt for credentials:i:1",
        "screen mode id:i:2",
        "session bpp:i:32",
        "redirectclipboard:i:1",
        "autoreconnection enabled:i:1",
        "authentication level:i:2"
    ];
    return lines.filter(Boolean).join("\r\n") + "\r\n";
}

// --- Embedded Remote Desktop (W7-S6) ---
// The IronRDP client runs in the page (WebAssembly) and reaches the server
// through the backend's RDCleanPath gateway, a WebSocket at this path. Its
// destination always comes from the saved server; a connection needs a
// one-time ticket handed out over the authenticated socket ("rdp-open").
export const RDP_GATEWAY_PATH = "/api/rdp/gateway";

// The server's TLS certificate, pinned on first use like an SSH host key.
export type RdpCertificate = {
    host: string;
    port: number;
    // The jump hosts the server is reached through ("" when direct).
    via: string;
    // SHA-256 of the certificate (DER), upper-case hex pairs joined with ":".
    fingerprint: string;
    // SHA-1 thumbprint as Windows shows it (certlm.msc, Get-ChildItem Cert:\).
    thumbprint: string;
    subject: string;
    issuer: string;
    // Validity (epoch ms); null when the certificate does not say.
    validFrom: number | null;
    validTo: number | null;
};

export type PinnedRdpCertificate = RdpCertificate & { id: number; createdAt: number };

// GET /api/rdp/certificate?serverId=: the pin of the server's route, if any.
export type RdpCertificateState = { host: string; port: number; via: string; pinned: PinnedRdpCertificate | null };

// GET /api/rdp/options?serverId=, PUT /api/rdp/options ({serverId, ...}):
// settings of a server's embedded client the backend enforces, so they hold
// on every device. `askPassword`: "rdp-open" never hands out the saved
// password (the user types one each time).
export type RdpOptions = { askPassword: boolean };
export type RdpOptionsInput = { serverId: number } & RdpOptions;

// "rdp-open": `saved` hands the stored password to the page for this one
// connection; `prompt` means the user types it (the saved one never leaves
// the backend), optionally signing in as someone else.
export type RdpOpenRequest = {
    serverId: number;
    credentials: "saved" | "prompt";
    username?: string;
    domain?: string;
};

export type RdpOpenResult =
    | {
        ok: true;
        sessionId: string;
        // One-time token for the gateway (it expires unused after a few seconds).
        ticket: string;
        gatewayPath: string;
        // host:port the client names in CredSSP (the gateway ignores it).
        destination: string;
        username: string;
        domain: string;
        // Only with credentials "saved", and only when one is stored.
        password?: string;
        // Name of the jump host the connection goes through, if any.
        via: string | null;
    }
    | { ok: false; code: string; error: string };

export type RdpErrorCode =
    | "RDP_UNREACHABLE"
    | "RDP_TIMEOUT"
    | "RDP_JUMP_FAILED"
    | "RDP_NEGOTIATION_FAILED"
    | "RDP_LEGACY_SECURITY"
    | "RDP_TLS_FAILED"
    | "RDP_CERT_MISMATCH"
    | "RDP_PROTOCOL"
    | "RDP_TICKET"
    | "RDP_BUSY"
    | "RDP_INTERNAL";

export type RdpGatewayError = {
    code: RdpErrorCode;
    // English text; the client shows its own translation of the code.
    message: string;
    // RDP_UNREACHABLE: errno (ECONNREFUSED...), RDP_NEGOTIATION_FAILED:
    // failure (HYBRID_REQUIRED_BY_SERVER...), RDP_JUMP_FAILED: jump host name.
    details?: Record<string, string | number>;
    // RDP_CERT_MISMATCH: the pinned certificate and the one presented now.
    mismatch?: { expected: PinnedRdpCertificate; actual: RdpCertificate };
};

export type RdpSessionPhase = "connecting" | "securing" | "established" | "closed" | "failed";

// How the gateway secured its connection to the server.
export type RdpTlsParameters = {
    // "TLSv1.3", "TLSv1.2".
    protocol: string;
    // The cipher suite's standard (IANA) name.
    cipher: string;
    // TLS 1.3, or TLS 1.2 with ephemeral (EC)DH key exchange: whoever later
    // gets the server's private key still cannot decrypt a recording of it.
    forwardSecrecy: boolean;
    // The runtime refused the server's certificate for TLS 1.3 and ECDHE (its
    // key usage does not allow digital signatures), so the gateway connected
    // again with TLS 1.2 and RSA key exchange.
    keyUsageFallback: boolean;
};

// "rdp-status": progress of a gateway connection of this socket.
export type RdpStatusEvent = {
    sessionId: string;
    phase: RdpSessionPhase;
    error?: RdpGatewayError;
    // "established": the server's certificate, whether it was pinned just
    // now, and the TLS the connection to it uses.
    certificate?: RdpCertificate;
    pinnedNow?: boolean;
    tls?: RdpTlsParameters;
};

// "rdp-disconnect": a session this socket opened ended in the page, and how
// (the client does not always close its WebSocket, so the gateway would not
// know): `user` ended or cancelled it (one still being set up stops at
// once), the `remote` desktop ended it, or the client stopped on an `error`.
// `detail`: the remote desktop's reason or the error, for the audit log.
export type RdpEndCause = "user" | "remote" | "error";
export type RdpDisconnectRequest = { sessionId: string; cause?: RdpEndCause; detail?: string };

// "rdp-trust-certificate": replaces the pin of the server's route with the
// certificate the gateway was just shown (only that one).
export type RdpTrustCertificateRequest = { serverId: number; expected: string; actual: string };
export type RdpTrustCertificateResult = { ok: true } | { ok: false; code: string; error: string };

// host:port, with an IPv6 address in brackets.
export function formatRdpAddress(host: string, port: number): string {
    return `${host.includes(":") ? `[${host}]` : host}:${port}`;
}

// Remote desktop sizes the display control channel accepts (MS-RDPEDISP:
// 200 to 8192 pixels, even widths).
export const RDP_MIN_SIZE = 200;
export const RDP_MAX_SIZE = 8192;

export function clampDesktopSize(width: number, height: number): { width: number; height: number } {
    const clamp = (value: number) => Math.min(RDP_MAX_SIZE, Math.max(RDP_MIN_SIZE, Math.floor(value)));
    const w = clamp(width);
    return { width: w - (w % 2), height: clamp(height) };
}
