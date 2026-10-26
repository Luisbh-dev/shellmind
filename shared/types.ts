// Types shared by the backend (server/) and the frontend (src/).
// shared/ is framework-free: no Node, DOM, React or socket.io imports.

export type AiProvider = "gemini" | "minimax";
export type ConfigSource = "env" | "db" | "none";
export type ProviderStatus = {
    configured: boolean;
    source: ConfigSource;
};

export type ServerType = "linux" | "windows" | "ftp" | "s3" | "local";
export const SERVER_TYPES: readonly ServerType[] = ["linux", "windows", "ftp", "s3", "local"];

// What a connection to a saved server is opened for. It selects the protocol
// and the port (a Windows server is reached over SSH for everything but RDP).
export type ConnectionPurpose = "terminal" | "files" | "status" | "rdp" | "exec";

// A saved connection as GET /api/servers returns it. Secrets never leave the
// backend; the has_* flags (SQLite 0/1) only say whether one is stored.
// A null port means "the default for the type" (see shared/ports.ts).
export type ServerSummary = {
    id: number;
    name: string;
    ip: string;
    type: ServerType;
    username?: string | null;
    port?: number | null;
    ssh_port?: number | null;
    os_detail?: string | null;
    s3_provider?: string | null;
    s3_bucket?: string | null;
    s3_region?: string | null;
    s3_endpoint?: string | null;
    s3_access_key?: string | null;
    command?: string | null;
    cwd?: string | null;
    initial_command?: string | null;
    cli_preset?: string | null;
    // RDP / Windows logon domain.
    domain?: string | null;
    // Private key read from this file at connect time (`~` is expanded).
    private_key_path?: string | null;
    // SSH connections go through this saved server first (ProxyJump).
    jump_server_id?: number | null;
    // W7-S2: the saved identity (Settings > Keychain) whose credentials the
    // server connects with; null or absent: its own.
    identity_id?: number | null;
    // W7-S2: SSH agent forwarding on its terminal sessions (SQLite 0/1); only
    // with an identity that signs in with the agent.
    agent_forward?: number | boolean;
    group_name?: string | null;
    tags?: string[];
    color?: string | null;
    notes?: string | null;
    sort_order?: number;
    // Epoch ms of the last edit.
    updated_at?: number | null;
    // FTP over explicit TLS (FTPS), SQLite 0/1.
    ftp_secure?: number | boolean;
    // Pinned at the top of the sidebar, SQLite 0/1 (PATCH /api/servers/:id/favorite).
    favorite?: number | boolean;
    has_password?: number | boolean;
    has_private_key?: number | boolean;
    has_passphrase?: number | boolean;
    has_s3_secret_key?: number | boolean;
};

// Body of POST /api/servers and PUT /api/servers/:id.
// Secrets are write-only: a missing or blank secret keeps the stored one and a
// clear_* flag removes it. PUT replaces the connection fields; os_detail and
// the fields from `domain` on are only changed when present in the body.
// When PUT changes where a server points (address, type, port, S3 endpoint or
// jump server) while stored secrets would be kept, the request is refused
// (409, code SECRETS_RETARGET) unless the secrets are re-entered, cleared, or
// `keep_secrets: true` confirms they may go to the new target.
export type ServerInput = {
    name: string;
    ip?: string;
    type: ServerType;
    username?: string | null;
    port?: number | null;
    ssh_port?: number | null;
    os_detail?: string | null;
    s3_provider?: string | null;
    s3_bucket?: string | null;
    s3_region?: string | null;
    s3_endpoint?: string | null;
    s3_access_key?: string | null;
    command?: string | null;
    cwd?: string | null;
    initial_command?: string | null;
    cli_preset?: string | null;
    domain?: string | null;
    private_key_path?: string | null;
    jump_server_id?: number | null;
    group_name?: string | null;
    tags?: string[] | null;
    color?: string | null;
    notes?: string | null;
    sort_order?: number | null;
    // Turning it off while the FTP password is kept needs `keep_secrets`.
    ftp_secure?: boolean;
    favorite?: boolean;
    password?: string;
    privateKey?: string;
    passphrase?: string;
    s3_secret_key?: string;
    clear_password?: boolean;
    clear_private_key?: boolean;
    clear_passphrase?: boolean;
    clear_s3_secret_key?: boolean;
    keep_secrets?: boolean;
    // --- W7-S2 identities ---
    // Linux and Windows servers only (null: none). Keeping it while the
    // server is pointed elsewhere counts as kept secrets ("identity" in
    // SECRETS_RETARGET details.kept) when the identity holds any.
    identity_id?: number | null;
    agent_forward?: boolean;
};

// A pinned SSH host key (trust on first use), keyed by host and port.
// `fingerprint` is OpenSSH style: "SHA256:<base64 without padding>".
export type KnownHost = {
    id: number;
    host: string;
    port: number;
    key_type: string;
    fingerprint: string;
    created_at: number;
    // V1 (BC-02): the jump hosts the host is reached through, as host:port
    // joined with ">" from the first hop; "" (or absent) for a direct
    // connection. Pins are unique per host, port and via.
    via?: string;
};

// Where a command recorded in the audit log came from. W7: "fleet" (health
// probes and fleet board actions), "identity" (keys installed on servers,
// identity changes), "rdp" (embedded RDP sessions).
export const AUDIT_SOURCES = ["ai-run", "ai-autorun", "snippet", "multi-exec", "ops", "terminal", "fleet", "identity", "rdp"] as const;
export type AuditSource = typeof AUDIT_SOURCES[number];

// What the frontend reports through POST /api/audit: commands it typed into
// a terminal on someone's behalf, and broadcast input. The backend records
// these entries with meta.reportedBy "client". Fleet, identity and RDP
// entries are only ever the backend's own.
export const CLIENT_AUDIT_SOURCES = ["ai-run", "ai-autorun", "snippet", "multi-exec", "ops", "terminal"] as const satisfies readonly AuditSource[];
export type ClientAuditSource = typeof CLIENT_AUDIT_SOURCES[number];
export const CLIENT_REPORTED = "client";

export type AuditEntry = {
    id: number;
    ts: number;
    server_id: number | null;
    server_name: string | null;
    source: AuditSource;
    command: string;
    exit_code: number | null;
    meta: Record<string, unknown> | null;
};

// What the backend records (recordAudit). POST /api/audit takes one with a
// ClientAuditSource; the server name is looked up by the backend.
export type AuditInput = {
    serverId?: number | null;
    source: AuditSource;
    command: string;
    exitCode?: number | null;
    meta?: Record<string, unknown> | null;
};

// A saved command (runbook step); `{{name}}` placeholders are filled in before
// it runs. server_id null means the snippet is available on every server.
export type Snippet = {
    id: number;
    name: string;
    command: string;
    description: string | null;
    tags: string[];
    server_id: number | null;
    created_at: number;
    updated_at: number;
};

// SSH local port forward: local_host:local_port -> remote_host:remote_port
// through the saved server.
export type Tunnel = {
    id: number;
    server_id: number;
    name: string | null;
    local_host: string;
    local_port: number;
    remote_host: string;
    remote_port: number;
    auto_start: boolean;
    created_at: number;
};

export type ChatTurn = { role: "user" | "assistant"; content: string };

// GET /api/health (public): the backend is up.
export type HealthResponse = { ok: true; version: string };

// GET /api/session (authenticated): the session token was accepted.
export type SessionResponse = { authenticated: true };

// --- slice V4b: HTTP error envelope and audit retention ----------------------

// The body of every non-2xx JSON answer of the API: a readable message, a
// stable machine-readable code (what the UI translates) and, for some codes,
// structured details.
export type ApiErrorBody = {
    error: string;
    code: string;
    details?: Record<string, unknown>;
};

// GET/PUT /api/audit/settings. retentionDays 0 keeps entries without a time
// limit; the newest maxEntries are kept in any case.
export const AUDIT_RETENTION_DAYS = [30, 90, 180, 365, 0] as const;
export type AuditRetentionDays = typeof AUDIT_RETENTION_DAYS[number];
export type AuditSettings = {
    retentionDays: AuditRetentionDays;
    maxEntries: number;
};
